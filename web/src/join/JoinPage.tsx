import { useEffect, useRef, useState, type FormEvent } from 'react'
import { KEY_NAMES } from '../audio/engine'
import { PRESETS, presetOf } from '../audio/presets'
import { api, ApiError, getSingerId, getToken, saveIdentity } from '../lib/api'
import { entryReady, fmtDuration, fmtPoints, keyLabel, keyText, singersOf, songKey, statusText } from '../lib/format'
import { useSession } from '../lib/useSession'
import type {
  GuideSettings,
  LibraryData,
  LibraryWhere,
  MicSettings,
  MusicSettings,
  QueueEntry,
  ReverbSettings,
  SearchResult,
  Singer,
  SongKey,
  State,
  Video,
} from '../lib/types'

type Tab = 'buscar' | 'fila' | 'eu'

export function JoinPage() {
  const { state, connected, progress } = useSession()
  const [singerId, setSingerId] = useState<string | null>(getSingerId())
  const [tab, setTab] = useState<Tab>('buscar')
  const [toast, setToast] = useState<string | null>(null)
  const me = state?.singers.find((s) => s.id === singerId)

  // Se o servidor não reconhece mais este aparelho (reiniciou), volta para o formulário.
  // Confere pela API, porque logo após entrar o estado via WebSocket pode ainda não ter o cantor.
  useEffect(() => {
    if (!state || !singerId || me) return
    let cancelled = false
    api<{ me: Singer | null }>('/api/state')
      .then((res) => {
        if (!cancelled && !res.me) {
          saveIdentity(null, null)
          setSingerId(null)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [state, singerId, me])

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 2500)
    return () => window.clearTimeout(t)
  }, [toast])

  if (!state) {
    return (
      <main className="center">
        <p>Conectando…</p>
      </main>
    )
  }

  if (!me) {
    return (
      <JoinForm
        onJoined={(singer, token) => {
          saveIdentity(token, singer.id)
          setSingerId(singer.id)
        }}
      />
    )
  }

  return (
    <main className="join">
      <NowPlaying state={state} me={me} progress={progress} onMsg={(t) => setToast(t)} />
      {/* As três seções ficam sempre montadas: no celular as abas escondem as inativas (CSS),
          no computador aparecem lado a lado. Assim a busca não perde os resultados ao trocar de aba. */}
      <div className={`panel panel-search ${tab === 'buscar' ? '' : 'mobile-hidden'}`}>
        <h2 className="panel-title">Buscar</h2>
        <Search state={state} me={me} onAdded={(t) => setToast(t)} />
        <Library state={state} me={me} onMsg={(t) => setToast(t)} />
      </div>
      <div className={`panel panel-queue ${tab === 'fila' ? '' : 'mobile-hidden'}`}>
        <h2 className="panel-title">Fila ({state.queue.length})</h2>
        <Queue state={state} me={me} onMsg={(t) => setToast(t)} />
      </div>
      <div className={`panel panel-me ${tab === 'eu' ? '' : 'mobile-hidden'}`}>
        <h2 className="panel-title">Você</h2>
        <Me state={state} me={me} onMsg={(t) => setToast(t)} />
      </div>
      <nav className="tabs">
        <button className={tab === 'buscar' ? 'active' : ''} onClick={() => setTab('buscar')}>
          Buscar
        </button>
        <button className={tab === 'fila' ? 'active' : ''} onClick={() => setTab('fila')}>
          Fila ({state.queue.length})
        </button>
        <button className={tab === 'eu' ? 'active' : ''} onClick={() => setTab('eu')}>
          {me.name}
        </button>
      </nav>
      {toast && <div className="toast">{toast}</div>}
      {!connected && <div className="toast">Reconectando…</div>}
    </main>
  )
}

function JoinForm({ onJoined }: { onJoined: (singer: Singer, token: string) => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await api<{ singer: Singer; token: string }>('/api/join', { body: { name: name.trim() } })
      onJoined(res.singer, res.token)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao entrar')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="center">
      <form onSubmit={submit} style={{ width: '100%', maxWidth: 360 }}>
        <h1>Karaokê</h1>
        <p className="muted">Como você quer aparecer na tela?</p>
        <input
          type="text"
          placeholder="Seu nome"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          autoFocus
        />
        {error && <p className="error">{error}</p>}
        <button className="primary" style={{ width: '100%', marginTop: 12 }} disabled={busy || !name.trim()}>
          Entrar
        </button>
      </form>
    </main>
  )
}

function NowPlaying({
  state,
  me,
  progress,
  onMsg,
}: {
  state: State
  me: Singer
  progress: { entry_id: string | null; position: number }
  onMsg: (msg: string) => void
}) {
  const current = state.queue.find((e) => e.id === state.player.entry_id)
  if (!current) {
    return (
      <div className="card now">
        <div className="title">Nada tocando</div>
        <div className="sub">Busque uma música e adicione à fila.</div>
      </div>
    )
  }
  const song = state.songs[current.yt_id]
  const singers = singersOf(current, state)
  const ready = entryReady(current, song, state)
  const st = state.player.status
  const canControl = me.is_host || current.singer_ids.includes(me.id)
  const position = progress.entry_id === current.id ? progress.position : state.player.position
  const label =
    st === 'paused' ? 'pausado' : st === 'stopped' ? 'parada' : ready ? 'tocando' : statusText(song, current, state)
  const post = (path: string) => () =>
    api(path, { method: 'POST' }).catch((err) => onMsg(err instanceof ApiError ? err.message : 'Falha'))
  return (
    <div className="card now">
      <div className="title">{song?.video.title ?? current.yt_id}</div>
      <div className="sub">
        {singers.map((s) => s.name).join(' e ') || 'sem cantor'} · {label}
        {current.key_shift !== 0 ? ` · ${keyLabel(current.key_shift)}` : ''}
        {(st === 'playing' || st === 'paused') && song?.video.duration
          ? ` · ${fmtDuration(position)} / ${fmtDuration(song.video.duration)}`
          : ''}
      </div>
      {canControl && ready && (
        <div className="controls">
          {st === 'playing' && <button onClick={post('/api/player/pause')}>Pausar</button>}
          {st === 'paused' && (
            <button className="primary" onClick={post('/api/player/play')}>
              Continuar
            </button>
          )}
          {st === 'stopped' && (
            <button className="primary" onClick={post('/api/player/play')}>
              Tocar do início
            </button>
          )}
          {st !== 'stopped' && <button onClick={post('/api/player/restart')}>Recomeçar</button>}
          {st !== 'stopped' && <button onClick={post('/api/player/stop')}>Parar</button>}
          <button onClick={post('/api/player/next')}>Pular</button>
        </div>
      )}
      {canControl && !ready && (
        <div className="controls">
          <button onClick={post('/api/player/next')}>Pular</button>
        </div>
      )}
    </div>
  )
}

const WHERE_LABEL: Record<LibraryWhere, { text: string; cls: string }> = {
  local: { text: 'no Mac', cls: 'ok' },
  drive: { text: 'processada no Colab', cls: 'ok' },
  requested: { text: 'pedida ao Colab', cls: 'warn' },
}

async function addToQueue(video: Video, isKaraoke: boolean, onMsg: (msg: string) => void) {
  try {
    await api<QueueEntry>('/api/queue', { body: { video, is_karaoke_version: isKaraoke } })
    onMsg('Adicionada à fila')
  } catch (err) {
    onMsg(err instanceof Error ? err.message : 'Falha ao adicionar')
  }
}

function Search({ state, me, onAdded }: { state: State; me: Singer; onAdded: (msg: string) => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [karaoke, setKaraoke] = useState<Record<string, boolean>>({})
  const [adding, setAdding] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!q.trim()) return
    setBusy(true)
    setError(null)
    try {
      setResults(await api<SearchResult[]>(`/api/search?q=${encodeURIComponent(q.trim())}`))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Busca falhou')
    } finally {
      setBusy(false)
    }
  }

  const add = async (video: Video) => {
    setAdding(video.yt_id)
    await addToQueue(video, Boolean(karaoke[video.yt_id]), onAdded)
    setAdding(null)
  }

  const request = async (r: SearchResult) => {
    const { library: _where, ...video } = r
    try {
      await api('/api/requests', { body: { video, is_karaoke_version: Boolean(karaoke[r.yt_id]) } })
      setResults((list) => list.map((x) => (x.yt_id === r.yt_id ? { ...x, library: 'requested' } : x)))
      onAdded('Pedida ao Colab')
    } catch (err) {
      onAdded(err instanceof Error ? err.message : 'Falha ao pedir')
    }
  }

  const inQueue = new Set(state.queue.map((e) => e.yt_id))

  return (
    <section className="card">
      <form onSubmit={submit} className="row">
        <input
          type="search"
          placeholder="Música, artista ou link do YouTube"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="primary" disabled={busy || !q.trim()}>
          {busy ? '…' : 'Buscar'}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {!state.separation_enabled && (
        <p className="muted">Separação de voz desligada neste servidor: os vídeos tocam com a voz original.</p>
      )}
      <ul className="results">
        {results.map((v) => (
          <li className="result" key={v.yt_id}>
            <img src={v.thumbnail ?? ''} alt="" loading="lazy" />
            <div>
              <div className="title">{v.title}</div>
              <div className="sub">
                {v.channel} {v.duration ? `· ${fmtDuration(v.duration)}` : ''}
              </div>
              {v.library && <span className={`badge ${WHERE_LABEL[v.library].cls}`}>{WHERE_LABEL[v.library].text}</span>}
            </div>
            <div className="actions">
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(karaoke[v.yt_id])}
                  onChange={(e) => setKaraoke({ ...karaoke, [v.yt_id]: e.target.checked })}
                />
                Já é versão karaokê
              </label>
              <div className="row">
                {me.is_host && v.library === null && (
                  <button onClick={() => request(v)} title="Processar no Colab (GPU) e importar depois">
                    Pedir ao Colab
                  </button>
                )}
                <button className="primary" disabled={adding === v.yt_id} onClick={() => add(v)}>
                  {inQueue.has(v.yt_id) ? 'Adicionar de novo' : 'Adicionar'}
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

type LibraryTab = 'local' | 'drive' | 'requests'

/** O que já existe: músicas no Mac, processadas no Colab (catálogo dos pacotes) e pedidos ao Colab. */
function Library({ state, me, onMsg }: { state: State; me: Singer; onMsg: (msg: string) => void }) {
  const [data, setData] = useState<LibraryData | null>(null)
  const [tab, setTab] = useState<LibraryTab>('local')
  const [filter, setFilter] = useState('')
  const [text, setText] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let cancelled = false
    api<LibraryData>('/api/library')
      .then((d) => !cancelled && setData(d))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [state.library_rev])

  if (!data) return null
  const f = filter.trim().toLocaleLowerCase()
  const match = (title: string, channel: string) => !f || `${title} ${channel}`.toLocaleLowerCase().includes(f)
  const inQueue = new Set(state.queue.map((e) => e.yt_id))

  // texto para colar no SONGS do notebook (ou salvar como MyDrive/karaoke/pedidos.txt)
  const loadText = async () => {
    try {
      const res = await fetch('/api/requests.txt', { headers: { 'X-Singer-Token': getToken() ?? '' } })
      if (!res.ok) throw new Error('Falha ao gerar a lista')
      const t = await res.text()
      setText(t)
      return t
    } catch (err) {
      onMsg(err instanceof Error ? err.message : 'Falha')
      return null
    }
  }
  const copy = async () => {
    const t = await loadText()
    if (t === null) return
    try {
      await navigator.clipboard.writeText(t)
      onMsg('Lista copiada: cole no SONGS do notebook')
    } catch {
      // http na rede local não é contexto seguro: a lista fica selecionada para copiar à mão
      window.setTimeout(() => {
        textRef.current?.select()
        textRef.current?.setSelectionRange(0, t.length) // o Safari do iPhone ignora o select()
      }, 0)
      onMsg('Selecione o texto abaixo e copie')
    }
  }
  const download = async () => {
    const t = await loadText()
    if (t === null) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([t], { type: 'text/plain' }))
    a.download = 'pedidos.txt'
    a.click()
    URL.revokeObjectURL(a.href)
  }
  const removeRequest = (ytId: string) =>
    api(`/api/requests/${ytId}`, { method: 'DELETE' }).catch((err) => onMsg(err instanceof Error ? err.message : 'Falha'))

  const deleteSong = async (ytId: string) => {
    try {
      await api(`/api/songs/${ytId}`, { method: 'DELETE' })
      setConfirmDel(null)
      setData((prev) =>
        prev
          ? {
              ...prev,
              local: prev.local.filter((s) => s.video.yt_id !== ytId),
              drive: prev.drive.filter((e) => e.yt_id !== ytId),
            }
          : prev,
      )
      onMsg('Música removida')
    } catch (err) {
      onMsg(err instanceof Error ? err.message : 'Falha ao remover')
    }
  }

  const local = data.local.filter((s) => match(s.video.title, s.video.channel))
  const drive = data.drive.filter((s) => match(s.title, s.channel))
  const requests = data.requests.filter((r) => match(r.video.title, r.video.channel))

  return (
    <section className="card">
      <h2>Biblioteca</h2>
      <div className="row wrap">
        <button className={tab === 'local' ? 'primary' : ''} onClick={() => setTab('local')}>
          No Mac ({data.local.length})
        </button>
        <button className={tab === 'drive' ? 'primary' : ''} onClick={() => setTab('drive')}>
          Só no Drive ({data.drive.length})
        </button>
        <button className={tab === 'requests' ? 'primary' : ''} onClick={() => setTab('requests')}>
          Pedidos ({data.requests.length})
        </button>
      </div>
      <input
        type="search"
        placeholder="Filtrar por título ou canal"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{ marginTop: 10 }}
      />
      {tab === 'local' && (
        <>
          <p className="muted hint">Prontas para tocar, sem esperar processamento.</p>
          <ul className="lib-list">
            {local.map((s) => (
              <li key={s.video.yt_id}>
                <div className="grow">
                  <div className="title">{s.video.title}</div>
                  <div className="sub">
                    {s.video.channel} {s.video.duration ? `· ${fmtDuration(s.video.duration)}` : ''}
                    {s.karaoke ? ' · versão karaokê' : !s.has_instrumental ? ' · sem voz separada' : ''}
                    {s.has_lyrics ? ' · letra' : ''}
                  </div>
                </div>
                <button
                  className={inQueue.has(s.video.yt_id) ? '' : 'primary'}
                  onClick={() => addToQueue(s.video, s.karaoke, onMsg)}
                >
                  {inQueue.has(s.video.yt_id) ? 'De novo' : 'Adicionar'}
                </button>
                {me.is_host &&
                  (confirmDel === s.video.yt_id ? (
                    <button
                      className="primary"
                      style={{ background: 'var(--err)' }}
                      onClick={() => deleteSong(s.video.yt_id)}
                      title="Confirmar remoção"
                    >
                      Apagar
                    </button>
                  ) : (
                    <button
                      className="ghost"
                      onClick={() => setConfirmDel(s.video.yt_id)}
                      title="Apagar música do Mac"
                    >
                      ✕
                    </button>
                  ))}
              </li>
            ))}
          </ul>
        </>
      )}
      {tab === 'drive' && (
        <>
          <p className="muted hint">
            Já processadas no Colab, mas ainda não importadas neste Mac. Copie o pacote indicado do Drive para{' '}
            <code>data/import</code> e importe.
            {data.catalog_updated_at ? ` Catálogo de ${data.catalog_updated_at.slice(0, 16).replace('T', ' ')}.` : ''}
            {data.catalog_size === 0 ? ' O catálogo chega junto com o próximo pacote importado do notebook.' : ''}
          </p>
          <ul className="lib-list">
            {drive.map((e) => (
              <li key={e.yt_id}>
                <div className="grow">
                  <div className="title">{e.title || e.yt_id}</div>
                  <div className="sub">
                    {e.channel} {e.duration ? `· ${fmtDuration(e.duration)}` : ''} · {e.pack ?? 'pacote desconhecido'}
                  </div>
                </div>
                {me.is_host &&
                  (confirmDel === e.yt_id ? (
                    <button
                      className="primary"
                      style={{ background: 'var(--err)' }}
                      onClick={() => deleteSong(e.yt_id)}
                      title="Confirmar remoção do catálogo"
                    >
                      Apagar
                    </button>
                  ) : (
                    <button
                      className="ghost"
                      onClick={() => setConfirmDel(e.yt_id)}
                      title="Remover do catálogo"
                    >
                      ✕
                    </button>
                  ))}
              </li>
            ))}
          </ul>
        </>
      )}
      {tab === 'requests' && (
        <>
          <p className="muted hint">
            Músicas para processar no Colab. Cole a lista no <code>SONGS</code> do notebook ou salve como{' '}
            <code>MyDrive/karaoke/pedidos.txt</code> (usado quando o <code>SONGS</code> está vazio). Saem daqui
            quando o pacote com elas é importado.
          </p>
          {me.is_host && data.requests.length > 0 && (
            <div className="row wrap">
              <button className="primary" onClick={copy}>
                Copiar lista
              </button>
              <button onClick={download}>Baixar pedidos.txt</button>
            </div>
          )}
          {text !== null && (
            <textarea ref={textRef} className="req-text" readOnly value={text} rows={Math.min(10, text.split('\n').length)} />
          )}
          <ul className="lib-list">
            {requests.map((r) => (
              <li key={r.video.yt_id}>
                <div className="grow">
                  <div className="title">{r.video.title}</div>
                  <div className="sub">
                    {r.video.channel}
                    {r.is_karaoke_version ? ' · versão karaokê' : ''}
                    {r.requested_by ? ` · pedida por ${r.requested_by}` : ''}
                  </div>
                </div>
                {me.is_host && <button onClick={() => removeRequest(r.video.yt_id)}>Remover</button>}
              </li>
            ))}
          </ul>
          {!me.is_host && <p className="muted hint">Só o anfitrião faz pedidos ao Colab.</p>}
        </>
      )}
    </section>
  )
}

function Queue({ state, me, onMsg }: { state: State; me: Singer; onMsg: (msg: string) => void }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const call = async (path: string, init?: { method?: string; body?: unknown }) => {
    try {
      await api(path, init)
    } catch (err) {
      onMsg(err instanceof ApiError ? err.message : 'Falha')
    }
  }
  const withScores = [...state.history].reverse().filter((e) => e.scores && Object.keys(e.scores).length).slice(0, 5)
  return (
    <>
    <section className="card">
      {me.is_host && (
        <div className="row" style={{ marginBottom: 10 }}>
          <span className="badge">anfitrião: pode reordenar e remover qualquer música</span>
        </div>
      )}
      {state.queue.length === 0 && <p className="muted">A fila está vazia.</p>}
      {state.queue.map((entry, i) => {
        const song = state.songs[entry.yt_id]
        const singers = singersOf(entry, state)
        const isCurrent = entry.id === state.player.entry_id
        const mine = entry.singer_ids.includes(me.id)
        const ready = entryReady(entry, song, state)
        return (
          <div className={`qitem ${isCurrent ? 'current' : ''}`} key={entry.id}>
            <span className="muted">{isCurrent ? '▶' : i + 1}</span>
            <div>
              <div className="title">{song?.video.title ?? entry.yt_id}</div>
              <div className="sub">
                {singers.map((s) => s.name).join(' e ')}
                {entry.is_karaoke_version ? ' · versão karaokê' : ''}
                {' · '}
                {ready ? (isCurrent ? 'tocando' : 'pronta') : statusText(song, entry, state)}
              </div>
            </div>
            <div className="btns">
              {me.is_host && i > 0 && (
                <button className="ghost" onClick={() => call(`/api/queue/${entry.id}/move`, { body: { position: i - 1 } })}>
                  ↑
                </button>
              )}
              {me.is_host && i < state.queue.length - 1 && (
                <button className="ghost" onClick={() => call(`/api/queue/${entry.id}/move`, { body: { position: i + 1 } })}>
                  ↓
                </button>
              )}
              {(mine || me.is_host) && (
                <button className="ghost" onClick={() => setOpenId(openId === entry.id ? null : entry.id)}>
                  ⚙
                </button>
              )}
              {(mine || me.is_host) && (
                <button className="ghost" onClick={() => call(`/api/queue/${entry.id}`, { method: 'DELETE' })}>
                  ✕
                </button>
              )}
            </div>
            {openId === entry.id && (mine || me.is_host) && (
              <EntryOptions entry={entry} state={state} me={me} call={call} />
            )}
          </div>
        )
      })}
    </section>
    {withScores.length > 0 && (
      <section className="card">
        <h2>Últimos resultados</h2>
        {withScores.map((e) => (
          <div key={e.id} className="score-list">
            <div className="muted">{state.songs[e.yt_id]?.video.title ?? e.yt_id}</div>
            {Object.entries(e.scores ?? {})
              .sort((a, b) => b[1] - a[1])
              .map(([who, pts]) => {
                const d = e.score_details?.[who]
                const parts = [
                  d?.pitch !== undefined ? `afinação ${fmtPoints(d.pitch)}` : null,
                  d?.lyrics !== undefined ? `letra ${fmtPoints(d.lyrics)}` : null,
                ].filter(Boolean)
                return (
                  <div key={who}>
                    <span>
                      {state.singers.find((s) => s.id === who)?.name ?? who.replace('mic', 'Mic ')}
                      {parts.length > 0 && <span className="muted"> · {parts.join(' · ')}</span>}
                    </span>
                    <strong>{fmtPoints(pts)}</strong>
                  </div>
                )
              })}
          </div>
        ))}
      </section>
    )}
    </>
  )
}

function EntryOptions({
  entry,
  state,
  me,
  call,
}: {
  entry: QueueEntry
  state: State
  me: Singer
  call: (path: string, init?: { method?: string; body?: unknown }) => Promise<void>
}) {
  const lead = entry.singer_ids[0] ?? me.id
  const partner = entry.singer_ids[1] ?? ''
  const others = state.singers.filter((s) => s.id !== lead)
  const setKey = (n: number) => call(`/api/queue/${entry.id}/key`, { body: { semitones: Math.max(-6, Math.min(6, n)) } })
  return (
    <div className="options">
      <div className="row">
        <span>Tom</span>
        <button className="ghost" onClick={() => setKey(entry.key_shift - 1)} disabled={entry.key_shift <= -6}>
          −
        </button>
        <strong style={{ minWidth: 110, textAlign: 'center' }}>{keyLabel(entry.key_shift)}</strong>
        <button className="ghost" onClick={() => setKey(entry.key_shift + 1)} disabled={entry.key_shift >= 6}>
          +
        </button>
      </div>
      <div className="row">
        <span>Dueto</span>
        <select
          className="grow"
          value={partner}
          onChange={(e) =>
            call(`/api/queue/${entry.id}/singers`, {
              body: { singer_ids: e.target.value ? [lead, e.target.value] : [lead] },
            })
          }
        >
          <option value="">Sem dueto</option>
          {others.map((s) => (
            <option key={s.id} value={s.id}>
              com {s.name}
            </option>
          ))}
        </select>
      </div>
      {partner && (
        <div className="row">
          <span>Partes</span>
          <button className="ghost" onClick={() => call(`/api/queue/${entry.id}/duet`, { body: { swap: !entry.duet_swap } })}>
            Trocar quem começa
          </button>
        </div>
      )}
      <p className="muted">A letra alterna as estrofes entre os dois cantores, cada um na sua cor.</p>
    </div>
  )
}

function Me({ state, me, onMsg }: { state: State; me: Singer; onMsg: (msg: string) => void }) {
  const [pin, setPin] = useState('')
  const becomeHost = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await api('/api/host', { body: { pin } })
      onMsg('Agora você é o anfitrião')
      setPin('')
    } catch (err) {
      onMsg(err instanceof Error ? err.message : 'Falha')
    }
  }
  const setMic = async (mic: number | null) => {
    try {
      await api('/api/me/mic', { body: { mic } })
    } catch (err) {
      onMsg(err instanceof Error ? err.message : 'Falha')
    }
  }
  const current = state.queue.find((e) => e.id === state.player.entry_id)
  const currentSong = current ? state.songs[current.yt_id] : undefined
  const key = current && currentSong ? songKey(current, currentSong, state) : null
  const hasMelody = Boolean(currentSong?.has_melody && !current?.is_karaoke_version)
  const card = (n: number) => (
    <AutotuneCard key={n} n={n} settings={state.audio.mics[n - 1]} songKey={key} hasMelody={hasMelody} onMsg={onMsg} />
  )
  return (
    <>
      <section className="card">
        <h2>
          <span className="dot" style={{ background: me.color }} />
          {me.name} {me.is_host && <span className="badge ok">anfitrião</span>}
        </h2>
        <p className="muted">Qual microfone você está usando?</p>
        <div className="row">
          {[1, 2].map((n) => (
            <button key={n} className={me.mic === n ? 'primary' : ''} onClick={() => setMic(n)}>
              Mic {n}
            </button>
          ))}
          <button className={me.mic === null ? 'primary' : ''} onClick={() => setMic(null)}>
            Nenhum
          </button>
        </div>
      </section>
      {me.mic && card(me.mic)}
      {me.is_host && [1, 2].filter((n) => n !== me.mic).map(card)}
      {canControl(state, me) && <MusicCard settings={state.audio.music} onMsg={onMsg} />}
      {canControl(state, me) && <GuideCard settings={state.audio.guide} onMsg={onMsg} />}
      {me.is_host && <ReverbCard settings={state.audio.reverb} onMsg={onMsg} />}
      {me.is_host && <ImportCard onMsg={onMsg} />}
      {!me.is_host && (
        <section className="card">
          <h2>Virar anfitrião</h2>
          <p className="muted">O PIN aparece no terminal do computador que roda o karaokê.</p>
          <form onSubmit={becomeHost} className="row">
            <input type="password" inputMode="numeric" placeholder="PIN" value={pin} onChange={(e) => setPin(e.target.value)} />
            <button className="primary" disabled={!pin}>
              Entrar
            </button>
          </form>
        </section>
      )}
      <section className="card">
        <h2>Na sessão</h2>
        {state.singers.map((s) => (
          <div key={s.id} className="row" style={{ padding: '4px 0' }}>
            <span className="dot" style={{ background: s.color }} />
            <span className="grow">{s.name}</span>
            {s.mic && <span className="badge">mic {s.mic}</span>}
            {s.is_host && <span className="badge ok">anfitrião</span>}
          </div>
        ))}
      </section>
      <section className="card">
        <button
          className="ghost"
          onClick={() => {
            saveIdentity(null, null)
            location.reload()
          }}
        >
          Sair da sessão neste aparelho
        </button>
      </section>
    </>
  )
}

function useDebouncedSend(send: (body: Record<string, unknown>) => void) {
  const timer = useRef<number | undefined>(undefined)
  return (body: Record<string, unknown>) => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => send(body), 150)
  }
}

function SliderField({
  label,
  value,
  min = 0,
  max = 100,
  unit = '%',
  disabled,
  onChange,
}: {
  label: string
  value: number
  min?: number
  max?: number
  unit?: string
  disabled?: boolean
  onChange: (v: number) => void
}) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  const later = useDebouncedSend((body) => onChange(body.v as number))
  return (
    <>
      <label className="muted">
        {label}: {v}
        {unit}
      </label>
      <input
        className="slider"
        type="range"
        min={min}
        max={max}
        value={v}
        disabled={disabled}
        onChange={(e) => {
          const n = Number(e.target.value)
          setV(n)
          later({ v: n })
        }}
      />
    </>
  )
}

function AutotuneCard({
  n,
  settings,
  songKey: detected,
  hasMelody,
  onMsg,
}: {
  n: number
  settings: MicSettings
  songKey: SongKey | null
  hasMelody: boolean
  onMsg: (msg: string) => void
}) {
  const send = (body: Record<string, unknown>) =>
    api(`/api/audio/mic/${n}`, { body }).catch((err) => onMsg(err instanceof Error ? err.message : 'Falha'))
  const scale = settings.scale === 'chromatic' ? 'major' : settings.scale
  const preset = presetOf(settings)
  const keyValue = settings.auto_key ? 'auto' : settings.key === null ? 'chromatic' : String(settings.key)
  const onKey = (value: string) => {
    if (value === 'auto') send({ auto_key: true })
    else if (value === 'chromatic') send({ auto_key: false, chromatic: true })
    else send({ auto_key: false, key: Number(value), scale })
  }
  return (
    <section className="card">
      <h2>Voz do mic {n}</h2>
      <SliderField
        label="Boost de entrada (pré-ganho)"
        value={settings.boost_db ?? 0}
        min={0}
        max={36}
        unit=" dB"
        onChange={(v) => send({ boost_db: v })}
      />
      <SliderField
        label="Volume do mic"
        value={Math.round(settings.gain * 100)}
        max={400}
        onChange={(v) => send({ gain: v / 100 })}
      />
      <SliderField label="Supressão de ruído" value={settings.denoise ?? 0} onChange={(v) => send({ denoise: v })} />
      <p className="muted hint">
        O Boost de entrada amplifica o microfone antes do autotune e da pontuação (ideal para interfaces USB como a
        Q-12). A supressão de ruído abaixa o mic quando ninguém canta nele (chiado e barulho da sala; 0 = desligada).
        Se cortar o começo das frases, diminua.
      </p>
      <div className="row wrap">
        {PRESETS.map((p) => (
          <button key={p.id} className={preset?.id === p.id ? 'primary' : ''} onClick={() => send(p.values)}>
            {p.label}
          </button>
        ))}
      </div>
      <p className="muted hint">{preset ? preset.hint : 'Personalizado.'}</p>
      <label className="row">
        <span className="grow">Autotune ligado</span>
        <input type="checkbox" checked={settings.enabled} onChange={(e) => send({ enabled: e.target.checked })} />
      </label>
      <SliderField
        label="Quanto de ajuda"
        value={settings.strength}
        disabled={!settings.enabled}
        onChange={(v) => send({ strength: v })}
      />
      <SliderField
        label="Velocidade da correção (1 = robótico, 200 = natural)"
        value={settings.speed_ms}
        min={1}
        max={200}
        unit=" ms"
        disabled={!settings.enabled}
        onChange={(v) => send({ speed_ms: v })}
      />
      <label className="row">
        <span className="grow">Seguir o vocal original</span>
        <input
          type="checkbox"
          checked={settings.follow_melody}
          disabled={!settings.enabled}
          onChange={(e) => send({ follow_melody: e.target.checked })}
        />
      </label>
      {settings.follow_melody && (
        <p className="muted hint">
          {hasMelody
            ? 'Corrige para a nota que o cantor original canta em cada momento (quando você está perto dela).'
            : 'A música atual não tem melodia do vocal; vale a tonalidade abaixo.'}
        </p>
      )}
      <label className="muted">Tonalidade</label>
      <div className="row">
        <select value={keyValue} onChange={(e) => onKey(e.target.value)}>
          <option value="auto">Automática{detected ? ` (${keyText(detected)})` : ''}</option>
          <option value="chromatic">Cromática (todas as notas)</option>
          {KEY_NAMES.map((k, i) => (
            <option key={k} value={i}>
              {k}
            </option>
          ))}
        </select>
        <select
          value={scale}
          disabled={settings.auto_key || settings.key === null}
          onChange={(e) => send({ scale: e.target.value })}
        >
          <option value="major">maior</option>
          <option value="minor">menor</option>
        </select>
      </div>
      {settings.auto_key && !detected && (
        <p className="muted hint">Sem tonalidade detectada para a música atual: corrige para qualquer nota (cromática).</p>
      )}
      <h3>Efeitos</h3>
      <SliderField label="Dobra de voz" value={settings.double} onChange={(v) => send({ double: v })} />
      <SliderField label="Eco" value={settings.echo} onChange={(v) => send({ echo: v })} />
      <SliderField label="Saturação" value={settings.drive} onChange={(v) => send({ drive: v })} />
    </section>
  )
}

/** Anfitrião ou quem está cantando a música atual. */
function canControl(state: State, me: Singer): boolean {
  if (me.is_host) return true
  const current = state.queue.find((e) => e.id === state.player.entry_id)
  return Boolean(current && current.singer_ids.includes(me.id))
}

function MusicCard({ settings, onMsg }: { settings: MusicSettings; onMsg: (msg: string) => void }) {
  const send = (body: Record<string, unknown>) =>
    api('/api/audio/music', { body }).catch((err) => onMsg(err instanceof Error ? err.message : 'Falha'))
  return (
    <section className="card">
      <h2>Música</h2>
      <SliderField label="Volume da música" value={settings.volume} onChange={(v) => send({ volume: v })} />
      <p className="muted hint">Abaixe se a voz some no meio da música. A voz guia acompanha este volume.</p>
    </section>
  )
}

function GuideCard({ settings, onMsg }: { settings: GuideSettings; onMsg: (msg: string) => void }) {
  const [volume, setVolume] = useState(settings.volume)
  useEffect(() => setVolume(settings.volume), [settings.volume])
  const send = (body: Record<string, unknown>) =>
    api('/api/audio/guide', { body }).catch((err) => onMsg(err instanceof Error ? err.message : 'Falha'))
  const sendLater = useDebouncedSend(send)
  return (
    <section className="card">
      <h2>Voz guia</h2>
      <p className="muted">O vocal original toca junto com a música para ajudar quem não sabe a letra ou a melodia.</p>
      <label className="row">
        <span className="grow">Ligada</span>
        <input type="checkbox" checked={settings.enabled} onChange={(e) => send({ enabled: e.target.checked })} />
      </label>
      <label className="muted">Volume da voz guia: {volume}%</label>
      <input
        className="slider"
        type="range"
        min={0}
        max={100}
        value={volume}
        disabled={!settings.enabled}
        onChange={(e) => {
          const v = Number(e.target.value)
          setVolume(v)
          sendLater({ volume: v })
        }}
      />
      <label className="row">
        <span className="grow">Some quando alguém canta no microfone</span>
        <input
          type="checkbox"
          checked={settings.duck}
          disabled={!settings.enabled}
          onChange={(e) => send({ duck: e.target.checked })}
        />
      </label>
    </section>
  )
}

function ReverbCard({ settings, onMsg }: { settings: ReverbSettings; onMsg: (msg: string) => void }) {
  const [amount, setAmount] = useState(settings.amount)
  useEffect(() => setAmount(settings.amount), [settings.amount])
  const send = (body: Record<string, unknown>) =>
    api('/api/audio/reverb', { body }).catch((err) => onMsg(err instanceof Error ? err.message : 'Falha'))
  const sendLater = useDebouncedSend(send)
  return (
    <section className="card">
      <h2>Reverb (os dois mics)</h2>
      <label className="row">
        <span className="grow">Ligado</span>
        <input type="checkbox" checked={settings.enabled} onChange={(e) => send({ enabled: e.target.checked })} />
      </label>
      <label className="muted">Quantidade: {amount}%</label>
      <input
        className="slider"
        type="range"
        min={0}
        max={100}
        value={amount}
        disabled={!settings.enabled}
        onChange={(e) => {
          const v = Number(e.target.value)
          setAmount(v)
          sendLater({ amount: v })
        }}
      />
    </section>
  )
}

function ImportCard({ onMsg }: { onMsg: (msg: string) => void }) {
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      const res = await api<{ imported: string[]; import_dir: string }>('/api/import/scan', { method: 'POST' })
      onMsg(res.imported.length ? `${res.imported.length} música(s) importada(s)` : `Nenhum .zip novo em ${res.import_dir}`)
    } catch (err) {
      onMsg(err instanceof Error ? err.message : 'Falha')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="card">
      <h2>Pacotes do Colab</h2>
      <p className="muted">Coloque os .zip gerados pelo notebook na pasta data/import do computador e importe.</p>
      <button onClick={run} disabled={busy}>
        {busy ? 'Importando…' : 'Importar pacotes'}
      </button>
    </section>
  )
}
