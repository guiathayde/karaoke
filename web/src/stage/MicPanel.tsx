import { useEffect, useRef, useState } from 'react'
import { KEY_NAMES, MicEngine, effectiveKey, type EngineConfig, type InputMode } from '../audio/engine'
import { presetOf } from '../audio/presets'
import { api } from '../lib/api'
import { fmtPoints, keyText } from '../lib/format'
import type { AudioSettings, MicSettings, SongKey } from '../lib/types'

const CONFIG_KEY = 'karaoke.micConfig'

export function loadMicConfig(): EngineConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (raw) return JSON.parse(raw) as EngineConfig
  } catch {
    /* sem config salva */
  }
  return { mode: 'stereo', deviceA: null, deviceB: null }
}

function saveMicConfig(cfg: EngineConfig) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg))
  } catch {
    /* ignora */
  }
}

export function noteName(freq: number): string {
  if (!freq) return '–'
  const midi = 69 + 12 * Math.log2(freq / 440)
  const r = Math.round(midi)
  const cents = Math.round((midi - r) * 100)
  return `${KEY_NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1} ${cents >= 0 ? '+' : ''}${cents}`
}

function MicCardControls({
  index,
  settings,
  engine,
  songKey,
}: {
  index: 0 | 1
  settings: MicSettings
  engine: MicEngine
  songKey: SongKey | null
}) {
  const [boostDb, setBoostDb] = useState(settings.boost_db ?? 0)
  const [gainPct, setGainPct] = useState(Math.round(settings.gain * 100))
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => setBoostDb(settings.boost_db ?? 0), [settings.boost_db])
  useEffect(() => setGainPct(Math.round(settings.gain * 100)), [settings.gain])

  const sendPatch = (patch: Partial<MicSettings>) => {
    engine.applyMic(index, { ...settings, boost_db: boostDb, gain: gainPct / 100, ...patch }, songKey)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      void api(`/api/audio/mic/${index + 1}`, { body: patch }).catch(() => undefined)
    }, 120)
  }

  const totalDb = Math.round(boostDb + (gainPct > 0 ? 20 * Math.log10(gainPct / 100) : -60))

  return (
    <div style={{ marginTop: 10 }}>
      <label className="muted" style={{ display: 'block', fontSize: 13 }}>
        Boost de entrada (pré-ganho): <strong>+{boostDb} dB</strong> ({Math.pow(10, boostDb / 20).toFixed(1)}×)
      </label>
      <input
        className="slider"
        type="range"
        min={0}
        max={36}
        step={1}
        value={boostDb}
        onChange={(e) => {
          const v = Number(e.target.value)
          setBoostDb(v)
          sendPatch({ boost_db: v })
        }}
      />
      <label className="muted" style={{ display: 'block', fontSize: 13 }}>
        Volume do mic: <strong>{gainPct}%</strong> (ganho total: {totalDb >= 0 ? `+${totalDb}` : totalDb} dB)
      </label>
      <input
        className="slider"
        type="range"
        min={0}
        max={400}
        step={5}
        value={gainPct}
        onChange={(e) => {
          const v = Number(e.target.value)
          setGainPct(v)
          sendPatch({ gain: v / 100 })
        }}
      />
    </div>
  )
}

export function MicPanel({
  engine,
  audio,
  songKey,
  onClose,
}: {
  engine: MicEngine
  audio: AudioSettings
  songKey: SongKey | null
  onClose: () => void
}) {
  const [config, setConfig] = useState<EngineConfig>(loadMicConfig)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    void MicEngine.listInputs().then(setDevices)
  }, [tick])

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 100)
    return () => window.clearInterval(id)
  }, [])

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      await engine.start(config)
      saveMicConfig(config)
      setDevices(await MicEngine.listInputs())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível abrir o microfone')
    } finally {
      setBusy(false)
    }
  }

  const deviceSelect = (value: string | null, onChange: (v: string | null) => void) => (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">Padrão do sistema</option>
      {devices.map((d) => (
        <option key={d.deviceId} value={d.deviceId}>
          {d.label || `Entrada ${d.deviceId.slice(0, 6)}`}
        </option>
      ))}
    </select>
  )

  return (
    <div className="stage-overlay panel">
      <div className="inner panel-inner">
        <h1>Testar e Configurar Microfones</h1>
        <p className="muted">
          Fale nos microfones para testar o nível e a nota detectada em tempo real. Para a interface{' '}
          <strong>Q-12 com 2 microfones</strong>, use <strong>1 entrada estéreo</strong> para separar e amplificar cada
          microfone individualmente. Latência: {engine.latencyMs} ms.
        </p>
        <div className="field">
          <label>Modo de entrada</label>
          <select value={config.mode} onChange={(e) => setConfig({ ...config, mode: e.target.value as InputMode })}>
            <option value="stereo">1 entrada estéreo — Interface USB com 2 mics (Q-12: Mic 1 Esq / Mic 2 Dir)</option>
            <option value="mono">1 entrada mono — Receptor sem fio com saída única (os dois mics juntos)</option>
            <option value="two">2 dispositivos de áudio USB separados</option>
          </select>
        </div>
        <div className="field">
          <label>{config.mode === 'two' ? 'Dispositivo do mic 1' : 'Dispositivo (Interface Q-12 / USB Audio CODEC)'}</label>
          {deviceSelect(config.deviceA, (v) => setConfig({ ...config, deviceA: v }))}
        </div>
        {config.mode === 'two' && (
          <div className="field">
            <label>Dispositivo do mic 2</label>
            {deviceSelect(config.deviceB, (v) => setConfig({ ...config, deviceB: v }))}
          </div>
        )}
        <div className="row" style={{ justifyContent: 'center', gap: 12 }}>
          <button className="primary" onClick={start} disabled={busy}>
            {engine.running ? 'Aplicar / Reiniciar microfones' : 'Ligar microfones para testar'}
          </button>
          <button onClick={onClose}>Fechar (M)</button>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="mic-grid">
          {([0, 1] as const).map((i) => {
            const active = engine.hasChain(i)
            const pitch = engine.pitch(i)
            const m = active ? engine.meter(i) : { rms: 0, peak: 0, db: -100, clipping: false }
            const s = audio.mics[i]
            const chLabel =
              config.mode === 'stereo' ? (i === 0 ? ' (Canal 1 / Esq)' : ' (Canal 2 / Dir)') : ''
            let statusBadge = <span className="badge">em silêncio</span>
            if (active) {
              if (m.clipping) {
                statusBadge = <span className="badge err">forte / limitando ({m.db} dB)</span>
              } else if ((pitch?.rms ?? m.rms) >= 0.01) {
                statusBadge = <span className="badge ok">bom para cantar ({m.db} dB)</span>
              } else if (m.rms > 0.001) {
                statusBadge = <span className="badge warn">sinal baixo ({m.db} dB — suba o Boost)</span>
              }
            }
            return (
              <div key={i} className={`mic-card ${active ? '' : 'off'}`}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <h3 style={{ margin: 0 }}>
                    Mic {i + 1}
                    <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>
                      {chLabel}
                    </span>
                  </h3>
                  {statusBadge}
                </div>
                <div className="meter">
                  <span style={{ width: `${Math.min(100, m.rms * 300)}%` }} />
                </div>
                <div className="muted">
                  {active ? `Nota: ${noteName(pitch?.freq ?? 0)}` : 'sem entrada (modo mono usa só o Mic 1)'}
                  {active && pitch?.shift ? ` · correção ${pitch.shift > 0 ? '+' : ''}${pitch.shift.toFixed(2)} st` : ''}
                  {active && pitch?.guided ? ' · seguindo o vocal' : ''}
                </div>
                <div className="muted">
                  Autotune {s.enabled ? `${s.strength}%` : 'desligado'} · {keyText(effectiveKey(s, songKey))}
                  {s.auto_key ? ' (automático)' : ''}
                  {s.follow_melody ? ' · guiado pelo vocal' : ''} · Efeito: {presetOf(s)?.label ?? 'personalizado'}
                </div>
                <MicCardControls index={i} settings={s} engine={engine} songKey={songKey} />
              </div>
            )
          })}
        </div>
        <p className="muted">
          Reverb: {audio.reverb.enabled ? `${audio.reverb.amount}%` : 'desligado'} · Música: {audio.music.volume}%. O{' '}
          <strong>Boost de entrada</strong> amplifica cada canal via <code>GainNode</code> antes do detector de notas e
          da pontuação, com compressor/limitador integrado para não distorcer.
        </p>
      </div>
    </div>
  )
}

export function MicStatus({
  engine,
  audio,
  scores,
  onOpen,
}: {
  engine: MicEngine | null
  audio: AudioSettings
  scores?: [number, number] | null
  onOpen?: () => void
}) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 150)
    return () => window.clearInterval(id)
  }, [])
  if (!engine || !engine.running) {
    return (
      <div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Microfones</h2>
          {onOpen && (
            <button className="ghost" style={{ minHeight: 30, padding: '4px 10px', fontSize: 12 }} onClick={onOpen}>
              Testar / Configurar (M)
            </button>
          )}
        </div>
        <p className="muted">Desligados. Clique acima ou aperte M para configurar.</p>
      </div>
    )
  }
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Microfones</h2>
        {onOpen && (
          <button className="ghost" style={{ minHeight: 30, padding: '4px 10px', fontSize: 12 }} onClick={onOpen}>
            Testar / Boost (M)
          </button>
        )}
      </div>
      {[0, 1].map((i) => {
        if (!engine.hasChain(i as 0 | 1)) return null
        const level = engine.level(i as 0 | 1)
        const s = audio.mics[i]
        return (
          <div key={i} className="mic-row">
            <span>Mic {i + 1}</span>
            <div className="meter">
              <span style={{ width: `${Math.min(100, level * 300)}%` }} />
            </div>
            <span className="muted">{scores ? fmtPoints(scores[i]) : s.enabled ? `${s.strength}%` : 'off'}</span>
          </div>
        )
      })}
    </div>
  )
}
