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
  variants: string[]
  rendering: string | null
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
  added_at: number
}

export interface Player {
  status: PlayerStatus
  entry_id: string | null
  position: number
  restart_id: number
}

export type Scale = 'chromatic' | 'major' | 'minor'

export interface MicSettings {
  enabled: boolean
  strength: number // 0..100
  speed_ms: number
  key: number | null // 0 = C ... 11 = B
  scale: Scale
  gain: number
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
