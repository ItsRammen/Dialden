import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type {
  CertificationLookup,
  MetadataCandidate,
  MetadataProvider,
  MetadataSearchInput,
  ProviderTitleDetails,
} from '../src/metadata/types'
import { MetadataProviderError } from '../src/metadata/types'
import type { MetadataRuntimeConfig } from '../src/config/metadata'
import type { MediaItemInput } from '../src/repositories/IMediaRepository'
import { MediaRepository } from '../src/repositories/MediaRepository'
import { MetadataEnrichmentService } from '../src/services/metadata/MetadataEnrichmentService'
import type { RatingPolicyProfile } from '../src/policy/PolicyEngine'

const runtimeConfig: MetadataRuntimeConfig = {
  tmdbApiKey: 'server-only-test-key',
  language: 'en-US',
  preferredRatingRegion: 'US',
  fallbackRatingRegions: [],
  requestTimeoutMs: 1_000,
}

interface ProviderScenario {
  readonly configured?: boolean
  readonly candidates?: readonly MetadataCandidate[]
  readonly certification?: string | null
  readonly certificationRegion?: string
  readonly ratingStatus?: CertificationLookup['status']
  readonly searchError?: Error
  readonly connectionError?: Error
}

function providerFor(scenario: ProviderScenario): MetadataProvider {
  const candidates = [...(scenario.candidates ?? [])]
  const detailsFor = (externalId: string): ProviderTitleDetails => {
    const candidate = candidates.find((item) => item.externalId === externalId)
    if (!candidate) throw new Error(`Unexpected details lookup for ${externalId}`)
    return { ...candidate, genres: ['Animation', 'Family'] }
  }
  const rating = (): CertificationLookup => ({
    status: scenario.ratingStatus ?? (scenario.certification ? 'resolved' : 'missing'),
    selected:
      scenario.certification === null || scenario.certification === undefined
        ? null
        : {
            region: scenario.certificationRegion ?? 'US',
            certification: scenario.certification,
          },
    all:
      scenario.certification === null || scenario.certification === undefined
        ? []
        : [
            {
              region: scenario.certificationRegion ?? 'US',
              certification: scenario.certification,
            },
          ],
  })

  return {
    id: 'tmdb',
    configured: scenario.configured ?? true,
    async testConnection() {
      if (scenario.connectionError) throw scenario.connectionError
    },
    async searchMovie(_input: MetadataSearchInput) {
      if (scenario.searchError) throw scenario.searchError
      return candidates
    },
    async searchTV(_input: MetadataSearchInput) {
      if (scenario.searchError) throw scenario.searchError
      return candidates
    },
    async getMovie(externalId: string) {
      return detailsFor(externalId)
    },
    async getTV(externalId: string) {
      return detailsFor(externalId)
    },
    async getMovieCertification() {
      return rating()
    },
    async getTVContentRating() {
      return rating()
    },
  }
}

function mediaInput(
  collectionId: number,
  title: string,
  filename = `${title} - S01E01.mkv`
): MediaItemInput {
  return {
    path: `/media/tv/${title}/${filename}`,
    filename,
    durationSeconds: 420,
    isInterlude: false,
    mediaType: 'video',
    dateStart: null,
    dateEnd: null,
    codec: 'h264',
    width: 1920,
    height: 1080,
    warning: null,
    mtime: 1,
    compatibility: 'compatible',
    rootId: 'tv',
    relativePath: `${title}/${filename}`,
    libraryKind: 'tv',
    collectionTitle: title,
    collectionId,
    seasonNumber: 1,
    episodeNumber: 1,
    episodeTitle: null,
    policyEnabled: false,
    playbackOverride: null,
    rootAvailable: true,
  }
}

describe('metadata enrichment and policy integration', () => {
  let repository: MediaRepository

  beforeEach(async () => {
    repository = new MediaRepository(':memory:')
    await repository.initialize()
  })

  afterEach(async () => {
    await repository.close()
  })

  async function addCollection(title: string, year: number | null = null) {
    const [collection] = await repository.upsertCollections([
      {
        rootId: 'tv',
        libraryKind: 'tv',
        identityKey: JSON.stringify([title.toLowerCase(), year]),
        sourceTitle: year === null ? title : `${title} (${year})`,
        parsedTitle: title,
        year,
      },
    ])
    if (!collection) throw new Error('Expected collection to be created')
    await repository.upsertMedia(mediaInput(collection.id, title))
    return collection
  }

  test('keeps a collection in review when the provider has no key', async () => {
    const collection = await addCollection('Bluey', 2018)
    const provider = providerFor({ configured: false })
    const service = new MetadataEnrichmentService(repository, provider, {
      ...runtimeConfig,
      tmdbApiKey: null,
    })

    const state = await service.runPending()
    const updated = await repository.getCollectionById(collection.id)

    expect(state).toMatchObject({
      status: 'not_configured',
      providerHealth: 'not_configured',
      processed: 1,
      matched: 0,
      needsReview: 1,
    })
    expect(updated).toMatchObject({
      metadataStatus: 'not_configured',
      policyDecision: 'review',
      effectiveDecision: 'review',
      scheduleEligibleCount: 0,
    })
    expect(await repository.getAllVideos()).toEqual([])
  })

  test('allows an exact TMDB match with a Kids 7-safe rating', async () => {
    const collection = await addCollection('Bluey', 2018)
    const service = new MetadataEnrichmentService(
      repository,
      providerFor({
        candidates: [
          {
            provider: 'tmdb',
            externalId: '82728',
            mediaType: 'tv',
            title: 'Bluey',
            originalTitle: 'Bluey',
            year: 2018,
          },
        ],
        certification: 'TV-Y7',
      }),
      runtimeConfig
    )

    expect(await service.runPending()).toMatchObject({
      status: 'completed',
      providerHealth: 'connected',
      processed: 1,
      matched: 1,
      needsReview: 0,
    })
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      metadataExternalId: '82728',
      metadataStatus: 'matched',
      certification: 'TV-Y7',
      ratingStatus: 'resolved',
      policyDecision: 'allow',
      effectiveDecision: 'allow',
      scheduleEligibleCount: 1,
    })
    expect(await repository.getAllVideos()).toHaveLength(1)
  })

  test('does not infer a connection from a configured key when no provider call ran', async () => {
    const service = new MetadataEnrichmentService(
      repository,
      providerFor({ configured: true }),
      runtimeConfig
    )

    expect(service.getState()).toMatchObject({
      status: 'idle',
      providerHealth: 'unverified',
    })
    expect(await service.runPending()).toMatchObject({
      status: 'completed',
      total: 0,
      providerHealth: 'unverified',
    })

    await service.testConnection()
    expect(service.getState()).toMatchObject({
      providerHealth: 'connected',
      providerMessage: null,
    })
  })

  test('degrades and redacts provider failures instead of leaking credentials', async () => {
    const collection = await addCollection('Network Failure', 2024)
    const error = new MetadataProviderError(
      'request failed with secret server-only-test-key',
      { code: 'network', provider: 'tmdb', retryable: true }
    )
    const service = new MetadataEnrichmentService(
      repository,
      providerFor({ searchError: error }),
      runtimeConfig
    )

    const state = await service.runPending()
    const updated = await repository.getCollectionById(collection.id)

    expect(state).toMatchObject({
      status: 'completed',
      providerHealth: 'degraded',
      providerMessage:
        'The metadata provider could not be reached over the network.',
      processed: 1,
      failed: 1,
    })
    expect(updated).toMatchObject({
      metadataStatus: 'error',
      policyDecision: 'review',
      effectiveDecision: 'review',
    })
    expect(JSON.stringify({ state, updated })).not.toContain(
      'server-only-test-key'
    )
  })

  test('records a failed connection test as degraded health', async () => {
    const error = new MetadataProviderError('credential secret', {
      code: 'unauthorized',
      provider: 'tmdb',
    })
    const service = new MetadataEnrichmentService(
      repository,
      providerFor({ connectionError: error }),
      runtimeConfig
    )

    await expect(service.testConnection()).rejects.toBe(error)
    expect(service.getState()).toMatchObject({
      providerHealth: 'degraded',
      providerMessage: 'The metadata provider rejected the configured credentials.',
    })
    expect(JSON.stringify(service.getState())).not.toContain('credential secret')
  })

  test('blocks a TV-14 match and never exposes it to scheduling', async () => {
    const collection = await addCollection('Teen Drama', 2024)
    const service = new MetadataEnrichmentService(
      repository,
      providerFor({
        candidates: [
          {
            provider: 'tmdb',
            externalId: '1400',
            mediaType: 'tv',
            title: 'Teen Drama',
            year: 2024,
          },
        ],
        certification: 'TV-14',
      }),
      runtimeConfig
    )

    await service.runPending()

    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      metadataStatus: 'matched',
      certification: 'TV-14',
      policyDecision: 'block',
      effectiveDecision: 'block',
      scheduleEligibleCount: 0,
    })
    expect(await repository.getAllVideos()).toEqual([])
  })

  test('sends ambiguous and unrated matches to parent review', async () => {
    const ambiguous = await addCollection('Shared Title', 2020)
    const ambiguousService = new MetadataEnrichmentService(
      repository,
      providerFor({
        candidates: [
          {
            provider: 'tmdb',
            externalId: '1',
            mediaType: 'tv',
            title: 'Shared Title',
            year: 2020,
          },
          {
            provider: 'tmdb',
            externalId: '2',
            mediaType: 'tv',
            title: 'Shared Title',
            year: 2020,
          },
        ],
      }),
      runtimeConfig
    )
    await ambiguousService.runPending()
    expect(await repository.getCollectionById(ambiguous.id)).toMatchObject({
      metadataStatus: 'ambiguous',
      policyDecision: 'review',
      effectiveDecision: 'review',
      scheduleEligibleCount: 0,
    })

    const unrated = await addCollection('No Rating', 2021)
    const unratedService = new MetadataEnrichmentService(
      repository,
      providerFor({
        candidates: [
          {
            provider: 'tmdb',
            externalId: '3',
            mediaType: 'tv',
            title: 'No Rating',
            year: 2021,
          },
        ],
        certification: null,
        ratingStatus: 'missing',
      }),
      runtimeConfig
    )
    await unratedService.runPending()
    expect(await repository.getCollectionById(unrated.id)).toMatchObject({
      metadataStatus: 'matched',
      ratingStatus: 'missing',
      certification: null,
      policyDecision: 'review',
      effectiveDecision: 'review',
      scheduleEligibleCount: 0,
    })
  })

  test('re-evaluates cached ratings when policy rules change without TMDB calls', async () => {
    const collection = await addCollection('Bluey', 2018)
    const originalService = new MetadataEnrichmentService(
      repository,
      providerFor({
        candidates: [
          {
            provider: 'tmdb',
            externalId: '82728',
            mediaType: 'tv',
            title: 'Bluey',
            year: 2018,
          },
        ],
        certification: 'TV-Y7',
      }),
      runtimeConfig
    )
    await originalService.runPending()
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      policyDecision: 'allow',
      effectiveDecision: 'allow',
    })

    const stricterProfile: RatingPolicyProfile = {
      id: 'strict-kids',
      name: 'Strict Kids',
      rules: {
        allow: ['G'],
        review: ['TV-Y'],
        block: ['TV-Y7'],
      },
    }
    const reloaded = new MetadataEnrichmentService(
      repository,
      providerFor({ candidates: [] }),
      runtimeConfig,
      stricterProfile
    )

    expect(await reloaded.reapplyCachedPolicies()).toBe(1)
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      certification: 'TV-Y7',
      policyDecision: 'block',
      effectiveDecision: 'block',
      policyProfileId: 'strict-kids',
      scheduleEligibleCount: 0,
    })
    expect(await repository.getAllVideos()).toEqual([])
  })

  test('missing startup policy revokes cached automatic allow but preserves parent authority', async () => {
    const collection = await addCollection('Bluey', 2018)
    const service = new MetadataEnrichmentService(
      repository,
      providerFor({
        candidates: [
          {
            provider: 'tmdb',
            externalId: '82728',
            mediaType: 'tv',
            title: 'Bluey',
            year: 2018,
          },
        ],
        certification: 'TV-Y7',
      }),
      runtimeConfig
    )
    await service.runPending()

    const noPolicy = new MetadataEnrichmentService(
      repository,
      providerFor({ candidates: [] }),
      runtimeConfig,
      null
    )
    expect(await noPolicy.reapplyCachedPolicies()).toBe(1)
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      policyDecision: 'review',
      policyReason: 'policy_missing',
      effectiveDecision: 'review',
      scheduleEligibleCount: 0,
    })

    await repository.updateCollectionOverride(collection.id, 'allow')
    expect(await noPolicy.reapplyCachedPolicies()).toBe(0)
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      policyDecision: 'review',
      parentOverride: 'allow',
      effectiveDecision: 'allow',
    })
  })

  test('holds cached ratings for review when regions change and refreshes a locked match', async () => {
    const collection = await addCollection('Bluey', 2018)
    const candidate: MetadataCandidate = {
      provider: 'tmdb',
      externalId: '82728',
      mediaType: 'tv',
      title: 'Bluey',
      originalTitle: 'Bluey',
      year: 2018,
    }
    const original = new MetadataEnrichmentService(
      repository,
      providerFor({ candidates: [candidate], certification: 'TV-Y7' }),
      runtimeConfig
    )
    expect(await original.synchronizeRatingRegions()).toBe(0)
    await original.runPending()
    await original.confirmMatch(collection.id, candidate.externalId)
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      metadataStatus: 'manual',
      metadataLocked: true,
      certification: 'TV-Y7',
      effectiveDecision: 'allow',
    })

    const changedConfig: MetadataRuntimeConfig = {
      ...runtimeConfig,
      preferredRatingRegion: 'AU',
    }
    const changed = new MetadataEnrichmentService(
      repository,
      providerFor({
        candidates: [candidate],
        certification: 'TV-14',
        certificationRegion: 'AU',
      }),
      changedConfig
    )
    expect(await changed.synchronizeRatingRegions()).toBe(1)
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      metadataExternalId: '82728',
      metadataStatus: 'pending',
      metadataLocked: true,
      certification: null,
      certificationRegion: null,
      policyDecision: 'review',
      effectiveDecision: 'review',
      scheduleEligibleCount: 0,
    })
    expect(await repository.getCollectionsNeedingMetadata()).toHaveLength(1)

    await changed.runPending()
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      metadataExternalId: '82728',
      metadataStatus: 'manual',
      metadataLocked: true,
      certification: 'TV-14',
      certificationRegion: 'AU',
      policyDecision: 'block',
      effectiveDecision: 'block',
      scheduleEligibleCount: 0,
    })
    expect(await repository.getAllVideos()).toEqual([])
  })
})
