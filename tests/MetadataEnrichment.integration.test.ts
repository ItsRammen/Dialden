import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type {
  CertificationLookup,
  MetadataCandidate,
  MetadataProvider,
  MetadataSearchInput,
  ProviderTitleDetails,
  ProviderEpisodeDetails,
} from '../src/metadata/types'
import { MetadataProviderError } from '../src/metadata/types'
import {
  METADATA_CONFIG_SETTING_KEY,
  type MetadataRuntimeConfig,
} from '../src/config/metadata'
import type {
  IMediaRepository,
  MediaItemInput,
} from '../src/repositories/IMediaRepository'
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
  readonly candidatesForSearch?: (
    input: MetadataSearchInput
  ) => readonly MetadataCandidate[]
  readonly detailsForLanguage?: (
    language: string,
    candidate: MetadataCandidate
  ) => ProviderTitleDetails
  readonly episodes?: readonly ProviderEpisodeDetails[]
}

function providerFor(scenario: ProviderScenario): MetadataProvider {
  const candidates = [...(scenario.candidates ?? [])]
  const detailsFor = (
    externalId: string,
    language: string
  ): ProviderTitleDetails => {
    const candidate = candidates.find((item) => item.externalId === externalId)
    if (!candidate) throw new Error(`Unexpected details lookup for ${externalId}`)
    if (scenario.detailsForLanguage) {
      return scenario.detailsForLanguage(language, candidate)
    }
    return {
      ...candidate,
      genres: ['Animation', 'Family'],
      networks: ['ABC Kids'],
      studios: ['Ludo Studio'],
    }
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
    async searchMovie(input: MetadataSearchInput) {
      if (scenario.searchError) throw scenario.searchError
      return [...(scenario.candidatesForSearch?.(input) ?? candidates)]
    },
    async searchTV(input: MetadataSearchInput) {
      if (scenario.searchError) throw scenario.searchError
      return [...(scenario.candidatesForSearch?.(input) ?? candidates)]
    },
    async getMovie(externalId: string, input) {
      return detailsFor(externalId, input.language)
    },
    async getTV(externalId: string, input) {
      return detailsFor(externalId, input.language)
    },
    async getTVSeason() {
      return scenario.episodes ?? []
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
      networks: ['ABC Kids'],
      studios: ['Ludo Studio'],
      policyDecision: 'allow',
      effectiveDecision: 'allow',
      scheduleEligibleCount: 1,
    })
    expect(await repository.getAllVideos()).toHaveLength(1)
  })

  test('retries without the year when a regional release year hides the exact title', async () => {
    const collection = await addCollection('A Close Shave', 1995)
    const exact: MetadataCandidate = {
      provider: 'tmdb',
      externalId: '532',
      mediaType: 'tv',
      title: 'A Close Shave',
      year: 1996,
    }
    const derivative: MetadataCandidate = {
      provider: 'tmdb',
      externalId: '999',
      mediaType: 'tv',
      title: 'The Digital Special Effects in "A Close Shave"',
      year: 1995,
    }
    const searchedYears: Array<number | undefined> = []
    const service = new MetadataEnrichmentService(
      repository,
      providerFor({
        candidates: [exact, derivative],
        candidatesForSearch(input) {
          searchedYears.push(input.year)
          return input.year === 1995 ? [derivative] : [exact, derivative]
        },
        certification: 'TV-Y7',
      }),
      runtimeConfig
    )

    await service.runPending()

    expect(searchedYears).toEqual([1995, undefined])
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      metadataExternalId: '532',
      metadataStatus: 'matched',
      matchConfidence: 0.98,
    })
  })

  test('stores TMDB episode titles separately from filename-derived titles', async () => {
    const collection = await addCollection('The Magic School Bus')
    const service = new MetadataEnrichmentService(
      repository,
      providerFor({
        candidates: [
          {
            provider: 'tmdb',
            externalId: '123',
            mediaType: 'tv',
            title: 'The Magic School Bus',
          },
        ],
        certification: 'TV-Y7',
        episodes: [
          {
            seasonNumber: 1,
            episodeNumber: 1,
            title: 'Gets Lost in Space',
            overview: 'The class explores the solar system.',
            airDate: '1994-09-10',
            stillPath: '/space.jpg',
          },
        ],
      }),
      runtimeConfig
    )

    await service.runPending()
    const [episode] = await repository.getCollectionMedia(collection.id)
    expect(episode).toMatchObject({
      episodeMetadataTitle: 'Gets Lost in Space',
      episodeOverview: 'The class explores the solar system.',
      episodeAirDate: '1994-09-10',
      episodeStillPath: '/space.jpg',
    })
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

  test('tests supplied settings without persisting or exposing the candidate key', async () => {
    const builtConfigs: MetadataRuntimeConfig[] = []
    const service = new MetadataEnrichmentService(
      repository,
      providerFor({ configured: true }),
      runtimeConfig,
      undefined,
      (config) => {
        builtConfigs.push(config)
        return providerFor({ configured: config.tmdbApiKey !== null })
      }
    )
    const candidateKey = 'candidate-secret-value-123456'

    await service.testConfiguration({})
    await service.testConfiguration({
      tmdbApiKey: candidateKey,
      language: 'zh-tw',
      preferredRatingRegion: 'tw',
      fallbackRatingRegions: 'US',
      requestTimeoutMs: '2500',
    })

    expect(service.getState().providerHealth).toBe('connected')
    expect(builtConfigs).toEqual([
      {
        tmdbApiKey: candidateKey,
        language: 'zh-TW',
        preferredRatingRegion: 'TW',
        fallbackRatingRegions: ['US'],
        requestTimeoutMs: 2500,
      },
    ])
    expect(await repository.getSetting(METADATA_CONFIG_SETTING_KEY)).toBeNull()
    expect(service.getPublicConfig()).toMatchObject({
      configured: true,
      language: runtimeConfig.language,
    })
    expect(JSON.stringify(service.getPublicConfig())).not.toContain(candidateKey)
  })

  test('keeps the saved and active configuration unchanged when region invalidation fails', async () => {
    const collection = await addCollection('Bluey', 2018)
    const candidate: MetadataCandidate = {
      provider: 'tmdb',
      externalId: '82728',
      mediaType: 'tv',
      title: 'Bluey',
      year: 2018,
    }
    const initial = new MetadataEnrichmentService(
      repository,
      providerFor({ candidates: [candidate], certification: 'TV-Y7' }),
      runtimeConfig
    )
    await initial.synchronizeRatingRegions()
    await initial.runPending()

    const invalidationFailure = new Error('simulated invalidation failure')
    const failingRepository = new Proxy(repository as IMediaRepository, {
      get(target, property, receiver) {
        if (property === 'updateCollectionMetadata') {
          return async (
            id: number,
            metadata: Parameters<
              IMediaRepository['updateCollectionMetadata']
            >[1]
          ) => {
            if (metadata.status === 'pending') throw invalidationFailure
            return target.updateCollectionMetadata(id, metadata)
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    let activeProviderTests = 0
    let candidateProviderTests = 0
    const activeProvider: MetadataProvider = {
      ...providerFor({ configured: true }),
      async testConnection() {
        activeProviderTests++
      },
    }
    const service = new MetadataEnrichmentService(
      failingRepository,
      activeProvider,
      runtimeConfig,
      undefined,
      () => ({
        ...providerFor({ configured: true }),
        async testConnection() {
          candidateProviderTests++
        },
      })
    )

    await expect(
      service.updateConfiguration({ preferredRatingRegion: 'AU' })
    ).rejects.toBe(invalidationFailure)

    expect(service.getPublicConfig()).toMatchObject({
      language: 'en-US',
      preferredRatingRegion: 'US',
    })
    expect(await repository.getSetting(METADATA_CONFIG_SETTING_KEY)).toBeNull()
    await service.testConnection()
    expect(activeProviderTests).toBe(1)
    expect(candidateProviderTests).toBe(0)
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      metadataStatus: 'matched',
      certification: 'TV-Y7',
      policyDecision: 'review',
      effectiveDecision: 'review',
      scheduleEligibleCount: 0,
    })
  })

  test('requeues direct matches when language changes and refreshes localized fields', async () => {
    const collection = await addCollection('Bluey', 2018)
    const candidate: MetadataCandidate = {
      provider: 'tmdb',
      externalId: '82728',
      mediaType: 'tv',
      title: 'Bluey',
      originalTitle: 'Bluey',
      year: 2018,
    }
    const requestedLanguages: string[] = []
    const service = new MetadataEnrichmentService(
      repository,
      providerFor({ candidates: [candidate], certification: 'TV-Y7' }),
      runtimeConfig,
      undefined,
      () =>
        providerFor({
          candidates: [candidate],
          certification: 'TV-Y7',
          detailsForLanguage(language) {
            requestedLanguages.push(language)
            return {
              ...candidate,
              title: '妙妙犬布麗',
              overview: '繁體中文簡介',
              posterPath: '/bluey-zh-poster.jpg',
              backdropPath: '/bluey-zh-backdrop.jpg',
              genres: ['動畫', '家庭'],
              networks: ['澳洲兒童頻道'],
              studios: ['魯多工作室'],
            }
          },
        })
    )
    await service.synchronizeRatingRegions()
    await service.runPending()
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      metadataStatus: 'matched',
      metadataTitle: 'Bluey',
      policyDecision: 'allow',
    })

    await service.updateConfiguration({ language: 'zh-TW' })
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      metadataStatus: 'pending',
      policyDecision: 'allow',
      effectiveDecision: 'allow',
      scheduleEligibleCount: 1,
    })

    await service.runPending()
    expect(requestedLanguages).toEqual(['zh-TW'])
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      metadataStatus: 'matched',
      metadataTitle: '妙妙犬布麗',
      overview: '繁體中文簡介',
      posterPath: '/bluey-zh-poster.jpg',
      backdropPath: '/bluey-zh-backdrop.jpg',
      genres: ['動畫', '家庭'],
      networks: ['澳洲兒童頻道'],
      studios: ['魯多工作室'],
      certification: 'TV-Y7',
      policyDecision: 'allow',
    })
    expect(
      JSON.parse(
        (await repository.getSetting(METADATA_CONFIG_SETTING_KEY)) ?? '{}'
      ).language
    ).toBe('zh-TW')
  })

  test('does not let a pending run hydrate a region change with the old provider', async () => {
    const collection = await addCollection('Bluey', 2018)
    const candidate: MetadataCandidate = {
      provider: 'tmdb',
      externalId: '82728',
      mediaType: 'tv',
      title: 'Bluey',
      year: 2018,
    }
    const initial = new MetadataEnrichmentService(
      repository,
      providerFor({ candidates: [candidate], certification: 'TV-Y7' }),
      runtimeConfig
    )
    await initial.synchronizeRatingRegions()
    await initial.runPending()

    let releaseInvalidation!: () => void
    let invalidationStarted!: () => void
    const invalidationGate = new Promise<void>((resolve) => {
      releaseInvalidation = resolve
    })
    const invalidationEntered = new Promise<void>((resolve) => {
      invalidationStarted = resolve
    })
    let paused = false
    const gatedRepository = new Proxy(repository as IMediaRepository, {
      get(target, property, receiver) {
        if (property === 'updateCollectionMetadata') {
          return async (
            id: number,
            metadata: Parameters<
              IMediaRepository['updateCollectionMetadata']
            >[1]
          ) => {
            if (!paused && metadata.status === 'pending') {
              paused = true
              invalidationStarted()
              await invalidationGate
            }
            return target.updateCollectionMetadata(id, metadata)
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    let oldProviderHydrations = 0
    let newProviderHydrations = 0
    const oldBase = providerFor({
      candidates: [candidate],
      certification: 'TV-Y7',
    })
    const oldProvider: MetadataProvider = {
      ...oldBase,
      async getTV(externalId, input) {
        oldProviderHydrations++
        return oldBase.getTV(externalId, input)
      },
    }
    const service = new MetadataEnrichmentService(
      gatedRepository,
      oldProvider,
      runtimeConfig,
      undefined,
      () => {
        const nextBase = providerFor({
          candidates: [candidate],
          certification: 'TV-Y7',
          certificationRegion: 'AU',
        })
        return {
          ...nextBase,
          async getTV(externalId, input) {
            newProviderHydrations++
            return nextBase.getTV(externalId, input)
          },
        }
      }
    )

    const update = service.updateConfiguration({
      preferredRatingRegion: 'AU',
    })
    await invalidationEntered
    const pending = service.runPending()
    await Promise.resolve()
    expect(oldProviderHydrations).toBe(0)
    expect(newProviderHydrations).toBe(0)

    releaseInvalidation()
    await update
    await pending

    expect(oldProviderHydrations).toBe(0)
    expect(newProviderHydrations).toBe(1)
    expect(service.getPublicConfig().preferredRatingRegion).toBe('AU')
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      metadataStatus: 'matched',
      certificationRegion: 'AU',
      policyDecision: 'allow',
    })
  })

  test('persists a live provider swap while blank key input keeps the secret', async () => {
    const builtConfigs: MetadataRuntimeConfig[] = []
    const service = new MetadataEnrichmentService(
      repository,
      providerFor({ configured: true }),
      runtimeConfig,
      undefined,
      (config) => {
        builtConfigs.push(config)
        return providerFor({ configured: config.tmdbApiKey !== null })
      }
    )

    const publicConfig = await service.updateConfiguration({
      tmdbApiKey: '',
      language: 'en-GB',
      preferredRatingRegion: 'gb',
      fallbackRatingRegions: 'US, GB',
      requestTimeoutMs: '3500',
    })

    expect(builtConfigs[0]).toEqual({
      tmdbApiKey: runtimeConfig.tmdbApiKey,
      language: 'en-GB',
      preferredRatingRegion: 'GB',
      fallbackRatingRegions: ['US'],
      requestTimeoutMs: 3500,
    })
    expect(publicConfig).toEqual({
      provider: 'tmdb',
      configured: true,
      language: 'en-GB',
      preferredRatingRegion: 'GB',
      fallbackRatingRegions: ['US'],
      requestTimeoutMs: 3500,
    })
    expect(JSON.stringify(publicConfig)).not.toContain(runtimeConfig.tmdbApiKey!)

    const saved = JSON.parse(
      (await repository.getSetting(METADATA_CONFIG_SETTING_KEY)) ?? '{}'
    )
    expect(saved.tmdbApiKey).toBe(runtimeConfig.tmdbApiKey)
    expect(saved.preferredRatingRegion).toBe('GB')
  })
})
