import type { MediaItem } from '../types'

/** Presentation only: uses stored metadata, never changes playback approval. */
export interface ProgramMetadata {
  readonly overview?: string
  readonly overviewScope?: 'episode' | 'show' | 'movie'
  readonly airDate?: string
  readonly rating?: string
  readonly ratingRegion?: string
}
export function programMetadata(item: MediaItem): ProgramMetadata | undefined {
  if (item.isInterlude || item.mediaType === 'interlude') return undefined
  const clean = (value: string | null | undefined, max: number) =>
    value?.replace(/\s+/g, ' ').trim().slice(0, max) || undefined
  const episode = item.libraryKind === 'tv' ? clean(item.episodeOverview, 1200) : undefined
  const overview = episode ?? clean(item.collectionOverview, 1200)
  const rating = item.collectionRatingStatus === 'resolved'
    ? clean(item.collectionCertification, 40) : undefined
  return {
    ...(overview ? { overview, overviewScope: episode ? 'episode' : item.libraryKind === 'movie' ? 'movie' : 'show' } : {}),
    ...(item.libraryKind === 'tv' && /^\d{4}-\d{2}-\d{2}$/.test(item.episodeAirDate ?? '') ? { airDate: item.episodeAirDate! } : {}),
    ...(rating ? { rating, ratingRegion: clean(item.collectionCertificationRegion, 8) } : {}),
  }
}
