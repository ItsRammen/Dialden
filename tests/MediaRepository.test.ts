/**
 * MediaRepository Tests
 *
 * Integration tests using in-memory SQLite database.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { MediaRepository } from '../src/repositories/MediaRepository'
import type { MediaItemInput } from '../src/repositories/IMediaRepository'
import { Database } from 'bun:sqlite'

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

  test('a probed row stops being offered for backfill once both halves are stored', async () => {
    /* listMissingAudioProbe has always selected rows missing the pixel format
       as well as the audio flag, but only the audio half was written back, so
       such a row was re-probed on every scan and never converged. That is why
       pixel_format was empty on nearly the whole library. */
    await repo.upsertMedia(
      createInput({ path: '/videos/legacy.mp4', filename: 'legacy.mp4' })
    )
    const [stored] = await repo.getAll()
    const id = stored?.id ?? 0

    // A legacy row: audio already known, video half never recorded.
    await repo.updateAudioProbe(id, true, 'aac')
    expect((await repo.listMissingAudioProbe(10)).map((item) => item.id)).toEqual([id])

    await repo.updateVideoProbe(id, 'yuv420p', 23.976)

    expect(await repo.listMissingAudioProbe(10)).toEqual([])
    const [refreshed] = await repo.getAll()
    expect(refreshed?.pixelFormat).toBe('yuv420p')
    expect(refreshed?.fps).toBeCloseTo(23.976, 3)
  })

  test('a probe that comes back empty does not erase what is already known', async () => {
    await repo.upsertMedia(
      createInput({ path: '/videos/known.mp4', filename: 'known.mp4' })
    )
    const [stored] = await repo.getAll()
    const id = stored?.id ?? 0
    await repo.updateVideoProbe(id, 'yuv420p10le', 25)

    // ffprobe failing on a later pass must not clear a good value.
    await repo.updateVideoProbe(id, null, null)

    const [refreshed] = await repo.getAll()
    expect(refreshed?.pixelFormat).toBe('yuv420p10le')
    expect(refreshed?.fps).toBe(25)
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

  test('summarizes eligible programming duration in SQLite', async () => {
    await repo.upsertBatch([
      createInput({
        path: '/videos/approved.mp4',
        filename: 'approved.mp4',
        durationSeconds: 3_600,
        policyEnabled: true,
      }),
      createInput({
        path: '/videos/parent-approved.mp4',
        filename: 'parent-approved.mp4',
        durationSeconds: 1_800,
        policyEnabled: false,
        playbackOverride: true,
      }),
      createInput({
        path: '/videos/blocked.mp4',
        filename: 'blocked.mp4',
        durationSeconds: 900,
        policyEnabled: false,
      }),
      createInput({
        path: '/videos/interlude.mp4',
        filename: 'interlude.mp4',
        durationSeconds: 300,
        mediaType: 'interlude',
        isInterlude: true,
        policyEnabled: true,
      }),
      createInput({
        path: '/videos/unavailable.mp4',
        filename: 'unavailable.mp4',
        durationSeconds: 600,
        policyEnabled: true,
        rootAvailable: false,
      }),
    ])

    expect((await repo.getLibrarySummary()).eligibleDurationSeconds).toBe(5_400)
  })

  test('persists network and studio metadata for station facets', async () => {
    const [collection] = await repo.upsertCollections([
      {
        rootId: 'tv',
        libraryKind: 'tv',
        identityKey: 'spongebob-squarepants',
        sourceTitle: 'SpongeBob SquarePants',
        parsedTitle: 'SpongeBob SquarePants',
        year: 1999,
      },
    ])
    expect(collection).toBeDefined()
    await repo.updateCollectionMetadata(collection?.id ?? 0, {
      provider: 'tmdb',
      externalId: '387',
      status: 'matched',
      genres: ['Animation', 'Comedy'],
      networks: ['Nickelodeon'],
      studios: ['Nickelodeon Animation Studio'],
    })

    expect(await repo.getCollectionById(collection?.id ?? 0)).toMatchObject({
      networks: ['Nickelodeon'],
      studios: ['Nickelodeon Animation Studio'],
    })
  })

  test('queues existing TMDB matches once when station facets are introduced', async () => {
    const [stored] = await repo.upsertCollections([
      {
        rootId: 'tv',
        libraryKind: 'tv',
        identityKey: 'locked-show',
        sourceTitle: 'Locked Show',
        parsedTitle: 'Locked Show',
        year: 2020,
      },
    ])
    await repo.updateCollectionMetadata(stored?.id ?? 0, {
      provider: 'tmdb',
      externalId: '1234',
      status: 'manual',
      locked: true,
    })
    await repo.updateCollectionOverride(stored?.id ?? 0, 'allow')

    const internals = repo as unknown as {
      db: Database
      migrateStationFacets(): void
    }
    internals.db.exec('DELETE FROM schema_migrations WHERE version = 2')
    internals.migrateStationFacets()

    expect(await repo.getCollectionById(stored?.id ?? 0)).toMatchObject({
      metadataStatus: 'pending',
      metadataLocked: true,
      metadataExternalId: '1234',
      parentOverride: 'allow',
      effectiveDecision: 'allow',
    })
  })

  test('sanitizes malformed persisted parent overrides to review and rejects new corruption', async () => {
    const [collection] = await repo.upsertCollections([
      {
        rootId: 'tv',
        libraryKind: 'tv',
        identityKey: 'show',
        sourceTitle: 'Show',
        parsedTitle: 'Show',
        year: null,
      },
    ])
    expect(collection).toBeDefined()
    await repo.updateCollectionPolicy(
      collection?.id ?? 0,
      'allow',
      'rating_allowed'
    )

    const internals = repo as unknown as {
      db: Database
      sanitizeAndGuardCollectionOverrides(): void
    }
    internals.db.exec(`
      DROP TRIGGER validate_collection_parent_override_insert;
      DROP TRIGGER validate_collection_parent_override_update;
      PRAGMA ignore_check_constraints = ON;
      UPDATE media_collections SET parent_override = 'unexpected';
    `)

    // Even before startup sanitation runs, the shared decision expression
    // treats an unexpected override as review instead of falling through.
    expect(await repo.getCollectionById(collection?.id ?? 0)).toMatchObject({
      effectiveDecision: 'review',
      decisionSource: 'fail_closed',
    })
    expect(await repo.getCollections({ effectiveDecision: 'allow' })).toEqual(
      []
    )

    internals.sanitizeAndGuardCollectionOverrides()
    expect(await repo.getCollectionById(collection?.id ?? 0)).toMatchObject({
      parentOverride: null,
      policyDecision: 'review',
      policyReason: 'invalid_parent_override',
      effectiveDecision: 'review',
    })
    expect(() =>
      internals.db
        .prepare(
          `UPDATE media_collections SET parent_override = 'unexpected' WHERE id = ?`
        )
        .run(collection?.id ?? 0)
    ).toThrow(/invalid collection parent override/i)
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

  test('collection approval stays authoritative over stale scan upserts and file inheritance', async () => {
    const [collection] = await repo.upsertCollections([
      {
        rootId: 'tv',
        libraryKind: 'tv',
        identityKey: 'bluey',
        sourceTitle: 'Bluey',
        parsedTitle: 'Bluey',
        year: null,
      },
    ])
    const collectionId = collection?.id ?? 0
    const staleScanInput = createInput({
      path: '/media/tv/Bluey/episode.mkv',
      filename: 'episode.mkv',
      rootId: 'tv',
      relativePath: 'Bluey/episode.mkv',
      libraryKind: 'tv',
      collectionTitle: 'Bluey',
      collectionId,
      policyEnabled: false,
      rootAvailable: true,
    })
    await repo.upsertBatch([staleScanInput])

    await repo.updateCollectionOverride(collectionId, 'allow')
    expect((await repo.getAll())[0]).toMatchObject({
      policyEnabled: true,
      playbackEnabled: true,
    })

    // A long-running scanner may have captured review before the approval.
    // Landing that stale descriptor later must not undo the parent decision.
    await repo.upsertBatch([{ ...staleScanInput, policyEnabled: false }])
    const approvedPage = await repo.getMediaPage({
      filter: 'approved',
      limit: 100,
      offset: 0,
    })
    expect(approvedPage.total).toBe(1)
    expect(approvedPage.items[0]).toMatchObject({
      collectionId,
      policyEnabled: true,
      playbackEnabled: true,
    })

    const itemId = approvedPage.items[0]?.id ?? 0
    await repo.updatePlaybackOverride(itemId, false)
    expect((await repo.getById(itemId))?.playbackEnabled).toBe(false)

    // Repair a stale cache left by an older process. Choosing "Use collection
    // decision" must re-read the approved collection, not merely clear the
    // per-file override and expose the stale zero.
    const internals = repo as unknown as { db: Database }
    internals.db
      .prepare('UPDATE media SET policy_enabled = 0 WHERE id = ?')
      .run(itemId)
    await repo.updatePlaybackOverride(itemId, null)
    expect(await repo.getById(itemId)).toMatchObject({
      playbackOverride: null,
      policyEnabled: true,
      playbackEnabled: true,
    })
  })

  test('rolls back collection decisions when linked eligibility propagation fails', async () => {
    const [collection] = await repo.upsertCollections([
      {
        rootId: 'tv',
        libraryKind: 'tv',
        identityKey: 'rollback-show',
        sourceTitle: 'Rollback Show',
        parsedTitle: 'Rollback Show',
        year: null,
      },
    ])
    const collectionId = collection?.id ?? 0
    await repo.updateCollectionPolicy(
      collectionId,
      'allow',
      'test_allowed',
      'kids-7'
    )
    await repo.upsertMedia(
      createInput({
        path: '/media/tv/Rollback Show/episode.mkv',
        rootId: 'tv',
        relativePath: 'Rollback Show/episode.mkv',
        libraryKind: 'tv',
        collectionTitle: 'Rollback Show',
        collectionId,
        policyEnabled: true,
      })
    )
    const internals = repo as unknown as { db: Database }
    internals.db.exec(`
      CREATE TRIGGER reject_eligibility_sync
      BEFORE UPDATE OF policy_enabled ON media
      WHEN NEW.collection_id = ${collectionId}
      BEGIN
        SELECT RAISE(ABORT, 'eligibility sync failed');
      END;
    `)

    await expect(
      repo.updateCollectionOverride(collectionId, 'block')
    ).rejects.toThrow('eligibility sync failed')
    await expect(
      repo.updateCollectionPolicy(
        collectionId,
        'block',
        'test_blocked',
        'kids-7'
      )
    ).rejects.toThrow('eligibility sync failed')

    expect(await repo.getCollectionById(collectionId)).toMatchObject({
      policyDecision: 'allow',
      parentOverride: null,
      effectiveDecision: 'allow',
    })
    expect((await repo.getAll())[0]).toMatchObject({
      policyEnabled: true,
      playbackEnabled: true,
    })
  })

  test('finds file-approved media without requiring a collection allow decision', async () => {
    const [collection] = await repo.upsertCollections([
      {
        rootId: 'tv',
        libraryKind: 'tv',
        identityKey: 'file-approved-show',
        sourceTitle: 'File Approved Show',
        parsedTitle: 'File Approved Show',
        year: null,
      },
    ])
    const collectionId = collection?.id ?? 0
    await repo.upsertMedia(
      createInput({
        path: '/media/tv/File Approved Show/episode.mkv',
        rootId: 'tv',
        relativePath: 'File Approved Show/episode.mkv',
        libraryKind: 'tv',
        collectionTitle: 'File Approved Show',
        collectionId,
        policyEnabled: false,
        playbackOverride: true,
        rootAvailable: true,
      })
    )

    const playable = await repo.getCollections({ scheduleEligibleOnly: true })

    expect(playable).toHaveLength(1)
    expect(playable[0]).toMatchObject({
      id: collectionId,
      effectiveDecision: 'review',
      scheduleEligibleCount: 1,
    })
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

  test('does not promote the legacy collection allowlist into approval', async () => {
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
    expect(playable).toEqual([])
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
        policyEnabled: true,
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
        policyEnabled: true,
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
        policyEnabled: true,
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

  test('pages and filters more than 250 advanced-library files in SQLite', async () => {
    await repo.upsertBatch(
      Array.from({ length: 275 }, (_, index) => {
        const number = index + 1
        const filename = `file-${String(number).padStart(3, '0')}.mp4`
        return createInput({
          path: `/videos/${filename}`,
          filename,
          relativePath: filename,
          collectionTitle: number % 40 === 0 ? 'Needle Collection' : 'Other',
          policyEnabled: number % 2 === 0,
          isInterlude: number % 3 === 0,
          mediaType: number % 3 === 0 ? 'interlude' : 'video',
        })
      })
    )

    const lastPage = await repo.getMediaPage({
      filter: 'all',
      limit: 100,
      offset: 200,
    })
    expect(lastPage.total).toBe(275)
    expect(lastPage.items).toHaveLength(75)
    expect(lastPage.items[0]?.filename).toBe('file-201.mp4')
    expect(lastPage.items.at(-1)?.filename).toBe('file-275.mp4')

    const playable = await repo.getMediaPage({
      filter: 'approved',
      limit: 100,
      offset: 0,
    })
    expect(playable.total).toBe(137)
    expect(playable.items).toHaveLength(100)
    expect(playable.items.every((item) => item.playbackEnabled === true)).toBe(
      true
    )

    const interludes = await repo.getMediaPage({
      filter: 'interludes',
      limit: 100,
      offset: 0,
    })
    expect(interludes.total).toBe(91)
    expect(interludes.items.every((item) => item.isInterlude)).toBe(true)

    const search = await repo.getMediaPage({
      filter: 'all',
      search: 'needle',
      limit: 100,
      offset: 0,
      prioritizedIds: [240],
    })
    expect(search.total).toBe(6)
    expect(search.items).toHaveLength(6)
    expect(search.items[0]?.filename).toBe('file-240.mp4')
  })

  test('filters technical failures without mixing in healthy files', async () => {
    await repo.upsertBatch([
      createInput({ path: '/videos/healthy.mp4', filename: 'healthy.mp4' }),
      createInput({
        path: '/videos/no-duration.mp4',
        filename: 'no-duration.mp4',
        durationSeconds: 0,
      }),
      createInput({
        path: '/videos/probe-warning.mp4',
        filename: 'probe-warning.mp4',
        warning: 'ffprobe could not read the video stream',
      }),
    ])

    const failures = await repo.getMediaPage({
      filter: 'errors',
      limit: 100,
      offset: 0,
    })

    expect(failures.total).toBe(2)
    expect(failures.items.map((item) => item.filename)).toEqual([
      'no-duration.mp4',
      'probe-warning.mp4',
    ])
  })
})
