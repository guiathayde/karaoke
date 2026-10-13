/* Cópia do microfone para o servidor (pontuação de letra): reamostra para 16 kHz e envia blocos de 100 ms. */
class TapProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / 16000
    this.phase = 0
    this.prev = 0
    this.buf = new Int16Array(1600)
    this.n = 0
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0]
    if (!input) return true
    for (let i = 0; i < input.length; i++) {
      const cur = input[i]
      while (this.phase < 1) {
        const v = this.prev + (cur - this.prev) * this.phase
        this.buf[this.n++] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)))
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf.buffer.slice(0))
          this.n = 0
        }
        this.phase += this.ratio
      }
      this.phase -= 1
      this.prev = cur
    }
    return true
  }
}

registerProcessor('tap', TapProcessor)
