import { useEffect, useRef, useState } from 'react'
import type { LyricEvent, State } from './types'

interface Progress {
  entry_id: string | null
  position: number
}

export function useSession() {
  const [state, setState] = useState<State | null>(null)
  const [connected, setConnected] = useState(false)
  const [progress, setProgress] = useState<Progress>({ entry_id: null, position: 0 })
  const [lyric, setLyric] = useState<LyricEvent | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    let ws: WebSocket | null = null
    let stopped = false
    let timer: number | undefined

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/ws`)
      ws.onopen = () => setConnected(true)
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as
          | { type: 'state'; state: State }
          | { type: 'progress'; entry_id: string | null; position: number }
          | ({ type: 'lyric' } & Omit<LyricEvent, 'seq'>)
        if (msg.type === 'state') setState(msg.state)
        else if (msg.type === 'progress') setProgress({ entry_id: msg.entry_id, position: msg.position })
        else if (msg.type === 'lyric') setLyric({ ...msg, seq: ++seq.current })
      }
      ws.onclose = () => {
        setConnected(false)
        if (!stopped) timer = window.setTimeout(connect, 1500)
      }
      ws.onerror = () => ws?.close()
    }
    connect()
    return () => {
      stopped = true
      window.clearTimeout(timer)
      ws?.close()
    }
  }, [])

  return { state, connected, progress, lyric }
}
