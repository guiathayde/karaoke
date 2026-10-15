/* Predefinições de voz por microfone: autotune + efeitos. A tonalidade (automática ou manual) não muda. */
import type { MicSettings } from '../lib/types'

type PresetValues = Pick<MicSettings, 'enabled' | 'strength' | 'speed_ms' | 'follow_melody' | 'double' | 'echo' | 'drive'>

export interface Preset {
  id: string
  label: string
  hint: string
  values: PresetValues
}

export const PRESETS: Preset[] = [
  {
    id: 'natural',
    label: 'Natural',
    hint: 'Ajuda discreta, quase não se percebe.',
    values: { enabled: true, strength: 40, speed_ms: 80, follow_melody: false, double: 0, echo: 0, drive: 0 },
  },
  {
    id: 'singer',
    label: 'Como o cantor',
    hint: 'Puxa para as notas que o cantor original canta.',
    values: { enabled: true, strength: 75, speed_ms: 30, follow_melody: true, double: 10, echo: 0, drive: 0 },
  },
  {
    id: 'pop',
    label: 'Pop',
    hint: 'Afinação firme, voz dobrada e um pouco de eco.',
    values: { enabled: true, strength: 70, speed_ms: 20, follow_melody: false, double: 25, echo: 15, drive: 0 },
  },
  {
    id: 'trap',
    label: 'Trap',
    hint: 'Autotune robótico (pula de nota em nota), eco e saturação.',
    values: { enabled: true, strength: 100, speed_ms: 1, follow_melody: false, double: 30, echo: 30, drive: 25 },
  },
]

export function presetOf(s: MicSettings): Preset | null {
  return (
    PRESETS.find((p) => (Object.keys(p.values) as (keyof PresetValues)[]).every((k) => s[k] === p.values[k])) ?? null
  )
}
