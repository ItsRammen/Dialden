/**
 * Unit tests for MediaIndexer
 */

import { describe, expect, test, beforeEach } from 'bun:test'
import { mock, type MockProxy } from 'jest-mock-extended'
import { MediaIndexer } from '../src/services/MediaIndexer'
import type { IMediaRepository } from '../src/repositories/IMediaRepository'
import type {
  IFileSystem,
  IMediaProbe,
  MediaConfig,
  InterludeConfig,
  LibraryScanEvent,
} from '../src/types'

describe('MediaIndexer', () => {
  let repo: MockProxy<IMediaRepository>
  let fs: MockProxy<IFileSystem>
  let probe: MockProxy<IMediaProbe>
  let indexer: MediaIndexer

  const mediaConfig: MediaConfig = {
    directory: '/media/videos',
    supportedExtensions: ['.mp4', '.mkv'],
    databasePath: ':memory:',
  }

  const interludeConfig: InterludeConfig = {
    enabled: true,
    frequency: 2,
    directory: '/media/interludes',
  }

  beforeEach(() => {
    repo = mock<IMediaRepository>()
    fs = mock<IFileSystem>()
    probe = mock<IMediaProbe>()

    // Default mocks
    repo.upsertMedia.mockResolvedValue()
    repo.upsertBatch.mockResolvedValue()
    repo.getByPaths.mockResolvedValue(new Map()) // All files are new by default
    repo.getByRootRelativePaths.mockResolvedValue(new Map())
    repo.getAll.mockResolvedValue([])
    repo.removeNotInPaths.mockResolvedValue(0)
    repo.removeNotInRootPaths.mockResolvedValue(0)
    fs.exists.mockReturnValue(true)
    fs.listFiles.mockReturnValue([]) // Default to empty list
    fs.getMtime.mockReturnValue(Date.now()) // Current timestamp
    probe.getDuration.mockResolvedValue(60)
    probe.getMetadata.mockResolvedValue({
      durationSeconds: 60,
      codec: 'h264',
      width: 1920,
      height: 1080,
      fps: 30,
      bitrateMbps: 10,
      hasAudio: true,
      audioCodec: 'aac',
    })

    indexer = new MediaIndexer(mediaConfig, interludeConfig, repo, fs, probe)
  })

  test('scanAll indexes videos and interludes', async () => {
    // Setup file listing with simpler matchers
    // We can check calls later, just set return values for now if specific matchers fail
    fs.listFiles
      .mockReturnValueOnce([
        '/media/videos/show1.mp4',
        '/media/videos/show2.mp4',
      ])
      .mockReturnValueOnce(['/media/interludes/bump.mp4'])

    probe.getDuration.mockResolvedValue(1200)

    const result = await indexer.scanAll()

    expect(result).toBe(3) // 2 videos + 1 interlude
    // Now using batch upsert - called once per directory scan
    expect(repo.upsertBatch).toHaveBeenCalledTimes(2)

    // Check first batch (videos)
    const videoBatchCall = repo.upsertBatch.mock.calls[0]?.[0]
    expect(videoBatchCall).toHaveLength(2)
    expect(videoBatchCall).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filename: 'show1.mp4',
          mediaType: 'video',
          isInterlude: false,
        }),
        expect.objectContaining({
          filename: 'show2.mp4',
          mediaType: 'video',
          isInterlude: false,
        }),
      ])
    )

    // Check second batch (interludes)
    const interludeBatchCall = repo.upsertBatch.mock.calls[1]?.[0]
    expect(interludeBatchCall).toHaveLength(1)
    expect(interludeBatchCall?.[0]).toEqual(
      expect.objectContaining({
        filename: 'bump.mp4',
        mediaType: 'interlude',
        isInterlude: true,
      })
    )
  })

  test('scanAll handles missing directory', async () => {
    fs.exists.calledWith(mediaConfig.directory).mockReturnValue(false)
    // fs.listFiles default is [] which is fine

    const result = await indexer.scanAll()

    expect(result).toBe(0)
    expect(repo.upsertBatch).not.toHaveBeenCalled()
  })

  test('scanAll reconciles a readable root that is intentionally empty', async () => {
    repo.getAll.mockResolvedValue([
      {
        id: 42,
        path: '/media/videos/existing.mp4',
        filename: 'existing.mp4',
        durationSeconds: 60,
        isInterlude: false,
        mediaType: 'video',
        dateStart: null,
        dateEnd: null,
        codec: 'h264',
        width: 1920,
        height: 1080,
        warning: null,
        mtime: 123,
        compatibility: 'compatible',
      },
    ])

    const result = await indexer.scanAll()

    expect(result).toBe(0)
    expect(repo.removeNotInPaths).not.toHaveBeenCalled()
    expect(repo.removeNotInRootPaths).toHaveBeenCalledWith('media', [])
    expect(repo.removeNotInRootPaths).toHaveBeenCalledWith('interludes', [])
  })

  test('scanAll preserves an unavailable root while reconciling healthy roots', async () => {
    const multiRootConfig: MediaConfig = {
      ...mediaConfig,
      roots: [
        { id: 'tv', directory: '/media/tv', kind: 'tv' },
        { id: 'movies', directory: '/media/movies', kind: 'movie' },
      ],
    }
    fs.exists.calledWith('/media/tv').mockReturnValue(false)
    fs.exists.calledWith('/media/movies').mockReturnValue(true)
    fs.listFiles.mockReturnValue([])

    indexer = new MediaIndexer(
      multiRootConfig,
      interludeConfig,
      repo,
      fs,
      probe
    )
    const events: LibraryScanEvent[] = []
    indexer.onScanEvent((event) => {
      events.push(event)
    })
    await indexer.scanAll()

    expect(repo.setRootAvailable).toHaveBeenCalledWith('tv', false)
    expect(repo.removeNotInRootPaths).not.toHaveBeenCalledWith('tv', [])
    expect(repo.removeNotInRootPaths).toHaveBeenCalledWith('movies', [])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'library.scan.root.unavailable',
        state: expect.objectContaining({ currentRoot: 'tv' }),
      })
    )
  })

  test('routine scan keeps a healthy root available while its files are probed', async () => {
    const managedConfig: MediaConfig = {
      ...mediaConfig,
      roots: [{ id: 'tv', directory: '/media/tv', kind: 'tv' }],
    }
    fs.listFiles.mockImplementation((directory) =>
      directory === '/media/tv' ? ['/media/tv/Bluey/episode.mkv'] : []
    )
    let markProbeStarted!: () => void
    let releaseProbe!: () => void
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve
    })
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    probe.getMetadata.mockImplementation(async () => {
      markProbeStarted()
      await probeGate
      return {
        durationSeconds: 420,
        codec: 'h264',
        width: 1920,
        height: 1080,
        fps: 24,
        bitrateMbps: 4,
        hasAudio: true,
        audioCodec: 'aac',
      }
    })
    indexer = new MediaIndexer(
      managedConfig,
      interludeConfig,
      repo,
      fs,
      probe
    )

    const scan = indexer.scanAll()
    await probeStarted

    expect(repo.setRootAvailable).not.toHaveBeenCalledWith('tv', false)

    releaseProbe()
    await scan
    expect(repo.setRootAvailable).toHaveBeenCalledWith('tv', true)
  })

  test('scan traversal failure gates only the failed root and identifies it', async () => {
    const managedConfig: MediaConfig = {
      ...mediaConfig,
      roots: [{ id: 'tv', directory: '/media/tv', kind: 'tv' }],
    }
    fs.listFiles.mockImplementation((directory) => {
      if (directory === '/media/tv') throw new Error('stale NAS handle')
      return []
    })
    indexer = new MediaIndexer(
      managedConfig,
      interludeConfig,
      repo,
      fs,
      probe
    )
    const events: LibraryScanEvent[] = []
    indexer.onScanEvent((event) => {
      events.push(event)
    })

    expect(await indexer.scanAll()).toBe(0)

    expect(repo.setRootAvailable).toHaveBeenCalledWith('tv', false)
    expect(repo.removeNotInRootPaths).not.toHaveBeenCalledWith('tv', [])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'library.scan.root.unavailable',
        state: expect.objectContaining({ currentRoot: 'tv' }),
      })
    )
  })

  test('managed roots probe all files and use effective collection decisions', async () => {
    const multiRootConfig: MediaConfig = {
      ...mediaConfig,
      roots: [
        {
          id: 'tv',
          directory: '/media/tv',
          kind: 'tv',
          approvedCollections: ['Bluey (2018)'],
        },
      ],
    }
    fs.listFiles
      .mockReturnValueOnce([
        '/media/tv/Bluey (2018)/Season 01/Bluey - S01E01.mkv',
        '/media/tv/South Park/Season 01/South Park - S01E01.mkv',
      ])
      .mockReturnValueOnce([])
    repo.upsertCollections.mockImplementation(async (collections) =>
      collections.map(
        (collection, index) =>
          ({
            ...collection,
            id: index + 1,
            effectiveDecision:
              collection.sourceTitle === 'Bluey (2018)' ? 'allow' : 'block',
          }) as any
      )
    )

    indexer = new MediaIndexer(
      multiRootConfig,
      interludeConfig,
      repo,
      fs,
      probe
    )
    await indexer.scanAll()

    expect(probe.getMetadata).toHaveBeenCalledTimes(2)
    expect(probe.getMetadata).toHaveBeenCalledWith(
      '/media/tv/Bluey (2018)/Season 01/Bluey - S01E01.mkv'
    )
    const batch = repo.upsertBatch.mock.calls[0]?.[0]
    expect(batch).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rootId: 'tv',
          relativePath: 'Bluey (2018)/Season 01/Bluey - S01E01.mkv',
          libraryKind: 'tv',
          collectionTitle: 'Bluey (2018)',
          policyEnabled: true,
          collectionId: 1,
        }),
        expect.objectContaining({
          collectionTitle: 'South Park',
          policyEnabled: false,
          durationSeconds: 60,
          collectionId: 2,
        }),
      ])
    )
  })

  test('queues matched shows for TMDB episode refresh when a file gains episode coordinates', async () => {
    const path =
      '/media/tv/CatDog/Season 03/Catdog - S03 E08-E09 - Remain Seated And Catdog Catcher (1080P - Web-Dl)-91.mkv'
    const multiRootConfig: MediaConfig = {
      ...mediaConfig,
      roots: [{ id: 'tv', directory: '/media/tv', kind: 'tv' }],
    }
    fs.listFiles
      .mockReturnValueOnce([path])
      .mockReturnValueOnce([])
    repo.upsertCollections.mockImplementation(async (collections) =>
      collections.map(
        (collection) =>
          ({
            ...collection,
            id: 27,
            effectiveDecision: 'allow',
            metadataProvider: 'tmdb',
            metadataExternalId: '606',
            metadataStatus: 'matched',
          }) as any
      )
    )

    indexer = new MediaIndexer(
      multiRootConfig,
      interludeConfig,
      repo,
      fs,
      probe
    )
    await indexer.scanAll()

    expect(repo.upsertBatch.mock.calls[0]?.[0]?.[0]).toEqual(
      expect.objectContaining({
        seasonNumber: 3,
        episodeNumber: 8,
        episodeTitle: 'Remain Seated And Catdog Catcher',
      })
    )
    expect(repo.updateCollectionMetadata).toHaveBeenCalledWith(27, {
      provider: 'tmdb',
      externalId: '606',
      status: 'pending',
      error: null,
    })
  })

  test('coalesces per-file progress events while preserving root and terminal state', async () => {
    const files = Array.from(
      { length: 40 },
      (_, index) => `/media/videos/show-${index}.mp4`
    )
    fs.listFiles.mockImplementation((directory) =>
      directory === '/media/videos' ? files : []
    )

    let clockMs = 0
    probe.getMetadata.mockImplementation(async () => {
      // Four probes complete per batch. At 25 ms each, the indexer sees a
      // sustained one-second scan without making this test wait in real time.
      clockMs += 25
      return {
        durationSeconds: 60,
        codec: 'h264',
        width: 1920,
        height: 1080,
        fps: 30,
        bitrateMbps: 10,
      hasAudio: true,
      audioCodec: 'aac',
      }
    })
    indexer = new MediaIndexer(
      mediaConfig,
      interludeConfig,
      repo,
      fs,
      probe,
      undefined,
      undefined,
      { nowMs: () => clockMs }
    )

    const received: Array<{ event: LibraryScanEvent; atMs: number }> = []
    indexer.onScanEvent((event) => {
      received.push({ event, atMs: clockMs })
    })

    expect(await indexer.scanAll()).toBe(40)

    const progress = received.filter(
      ({ event }) => event.type === 'library.scan.progress'
    )
    expect(progress).toHaveLength(6)
    for (let index = 1; index < progress.length; index++) {
      expect(
        (progress[index]?.atMs ?? 0) - (progress[index - 1]?.atMs ?? 0)
      ).toBeGreaterThanOrEqual(200)
    }

    const rootCompleted = received.filter(
      ({ event }) => event.type === 'library.scan.root.completed'
    )
    expect(rootCompleted).toHaveLength(2)
    expect(rootCompleted[0]?.event.state.processedFiles).toBe(40)
    expect(rootCompleted[1]?.event.state.processedFiles).toBe(40)

    const completed = received.filter(
      ({ event }) => event.type === 'library.scan.completed'
    )
    expect(completed).toHaveLength(1)
    expect(completed[0]?.event.state).toMatchObject({
      status: 'completed',
      discoveredFiles: 40,
      processedFiles: 40,
      indexedFiles: 40,
      failedFiles: 0,
    })
    expect(received.at(-1)?.event.type).toBe('library.scan.completed')
  })

  test('uses the stable locator to preserve metadata across a root path change', async () => {
    const existing = {
      id: 17,
      path: '/old-tv/Manual Pick/episode.mkv',
      filename: 'episode.mkv',
      durationSeconds: 720,
      isInterlude: false,
      mediaType: 'video' as const,
      dateStart: null,
      dateEnd: null,
      codec: 'hevc',
      width: 3840,
      height: 2160,
      warning: 'Requires a compatible client',
      mtime: 123,
      compatibility: 'incompatible' as const,
      rootId: 'tv',
      relativePath: 'Manual Pick/episode.mkv',
      libraryKind: 'tv' as const,
      collectionTitle: 'Manual Pick',
      policyEnabled: false,
      playbackOverride: true,
      rootAvailable: true,
      playbackEnabled: true,
    }
    const managedConfig: MediaConfig = {
      ...mediaConfig,
      roots: [
        {
          id: 'tv',
          directory: '/media/tv',
          kind: 'tv',
          approvedCollections: [],
        },
      ],
    }
    fs.listFiles.mockImplementation((directory) =>
      directory === '/media/tv'
        ? ['/media/tv/Manual Pick/episode.mkv']
        : []
    )
    fs.getMtime.mockReturnValue(123)
    repo.getByRootRelativePaths.mockResolvedValue(
      new Map([['Manual Pick/episode.mkv', existing]])
    )

    indexer = new MediaIndexer(
      managedConfig,
      interludeConfig,
      repo,
      fs,
      probe
    )
    await indexer.scanAll()

    expect(probe.getMetadata).not.toHaveBeenCalled()
    expect(repo.upsertBatch.mock.calls[0]?.[0]?.[0]).toEqual(
      expect.objectContaining({
        path: '/media/tv/Manual Pick/episode.mkv',
        durationSeconds: 720,
        codec: 'hevc',
        width: 3840,
        height: 2160,
        mtime: 123,
        compatibility: 'incompatible',
        playbackOverride: true,
      })
    )
  })

  test('re-probes a changed unapproved row without making it playable', async () => {
    const existing = {
      id: 18,
      path: '/media/tv/Blocked Show/episode.mkv',
      filename: 'episode.mkv',
      durationSeconds: 900,
      isInterlude: false,
      mediaType: 'video' as const,
      dateStart: null,
      dateEnd: null,
      codec: 'hevc',
      width: 3840,
      height: 2160,
      warning: 'Requires a compatible client',
      mtime: 123,
      compatibility: 'incompatible' as const,
      rootId: 'tv',
      relativePath: 'Blocked Show/episode.mkv',
      libraryKind: 'tv' as const,
      collectionTitle: 'Blocked Show',
      policyEnabled: false,
      playbackOverride: null,
      rootAvailable: true,
      playbackEnabled: false,
    }
    const managedConfig: MediaConfig = {
      ...mediaConfig,
      roots: [
        {
          id: 'tv',
          directory: '/media/tv',
          kind: 'tv',
          approvedCollections: [],
        },
      ],
    }
    fs.listFiles.mockImplementation((directory) =>
      directory === '/media/tv'
        ? ['/media/tv/Blocked Show/episode.mkv']
        : []
    )
    fs.getMtime.mockReturnValue(999)
    repo.getByRootRelativePaths.mockResolvedValue(
      new Map([['Blocked Show/episode.mkv', existing]])
    )
    indexer = new MediaIndexer(
      managedConfig,
      interludeConfig,
      repo,
      fs,
      probe
    )

    await indexer.scanAll()

    expect(probe.getMetadata).toHaveBeenCalledWith(
      '/media/tv/Blocked Show/episode.mkv'
    )
    expect(repo.upsertBatch.mock.calls[0]?.[0]?.[0]).toEqual(
      expect.objectContaining({
        durationSeconds: 60,
        codec: 'h264',
        compatibility: 'compatible',
        mtime: 999,
        policyEnabled: false,
        playbackOverride: null,
      })
    )
  })

  test('coalesces a concurrent rescan and performs a fresh pass', async () => {
    const managedConfig: MediaConfig = {
      ...mediaConfig,
      roots: [
        {
          id: 'tv',
          directory: '/media/tv',
          kind: 'tv',
          approvedCollections: ['Bluey'],
        },
      ],
    }
    fs.listFiles.mockImplementation((directory) =>
      directory === '/media/tv' ? ['/media/tv/Bluey/episode.mkv'] : []
    )
    let releaseProbe!: (value: {
      durationSeconds: number
      codec: string | null
      width: number | null
      height: number | null
      fps: number | null
      bitrateMbps: number | null
      hasAudio: boolean | null
      audioCodec: string | null
    }) => void
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => (markStarted = resolve))
    const pendingProbe = new Promise<{
      durationSeconds: number
      codec: string | null
      width: number | null
      height: number | null
      fps: number | null
      bitrateMbps: number | null
      hasAudio: boolean | null
      audioCodec: string | null
    }>((resolve) => (releaseProbe = resolve))
    const metadata = {
      durationSeconds: 420,
      codec: 'h264',
      width: 1920,
      height: 1080,
      fps: 24,
      bitrateMbps: 4,
      hasAudio: true,
      audioCodec: 'aac',
    }
    probe.getMetadata
      .mockImplementationOnce(async () => {
        markStarted()
        return pendingProbe
      })
      .mockResolvedValue(metadata)

    indexer = new MediaIndexer(
      managedConfig,
      interludeConfig,
      repo,
      fs,
      probe
    )
    const first = indexer.scanAll()
    await started
    const concurrent = indexer.scanAll()
    releaseProbe(metadata)

    expect(await first).toBe(1)
    expect(await concurrent).toBe(1)
    expect(repo.upsertBatch).toHaveBeenCalledTimes(2)
  })

  test('keeps a newly unreadable approved file out of playback and retries later', async () => {
    const managedConfig: MediaConfig = {
      ...mediaConfig,
      roots: [
        {
          id: 'tv',
          directory: '/media/tv',
          kind: 'tv',
          approvedCollections: ['Bluey'],
        },
      ],
    }
    fs.listFiles.mockImplementation((directory) =>
      directory === '/media/tv' ? ['/media/tv/Bluey/broken.mkv'] : []
    )
    probe.getMetadata.mockRejectedValue(new Error('transient ffprobe failure'))
    indexer = new MediaIndexer(
      managedConfig,
      interludeConfig,
      repo,
      fs,
      probe
    )

    await indexer.scanAll()

    expect(repo.upsertBatch.mock.calls[0]?.[0]?.[0]).toEqual(
      expect.objectContaining({
        durationSeconds: 0,
        policyEnabled: false,
        rootAvailable: false,
        mtime: null,
      })
    )
  })

  test('scanAll marks interludes correctly', async () => {
    fs.listFiles
      .mockReturnValueOnce(['/media/videos/show.mp4'])
      .mockReturnValueOnce(['/media/interludes/bump.mp4'])

    await indexer.scanAll()

    // Videos batch
    const videoBatch = repo.upsertBatch.mock.calls[0]?.[0]
    expect(videoBatch?.[0]).toEqual(
      expect.objectContaining({
        filename: 'show.mp4',
        isInterlude: false,
      })
    )
    // Interludes batch
    const interludeBatch = repo.upsertBatch.mock.calls[1]?.[0]
    expect(interludeBatch?.[0]).toEqual(
      expect.objectContaining({
        filename: 'bump.mp4',
        isInterlude: true,
      })
    )
  })

  test('scanAll detects seasonal dates from filenames', async () => {
    // First call is video dir -> empty
    // Second call is interlude dir -> files
    fs.listFiles
      .mockReturnValueOnce([])
      .mockReturnValueOnce([
        '/media/interludes/penny_xmas.mp4',
        '/media/interludes/penny_summer.mp4',
      ])

    await indexer.scanAll()

    // Second batch call has interludes (first is empty videos)
    const interludeBatch = repo.upsertBatch.mock.calls[0]?.[0]

    // Verify Xmas
    expect(interludeBatch).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filename: 'penny_xmas.mp4',
          dateStart: '12-01',
          dateEnd: '12-26',
        }),
      ])
    )

    // Verify Summer
    expect(interludeBatch).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filename: 'penny_summer.mp4',
          dateStart: '06-01',
          dateEnd: '08-31',
        }),
      ])
    )
  })

  test('scanAll detects special media types', async () => {
    fs.listFiles
      .mockReturnValueOnce([
        '/media/videos/mylogo_intro.mp4',
        '/media/videos/other_intro.mp4',
        '/media/videos/sleepy_bedtime.mp4',
        '/media/videos/credits_outro.mp4',
      ])
      .mockReturnValueOnce([])

    await indexer.scanAll()

    const videoBatch = repo.upsertBatch.mock.calls[0]?.[0]
    expect(videoBatch).toHaveLength(4)

    // Verify all special media types detected
    expect(videoBatch).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filename: 'mylogo_intro.mp4',
          mediaType: 'intro',
          isInterlude: false,
        }),
        expect.objectContaining({
          filename: 'other_intro.mp4',
          mediaType: 'intro',
          isInterlude: false,
        }),
        expect.objectContaining({
          filename: 'sleepy_bedtime.mp4',
          mediaType: 'offair',
          isInterlude: false,
        }),
        expect.objectContaining({
          filename: 'credits_outro.mp4',
          mediaType: 'outro',
          isInterlude: false,
        }),
      ])
    )
  })
})
