import { useEffect, useState } from 'react'
import { KEY_NAMES, MicEngine, effectiveKey, type EngineConfig, type InputMode } from '../audio/engine'
import { presetOf } from '../audio/presets'
import { fmtPoints, keyText } from '../lib/format'
import type { AudioSettings, SongKey } from '../lib/types'

const CONFIG_KEY = 'karaoke.micConfig'

export function loadMicConfig(): EngineConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (raw) return JSON.parse(raw) as EngineConfig
  } catch {
    /* sem config salva */
  }
  return { mode: 'mono', deviceA: null, deviceB: null }
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
    const id = window.setInterval(() => setTick((t) => t + 1), 200)
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
        <h1>Microfones</h1>
        <p className="muted">
          O sinal dos microfones passa pelo autotune aqui no palco e sai junto com a música. Latência do
          navegador: {engine.latencyMs} ms.
        </p>
        <div className="field">
          <label>Entrada</label>
          <select value={config.mode} onChange={(e) => setConfig({ ...config, mode: e.target.value as InputMode })}>
            <option value="mono">1 entrada mono (receptor com saída única: os dois mics juntos)</option>
            <option value="stereo">1 entrada estéreo (mic 1 no canal esquerdo, mic 2 no direito)</option>
            <option value="two">2 dispositivos separados</option>
          </select>
        </div>
        <div className="field">
          <label>{config.mode === 'two' ? 'Dispositivo do mic 1' : 'Dispositivo'}</label>
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
            {engine.running ? 'Reiniciar microfones' : 'Ligar microfones'}
          </button>
          <button onClick={onClose}>Fechar (M)</button>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="mic-grid">
          {[0, 1].map((i) => {
            const active = engine.hasChain(i as 0 | 1)
            const pitch = engine.pitch(i as 0 | 1)
            const level = active ? engine.level(i as 0 | 1) : 0
            const s = audio.mics[i]
            return (
              <div key={i} className={`mic-card ${active ? '' : 'off'}`}>
                <h3>Mic {i + 1}</h3>
                <div className="meter">
                  <span style={{ width: `${Math.min(100, level * 300)}%` }} />
                </div>
                <div className="muted">
                  {active ? `Nota: ${noteName(pitch?.freq ?? 0)}` : 'sem entrada'}
                  {active && pitch?.shift ? ` · correção ${pitch.shift > 0 ? '+' : ''}${pitch.shift.toFixed(2)} st` : ''}
                  {active && pitch?.guided ? ' · seguindo o vocal' : ''}
                </div>
                <div className="muted">
                  Autotune {s.enabled ? `${s.strength}%` : 'desligado'} · {keyText(effectiveKey(s, songKey))}
                  {s.auto_key ? ' (automático)' : ''}
                  {s.follow_melody ? ' · guiado pelo vocal' : ''}
                </div>
                <div className="muted">Efeito: {presetOf(s)?.label ?? 'personalizado'}</div>
              </div>
            )
          })}
        </div>
        <p className="muted">
          Reverb: {audio.reverb.enabled ? `${audio.reverb.amount}%` : 'desligado'}. Ajustes de autotune, efeitos e
          reverb ficam no celular (cada cantor no seu mic; anfitrião em tudo).
        </p>
      </div>
    </div>
  )
}

export function MicStatus({
  engine,
  audio,
  scores,
}: {
  engine: MicEngine | null
  audio: AudioSettings
  scores?: [number, number] | null
}) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 150)
    return () => window.clearInterval(id)
  }, [])
  if (!engine || !engine.running) {
    return (
      <div>
        <h2>Microfones</h2>
        <p className="muted">Desligados. Tecla M para configurar.</p>
      </div>
    )
  }
  return (
    <div>
      <h2>Microfones</h2>
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
