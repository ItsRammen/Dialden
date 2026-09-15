import type { IMediaRepository } from '../repositories/IMediaRepository'
import type {
  CollectionListOptions,
  LibrarySummary,
  MediaCollection,
  MediaItem,
  OverrideDecision,
} from '../types'

export interface CollectionSeason {
  readonly seasonNumber: number | null
  readonly episodes: readonly MediaItem[]
}

export interface CollectionDetail {
  readonly collection: MediaCollection
  readonly seasons: readonly CollectionSeason[]
  readonly files: readonly MediaItem[]
}

export class CollectionLibraryService {
  constructor(private readonly repository: IMediaRepository) {}

  getSummary(): Promise<LibrarySummary> {
    return this.repository.getLibrarySummary()
  }

  list(options: CollectionListOptions = {}): Promise<MediaCollection[]> {
    return this.repository.getCollections(options)
  }

  getReviewQueue(options: CollectionListOptions = {}): Promise<MediaCollection[]> {
    return this.repository.getCollections({
      ...options,
      effectiveDecision: 'review',
      excludeParentalGuidance: true,
    })
  }

  getMetadataReviewQueue(
    options: CollectionListOptions = {}
  ): Promise<MediaCollection[]> {
    return this.repository.getCollections({
      ...options,
      metadataReview: true,
    })
  }

  async getDetail(id: number): Promise<CollectionDetail | null> {
    let [collection, files] = await Promise.all([
      this.repository.getCollectionById(id),
      this.repository.getCollectionMedia(id),
    ])
    if (!collection) return null
    const evidenceRaw = await this.repository.getSetting(`metadata_rating_evidence_v1:${id}`)
    try {
      const evidence = evidenceRaw ? JSON.parse(evidenceRaw) : null
      if (evidence?.externalId === collection.metadataExternalId && Array.isArray(evidence.ratings)) {
        const labels = evidence.ratings.filter((r: any) => typeof r?.region === 'string' && typeof r?.certification === 'string')
          .map((r: any) => `${r.region}: ${r.certification}`) as string[]
        collection = { ...collection, certificationEvidence: [...new Set(labels)] }
      }
    } catch { /* Invalid evidence does not replace the stored metadata. */ }

    const bySeason = new Map<number | null, MediaItem[]>()
    for (const file of files) {
      const season = file.seasonNumber ?? null
      const items = bySeason.get(season) ?? []
      items.push(file)
      bySeason.set(season, items)
    }
    const seasons = [...bySeason.entries()]
      .sort(([left], [right]) => (left ?? -1) - (right ?? -1))
      .map(([seasonNumber, episodes]) => ({ seasonNumber, episodes }))
    return { collection, seasons, files }
  }

  async getInterludes(): Promise<MediaItem[]> {
    const media = await this.repository.getAll()
    return media.filter(
      (item) =>
        item.mediaType === 'interlude' ||
        item.mediaType === 'intro' ||
        item.mediaType === 'outro' ||
        item.mediaType === 'offair'
    )
  }

  setOverride(id: number, decision: OverrideDecision): Promise<boolean> {
    return this.repository.updateCollectionOverride(id, decision)
  }

  async setOverrides(
    ids: readonly number[],
    decision: OverrideDecision
  ): Promise<{ updated: number; rejected: number }> {
    const uniqueIds = [...new Set(ids)].filter(
      (id) => Number.isSafeInteger(id) && id > 0
    )
    if (uniqueIds.length > 100) {
      throw new Error('Bulk collection changes are limited to 100 items')
    }
    let updated = 0
    for (const id of uniqueIds) {
      if (await this.repository.updateCollectionOverride(id, decision)) updated++
    }
    return { updated, rejected: ids.length - updated }
  }
}
