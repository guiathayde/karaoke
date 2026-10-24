/* Motor de áudio dos microfones (roda na tela do palco): captura, supressão de ruído, autotune e efeitos por canal, eco e reverb. */

import type { MicSettings, ReverbSettings, Scale, SongKey } from '../lib/types'

export type InputMode = 'mono' | 'stereo' | 'two'

export interface EngineConfig {
  mode: InputMode
  deviceA: string | null
  deviceB: string | null
}

export interface PitchInfo {
  freq: number
  conf: number
  shift: number
  rms: number
  guided: boolean // a correção está seguindo a nota do vocal original
}

/** Estado da supressão de ruído de um canal; níveis em dBFS depois do pré-ganho, como no medidor. */
export interface NoiseInfo {
  open: boolean // alguém cantando: o sinal passa inteiro
  floor: number | null // piso de ruído estimado (null enquanto não há medida)
  level: number
  gain: number // atenuação aplicada agora (0 = nenhuma)
}

export interface MelodyTrack {
  hop: number
  notes: number[]
}

/** Tonalidade que o autotune de um mic usa: a detectada da música (automático) ou a escolhida à mão; null = cromática. */
export function effectiveKey(s: MicSettings, songKey: SongKey | null): SongKey | null {
  if (s.auto_key) return songKey
  if (s.key === null || s.scale === 'chromatic') return null
  return { tonic: s.key, scale: s.scale }
}

const SCALES: Record<Exclude<Scale, 'chromatic'>, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
}

export const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export function scaleMask(key: number | null, scale: Scale): boolean[] {
  if (scale === 'chromatic' || key === null) return new Array(12).fill(true)
  const mask = new Array(12).fill(false)
  for (const step of SCALES[scale]) mask[(key + step) % 12] = true
  return mask
}

export interface MeterInfo {
  rms: number
  peak: number
  db: number
  clipping: boolean
}

interface Chain {
  hpf: BiquadFilterNode
  gate: AudioWorkletNode
  noise: NoiseInfo // como o worklet relata, antes do pré-ganho
  inputGainDb: number
  preGain: GainNode
  comp: DynamicsCompressorNode
  worklet: AudioWorkletNode
  fx: AudioNode[] // saturação e dobra (desconectados juntos)
  lfos: OscillatorNode[]
  driveIn: GainNode
  driveDry: GainNode
  driveWet: GainNode
  double: GainNode
  echoSend: GainNode
  tap: AudioWorkletNode
  mute: GainNode
  ws: WebSocket | null
  gain: GainNode
  analyser: AnalyserNode
  pitch: PitchInfo
}

function makeImpulse(ctx: AudioContext, seconds = 1.8, decay = 0.45): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch)
    for (let i = 0; i < len; i++) {
      const t = i / ctx.sampleRate
      data[i] = (Math.random() * 2 - 1) * Math.exp(-t / decay) * (t < 0.01 ? t / 0.01 : 1)
    }
  }
  return buf
}

function driveCurve(): Float32Array<ArrayBuffer> {
  const n = 2048
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) curve[i] = Math.tanh((i / (n - 1)) * 2 - 1)
  return curve
}

export class MicEngine {
  readonly ctx: AudioContext
  private bus: GainNode
  private limiter: DynamicsCompressorNode
  private reverbSend: GainNode
  private convolver: ConvolverNode
  private echoIn: GainNode
  private melody: { hop: number; notes: Float32Array } | null = null
  private chains: (Chain | null)[] = [null, null]
  private lastMics: [MicSettings | null, MicSettings | null] = [null, null]
  private lastKey: SongKey | null = null
  private streams: MediaStream[] = []
  private sources: AudioNode[] = []
  private splitters: AudioNode[] = []
  private levelBuf = new Float32Array(1024)
  private workletReady: Promise<void>
  /** Tempo atual do vídeo (ou null fora de reprodução); carimba o áudio enviado ao servidor. */
  timeSource: (() => number | null) | null = null

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })
    this.bus = this.ctx.createGain()
    // Limitador de segurança no barramento final: impede distorção digital mesmo com ganho/boost alto nos 2 mics
    this.limiter = this.ctx.createDynamicsCompressor()
    this.limiter.threshold.value = -1.5
    this.limiter.knee.value = 3
    this.limiter.ratio.value = 20
    this.limiter.attack.value = 0.001
    this.limiter.release.value = 0.08
    this.reverbSend = this.ctx.createGain()
    this.reverbSend.gain.value = 0
    this.convolver = this.ctx.createConvolver()
    this.convolver.buffer = makeImpulse(this.ctx)
    this.bus.connect(this.limiter)
    this.limiter.connect(this.ctx.destination)
    this.limiter.connect(this.reverbSend)
    this.reverbSend.connect(this.convolver)
    this.convolver.connect(this.ctx.destination)
    // eco compartilhado: cada mic manda uma parte do sinal; repetições escurecem a cada volta
    this.echoIn = this.ctx.createGain()
    const echoDelay = this.ctx.createDelay(1)
    echoDelay.delayTime.value = 0.32
    const echoTone = this.ctx.createBiquadFilter()
    echoTone.type = 'lowpass'
    echoTone.frequency.value = 3200
    const echoFeedback = this.ctx.createGain()
    echoFeedback.gain.value = 0.38
    this.echoIn.connect(echoDelay)
    echoDelay.connect(echoTone)
    echoTone.connect(echoFeedback)
    echoFeedback.connect(echoDelay)
    echoTone.connect(this.limiter)
    echoTone.connect(this.reverbSend)
    // o autotune guiado precisa saber em que ponto do vídeo estamos
    window.setInterval(() => this.postClock(), 250)
    this.workletReady = Promise.all([
      this.ctx.audioWorklet.addModule('/worklets/noisegate.js'),
      this.ctx.audioWorklet.addModule('/worklets/autotune.js'),
      this.ctx.audioWorklet.addModule('/worklets/tap.js'),
    ]).then(() => undefined)
  }

  get running(): boolean {
    return this.streams.length > 0
  }

  get latencyMs(): number {
    const base = this.ctx.baseLatency ?? 0
    const out = this.ctx.outputLatency ?? 0
    return Math.round((base + out) * 1000)
  }

  static async listInputs(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter((d) => d.kind === 'audioinput')
  }

  async start(config: EngineConfig): Promise<void> {
    await this.workletReady
    if (this.ctx.state !== 'running') await this.ctx.resume()
    this.stopInputs()

    const open = async (deviceId: string | null, channels: number) => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: channels,
        },
      })
      this.streams.push(stream)
      const src = this.ctx.createMediaStreamSource(stream)
      this.sources.push(src)
      return src
    }

    if (config.mode === 'mono') {
      // Soma os 2 canais da interface sem a atenuação de -6 dB (0.5 * (L + R)) do downmix padrão
      const src = await open(config.deviceA, 2)
      const splitter = this.ctx.createChannelSplitter(2)
      const mono = this.ctx.createGain()
      mono.channelCount = 1
      mono.channelCountMode = 'explicit'
      src.connect(splitter)
      splitter.connect(mono, 0)
      splitter.connect(mono, 1)
      this.splitters.push(splitter, mono)
      this.chains[0] = this.buildChain(mono, 0, 0)
      this.chains[1] = null
    } else if (config.mode === 'stereo') {
      // Interface USB de 2 canais (ex.: Q-12): separa Canal 1 (Esq) -> Mic 1 e Canal 2 (Dir) -> Mic 2
      const src = await open(config.deviceA, 2)
      const splitter = this.ctx.createChannelSplitter(2)
      src.connect(splitter)
      this.splitters.push(splitter)
      this.chains[0] = this.buildChain(splitter, 0, 0)
      this.chains[1] = this.buildChain(splitter, 1, 1)
    } else {
      const a = await open(config.deviceA, 1)
      const b = await open(config.deviceB, 1)
      this.chains[0] = this.buildChain(a, 0, 0)
      this.chains[1] = this.buildChain(b, 0, 1)
    }

    if (this.lastMics[0]) this.applyMic(0, this.lastMics[0], this.lastKey)
    if (this.lastMics[1]) this.applyMic(1, this.lastMics[1], this.lastKey)
  }

  private connectMicSocket(chain: Chain, index: 0 | 1): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws/mic/${index + 1}`)
    ws.binaryType = 'arraybuffer'
    ws.onclose = () => {
      if (this.chains[index] === chain) window.setTimeout(() => this.connectMicSocket(chain, index), 2000)
    }
    ws.onerror = () => ws.close()
    chain.ws = ws
  }

  private buildChain(source: AudioNode, outputIndex: number, index: 0 | 1): Chain {
    const hpf = this.ctx.createBiquadFilter()
    hpf.type = 'highpass'
    hpf.frequency.value = 80
    hpf.channelCount = 1
    hpf.channelCountMode = 'explicit'
    // Supressão de ruído (noise gate adaptativo) antes do pré-ganho: o boost não desloca o piso de ruído
    const gate = new AudioWorkletNode(this.ctx, 'noisegate', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
    })
    // Pré-amplificador digital individual do canal (atua logo após o ChannelSplitterNode e antes do autotune/pontuação)
    const preGain = this.ctx.createGain()
    preGain.channelCount = 1
    preGain.channelCountMode = 'explicit'
    // Compressor/limitador por canal: levanta sinais fracos sem estourar quando cantam forte
    const comp = this.ctx.createDynamicsCompressor()
    comp.threshold.value = -10
    comp.knee.value = 8
    comp.ratio.value = 6
    comp.attack.value = 0.003
    comp.release.value = 0.15
    comp.channelCount = 1
    comp.channelCountMode = 'explicit'
    const worklet = new AudioWorkletNode(this.ctx, 'autotune', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
    })
    // saturação: mistura do sinal limpo com uma cópia amplificada e achatada por tanh
    const driveIn = this.ctx.createGain()
    const shaper = this.ctx.createWaveShaper()
    shaper.curve = driveCurve()
    shaper.oversample = '2x'
    const driveWet = this.ctx.createGain()
    driveWet.gain.value = 0
    const driveDry = this.ctx.createGain()
    const voice = this.ctx.createGain()
    // dobra: duas cópias atrasadas 20–30 ms com o atraso oscilando (leve desafinação), abertas no estéreo
    const double = this.ctx.createGain()
    double.gain.value = 0
    const fx: AudioNode[] = [driveIn, shaper, driveWet, driveDry, voice, double]
    const lfos: OscillatorNode[] = []
    for (const [base, rate, pan] of [
      [0.022, 0.33, -0.7],
      [0.031, 0.27, 0.7],
    ]) {
      const delay = this.ctx.createDelay(0.1)
      delay.delayTime.value = base
      const lfo = this.ctx.createOscillator()
      lfo.frequency.value = rate
      const depth = this.ctx.createGain()
      depth.gain.value = 0.0015
      lfo.connect(depth)
      depth.connect(delay.delayTime)
      lfo.start()
      const panner = this.ctx.createStereoPanner()
      panner.pan.value = pan
      voice.connect(delay)
      delay.connect(panner)
      panner.connect(double)
      fx.push(delay, depth, panner)
      lfos.push(lfo)
    }
    const echoSend = this.ctx.createGain()
    echoSend.gain.value = 0
    const gain = this.ctx.createGain()
    const analyser = this.ctx.createAnalyser()
    analyser.fftSize = 1024
    const tap = new AudioWorkletNode(this.ctx, 'tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
    })
    const mute = this.ctx.createGain()
    mute.gain.value = 0
    const chain: Chain = {
      hpf,
      gate,
      noise: { open: true, floor: null, level: -100, gain: 0 },
      inputGainDb: 0,
      preGain,
      comp,
      worklet,
      fx,
      lfos,
      driveIn,
      driveDry,
      driveWet,
      double,
      echoSend,
      tap,
      mute,
      ws: null,
      gain,
      analyser,
      pitch: { freq: 0, conf: 0, shift: 0, rms: 0, guided: false },
    }
    gate.port.onmessage = (e) => {
      chain.noise = e.data as NoiseInfo
    }
    worklet.port.onmessage = (e) => {
      chain.pitch = e.data as PitchInfo
    }
    tap.port.onmessage = (e) => {
      const t = this.timeSource?.()
      const ws = chain.ws
      if (t === null || t === undefined || !ws || ws.readyState !== WebSocket.OPEN) return
      const samples = e.data as ArrayBuffer
      const frame = new ArrayBuffer(8 + samples.byteLength)
      new DataView(frame).setFloat64(0, t, true)
      new Uint8Array(frame, 8).set(new Uint8Array(samples))
      ws.send(frame)
    }
    source.connect(hpf, outputIndex)
    hpf.connect(gate)
    gate.connect(preGain)
    preGain.connect(comp)
    comp.connect(worklet)
    comp.connect(tap)
    tap.connect(mute)
    mute.connect(this.ctx.destination)
    worklet.connect(driveDry)
    worklet.connect(driveIn)
    driveIn.connect(shaper)
    shaper.connect(driveWet)
    driveDry.connect(voice)
    driveWet.connect(voice)
    voice.connect(gain)
    double.connect(gain)
    gain.connect(analyser)
    gain.connect(this.bus)
    gain.connect(echoSend)
    echoSend.connect(this.echoIn)
    worklet.port.postMessage({ melody: this.melody })
    this.connectMicSocket(chain, index)
    return chain
  }

  applyMic(index: 0 | 1, s: MicSettings, songKey: SongKey | null): void {
    this.lastMics[index] = s
    this.lastKey = songKey
    const chain = this.chains[index]
    if (!chain) return
    const key = effectiveKey(s, songKey)
    chain.gate.port.postMessage({ strength: (s.denoise ?? 0) / 100 })
    chain.worklet.port.postMessage({
      enabled: s.enabled,
      strength: s.strength / 100,
      speed: s.speed_ms / 1000,
      mask: key ? scaleMask(key.tonic, key.scale) : scaleMask(null, 'chromatic'),
      follow: s.follow_melody,
    })
    const now = this.ctx.currentTime
    const drive = s.drive / 100
    // Amplificação na entrada do canal: boost em dB (0..+36 dB = 1x..63x) multiplicado pelo ganho acima de 100%
    const boostLinear = Math.pow(10, (s.boost_db ?? 0) / 20)
    const preGainVal = boostLinear * Math.max(1, s.gain)
    const postGainVal = Math.min(1, s.gain)
    chain.inputGainDb = 20 * Math.log10(preGainVal)
    chain.preGain.gain.setTargetAtTime(preGainVal, now, 0.05)
    chain.driveIn.gain.setTargetAtTime(1 + drive * 12, now, 0.05)
    chain.driveWet.gain.setTargetAtTime(drive * 0.45, now, 0.05)
    chain.driveDry.gain.setTargetAtTime(1 - drive * 0.5, now, 0.05)
    chain.double.gain.setTargetAtTime((s.double / 100) * 0.7, now, 0.05)
    chain.echoSend.gain.setTargetAtTime((s.echo / 100) * 0.5, now, 0.05)
    chain.gain.gain.setTargetAtTime(postGainVal, now, 0.05)
  }

  /** Melodia do vocal original (já no tom que está tocando) para o autotune guiado; null desliga. */
  setMelody(melody: MelodyTrack | null): void {
    this.melody = melody ? { hop: melody.hop, notes: Float32Array.from(melody.notes) } : null
    for (const c of this.chains) c?.worklet.port.postMessage({ melody: this.melody })
    this.postClock()
  }

  private postClock(): void {
    if (!this.chains.some(Boolean)) return
    const t = this.timeSource?.() ?? null
    // quem canta ouve a música atrasada pela latência de saída; a voz chega ao worklet nesse atraso
    const lag = (this.ctx.baseLatency ?? 0) + (this.ctx.outputLatency ?? 0)
    const clock = t === null ? null : [Math.max(0, t - lag), this.ctx.currentTime]
    for (const c of this.chains) c?.worklet.port.postMessage({ clock })
  }

  applyReverb(r: ReverbSettings): void {
    const target = r.enabled ? (r.amount / 100) * 0.6 : 0
    this.reverbSend.gain.setTargetAtTime(target, this.ctx.currentTime, 0.1)
  }

  meter(index: 0 | 1): MeterInfo {
    const chain = this.chains[index]
    if (!chain) return { rms: 0, peak: 0, db: -100, clipping: false }
    chain.analyser.getFloatTimeDomainData(this.levelBuf)
    let sum = 0
    let peak = 0
    for (let i = 0; i < this.levelBuf.length; i++) {
      const v = Math.abs(this.levelBuf[i])
      sum += v * v
      if (v > peak) peak = v
    }
    const rms = Math.sqrt(sum / this.levelBuf.length)
    const db = rms > 0.00001 ? Math.max(-100, Math.round(20 * Math.log10(rms))) : -100
    return { rms, peak, db, clipping: peak >= 0.95 }
  }

  level(index: 0 | 1): number {
    return this.meter(index).rms
  }

  pitch(index: 0 | 1): PitchInfo | null {
    return this.chains[index]?.pitch ?? null
  }

  noise(index: 0 | 1): NoiseInfo | null {
    const chain = this.chains[index]
    if (!chain) return null
    const { noise: n, inputGainDb: g } = chain
    return { ...n, floor: n.floor === null ? null : n.floor + g, level: n.level + g }
  }

  hasChain(index: 0 | 1): boolean {
    return this.chains[index] !== null
  }

  /** Alguém está cantando em algum microfone (nível do sinal acima do limiar). */
  voiceActive(threshold = 0.03): boolean {
    return this.chains.some((c) => c !== null && c.pitch.rms >= threshold)
  }

  private stopInputs(): void {
    for (const s of this.sources) s.disconnect()
    for (const sp of this.splitters) sp.disconnect()
    for (const st of this.streams) st.getTracks().forEach((t) => t.stop())
    for (const c of this.chains) {
      if (!c) continue
      c.hpf.disconnect()
      c.gate.disconnect()
      c.preGain.disconnect()
      c.comp.disconnect()
      c.worklet.disconnect()
      for (const n of c.fx) n.disconnect()
      for (const o of c.lfos) o.stop()
      c.echoSend.disconnect()
      c.tap.disconnect()
      c.mute.disconnect()
      c.gain.disconnect()
      c.gate.port.onmessage = null
      c.worklet.port.onmessage = null
      c.tap.port.onmessage = null
      const ws = c.ws
      c.ws = null
      if (ws) {
        ws.onclose = null
        ws.close()
      }
    }
    this.sources = []
    this.splitters = []
    this.streams = []
    this.chains = [null, null]
  }

  async stop(): Promise<void> {
    this.stopInputs()
    await this.ctx.suspend()
  }
}
