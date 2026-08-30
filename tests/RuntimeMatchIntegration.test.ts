import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type {
  CertificationLookup,
  MetadataCandidate,
  MetadataProvider,
  ProviderTitleDetails,
} from '../src/metadata/types'
import type { MetadataRuntimeConfig } from '../src/config/metadata'
import type { MediaItemInput } from '../src/repositories/IMediaRepository'
import { MediaRepository } from '../src/repositories/MediaRepository'
import { MetadataEnrichmentService } from '../src/services/metadata/MetadataEnrichmentService'

const runtimeConfig: MetadataRuntimeConfig = {
  tmdbApiKey: 'server-only-test-key',
  language: 'en-US',
  preferredRatingRegion: 'US',
  fallbackRatingRegions: [],
  requestTimeoutMs: 1_000,
}

/** The real collision: three records agreeing on title and year. */
const aliceCandidates: MetadataCandidate[] = [
  { provider: 'tmdb', externalId: '12155', mediaType: 'movie', title: 'Alice in Wonderland', year: 2010 },
  { provider: 'tmdb', externalId: '135361', mediaType: 'movie', title: 'Alice in Wonderland', year: 2010 },
  { provider: 'tmdb', externalId: '423971', mediaType: 'movie', title: 'Alice in Wonderland', year: 2010 },
]

function providerWithRuntimes(
  runtimes: Record<string, number | undefined>,
  candidates: MetadataCandidate[] = aliceCandidates
): MetadataProvider {
  const details = (externalId: string): ProviderTitleDetails => {
    const candidate = candidates.find((item) => item.externalId === externalId)
    if (!candidate) throw new Error(`Unexpected lookup for ${externalId}`)
    const minutes = runtimes[externalId]
    return {
      ...candidate,
      ...(minutes === undefined ? {} : { runtimeMinutes: minutes }),
      genres: ['Fantasy'],
      networks: [],
      studios: [],
    }
  }
  const rating = (): CertificationLookup => ({
    status: 'resolved',
    selected: { region: 'US', certification: 'PG' },
    all: [{ region: 'US', certification: 'PG' }],
  })
  return {
    id: 'tmdb',
    configured: true,
    async testConnection() {},
    async searchMovie() {
      return [...candidates]
    },
    async searchTV() {
      return [...candidates]
    },
    async getMovie(externalId) {
      return details(externalId)
    },
    async getTV(externalId) {
      return details(externalId)
    },
    async getTVSeason() {
      return []
    },
    async getMovieCertification() {
      return rating()
    },
    async getTVContentRating() {
      return rating()
    },
  }
}

function movieFile(collectionId: number, durationSeconds: number): MediaItemInput {
  return {
    path: '/media/movies/Alice in Wonderland (2010).mp4',
    filename: 'Alice in Wonderland (2010).mp4',
    durationSeconds,
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
    rootId: 'movies',
    relativePath: 'Alice in Wonderland (2010).mp4',
    libraryKind: 'movie',
    collectionTitle: 'Alice in Wonderland',
    collectionId,
    seasonNumber: null,
    episodeNumber: null,
    episodeTitle: null,
    policyEnabled: false,
    playbackOverride: null,
    rootAvailable: true,
  }
}

describe('resolving a tie from the file on disk', () => {
  let repository: MediaRepository

  beforeEach(async () => {
    repository = new MediaRepository(':memory:')
    await repository.initialize()
  })

  afterEach(async () => {
    await repository.close()
  })

  async function seed(durationSeconds: number) {
    const [collection] = await repository.upsertCollections([
      {
        rootId: 'movies',
        libraryKind: 'movie',
        identityKey: JSON.stringify(['alice in wonderland', 2010]),
        sourceTitle: 'Alice in Wonderland (2010)',
        parsedTitle: 'Alice in Wonderland',
        year: 2010,
      },
    ])
    if (!collection) throw new Error('Expected a collection')
    await repository.upsertMedia(movieFile(collection.id, durationSeconds))
    return collection
  }

  test('matches the candidate the file length identifies', async () => {
    // 6514 seconds is 108.6 minutes: Burton's film, not the other two.
    const collection = await seed(6514)
    const service = new MetadataEnrichmentService(
      repository,
      providerWithRuntimes({ '12155': 108, '135361': 33, '423971': 52 }),
      runtimeConfig,
      null,
      undefined,
      repository
    )

    await service.runPending()
    const updated = await repository.getCollectionById(collection.id)

    expect(updated?.metadataStatus).toBe('matched')
    expect(updated?.metadataExternalId).toBe('12155')
  })

  test('records the decision so it can be undone', async () => {
    const collection = await seed(6514)
    const service = new MetadataEnrichmentService(
      repository,
      providerWithRuntimes({ '12155': 108, '135361': 33, '423971': 52 }),
      runtimeConfig,
      null,
      undefined,
      repository
    )

    await service.runPending()
    const [decision] = await repository.listReviewDecisions()

    expect(decision?.collectionId).toBe(collection.id)
    expect(decision?.action).toBe('match')
    expect(decision?.detail).toContain('109 min')
    expect(decision?.detail).toContain('108 min')
    expect(decision?.previousMetadataStatus).toBe('pending')
  })

  test('leaves the collection for review when a rival is also close', async () => {
    const collection = await seed(6514)
    const service = new MetadataEnrichmentService(
      repository,
      providerWithRuntimes({ '12155': 108, '135361': 110, '423971': 52 }),
      runtimeConfig,
      null,
      undefined,
      repository
    )

    await service.runPending()
    const updated = await repository.getCollectionById(collection.id)

    expect(updated?.metadataStatus).toBe('ambiguous')
    expect(await repository.listReviewDecisions()).toHaveLength(0)
  })

  test('leaves the collection for review when a runtime is unknown', async () => {
    const collection = await seed(6514)
    const service = new MetadataEnrichmentService(
      repository,
      providerWithRuntimes({ '12155': 108, '135361': undefined, '423971': 52 }),
      runtimeConfig,
      null,
      undefined,
      repository
    )

    await service.runPending()
    const updated = await repository.getCollectionById(collection.id)

    expect(updated?.metadataStatus).toBe('ambiguous')
  })

  test('leaves the collection for review when the file was never probed', async () => {
    const collection = await seed(0)
    const service = new MetadataEnrichmentService(
      repository,
      providerWithRuntimes({ '12155': 108, '135361': 33, '423971': 52 }),
      runtimeConfig,
      null,
      undefined,
      repository
    )

    await service.runPending()
    const updated = await repository.getCollectionById(collection.id)

    expect(updated?.metadataStatus).toBe('ambiguous')
  })
})
