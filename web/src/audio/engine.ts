/* Motor de áudio dos microfones (roda na tela do palco): captura, autotune por canal, reverb. */

import type { MicSettings, ReverbSettings, Scale } from '../lib/types'

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

interface Chain {
  hpf: BiquadFilterNode
  worklet: AudioWorkletNode
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

export class MicEngine {
  readonly ctx: AudioContext
  private bus: GainNode
  private reverbSend: GainNode
  private convolver: ConvolverNode
  private chains: (Chain | null)[] = [null, null]
  private streams: MediaStream[] = []
  private sources: AudioNode[] = []
  private levelBuf = new Float32Array(1024)
  private workletReady: Promise<void>
  /** Tempo atual do vídeo (ou null fora de reprodução); carimba o áudio enviado ao servidor. */
  timeSource: (() => number | null) | null = null

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })
    this.bus = this.ctx.createGain()
    this.reverbSend = this.ctx.createGain()
    this.reverbSend.gain.value = 0
    this.convolver = this.ctx.createConvolver()
    this.convolver.buffer = makeImpulse(this.ctx)
    this.bus.connect(this.ctx.destination)
    this.bus.connect(this.reverbSend)
    this.reverbSend.connect(this.convolver)
    this.convolver.connect(this.ctx.destination)
    this.workletReady = Promise.all([
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
      const src = await open(config.deviceA, 1)
      const mono = this.ctx.createGain()
      mono.channelCount = 1
      mono.channelCountMode = 'explicit'
      src.connect(mono)
      this.chains[0] = this.buildChain(mono, 0, 0)
      this.chains[1] = null
    } else if (config.mode === 'stereo') {
      const src = await open(config.deviceA, 2)
      const splitter = this.ctx.createChannelSplitter(2)
      src.connect(splitter)
      this.chains[0] = this.buildChain(splitter, 0, 0)
      this.chains[1] = this.buildChain(splitter, 1, 1)
    } else {
      const a = await open(config.deviceA, 1)
      const b = await open(config.deviceB, 1)
      this.chains[0] = this.buildChain(a, 0, 0)
      this.chains[1] = this.buildChain(b, 0, 1)
    }
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
    const worklet = new AudioWorkletNode(this.ctx, 'autotune', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
    })
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
      worklet,
      tap,
      mute,
      ws: null,
      gain,
      analyser,
      pitch: { freq: 0, conf: 0, shift: 0, rms: 0 },
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
    hpf.connect(worklet)
    hpf.connect(tap)
    tap.connect(mute)
    mute.connect(this.ctx.destination)
    worklet.connect(gain)
    gain.connect(analyser)
    gain.connect(this.bus)
    this.connectMicSocket(chain, index)
    return chain
  }

  applyMic(index: 0 | 1, s: MicSettings): void {
    const chain = this.chains[index]
    if (!chain) return
    chain.worklet.port.postMessage({
      enabled: s.enabled,
      strength: s.strength / 100,
      speed: s.speed_ms / 1000,
      mask: scaleMask(s.key, s.scale),
    })
    chain.gain.gain.setTargetAtTime(s.gain, this.ctx.currentTime, 0.05)
  }

  applyReverb(r: ReverbSettings): void {
    const target = r.enabled ? (r.amount / 100) * 0.6 : 0
    this.reverbSend.gain.setTargetAtTime(target, this.ctx.currentTime, 0.1)
  }

  level(index: 0 | 1): number {
    const chain = this.chains[index]
    if (!chain) return 0
    chain.analyser.getFloatTimeDomainData(this.levelBuf)
    let sum = 0
    for (let i = 0; i < this.levelBuf.length; i++) sum += this.levelBuf[i] * this.levelBuf[i]
    return Math.sqrt(sum / this.levelBuf.length)
  }

  pitch(index: 0 | 1): PitchInfo | null {
    return this.chains[index]?.pitch ?? null
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
    for (const st of this.streams) st.getTracks().forEach((t) => t.stop())
    for (const c of this.chains) {
      if (!c) continue
      c.hpf.disconnect()
      c.worklet.disconnect()
      c.tap.disconnect()
      c.mute.disconnect()
      c.gain.disconnect()
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
    this.streams = []
    this.chains = [null, null]
  }

  async stop(): Promise<void> {
    this.stopInputs()
    await this.ctx.suspend()
  }
}
