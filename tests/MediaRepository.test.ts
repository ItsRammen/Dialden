/**
 * MediaRepository Tests
 *
 * Integration tests using in-memory SQLite database.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { MediaRepository } from '../src/repositories/MediaRepository'
import type { MediaItemInput } from '../src/repositories/IMediaRepository'

// Builder for MediaItemInput with extended metadata defaults
const createInput = (override?: Partial<MediaItemInput>): MediaItemInput => ({
  path: '/videos/test.mp4',
  filename: 'test.mp4',
  durationSeconds: 60,
  isInterlude: false,
  mediaType: 'video',
  dateStart: null,
  dateEnd: null,
  codec: null,
  width: null,
  height: null,
  warning: null,
  mtime: null,
  compatibility: 'compatible',
  ...override,
})

describe('MediaRepository', () => {
  let repo: MediaRepository

  beforeEach(async () => {
    // Use in-memory DB for each test
    repo = new MediaRepository(':memory:')
    await repo.initialize()
  })

  afterEach(async () => {
    await repo.close()
  })

  test('initializes with correct schema', async () => {
    const settings = await repo.getAllSettings()
    expect(settings).toEqual({})
    const videos = await repo.getAllVideos()
    expect(videos).toEqual([])
  })

  test('upsertMedia inserts and updates videos', async () => {
    const input = createInput({
      codec: 'hevc',
      width: 3840,
      height: 2160,
      warning: 'Requires a compatible client',
      mtime: 123,
      compatibility: 'incompatible',
    })

    await repo.upsertMedia(input)

    const all = await repo.getAll()
    expect(all).toHaveLength(1)
    expect(all[0]?.filename).toBe('test.mp4')
    expect(all[0]?.mediaType).toBe('video')
    expect(all[0]?.codec).toBe('hevc')
    expect(all[0]?.width).toBe(3840)
    expect(all[0]?.height).toBe(2160)
    expect(all[0]?.warning).toBe('Requires a compatible client')
    expect(all[0]?.mtime).toBe(123)
    expect(all[0]?.compatibility).toBe('incompatible')

    // Update duration
    await repo.upsertMedia({ ...input, durationSeconds: 120 })

    const updated = await repo.getAll()
    expect(updated).toHaveLength(1)
    expect(updated[0]?.durationSeconds).toBe(120)
  })

  test('upsertBatch persists compatibility from the indexer', async () => {
    await repo.upsertBatch([
      createInput({
        path: '/videos/hevc.mkv',
        filename: 'hevc.mkv',
        codec: 'hevc',
        compatibility: 'incompatible',
      }),
    ])

    const all = await repo.getAll()

    expect(all).toHaveLength(1)
    expect(all[0]?.filename).toBe('hevc.mkv')
    expect(all[0]?.compatibility).toBe('incompatible')

    await repo.upsertBatch([
      createInput({
        path: '/videos/hevc.mkv',
        filename: 'hevc.mkv',
        codec: 'h264',
        compatibility: 'compatible',
      }),
    ])

    expect((await repo.getAll())[0]?.compatibility).toBe('compatible')
  })

  test('kid playback eligibility is default-deny with a parent override', async () => {
    await repo.upsertMedia(
      createInput({
        path: '/media/tv/Adult Show/episode.mkv',
        rootId: 'tv',
        relativePath: 'Adult Show/episode.mkv',
        libraryKind: 'tv',
        collectionTitle: 'Adult Show',
        policyEnabled: false,
      })
    )

    expect(await repo.getAllVideos()).toEqual([])
    const item = (await repo.getAll())[0]
    expect(item?.playbackEnabled).toBe(false)

    await repo.updatePlaybackOverride(item?.id ?? 0, true)
    expect(await repo.getAllVideos()).toHaveLength(1)

    await repo.updatePlaybackOverride(item?.id ?? 0, null)
    expect(await repo.getAllVideos()).toEqual([])
  })

  test('stable root-relative locator survives a container path change', async () => {
    const first = createInput({
      path: '/old-media/Bluey/episode.mkv',
      rootId: 'tv',
      relativePath: 'Bluey/episode.mkv',
      libraryKind: 'tv',
      collectionTitle: 'Bluey',
      policyEnabled: true,
    })
    await repo.upsertMedia(first)
    const original = (await repo.getAll())[0]

    await repo.upsertMedia({ ...first, path: '/media/tv/Bluey/episode.mkv' })
    const moved = (await repo.getAll())[0]

    expect(await repo.getAll()).toHaveLength(1)
    expect(moved?.id).toBe(original?.id)
    expect(moved?.path).toBe('/media/tv/Bluey/episode.mkv')
  })

  test('upsert merges a legacy path row that collides with a stable locator', async () => {
    await repo.upsertBatch([
      createInput({
        path: '/old/Show/episode.mkv',
        rootId: 'tv',
        relativePath: 'Show/episode.mkv',
        playbackOverride: false,
      }),
      createInput({
        path: '/media/tv/Show/episode.mkv',
        rootId: 'legacy',
        relativePath: '/media/tv/Show/episode.mkv',
      }),
    ])
    const stableId = (await repo.getByPath('/old/Show/episode.mkv'))?.id

    await repo.upsertMedia(
      createInput({
        path: '/media/tv/Show/episode.mkv',
        rootId: 'tv',
        relativePath: 'Show/episode.mkv',
      })
    )

    const rows = await repo.getAll()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(stableId)
    expect(rows[0]?.path).toBe('/media/tv/Show/episode.mkv')
    expect(rows[0]?.playbackEnabled).toBe(false)
  })

  test('root-scoped reconciliation cannot delete another root', async () => {
    await repo.upsertBatch([
      createInput({
        path: '/media/tv/Bluey/one.mkv',
        rootId: 'tv',
        relativePath: 'Bluey/one.mkv',
      }),
      createInput({
        path: '/media/movies/Cars/Cars.mkv',
        rootId: 'movies',
        relativePath: 'Cars/Cars.mkv',
        libraryKind: 'movie',
      }),
    ])

    const removed = await repo.removeNotInRootPaths('tv', [])

    expect(removed).toBe(1)
    const remaining = await repo.getAll()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.rootId).toBe('movies')
  })

  test('managed roots fail closed for legacy catalog rows', async () => {
    await repo.upsertBatch([
      createInput({ path: '/legacy/adult.mkv' }),
      createInput({
        path: '/media/tv/Bluey/episode.mkv',
        rootId: 'tv',
        relativePath: 'Bluey/episode.mkv',
        policyEnabled: true,
      }),
    ])

    const changed = await repo.restrictPlaybackToRoots([
      'tv',
      'movies',
      'interludes',
    ])

    expect(changed).toBe(1)
    expect((await repo.getAllVideos()).map((item) => item.rootId)).toEqual([
      'tv',
    ])
  })

  test('synchronizes a narrowed policy before an unavailable root can play', async () => {
    await repo.upsertBatch([
      createInput({
        path: '/media/tv/Bluey/episode.mkv',
        rootId: 'tv',
        relativePath: 'Bluey/episode.mkv',
        collectionTitle: 'Bluey',
        policyEnabled: true,
      }),
      createInput({
        path: '/media/tv/Old Show/episode.mkv',
        rootId: 'tv',
        relativePath: 'Old Show/episode.mkv',
        collectionTitle: 'Old Show',
        policyEnabled: true,
      }),
      createInput({
        path: '/retired/Parent Pick/episode.mkv',
        rootId: 'retired',
        relativePath: 'Parent Pick/episode.mkv',
        collectionTitle: 'Parent Pick',
        policyEnabled: false,
        playbackOverride: true,
      }),
    ])

    await repo.synchronizePlaybackPolicy([
      { id: 'tv', approvedCollections: ['bluey'] },
      { id: 'interludes' },
    ])

    // All managed roots remain quarantined until their current mount scans.
    expect(await repo.getAllVideos()).toEqual([])
    await repo.setRootAvailable('tv', true)

    const playable = await repo.getAllVideos()
    expect(playable.map((item) => item.collectionTitle)).toEqual(['Bluey'])
    const rows = await repo.getAll()
    expect(rows.find((item) => item.collectionTitle === 'Old Show')?.policyEnabled).toBe(
      false
    )
    expect(rows.find((item) => item.rootId === 'retired')?.playbackOverride).toBe(
      true
    )
    expect(rows.find((item) => item.rootId === 'retired')?.playbackEnabled).toBe(
      false
    )
  })

  test('root availability gates videos and interludes without losing overrides', async () => {
    await repo.upsertBatch([
      createInput({
        path: '/media/tv/Manual Pick/episode.mkv',
        rootId: 'tv',
        relativePath: 'Manual Pick/episode.mkv',
        collectionTitle: 'Manual Pick',
        policyEnabled: false,
        playbackOverride: true,
      }),
      createInput({
        path: '/media/interludes/bump.mp4',
        rootId: 'interludes',
        relativePath: 'bump.mp4',
        collectionTitle: 'bump.mp4',
        isInterlude: true,
        mediaType: 'interlude',
      }),
    ])

    await repo.setRootAvailable('tv', false)
    await repo.setRootAvailable('interludes', false)
    expect(await repo.getAllVideos()).toEqual([])
    expect(await repo.getInterludes('2026-08-23')).toEqual([])
    expect(await repo.getAll()).toHaveLength(2)

    await repo.setRootAvailable('tv', true)
    await repo.setRootAvailable('interludes', true)
    expect((await repo.getAllVideos())[0]?.playbackOverride).toBe(true)
    expect(await repo.getInterludes('2026-08-23')).toHaveLength(1)
  })

  test('zero-duration files remain technically unavailable after parent allow', async () => {
    await repo.upsertMedia(
      createInput({
        path: '/media/tv/Unreadable/episode.mkv',
        durationSeconds: 0,
        rootId: 'tv',
        relativePath: 'Unreadable/episode.mkv',
        collectionTitle: 'Unreadable',
        policyEnabled: false,
        playbackOverride: true,
      })
    )

    expect(await repo.getAllVideos()).toEqual([])
    expect((await repo.getAll())[0]?.playbackEnabled).toBe(false)
  })

  test('getInterludes filters by date correctly', async () => {
    await repo.upsertMedia(
      createInput({
        path: '/int/always.mp4',
        filename: 'always.mp4',
        durationSeconds: 10,
        isInterlude: true,
        mediaType: 'interlude',
      })
    )

    await repo.upsertMedia(
      createInput({
        path: '/int/winter.mp4',
        filename: 'winter.mp4',
        durationSeconds: 10,
        isInterlude: true,
        mediaType: 'interlude',
        dateStart: '12-01',
        dateEnd: '02-28',
      })
    )

    // Test date in winter range
    const winterList = await repo.getInterludes('2023-01-15')
    expect(winterList.map((i) => i.filename)).toContain('winter.mp4')
    expect(winterList.map((i) => i.filename)).toContain('always.mp4')

    // Test date outside winter range
    const summerList = await repo.getInterludes('2023-07-15')
    expect(summerList.map((i) => i.filename)).not.toContain('winter.mp4')
    expect(summerList.map((i) => i.filename)).toContain('always.mp4')
  })

  test('settings management', async () => {
    await repo.setSetting('theme', 'dark')
    expect(await repo.getSetting('theme')).toBe('dark')

    await repo.setSetting('theme', 'light')
    expect(await repo.getSetting('theme')).toBe('light')

    const all = await repo.getAllSettings()
    expect(all).toEqual({ theme: 'light' })
  })

  test('removeNotInPaths cleans up stale entries', async () => {
    await repo.upsertMedia(
      createInput({
        path: '/keep.mp4',
        filename: 'keep.mp4',
        durationSeconds: 10,
      })
    )

    await repo.upsertMedia(
      createInput({
        path: '/remove.mp4',
        filename: 'remove.mp4',
        durationSeconds: 10,
      })
    )

    const removedCount = await repo.removeNotInPaths(['/keep.mp4'])

    expect(removedCount).toBe(1)
    const all = await repo.getAll()
    expect(all).toHaveLength(1)
    expect(all[0]?.path).toBe('/keep.mp4')
  })

  test('conflicting upsert preserves user settings', async () => {
    // Insert as Video
    await repo.upsertMedia(
      createInput({
        path: '/test.mp4',
        filename: 'test.mp4',
        durationSeconds: 10,
      })
    )

    // User manually changes to Interlude via method
    const id = (await repo.getAll())[0]?.id ?? 0
    await repo.toggleInterlude(id, true)

    // Re-scan (Upsert) as Video (file system says it's a video)
    await repo.upsertMedia(
      createInput({
        path: '/test.mp4',
        filename: 'test.mp4',
        durationSeconds: 10,
      })
    )

    // Should remain Interlude because User override (in DB) persists if FS says "Video" (default)
    // Logic: if excluded.is_interlude = 0 (Video), keep existing.

    const item = (await repo.getAll())[0]
    expect(item?.isInterlude).toBe(true)
    expect(item?.mediaType).toBe('interlude')
  })

  test('upsert special types override existing interlude', async () => {
    // Simulate: File was previously indexed as interlude (before detection fix)
    await repo.upsertMedia(
      createInput({
        path: '/interludes/penny_outro.mp4',
        filename: 'penny_outro.mp4',
        durationSeconds: 30,
        isInterlude: true,
        mediaType: 'interlude', // Old indexer didn't detect special type
      })
    )

    // Verify it's interlude
    let item = (await repo.getAll())[0]
    expect(item?.mediaType).toBe('interlude')

    // Re-scan with fixed indexer that detects _outro pattern
    await repo.upsertMedia(
      createInput({
        path: '/interludes/penny_outro.mp4',
        filename: 'penny_outro.mp4',
        durationSeconds: 30,
        isInterlude: false, // outro is not a generic interlude
        mediaType: 'outro', // NEW: Detected as outro
      })
    )

    // Should now be outro (special types override)
    item = (await repo.getAll())[0]
    expect(item?.mediaType).toBe('outro')
    expect(item?.isInterlude).toBe(false)
  })

  test('upsert offair overrides existing interlude', async () => {
    // Simulate: bedtime file was indexed as interlude
    await repo.upsertMedia(
      createInput({
        path: '/interludes/penny_bedtime.mp4',
        filename: 'penny_bedtime.mp4',
        durationSeconds: 30,
        isInterlude: true,
        mediaType: 'interlude',
      })
    )

    // Re-scan detects _bedtime -> offair
    await repo.upsertMedia(
      createInput({
        path: '/interludes/penny_bedtime.mp4',
        filename: 'penny_bedtime.mp4',
        durationSeconds: 30,
        isInterlude: false,
        mediaType: 'offair',
      })
    )

    const item = (await repo.getAll())[0]
    expect(item?.mediaType).toBe('offair')
  })

  test('upsert intro overrides existing interlude', async () => {
    // Simulate: intro file was indexed as interlude
    await repo.upsertMedia(
      createInput({
        path: '/interludes/penny_intro.mp4',
        filename: 'penny_intro.mp4',
        durationSeconds: 30,
        isInterlude: true,
        mediaType: 'interlude',
      })
    )

    // Re-scan detects _intro
    await repo.upsertMedia(
      createInput({
        path: '/interludes/penny_intro.mp4',
        filename: 'penny_intro.mp4',
        durationSeconds: 30,
        isInterlude: false,
        mediaType: 'intro',
      })
    )

    const item = (await repo.getAll())[0]
    expect(item?.mediaType).toBe('intro')
  })
})
