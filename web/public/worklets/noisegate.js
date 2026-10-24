/* Supressão de ruído para um canal de microfone: expansor para baixo (noise gate) sem atraso.
 *
 * - Piso de ruído adaptativo: mínimo do nível médio de 20 ms numa janela de ~4 s (8 subjanelas de 0,5 s).
 *   Desce na hora; sobe até 4 dB/s com o portão fechado e só 0,5 dB/s com ele aberto, para uma frase
 *   longa sem respiro não ser tomada por ruído. Blocos em silêncio digital (receptor sem fio mudo)
 *   ficam de fora.
 * - O portão abre quando o nível de 5 ms passa do piso + margem e fecha 4 dB abaixo disso, depois de
 *   200 ms de espera. Fechado, atenua o canal (não emudece). A força (0..1) aumenta margem e atenuação;
 *   0 deixa o sinal passar, mas o piso continua sendo medido.
 * - Fica antes do pré-ganho, então mexer no boost não desloca o piso (os níveis relatados são do sinal
 *   cru; a engine soma o pré-ganho).
 * - Sem lookahead: não atrasa a voz nem o áudio da pontuação, que segue o relógio do vídeo.
 */

const SUBWINDOWS = 8
const SUBWINDOW_S = 0.5
const RISE_CLOSED_DB_PER_S = 4
const RISE_OPEN_DB_PER_S = 0.5
// níveis antes do pré-ganho (o sinal cru da Q-12 é bem baixo)
const SILENCE_DB = -140 // abaixo disso o bloco não entra no piso
const MIN_FLOOR_DB = -130
const HYSTERESIS_DB = 4

const dbToPow = (db) => Math.pow(10, db / 10)

class NoiseGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.sr = sampleRate
    this.levA = 1 - Math.exp(-1 / (0.005 * this.sr))
    this.attackA = 1 - Math.exp(-1 / (0.001 * this.sr))
    this.releaseA = 1 - Math.exp(-1 / (0.12 * this.sr))
    this.holdLen = Math.round(0.2 * this.sr)
    this.setStrength(0)

    // piso de ruído
    this.slow = -1 // potência média de ~20 ms; -1 = ainda sem medida
    this.slowA = 0
    this.blockLen = 0
    this.subMin = Infinity
    this.subCount = 0
    this.subLen = 0
    this.hist = new Array(SUBWINDOWS).fill(Infinity)
    this.hi = 0
    this.floor = null // dBFS antes do pré-ganho

    // portão
    this.lev = 0
    this.open = true
    this.hold = this.holdLen
    this.g = 1
    this.sinceReport = 0

    this.port.onmessage = (e) => {
      const m = e.data || {}
      if (typeof m.strength === 'number') this.setStrength(Math.max(0, Math.min(1, m.strength)))
    }
  }

  setStrength(s) {
    this.strength = s
    this.margin = 8 + 10 * s // dB acima do piso para abrir
    this.closedGain = s > 0 ? Math.pow(10, -(10 + 30 * s) / 20) : 1 // atenuação com o portão fechado
  }

  trackFloor(pow, n) {
    if (n !== this.blockLen) {
      const dt = n / this.sr
      this.blockLen = n
      this.slowA = 1 - Math.exp(-dt / 0.02)
      this.subLen = Math.max(1, Math.round(SUBWINDOW_S / dt))
      this.riseClosed = RISE_CLOSED_DB_PER_S * dt
      this.riseOpen = RISE_OPEN_DB_PER_S * dt
    }
    if (10 * Math.log10(pow + 1e-30) < SILENCE_DB) return
    this.slow = this.slow < 0 ? pow : this.slow + (pow - this.slow) * this.slowA
    const db = 10 * Math.log10(this.slow + 1e-30)
    if (db < this.subMin) this.subMin = db
    if (++this.subCount >= this.subLen) {
      this.hist[this.hi] = this.subMin
      this.hi = (this.hi + 1) % SUBWINDOWS
      this.subMin = Infinity
      this.subCount = 0
    }
    let est = this.subMin
    for (const h of this.hist) if (h < est) est = h
    if (this.floor === null || est < this.floor) this.floor = est
    else this.floor = Math.min(est, this.floor + (this.open ? this.riseOpen : this.riseClosed))
    if (this.floor < MIN_FLOOR_DB) this.floor = MIN_FLOOR_DB
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0]
    const out = outputs[0][0]
    if (!input) {
      out.fill(0)
      return true
    }
    const n = input.length
    let sum = 0
    for (let i = 0; i < n; i++) sum += input[i] * input[i]
    this.trackFloor(sum / n, n)

    const openDb = (this.floor ?? MIN_FLOOR_DB) + this.margin
    const openPow = dbToPow(openDb)
    const closePow = dbToPow(openDb - HYSTERESIS_DB)
    for (let i = 0; i < n; i++) {
      const x = input[i]
      this.lev += (x * x - this.lev) * this.levA
      if (this.lev > openPow) {
        this.open = true
        this.hold = this.holdLen
      } else if (this.open) {
        if (this.lev >= closePow) this.hold = this.holdLen
        else if (--this.hold <= 0) this.open = false
      }
      const target = this.open ? 1 : this.closedGain
      this.g += (target - this.g) * (target > this.g ? this.attackA : this.releaseA)
      out[i] = x * this.g
    }

    this.sinceReport += n
    if (this.sinceReport >= 2400) {
      this.sinceReport = 0
      this.port.postMessage({
        open: this.open,
        floor: this.floor,
        level: 10 * Math.log10(this.lev + 1e-30),
        gain: 20 * Math.log10(this.g),
      })
    }
    return true
  }
}

registerProcessor('noisegate', NoiseGateProcessor)
