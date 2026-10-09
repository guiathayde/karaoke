/* Faixa de melodia: notas de referência rolando e o pitch cantado por microfone. */
import { useEffect, useMemo, useRef, type RefObject } from 'react'
import type { Melody, TrailPoint } from './scoring'

const PAST = 1.5
const FUTURE = 3.5

export function PitchLane({
  melody,
  trail,
  videoRef,
  colors,
}: {
  melody: Melody
  trail: RefObject<TrailPoint[]>
  videoRef: RefObject<HTMLVideoElement | null>
  colors: [string, string]
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const range = useMemo(() => {
    const voiced = melody.notes.filter((n) => n > 0).sort((a, b) => a - b)
    if (!voiced.length) return { lo: 48, hi: 72 }
    const lo = voiced[Math.floor(voiced.length * 0.03)] - 2
    const hi = voiced[Math.floor(voiced.length * 0.97)] + 2
    return { lo, hi: Math.max(hi, lo + 12) }
  }, [melody])

  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const canvas = canvasRef.current
      const v = videoRef.current
      if (!canvas || !v) return
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr
        canvas.height = h * dpr
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const t = v.currentTime
      const t0 = t - PAST
      const xOf = (time: number) => ((time - t0) / (PAST + FUTURE)) * w
      const yOf = (midi: number) => h - 8 - ((midi - range.lo) / (range.hi - range.lo)) * (h - 16)
      const barH = Math.max(4, (h - 16) / (range.hi - range.lo))

      // notas de referência (segmentos contínuos)
      const f0 = Math.max(0, Math.floor(t0 / melody.hop))
      const f1 = Math.min(melody.notes.length - 1, Math.ceil((t + FUTURE) / melody.hop))
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      let i = f0
      while (i <= f1) {
        const n = melody.notes[i]
        if (!n) {
          i++
          continue
        }
        let j = i
        while (j + 1 <= f1 && melody.notes[j + 1] && Math.abs(melody.notes[j + 1] - n) < 0.6) j++
        const x1 = xOf(i * melody.hop)
        const x2 = xOf((j + 1) * melody.hop)
        const y = yOf(n)
        ctx.fillStyle = i * melody.hop <= t && (j + 1) * melody.hop >= t ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.35)'
        ctx.fillRect(x1, y - barH / 2, Math.max(2, x2 - x1 - 1), barH)
        i = j + 1
      }

      // pitch cantado
      for (const pt of trail.current) {
        if (pt.t < t0) continue
        ctx.fillStyle = colors[pt.mic]
        ctx.beginPath()
        ctx.arc(xOf(pt.t), yOf(pt.midi), 3.5, 0, Math.PI * 2)
        ctx.fill()
      }

      // linha do agora
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(xOf(t), 0)
      ctx.lineTo(xOf(t), h)
      ctx.stroke()
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [melody, trail, videoRef, colors, range])

  return <canvas ref={canvasRef} className="pitch-lane" />
}
