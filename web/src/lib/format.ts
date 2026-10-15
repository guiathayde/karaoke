import { KEY_NAMES } from '../audio/engine'
import type { LyricLine, QueueEntry, Singer, Song, SongKey, State } from './types'

export function fmtDuration(seconds: number | null | undefined): string {
  if (!seconds && seconds !== 0) return ''
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function wantsInstrumental(entry: QueueEntry, state: State): boolean {
  return state.separation_enabled && !entry.is_karaoke_version
}

export function variantName(base: string, semitones: number): string {
  const sign = semitones >= 0 ? '+' : '-'
  const dot = base.lastIndexOf('.')
  return `${base.slice(0, dot)}_k${sign}${Math.abs(semitones)}${base.slice(dot)}`
}

/** Arquivo da voz guia (vocais separados) no tom da música, ou null se não existir. */
export function guideFile(entry: QueueEntry, song: Song): string | null {
  if (entry.is_karaoke_version || !song.has_vocals) return null
  if (entry.key_shift === 0) return 'vocals.m4a'
  const variant = variantName('vocals.m4a', entry.key_shift)
  return song.variants.includes(variant) ? variant : null
}

/** Arquivo a tocar e se a variante de tom pedida ainda está sendo preparada. */
export function mediaFile(entry: QueueEntry, song: Song, state: State): { name: string; pending: boolean } {
  const base = wantsInstrumental(entry, state) && song.has_instrumental ? 'instrumental.mp4' : 'original.mp4'
  if (entry.key_shift === 0) return { name: base, pending: false }
  const variant = variantName(base, entry.key_shift)
  return song.variants.includes(variant) ? { name: variant, pending: false } : { name: base, pending: true }
}

/** Semitons em relação ao original do que está tocando agora (0 enquanto a variante de tom é preparada). */
export function playingShift(entry: QueueEntry, song: Song, state: State): number {
  return mediaFile(entry, song, state).pending ? 0 : entry.key_shift
}

/** Tonalidade detectada da música, já transposta para o tom que está tocando. */
export function songKey(entry: QueueEntry, song: Song, state: State): SongKey | null {
  if (song.key_tonic === null || song.key_tonic === undefined || !song.key_scale) return null
  const tonic = (((song.key_tonic + playingShift(entry, song, state)) % 12) + 12) % 12
  return { tonic, scale: song.key_scale }
}

export function keyText(key: SongKey | null): string {
  if (!key) return 'cromático'
  return `${KEY_NAMES[key.tonic]} ${key.scale === 'minor' ? 'menor' : 'maior'}`
}

export function mediaUrl(entry: QueueEntry, song: Song, state: State): string {
  return `/media/${entry.yt_id}/${mediaFile(entry, song, state).name}`
}

export function keyLabel(semitones: number): string {
  if (semitones === 0) return 'tom original'
  return `tom ${semitones > 0 ? '+' : '−'}${Math.abs(semitones)}`
}

/**
 * Índice de bloco (estrofe) por linha. Novo bloco quando há linha vazia ou uma pausa bem maior
 * que o ritmo normal da música (2,2× a mediana dos intervalos, no mínimo 3,5 s).
 */
export function lyricBlocks(lines: LyricLine[]): number[] {
  const gaps = lines.slice(1).map((l, i) => l.t - lines[i].t).filter((g) => g > 0).sort((a, b) => a - b)
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 4
  const threshold = Math.max(3.5, median * 2.2)
  const blocks: number[] = []
  let block = -1
  let size = 0
  let prevT = -Infinity
  let prevEmpty = false
  for (const line of lines) {
    const empty = line.text.trim() === ''
    // estrofes longas são quebradas a cada 4 linhas para a alternância não ficar longa demais
    if (line.t - prevT > threshold || prevEmpty || size >= 4) {
      block++
      size = 0
    }
    blocks.push(block)
    size++
    prevT = line.t
    prevEmpty = empty
  }
  return blocks
}

/** Em dueto, qual dos dois cantores (0 ou 1) canta a linha i; null fora de dueto. */
export function lineSinger(entry: QueueEntry, blocks: number[], i: number): 0 | 1 | null {
  if (entry.singer_ids.length < 2) return null
  const base = blocks[i] % 2
  return ((entry.duet_swap ? 1 - base : base) as 0 | 1)
}

export function fmtPoints(points: number): string {
  return points.toLocaleString('pt-BR')
}

export function entryReady(entry: QueueEntry, song: Song | undefined, state: State): boolean {
  if (!song || song.status !== 'ready') return false
  return wantsInstrumental(entry, state) ? song.has_instrumental : song.has_original
}

/** Texto explicando em que ponto do preparo a música está. */
export function statusText(song: Song | undefined, entry: QueueEntry, state: State): string {
  if (!song) return 'Na fila para preparar'
  const pct = Math.round(song.progress * 100)
  switch (song.status) {
    case 'pending':
      return entryReady(entry, song, state) ? 'Pronta' : 'Na fila para preparar'
    case 'downloading':
      return `Baixando o vídeo do YouTube (${pct}%)`
    case 'separating':
      return `Separando a voz do instrumental com IA (${pct}%). Isso leva de 1 a 2 minutos por música.`
    case 'muxing':
      return 'Montando o vídeo com o instrumental'
    case 'melody':
      return 'Extraindo a melodia para a pontuação'
    case 'lyrics':
      return 'Buscando a letra sincronizada'
    case 'ready':
      return entryReady(entry, song, state) ? 'Pronta' : 'Precisa separar a voz'
    case 'error':
      return `Erro: ${song.error ?? 'desconhecido'}`
  }
}

export function singersOf(entry: QueueEntry, state: State): Singer[] {
  return entry.singer_ids
    .map((id) => state.singers.find((s) => s.id === id))
    .filter((s): s is Singer => Boolean(s))
}
