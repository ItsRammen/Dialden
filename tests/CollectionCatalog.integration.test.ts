import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { MediaRepository } from '../src/repositories/MediaRepository'
import { CollectionLibraryService } from '../src/services/CollectionLibraryService'
import { MediaIndexer } from '../src/services/MediaIndexer'
import type {
  IFileSystem,
  IMediaProbe,
  InterludeConfig,
  MediaConfig,
  MediaMetadata,
} from '../src/types'

const TV_ROOT = '/media/tv'

class MutableLibrary implements IFileSystem {
  files: string[] = []

  listFiles(directory: string): string[] {
    return directory === TV_ROOT ? [...this.files] : []
  }

  exists(path: string): boolean {
    return path === TV_ROOT
  }

  isReadableDirectory(path: string): boolean {
    return this.exists(path)
  }

  getMtime(path: string): number | null {
    return this.files.includes(path) ? 1 : null
  }

  watch() {
    return { close() {} }
  }
}

const probe: IMediaProbe = {
  async getDuration() {
    return 420
  },
  async getMetadata(): Promise<MediaMetadata> {
    return {
      durationSeconds: 420,
      codec: 'h264',
      width: 1920,
      height: 1080,
      fps: 24,
      bitrateMbps: 4,
    }
  },
}

const mediaConfig: MediaConfig = {
  directory: TV_ROOT,
  databasePath: ':memory:',
  supportedExtensions: ['.mkv'],
  roots: [{ id: 'tv', directory: TV_ROOT, kind: 'tv' }],
}

const interludeConfig: InterludeConfig = {
  enabled: false,
  frequency: 0,
  directory: '/media/interludes',
}

describe('collection-first catalog integration', () => {
  let repository: MediaRepository
  let filesystem: MutableLibrary
  let indexer: MediaIndexer
  let library: CollectionLibraryService

  beforeEach(async () => {
    repository = new MediaRepository(':memory:')
    await repository.initialize()
    filesystem = new MutableLibrary()
    indexer = new MediaIndexer(
      mediaConfig,
      interludeConfig,
      repository,
      filesystem,
      probe
    )
    library = new CollectionLibraryService(repository)
  })

  afterEach(async () => {
    await repository.close()
  })

  test('groups three Bluey episodes across two seasons and lets a later episode inherit an allowed collection', async () => {
    filesystem.files = [
      `${TV_ROOT}/Bluey (2018)/Season 01/Bluey - S01E01 - Magic Xylophone.mkv`,
      `${TV_ROOT}/Bluey (2018)/Season 01/Bluey - S01E02 - Hospital.mkv`,
      `${TV_ROOT}/Bluey (2018)/Season 02/Bluey - S02E01 - Dance Mode.mkv`,
    ]

    expect(await indexer.scanAll()).toBe(3)

    const collections = await library.list({ kind: 'tv' })
    expect(collections).toHaveLength(1)
    expect(collections[0]).toMatchObject({
      sourceTitle: 'Bluey (2018)',
      parsedTitle: 'Bluey',
      year: 2018,
      fileCount: 3,
      episodeCount: 3,
      seasonCount: 2,
      effectiveDecision: 'review',
      scheduleEligibleCount: 0,
    })

    const collectionId = collections[0]?.id ?? 0
    const detail = await library.getDetail(collectionId)
    expect(detail?.seasons.map((season) => season.seasonNumber)).toEqual([1, 2])
    expect(detail?.seasons[0]?.episodes).toHaveLength(2)
    expect(detail?.seasons[1]?.episodes).toHaveLength(1)

    await repository.updateCollectionPolicy(
      collectionId,
      'allow',
      'rating_allowed'
    )
    expect(await repository.getAllVideos()).toHaveLength(3)

    filesystem.files.push(
      `${TV_ROOT}/Bluey (2018)/Season 02/Bluey - S02E02 - Sleepytime.mkv`
    )
    expect(await indexer.scanAll()).toBe(4)

    const rescanned = await repository.getCollectionById(collectionId)
    expect(rescanned).toMatchObject({
      id: collectionId,
      fileCount: 4,
      episodeCount: 4,
      seasonCount: 2,
      effectiveDecision: 'allow',
      scheduleEligibleCount: 4,
    })
    const added = (await repository.getCollectionMedia(collectionId)).find(
      (item) => item.episodeNumber === 2 && item.seasonNumber === 2
    )
    expect(added).toMatchObject({
      episodeTitle: 'Sleepytime',
      policyEnabled: true,
      playbackEnabled: true,
    })
  })

  test('keeps a parent approval made while the scanner is probing a file', async () => {
    filesystem.files = [
      `${TV_ROOT}/Bluey (2018)/Season 01/Bluey - S01E01 - Magic Xylophone.mkv`,
    ]
    let releaseProbe: ((metadata: MediaMetadata) => void) | undefined
    let announceProbeStarted: (() => void) | undefined
    const probeStarted = new Promise<void>((resolve) => {
      announceProbeStarted = resolve
    })
    const delayedProbe: IMediaProbe = {
      async getDuration() {
        return 420
      },
      getMetadata() {
        announceProbeStarted?.()
        return new Promise<MediaMetadata>((resolve) => {
          releaseProbe = resolve
        })
      },
    }
    indexer = new MediaIndexer(
      mediaConfig,
      interludeConfig,
      repository,
      filesystem,
      delayedProbe
    )

    const scan = indexer.scanAll()
    await probeStarted
    const [collection] = await repository.getCollections({ kind: 'tv' })
    expect(collection?.effectiveDecision).toBe('review')
    await repository.updateCollectionOverride(collection?.id ?? 0, 'allow')

    if (!releaseProbe) throw new Error('Expected the media probe to be pending')
    releaseProbe({
      durationSeconds: 420,
      codec: 'h264',
      width: 1920,
      height: 1080,
      fps: 24,
      bitrateMbps: 4,
    })
    expect(await scan).toBe(1)

    const approvedFiles = await repository.getMediaPage({
      filter: 'approved',
      limit: 100,
      offset: 0,
    })
    expect(approvedFiles.total).toBe(1)
    expect(approvedFiles.items[0]).toMatchObject({
      collectionId: collection?.id,
      policyEnabled: true,
      playbackEnabled: true,
    })
    expect(await repository.getCollectionById(collection?.id ?? 0)).toMatchObject({
      parentOverride: 'allow',
      scheduleEligibleCount: 1,
    })
  })

  test('preserves a parent override while a collection disappears and is upserted again', async () => {
    const [created] = await repository.upsertCollections([
      {
        rootId: 'tv',
        libraryKind: 'tv',
        identityKey: JSON.stringify(['bluey', 2018]),
        sourceTitle: 'Bluey (2018)',
        parsedTitle: 'Bluey',
        year: 2018,
      },
    ])
    const collectionId = created?.id ?? 0
    await repository.updateCollectionOverride(collectionId, 'block')

    await repository.reconcileCollections('tv', [])
    const [restored] = await repository.upsertCollections([
      {
        rootId: 'tv',
        libraryKind: 'tv',
        identityKey: JSON.stringify(['bluey', 2018]),
        sourceTitle: 'Bluey (2018)',
        parsedTitle: 'Bluey',
        year: 2018,
      },
    ])

    expect(restored).toMatchObject({
      id: collectionId,
      present: true,
      parentOverride: 'block',
      effectiveDecision: 'block',
      decisionSource: 'parent',
    })
  })
})
