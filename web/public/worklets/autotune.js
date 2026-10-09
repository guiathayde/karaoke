/* Autotune em tempo real para um canal de microfone.
 *
 * - Detecção de pitch: YIN sobre o sinal decimado para sr/2 (janela 512, 70–1000 Hz), a cada 256 amostras.
 * - Correção: a nota detectada é levada para a nota mais próxima da escala escolhida; a força (0..1)
 *   decide quanto do desvio é corrigido e a velocidade (s) suaviza a transição.
 * - Pitch shift: linha de atraso com duas leituras cruzadas (grão sincronizado com o período),
 *   latência média de meio grão (~5–10 ms).
 */

class Yin {
  constructor(sampleRate, windowSize, minFreq, maxFreq) {
    this.sr = sampleRate
    this.w = windowSize
    this.tauMin = Math.floor(sampleRate / maxFreq)
    this.tauMax = Math.ceil(sampleRate / minFreq)
    this.d = new Float32Array(this.tauMax + 1)
    this.threshold = 0.15
    this.needed = this.w + this.tauMax + 1
  }

  detect(x) {
    const d = this.d
    const w = this.w
    let running = 0
    d[0] = 1
    for (let tau = 1; tau <= this.tauMax; tau++) {
      let sum = 0
      for (let j = 0; j < w; j++) {
        const diff = x[j] - x[j + tau]
        sum += diff * diff
      }
      running += sum
      d[tau] = running === 0 ? 1 : (sum * tau) / running
    }
    let best = -1
    let bestVal = 1
    for (let tau = this.tauMin; tau <= this.tauMax; tau++) {
      if (d[tau] < this.threshold) {
        while (tau + 1 <= this.tauMax && d[tau + 1] < d[tau]) tau++
        best = tau
        bestVal = d[tau]
        break
      }
    }
    if (best < 0) {
      for (let tau = this.tauMin; tau <= this.tauMax; tau++) {
        if (d[tau] < bestVal) {
          bestVal = d[tau]
          best = tau
        }
      }
      if (bestVal > 0.5) return { freq: 0, confidence: 0 }
    }
    let t = best
    if (t > 1 && t < this.tauMax) {
      const s0 = d[t - 1]
      const s1 = d[t]
      const s2 = d[t + 1]
      const denom = 2 * (2 * s1 - s2 - s0)
      if (denom !== 0) t += (s2 - s0) / denom
    }
    return { freq: this.sr / t, confidence: 1 - bestVal }
  }
}

const RING = 8192
const MASK = RING - 1

class AutotuneProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.sr = sampleRate
    this.ring = new Float32Array(RING)
    this.wp = 0
    this.yin = new Yin(this.sr / 2, 512, 70, 1000)
    this.detBuf = new Float32Array(this.yin.needed)
    this.hop = 256
    this.sinceDet = 0

    // configuração (via port)
    this.enabled = true
    this.strength = 1
    this.speed = 0.02
    this.mask = new Array(12).fill(true)
    this.gate = 0.01

    // estado
    this.targetShift = 0
    this.curShift = 0
    this.alpha = 1 - Math.exp(-1 / (this.speed * this.sr))
    this.period = 0
    this.freq = 0
    this.conf = 0
    this.rms = 0
    this.grain = 512
    this.phase = 0
    this.sinceReport = 0

    this.port.onmessage = (e) => {
      const m = e.data || {}
      if (typeof m.enabled === 'boolean') this.enabled = m.enabled
      if (typeof m.strength === 'number') this.strength = Math.max(0, Math.min(1, m.strength))
      if (typeof m.speed === 'number') {
        this.speed = Math.max(0.001, m.speed)
        this.alpha = 1 - Math.exp(-1 / (this.speed * this.sr))
      }
      if (Array.isArray(m.mask) && m.mask.length === 12) this.mask = m.mask.map(Boolean)
      if (typeof m.gate === 'number') this.gate = m.gate
    }
  }

  nearestAllowed(midi) {
    const r = Math.round(midi)
    for (let k = 0; k < 12; k++) {
      if (this.mask[((r + k) % 12 + 12) % 12]) {
        const up = r + k
        const down = r - k
        if (k === 0) return r
        if (this.mask[((r - k) % 12 + 12) % 12]) return Math.abs(up - midi) <= Math.abs(down - midi) ? up : down
        return up
      }
      if (this.mask[((r - k) % 12 + 12) % 12]) return r - k
    }
    return r
  }

  detect() {
    // decima por 2 as últimas `needed*2` amostras do anel
    const n = this.yin.needed
    let idx = (this.wp - n * 2) & MASK
    let energy = 0
    for (let i = 0; i < n; i++) {
      const a = this.ring[idx]
      const b = this.ring[(idx + 1) & MASK]
      const v = 0.5 * (a + b)
      this.detBuf[i] = v
      energy += v * v
      idx = (idx + 2) & MASK
    }
    this.rms = Math.sqrt(energy / n)
    if (this.rms < this.gate) {
      this.conf = 0
      this.freq = 0
      this.targetShift = 0
      return
    }
    const { freq, confidence } = this.yin.detect(this.detBuf)
    this.conf = confidence
    if (confidence < 0.6 || freq <= 0) {
      this.freq = 0
      this.targetShift = 0
      return
    }
    this.freq = freq
    this.period = this.sr / freq
    this.grain = Math.max(384, Math.min(1024, Math.round(2 * this.period)))
    const midi = 69 + 12 * Math.log2(freq / 440)
    const target = this.nearestAllowed(midi)
    let diff = target - midi
    if (diff > 2.5) diff = 2.5
    if (diff < -2.5) diff = -2.5
    this.targetShift = this.strength * diff
  }

  readAt(delay) {
    // leitura interpolada `delay` amostras atrás do ponteiro de escrita
    const pos = this.wp - 1 - delay
    const i0 = Math.floor(pos)
    const frac = pos - i0
    const a = this.ring[i0 & MASK]
    const b = this.ring[(i0 + 1) & MASK]
    return a + (b - a) * frac
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0]
    const out = outputs[0][0]
    if (!input) {
      out.fill(0)
      return true
    }
    const n = input.length
    for (let i = 0; i < n; i++) {
      this.ring[this.wp] = input[i]
      this.wp = (this.wp + 1) & MASK
      if (++this.sinceDet >= this.hop) {
        this.sinceDet = 0
        this.detect()
      }
      if (!this.enabled || this.strength <= 0) {
        this.curShift = 0
        this.phase = 0
        out[i] = input[i]
        continue
      }
      this.curShift += (this.targetShift - this.curShift) * this.alpha
      const ratio = Math.pow(2, this.curShift / 12)
      const g = this.grain
      this.phase += (1 - ratio) / g
      if (this.phase >= 1) this.phase -= 1
      else if (this.phase < 0) this.phase += 1
      const pA = this.phase
      const pB = pA + 0.5 >= 1 ? pA - 0.5 : pA + 0.5
      const sA = Math.sin(Math.PI * pA)
      const wA = sA * sA
      out[i] = wA * this.readAt(pA * g) + (1 - wA) * this.readAt(pB * g)
    }
    this.sinceReport += n
    if (this.sinceReport >= 2400) {
      this.sinceReport = 0
      this.port.postMessage({ freq: this.freq, conf: this.conf, shift: this.curShift, rms: this.rms })
    }
    return true
  }
}

registerProcessor('autotune', AutotuneProcessor)
