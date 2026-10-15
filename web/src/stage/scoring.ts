/* Pontuação estilo SingStar: compara o pitch cantado (detectado pelo autotune) com a melodia de referência. */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { MicEngine } from '../audio/engine'

export interface Melody {
  hop: number
  notes: number[] // midi por frame, 0 = sem voz
}

export interface TrailPoint {
  t: number
  midi: number
  mic: 0 | 1
}

export function midiOf(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440)
}

/** Leva `sung` para a oitava mais próxima de `ref` (pontuação ignora oitava). */
export function foldToRef(sung: number, ref: number): number {
  return sung + 12 * Math.round((ref - sung) / 12)
}

export function useScoring(
  engine: MicEngine | null,
  entryId: string,
  ytId: string,
  hasMelody: boolean,
  videoRef: RefObject<HTMLVideoElement | null>,
  resetKey = 0,
  keyShift = 0,
) {
  const [baseMelody, setMelody] = useState<Melody | null>(null)
  // melody.json é do tom original; com a variante de tom tocando, a referência sobe/desce junto
  const melody = useMemo<Melody | null>(
    () =>
      baseMelody && keyShift
        ? { hop: baseMelody.hop, notes: baseMelody.notes.map((n) => (n > 0 ? n + keyShift : 0)) }
        : baseMelody,
    [baseMelody, keyShift],
  )
  const [scores, setScores] = useState<[number, number]>([0, 0])
  const hits = useRef<[number, number]>([0, 0])
  const lastFrame = useRef<[number, number]>([-1, -1])
  const evaluated = useRef<[boolean, boolean]>([false, false])
  const trail = useRef<TrailPoint[]>([])

  useEffect(() => {
    setMelody(null)
    setScores([0, 0])
    hits.current = [0, 0]
    lastFrame.current = [-1, -1]
    evaluated.current = [false, false]
    trail.current = []
    if (!hasMelody) return
    let cancelled = false
    fetch(`/media/${ytId}/melody.json`)
      .then((r) => (r.ok ? (r.json() as Promise<Melody>) : null))
      .then((m) => {
        if (!cancelled && m && m.notes.length) setMelody(m)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [entryId, ytId, hasMelody, resetKey])

  useEffect(() => {
    if (!melody || !engine) return
    const voicedTotal = melody.notes.reduce((n, v) => n + (v > 0 ? 1 : 0), 0) || 1
    let ticks = 0
    const id = window.setInterval(() => {
      const v = videoRef.current
      if (!v || v.paused || v.ended) return
      const t = v.currentTime
      const frame = Math.floor(t / melody.hop)
      for (const mic of [0, 1] as const) {
        if (!engine.hasChain(mic) || frame === lastFrame.current[mic]) continue
        lastFrame.current[mic] = frame
        const ref = melody.notes[frame]
        const p = engine.pitch(mic)
        if (!p || p.conf < 0.6 || p.freq <= 0) continue
        const sung = midiOf(p.freq)
        if (!ref) {
          trail.current.push({ t, midi: sung, mic })
          continue
        }
        evaluated.current[mic] = true
        const folded = foldToRef(sung, ref)
        const d = Math.abs(folded - ref)
        hits.current[mic] += d <= 0.6 ? 1 : d <= 1.2 ? 0.5 : 0
        trail.current.push({ t, midi: folded, mic })
      }
      if (trail.current.length > 400) trail.current.splice(0, trail.current.length - 400)
      if (++ticks % 10 === 0) {
        setScores([
          Math.round((10000 * hits.current[0]) / voicedTotal),
          Math.round((10000 * hits.current[1]) / voicedTotal),
        ])
      }
    }, 50)
    return () => window.clearInterval(id)
  }, [melody, engine, videoRef])

  const activeMics = (engine ? ([0, 1] as const).filter((m) => engine.hasChain(m) && evaluated.current[m]) : []) as (0 | 1)[]
  return { melody, scores, trail, activeMics, scoring: melody !== null && Boolean(engine?.running) }
}
