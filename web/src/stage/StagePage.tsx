import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MicEngine } from '../audio/engine'
import { api } from '../lib/api'
import {
  entryReady,
  fmtDuration,
  fmtPoints,
  guideFile,
  keyLabel,
  lineSinger,
  lyricBlocks,
  mediaFile,
  playingShift,
  singersOf,
  songKey,
  statusText,
} from '../lib/format'
import { useSession } from '../lib/useSession'
import type { LyricEvent, LyricLine, QueueEntry, Singer, Song, State } from '../lib/types'
import { MicPanel, MicStatus, loadMicConfig } from './MicPanel'
import { PitchLane } from './PitchLane'
import { useScoring } from './scoring'

const RESULTS_SECONDS = 8

export function StagePage() {
  const { state, connected, lyric } = useSession()
  const [started, setStarted] = useState(false)
  const [engine, setEngine] = useState<MicEngine | null>(null)
  const [showMics, setShowMics] = useState(false)
  const [liveScores, setLiveScores] = useState<[number, number] | null>(null)
  const [progress, setProgress] = useState<{ time: number; duration: number }>({ time: 0, duration: 0 })
  const [guideInfo, setGuideInfo] = useState<GuideInfo>({ available: false, ducked: false })
  const status = state?.player.status
  const audio = state?.audio
  const playing = state?.queue.find((e) => e.id === state.player.entry_id)
  const playingSong = playing ? state?.songs[playing.yt_id] : undefined
  const key = state && playing && playingSong ? songKey(playing, playingSong, state) : null
  const keyTonic = key?.tonic ?? null
  const keyScale = key?.scale ?? null

  useEffect(() => {
    if (!engine || !audio) return
    const k = keyTonic !== null && keyScale ? { tonic: keyTonic, scale: keyScale } : null
    engine.applyMic(0, audio.mics[0], k)
    engine.applyMic(1, audio.mics[1], k)
    engine.applyReverb(audio.reverb)
  }, [engine, audio, keyTonic, keyScale])

  const startStage = () => {
    setStarted(true)
    void toggleFullscreen(true)
    const eng = new MicEngine()
    setEngine(eng)
    const cfg = loadMicConfig()
    if (cfg.deviceA || cfg.mode !== 'mono') {
      void eng.start(cfg).catch(() => undefined)
    }
  }

  const togglePause = useCallback(() => {
    if (status === 'playing') void api('/api/player/pause', { method: 'POST' })
    else if (status === 'paused') void api('/api/player/play', { method: 'POST' })
  }, [status])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (e.code === 'Space') {
        e.preventDefault()
        togglePause()
      } else if (e.key === 'n') {
        void api('/api/player/next', { method: 'POST' })
      } else if (e.key === 'f') {
        void toggleFullscreen()
      } else if (e.key === 'm') {
        setShowMics((v) => !v)
      } else if (e.key === 'r') {
        void api('/api/player/restart', { method: 'POST' })
      } else if (e.key === 's' || e.key === 'Escape') {
        void api('/api/player/stop', { method: 'POST' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePause])

  if (!started) {
    return (
      <div className="stage-gate">
        <div>
          <h1>Karaokê</h1>
          <p className="muted">Clique para liberar o áudio e entrar em tela cheia.</p>
          <button className="primary" onClick={startStage}>
            Iniciar o palco
          </button>
          <p className="muted" style={{ marginTop: 24 }}>
            Atalhos: espaço pausa, R recomeça, S para, N pula, F tela cheia, M microfones
          </p>
        </div>
      </div>
    )
  }

  if (!state) {
    return (
      <div className="center">
        <p>Conectando ao servidor…</p>
      </div>
    )
  }

  const current = state.queue.find((e) => e.id === state.player.entry_id) ?? null
  const song = current ? state.songs[current.yt_id] : undefined

  return (
    <main className="stage">
      <section className="stage-main">
        {current && song && state.player.status === 'stopped' ? (
          <Stopped entry={current} song={song} state={state} />
        ) : current && song && entryReady(current, song, state) ? (
          <Player
            entry={current}
            song={song}
            state={state}
            engine={engine}
            onScores={setLiveScores}
            onProgress={setProgress}
            onGuide={setGuideInfo}
            lyric={lyric}
          />
        ) : current ? (
          <Preparing entry={current} song={song} state={state} />
        ) : (
          <Idle state={state} />
        )}
      </section>
      <aside className="stage-side">
        <JoinCard state={state} />
        <Transport state={state} progress={progress} guide={guideInfo} />
        <QueueList state={state} />
        <MicStatus engine={engine} audio={state.audio} scores={current ? liveScores : null} onOpen={() => setShowMics(true)} />
        {current && <ScoreStatus entry={current} state={state} lyric={lyric} />}
      </aside>
      {showMics && engine && (
        <MicPanel engine={engine} audio={state.audio} songKey={key} onClose={() => setShowMics(false)} />
      )}
      {!connected && <div className="toast">Reconectando ao servidor…</div>}
    </main>
  )
}

async function toggleFullscreen(enter?: boolean) {
  try {
    if (document.fullscreenElement && enter !== true) await document.exitFullscreen()
    else if (!document.fullscreenElement) await document.documentElement.requestFullscreen()
  } catch {
    /* navegador recusou: segue em janela */
  }
}

interface GuideInfo {
  available: boolean
  ducked: boolean
}

function Transport({
  state,
  progress,
  guide,
}: {
  state: State
  progress: { time: number; duration: number }
  guide: GuideInfo
}) {
  const st = state.player.status
  if (!state.player.entry_id) return null
  const g = state.audio.guide
  const guideText = !g.enabled
    ? 'desligada'
    : !guide.available
      ? 'sem voz separada'
      : guide.ducked
        ? `${g.volume}% · alguém cantando`
        : `${g.volume}%`
  const post = (path: string) => () => void api(path, { method: 'POST' })
  const pct = progress.duration ? Math.min(100, (progress.time / progress.duration) * 100) : 0
  return (
    <div className="transport">
      <div className="row">
        {st === 'playing' && (
          <button onClick={post('/api/player/pause')} title="Pausar (espaço)">
            ⏸
          </button>
        )}
        {(st === 'paused' || st === 'stopped') && (
          <button className="primary" onClick={post('/api/player/play')} title="Tocar (espaço)">
            ▶
          </button>
        )}
        <button onClick={post('/api/player/restart')} title="Recomeçar (R)" disabled={st === 'waiting'}>
          ⟲
        </button>
        <button onClick={post('/api/player/stop')} title="Parar (S)" disabled={st === 'stopped' || st === 'waiting'}>
          ⏹
        </button>
        <button onClick={post('/api/player/next')} title="Pular (N)">
          ⏭
        </button>
      </div>
      {st !== 'stopped' && st !== 'waiting' && (
        <>
          <div className="progress thin">
            <span style={{ width: `${pct}%` }} />
          </div>
          <div className="muted small">
            {fmtDuration(progress.time)} / {fmtDuration(progress.duration)}
          </div>
        </>
      )}
      <div className="muted small">
        Música: {state.audio.music.volume}% · Voz guia: {guideText}
      </div>
    </div>
  )
}

function Stopped({ entry, song, state }: { entry: QueueEntry; song: Song; state: State }) {
  const singers = singersOf(entry, state)
  return (
    <div className="stage-overlay">
      <div className="inner">
        {song.video.thumbnail && <img className="thumb" src={song.video.thumbnail} alt="" />}
        <h1>{song.video.title}</h1>
        <p>
          {singers.map((s) => (
            <span key={s.id}>
              <span className="dot" style={{ background: s.color }} />
              {s.name}{' '}
            </span>
          ))}
        </p>
        <p className="muted">Parada. Pronta para tocar do início.</p>
        <div className="row" style={{ justifyContent: 'center', gap: 12 }}>
          <button className="primary" onClick={() => void api('/api/player/play', { method: 'POST' })}>
            Tocar do início
          </button>
          <button onClick={() => void api('/api/player/next', { method: 'POST' })}>Pular</button>
        </div>
      </div>
    </div>
  )
}

function Player({
  entry,
  song,
  state,
  engine,
  onScores,
  onProgress,
  onGuide,
  lyric,
}: {
  entry: QueueEntry
  song: Song
  state: State
  engine: MicEngine | null
  onScores: (s: [number, number] | null) => void
  onProgress: (p: { time: number; duration: number }) => void
  onGuide: (g: GuideInfo) => void
  lyric: LyricEvent | null
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const guideRef = useRef<HTMLAudioElement>(null)
  const [time, setTime] = useState(0)
  const [blocked, setBlocked] = useState(false)
  const [results, setResults] = useState<ResultRow[] | null>(null)

  // o motor carimba o áudio dos microfones com o tempo do vídeo (pontuação de letra no servidor)
  useEffect(() => {
    if (!engine) return
    engine.timeSource = () => {
      const v = videoRef.current
      return v && !v.paused && !v.ended ? v.currentTime : null
    }
    return () => {
      engine.timeSource = null
    }
  }, [engine])
  const lastReport = useRef(0)
  const lastTime = useRef(0) // o src novo zera o currentTime antes do efeito rodar; guardamos a posição aqui
  const entryIdRef = useRef(entry.id)
  const endedRef = useRef(false)
  const media = mediaFile(entry, song, state)
  const src = `/media/${entry.yt_id}/${media.name}`
  const paused = state.player.status === 'paused'
  const singers = singersOf(entry, state)
  const restartId = state.player.restart_id
  const shift = playingShift(entry, song, state)
  const scoring = useScoring(engine, entry.id, entry.yt_id, song.has_melody, videoRef, restartId, shift)

  // autotune guiado: a melodia vai para o worklet no tom que está tocando
  useEffect(() => {
    if (!engine) return
    engine.setMelody(scoring.melody)
    return () => engine.setMelody(null)
  }, [engine, scoring.melody])
  const guideName = guideFile(entry, song)
  const guideSrc = guideName ? `/media/${entry.yt_id}/${guideName}` : null
  const guideCfg = state.audio.guide
  const musicVolume = state.audio.music.volume / 100

  // volume da música (o volume do elemento sobrevive à troca de src)
  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = musicVolume
  }, [musicVolume])

  // --- voz guia: mesmo arquivo de vocais, sincronizado com o vídeo ---
  useEffect(() => {
    const g = guideRef.current
    if (!g) return
    if (!guideSrc) {
      g.pause()
      g.removeAttribute('src')
      g.load()
      return
    }
    g.volume = 0
    g.src = guideSrc
    g.load()
    const onMeta = () => {
      const v = videoRef.current
      if (!v) return
      g.currentTime = v.currentTime
      if (!v.paused) void g.play().catch(() => undefined)
    }
    g.addEventListener('loadedmetadata', onMeta)
    return () => g.removeEventListener('loadedmetadata', onMeta)
  }, [guideSrc])

  const syncGuide = (hard = false) => {
    const g = guideRef.current
    const v = videoRef.current
    if (!g || !v || !guideSrc || !g.duration) return
    const diff = g.currentTime - v.currentTime
    if (hard || Math.abs(diff) > 0.3) {
      g.currentTime = v.currentTime
      g.playbackRate = 1
    } else {
      g.playbackRate = Math.abs(diff) > 0.05 ? (diff > 0 ? 0.98 : 1.02) : 1
    }
  }

  // abaixa a voz guia quando alguém canta; volta devagar quando o microfone fica em silêncio
  useEffect(() => {
    const g = guideRef.current
    if (!g) return
    let lastActive = 0
    let lastDucked: boolean | null = null
    const id = window.setInterval(() => {
      const now = Date.now()
      if (engine?.running && engine.voiceActive()) lastActive = now
      const ducked = guideCfg.duck && now - lastActive < 1000
      const target = guideCfg.enabled && guideSrc ? (ducked ? 0 : (guideCfg.volume / 100) * musicVolume) : 0
      const cur = g.volume
      const step = target < cur ? 0.08 : 0.025
      g.volume = Math.abs(target - cur) <= step ? target : cur + Math.sign(target - cur) * step
      if (lastDucked !== ducked) {
        lastDucked = ducked
        onGuide({ available: Boolean(guideSrc), ducked })
      }
    }, 40)
    return () => window.clearInterval(id)
  }, [engine, guideCfg.enabled, guideCfg.volume, guideCfg.duck, guideSrc, musicVolume, onGuide])

  useEffect(() => {
    onScores(scoring.scoring ? scoring.scores : null)
  }, [scoring.scoring, scoring.scores, onScores])

  // troca de arquivo (nova música ou variante de tom) mantendo a posição quando é a mesma música
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const same = entryIdRef.current === entry.id
    const pos = same ? lastTime.current : 0 // lido ANTES de trocar o src (a troca zera o tempo e dispara timeupdate)
    lastTime.current = pos
    entryIdRef.current = entry.id
    endedRef.current = false
    setResults(null)
    v.src = src
    v.load()
    const onMeta = () => {
      if (pos > 0) v.currentTime = pos
      v.removeEventListener('loadedmetadata', onMeta)
    }
    v.addEventListener('loadedmetadata', onMeta)
    setTime(pos)
    return () => v.removeEventListener('loadedmetadata', onMeta)
  }, [src, entry.id])

  // recomeçar: volta ao início (ignora a primeira execução, que é a montagem)
  const firstRestart = useRef(restartId)
  useEffect(() => {
    const v = videoRef.current
    if (!v || restartId === firstRestart.current) return
    firstRestart.current = restartId
    v.currentTime = 0
    lastTime.current = 0
    setTime(0)
    endedRef.current = false
    setResults(null)
    void v.play().catch(() => undefined)
  }, [restartId])

  useEffect(() => {
    const v = videoRef.current
    if (!v || results) return
    if (paused) {
      v.pause()
      return
    }
    v.play()
      .then(() => setBlocked(false))
      .catch(() => setBlocked(true))
  }, [paused, src, results])

  const finish = useCallback(() => {
    if (endedRef.current) return
    endedRef.current = true
    guideRef.current?.pause()
    const mics = scoring.scoring ? scoring.activeMics : []
    const pitch = Object.fromEntries(mics.map((mic) => [mic + 1, scoring.scores[mic]]))
    // o servidor junta afinação (daqui) com letra (dele) por cantor
    api<{ score_details: Record<string, { pitch?: number; lyrics?: number; total: number }> }>('/api/player/finish', {
      body: { scores: pitch },
    })
      .then((res) => {
        const rows = Object.entries(res.score_details ?? {}).map(([who, d]) => ({ who, ...d }))
        if (rows.length === 0) {
          void api('/api/player/ended', { method: 'POST' })
          return
        }
        setResults(rows)
        window.setTimeout(() => void api('/api/player/ended', { method: 'POST' }), RESULTS_SECONDS * 1000)
      })
      .catch(() => void api('/api/player/ended', { method: 'POST' }))
  }, [scoring])

  const onTimeUpdate = () => {
    const v = videoRef.current
    if (!v) return
    setTime(v.currentTime)
    lastTime.current = v.currentTime
    syncGuide()
    const now = Date.now()
    if (now - lastReport.current > 1000) {
      lastReport.current = now
      onProgress({ time: v.currentTime, duration: v.duration || 0 })
      void api('/api/player/progress', { body: { position: v.currentTime } }).catch(() => undefined)
    }
  }

  const colors: [string, string] = [
    state.singers.find((s) => s.mic === 1)?.color ?? '#ff5c8a',
    state.singers.find((s) => s.mic === 2)?.color ?? '#38bdf8',
  ]

  return (
    <>
      <video
        ref={videoRef}
        playsInline
        onTimeUpdate={onTimeUpdate}
        onEnded={finish}
        onError={finish}
        onPlay={() => {
          syncGuide(true)
          void guideRef.current?.play().catch(() => undefined)
        }}
        onPause={() => guideRef.current?.pause()}
        onSeeked={() => syncGuide(true)}
      />
      <audio ref={guideRef} preload="auto" />
      {scoring.melody && (
        <PitchLane melody={scoring.melody} trail={scoring.trail} videoRef={videoRef} colors={colors} />
      )}
      {song.lyrics && <Lyrics lines={song.lyrics} time={time} entry={entry} singers={singers} />}
      <LyricPop entry={entry} state={state} lyric={lyric} />
      {media.pending && <div className="toast">Preparando {keyLabel(entry.key_shift)}…</div>}
      {paused && (
        <div className="stage-overlay paused">
          <div className="inner">
            <h1>Pausado</h1>
            <p>{song.video.title}</p>
          </div>
        </div>
      )}
      {blocked && !paused && !results && (
        <div className="stage-overlay">
          <div className="inner">
            <h1>Clique para tocar</h1>
            <button className="primary" onClick={() => videoRef.current?.play()}>
              Tocar
            </button>
          </div>
        </div>
      )}
      {results && <Results results={results} state={state} />}
    </>
  )
}

interface ResultRow {
  who: string
  pitch?: number
  lyrics?: number
  total: number
}

function whoLabel(who: string, state: State): { name: string; color: string } {
  const singer = state.singers.find((s) => s.id === who)
  if (singer) return { name: singer.name, color: singer.color }
  return { name: who.replace('mic', 'Mic '), color: '#fff' }
}

function Results({ results, state }: { results: ResultRow[]; state: State }) {
  const sorted = [...results].sort((a, b) => b.total - a.total)
  return (
    <div className="stage-overlay results">
      <div className="inner">
        <h1>Resultado</h1>
        {sorted.map((r, i) => {
          const who = whoLabel(r.who, state)
          return (
            <div key={r.who} className="result-row" style={{ color: who.color }}>
              <span className="pos">{i + 1}º</span>
              <span className="name">
                {who.name}
                <span className="parts">
                  {r.pitch !== undefined ? `afinação ${fmtPoints(r.pitch)}` : ''}
                  {r.pitch !== undefined && r.lyrics !== undefined ? ' · ' : ''}
                  {r.lyrics !== undefined ? `letra ${fmtPoints(r.lyrics)}` : ''}
                </span>
              </span>
              <span className="pts">{fmtPoints(r.total)}</span>
            </div>
          )
        })}
        <p className="muted">{verdict(sorted[0]?.total ?? 0)}</p>
      </div>
    </div>
  )
}

/** "+80 letra" ao lado da letra quando o servidor avalia uma linha. */
function LyricPop({ entry, state, lyric }: { entry: QueueEntry; state: State; lyric: LyricEvent | null }) {
  const [shown, setShown] = useState<LyricEvent | null>(null)
  useEffect(() => {
    if (!lyric || lyric.entry_id !== entry.id) return
    setShown(lyric)
    const id = window.setTimeout(() => setShown((cur) => (cur?.seq === lyric.seq ? null : cur)), 1800)
    return () => window.clearTimeout(id)
  }, [lyric, entry.id])
  if (!shown) return null
  const who = whoLabel(shown.singer_id, state)
  const pts = Math.round(shown.score * 100)
  return (
    <div className="lyric-pop" style={{ color: who.color }}>
      {pts > 0 ? `+${pts}` : '0'} letra · {who.name}
    </div>
  )
}

/** Painel lateral: afinação e letra por cantor durante a música. */
function ScoreStatus({ entry, state, lyric }: { entry: QueueEntry; state: State; lyric: LyricEvent | null }) {
  const totals = lyric && lyric.entry_id === entry.id ? lyric.totals : {}
  const singers = singersOf(entry, state)
  if (singers.length === 0 || Object.keys(totals).length === 0) return null
  return (
    <div>
      <h2>Letra</h2>
      {singers.map((s) => (
        <div key={s.id} className="mic-row">
          <span style={{ color: s.color }}>{s.name}</span>
          <div />
          <span className="muted">{totals[s.id] !== undefined ? fmtPoints(totals[s.id]) : '–'}</span>
        </div>
      ))}
    </div>
  )
}

function verdict(points: number): string {
  if (points >= 8500) return 'Estrela do karaokê!'
  if (points >= 7000) return 'Mandou muito bem!'
  if (points >= 5000) return 'Boa! Afinação na média.'
  if (points >= 2500) return 'Foi na emoção.'
  return 'O importante é se divertir.'
}

function Lyrics({
  lines,
  time,
  entry,
  singers,
}: {
  lines: LyricLine[]
  time: number
  entry: QueueEntry
  singers: Singer[]
}) {
  const blocks = useMemo(() => lyricBlocks(lines), [lines])
  const idx = useMemo(() => {
    let i = -1
    for (let k = 0; k < lines.length; k++) {
      if (lines[k].t <= time + 0.15) i = k
      else break
    }
    return i
  }, [lines, time])
  const duet = entry.singer_ids.length >= 2 && singers.length >= 2
  const style = (i: number) => {
    if (!duet || i < 0 || i >= lines.length) return undefined
    const who = lineSinger(entry, blocks, i)
    return who === null ? undefined : { color: singers[who].color }
  }
  const tag = (i: number) => {
    if (!duet || i < 0) return null
    const who = lineSinger(entry, blocks, i)
    return who === null ? null : singers[who].name
  }
  const prev = idx > 0 ? lines[idx - 1] : null
  const cur = idx >= 0 ? lines[idx] : null
  const next = lines[idx + 1] ?? null
  return (
    <div className="lyrics">
      <div className="prev" style={style(idx - 1)}>
        {prev?.text}
      </div>
      {duet && cur && <div className="singer-tag" style={style(idx)}>{tag(idx)}</div>}
      <div className="cur" style={style(idx)}>
        {cur ? cur.text || '♪' : '♪'}
      </div>
      <div className="next" style={style(idx + 1)}>
        {next?.text}
      </div>
    </div>
  )
}

function Preparing({ entry, song, state }: { entry: QueueEntry; song: Song | undefined; state: State }) {
  const singers = singersOf(entry, state)
  const text = statusText(song, entry, state)
  const isError = song?.status === 'error'
  const showBar = song && ['downloading', 'separating'].includes(song.status)
  return (
    <div className="stage-overlay">
      <div className="inner">
        {song?.video.thumbnail && <img className="thumb" src={song.video.thumbnail} alt="" />}
        <h1>{song?.video.title ?? 'Preparando…'}</h1>
        {singers.length > 0 && (
          <p>
            {singers.map((s) => (
              <span key={s.id}>
                <span className="dot" style={{ background: s.color }} />
                {s.name}{' '}
              </span>
            ))}
          </p>
        )}
        <p style={{ color: isError ? 'var(--err)' : undefined }}>{text}</p>
        {!isError && song?.status !== 'separating' && (
          <p className="muted">
            A música é preparada antes de tocar: baixamos o vídeo e a IA separa a voz do instrumental.
          </p>
        )}
        {isError && <p className="muted">O anfitrião pode pular esta música (tecla N ou pelo celular).</p>}
        {showBar && (
          <div className="progress">
            <span style={{ width: `${Math.round((song?.progress ?? 0) * 100)}%` }} />
          </div>
        )}
      </div>
    </div>
  )
}

function Idle({ state }: { state: State }) {
  return (
    <div className="stage-overlay">
      <div className="inner">
        <h1>Karaokê</h1>
        <p>Escaneie o QR code para entrar e escolher uma música</p>
        <img className="qr-big" src="/api/qr.svg" alt="QR code para entrar" />
        <p className="muted">{state.session.join_url}</p>
      </div>
    </div>
  )
}

function JoinCard({ state }: { state: State }) {
  return (
    <div className="join-card">
      <h2>Entrar</h2>
      <img src="/api/qr.svg" alt="QR code para entrar" />
      <div className="url">{state.session.join_url}</div>
    </div>
  )
}

function QueueList({ state }: { state: State }) {
  const items = state.queue.slice(0, 8)
  return (
    <div>
      <h2>Fila</h2>
      {items.length === 0 && <p className="muted">Ninguém escolheu uma música ainda.</p>}
      <ol className="queue-list">
        {items.map((entry, i) => {
          const song = state.songs[entry.yt_id]
          const singers = singersOf(entry, state)
          const ready = entryReady(entry, song, state)
          const isCurrent = entry.id === state.player.entry_id
          return (
            <li key={entry.id}>
              <span className="n">{isCurrent ? '▶' : i + 1}</span>
              <div>
                <div className="title">{song?.video.title ?? entry.yt_id}</div>
                <div className="sub">
                  {singers.map((s) => (
                    <span key={s.id}>
                      <span className="dot" style={{ background: s.color }} />
                      {s.name}{' '}
                    </span>
                  ))}
                  {song?.video.duration ? `· ${fmtDuration(song.video.duration)} ` : ''}
                  {entry.key_shift !== 0 && <span className="badge">{keyLabel(entry.key_shift)}</span>}{' '}
                  {!ready && !isCurrent && (
                    <span className={`badge ${song?.status === 'error' ? 'err' : 'warn'}`}>
                      {song?.status === 'error' ? 'erro' : 'preparando'}
                    </span>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
