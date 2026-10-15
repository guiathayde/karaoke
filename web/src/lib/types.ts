export type SongStatus =
  | 'pending'
  | 'downloading'
  | 'separating'
  | 'muxing'
  | 'melody'
  | 'lyrics'
  | 'ready'
  | 'error'
export type PlayerStatus = 'idle' | 'waiting' | 'playing' | 'paused' | 'stopped'

export interface Video {
  yt_id: string
  title: string
  channel: string
  duration: number | null
  thumbnail: string | null
}

export interface LyricLine {
  t: number
  text: string
  singer: number | null
}

export interface Song {
  video: Video
  status: SongStatus
  progress: number
  error: string | null
  has_original: boolean
  has_instrumental: boolean
  has_vocals: boolean
  lyrics: LyricLine[] | null
  lyrics_source: string | null
  has_melody: boolean
  lyrics_aligned: boolean | null
  variants: string[]
  rendering: string | null
  key_tonic: number | null // tonalidade detectada, no tom original
  key_scale: KeyScale | null
}

export interface Singer {
  id: string
  name: string
  color: string
  is_host: boolean
  mic: number | null
}

export interface QueueEntry {
  id: string
  yt_id: string
  singer_ids: string[]
  is_karaoke_version: boolean
  key_shift: number
  duet_swap: boolean
  scores: Record<string, number> | null
  score_details: Record<string, { pitch?: number; lyrics?: number; total: number }> | null
  added_at: number
}

export interface Player {
  status: PlayerStatus
  entry_id: string | null
  position: number
  restart_id: number
}

export type Scale = 'chromatic' | 'major' | 'minor'
export type KeyScale = 'major' | 'minor'

/** Tonalidade da música no tom que está tocando. */
export interface SongKey {
  tonic: number
  scale: KeyScale
}

export interface MicSettings {
  enabled: boolean
  strength: number // 0..100
  speed_ms: number
  key: number | null // 0 = C ... 11 = B
  scale: Scale
  gain: number
  auto_key: boolean
  follow_melody: boolean
  double: number // 0..100
  echo: number // 0..100
  drive: number // 0..100
}

export interface ReverbSettings {
  enabled: boolean
  amount: number
}

export interface GuideSettings {
  enabled: boolean
  volume: number // 0..100
  duck: boolean // some quando alguém canta
}

export interface AudioSettings {
  mics: MicSettings[]
  reverb: ReverbSettings
  guide: GuideSettings
}

export interface State {
  session: { join_url: string; pin_required: boolean }
  singers: Singer[]
  queue: QueueEntry[]
  history: QueueEntry[]
  player: Player
  songs: Record<string, Song>
  separation_enabled: boolean
  audio: AudioSettings
}

/** Evento de pontuação de letra enviado pelo servidor a cada linha avaliada. */
export interface LyricEvent {
  entry_id: string
  line: number
  mic: number
  singer_id: string
  score: number // 0..1
  heard: string
  totals: Record<string, number>
  seq: number
}
