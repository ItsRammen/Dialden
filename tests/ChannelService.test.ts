import { describe, expect, test } from 'bun:test'
import { mock } from 'jest-mock-extended'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IMediaRepository } from '../src/repositories/IMediaRepository'
import type { LibraryPolicyDocument } from '../src/config/library'
import type { MediaItem } from '../src/types'
import { ChannelService } from '../src/services/ChannelService'
import { ChannelConfigurationStore } from '../src/services/ChannelConfigurationStore'

const policy: LibraryPolicyDocument = {
  version: 1,
  profile: { id: 'kids-7', name: 'Kids 7', age: 7 },
  roots: {
    tv: {
      collections: [
        { name: 'Bluey (2018)', groups: ['comfort'] },
        { name: 'Numberblocks', groups: ['learning'] },
      ],
    },
  },
  channels: [
    {
      id: 'kids-club',
      name: 'Kids Club',
      enabled: true,
      timezone: 'Asia/Taipei',
      slots: [
        {
          days: ['mon'],
          start: '06:30',
          end: '07:00',
          groups: ['comfort', 'learning'],
        },
      ],
    },
  ],
}

function video(id: number, collectionTitle: string, enabled = true): MediaItem {
  return {
    id,
    path: `/media/tv/${collectionTitle}/episode-${id}.mkv`,
    filename: `episode-${id}.mkv`,
    durationSeconds: 600,
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
    relativePath: `${collectionTitle}/episode-${id}.mkv`,
    libraryKind: 'tv',
    collectionTitle,
    policyEnabled: enabled,
    playbackOverride: null,
    rootAvailable: true,
    playbackEnabled: enabled,
  }
}

function interlude(id: number, durationSeconds = 30): MediaItem {
  return {
    ...video(id, 'ToastTV Interludes'),
    path: `/media/interludes/bumper-${id}.mp4`,
    filename: `ToastTV bumper ${id}.mp4`,
    relativePath: `bumper-${id}.mp4`,
    durationSeconds,
    isInterlude: true,
    mediaType: 'interlude',
    libraryKind: undefined,
  }
}

describe('ChannelService', () => {
  test('uses provider show and episode metadata for schedule labels', async () => {
    const repository = mock<IMediaRepository>()
    repository.getAll.mockResolvedValue([
      {
        ...video(1, 'The.Magic.School.Bus'),
        collectionMetadataTitle: 'The Magic School Bus',
        seasonNumber: 3,
        episodeNumber: 5,
        episodeTitle: 'Gets.a.Bright.Idea.480p.WEBRip',
        episodeMetadataTitle: 'Gets a Bright Idea',
      },
    ])
    const metadataPolicy: LibraryPolicyDocument = {
      ...policy,
      roots: {
        tv: {
          collections: [
            { name: 'The.Magic.School.Bus', groups: ['learning'] },
          ],
        },
      },
    }
    const service = new ChannelService(repository, metadataPolicy, {
      now: () => new Date('2026-08-23T22:35:00.000Z'),
    })

    expect((await service.getNow('kids-club'))?.program).toMatchObject({
      title: 'Gets a Bright Idea',
      collectionTitle: 'The Magic School Bus',
      episodeLabel: 'S03E05',
    })
  })

  test('does not schedule TMDB animation in a legacy nature group', async () => {
    const repository = mock<IMediaRepository>()
    repository.getAll.mockResolvedValue([
      {
        ...video(1, 'The Wild Thornberrys'),
        collectionGenres: ['Animation', 'Comedy', 'Family'],
      },
    ])
    const naturePolicy: LibraryPolicyDocument = {
      ...policy,
      roots: {
        tv: {
          collections: [
            { name: 'The Wild Thornberrys', groups: ['nature'] },
          ],
        },
      },
      channels: [
        {
          id: 'nature',
          name: 'Nature',
          enabled: true,
          timezone: 'Asia/Taipei',
          slots: [
            {
              days: ['mon'],
              start: '06:30',
              end: '07:00',
              groups: ['nature'],
            },
          ],
        },
      ],
    }

    expect(
      (await new ChannelService(repository, naturePolicy, {
        now: () => new Date('2026-08-23T22:35:00.000Z'),
      }).getNow('nature'))?.program
    ).toBeNull()
  })

  test('computes current/next in the configured timezone at exact boundaries', async () => {
    const repository = mock<IMediaRepository>()
    repository.getAll.mockResolvedValue([video(1, 'Bluey (2018)')])

    const at0635 = new ChannelService(repository, policy, {
      now: () => new Date('2026-08-23T22:35:00.000Z'),
    })
    const middle = await at0635.getNow('kids-club')
    expect(middle?.program?.mediaId).toBe(1)
    expect(middle?.program?.scheduledStart).toBe(
      '2026-08-23T22:30:00.000Z'
    )
    expect(middle?.program?.offsetSeconds).toBe(300)
    expect(middle?.program?.offsetMs).toBe(300_000)
    expect(middle?.program?.durationMs).toBe(600_000)
    expect(middle?.program?.playback).toEqual({
      mode: 'direct',
      url: '/api/v1/media/1/stream',
      sourceOffsetAtPlaybackZeroMs: 0,
    })
    expect(middle?.next?.scheduledStart).toBe('2026-08-23T22:40:00.000Z')

    const at0640 = new ChannelService(repository, policy, {
      now: () => new Date('2026-08-23T22:40:00.000Z'),
    })
    const boundary = await at0640.getNow('kids-club')
    expect(boundary?.program?.scheduledStart).toBe(
      '2026-08-23T22:40:00.000Z'
    )
    expect(boundary?.program?.offsetSeconds).toBe(0)
    expect(boundary?.program?.offsetMs).toBe(0)
  })

  test('excludes blocked and unavailable media and stays deterministic', async () => {
    const repository = mock<IMediaRepository>()
    repository.getAll.mockResolvedValue([
      video(1, 'Bluey (2018)'),
      video(2, 'Numberblocks'),
      video(3, 'Bluey (2018)', false),
      { ...video(4, 'Bluey (2018)'), rootAvailable: false, playbackEnabled: false },
      { ...video(5, 'Bluey (2018)'), playbackEnabled: undefined },
      { ...video(6, 'Bluey (2018)'), rootAvailable: false, playbackEnabled: true },
    ])
    const clock = { now: () => new Date('2026-08-23T22:35:00.000Z') }

    const first = await new ChannelService(repository, policy, clock).getGuide(
      'kids-club',
      1
    )
    const second = await new ChannelService(repository, policy, clock).getGuide(
      'kids-club',
      1
    )
    const eligibleRepository = mock<IMediaRepository>()
    eligibleRepository.getAll.mockResolvedValue([
      video(1, 'Bluey (2018)'),
      video(2, 'Numberblocks'),
    ])
    const eligibleOnly = await new ChannelService(
      eligibleRepository,
      policy,
      clock
    ).getGuide('kids-club', 1)

    expect(first).toEqual(second)
    expect(first?.timelineRevision).toBe(eligibleOnly?.timelineRevision)
    expect(first?.programs.length).toBeGreaterThan(0)
    expect(first?.programs.every((program) => [1, 2].includes(program.mediaId))).toBe(true)
  })

  test('returns off-air and not-found states without inventing a program', async () => {
    const repository = mock<IMediaRepository>()
    repository.getAll.mockResolvedValue([video(1, 'Bluey (2018)')])
    const service = new ChannelService(repository, policy, {
      now: () => new Date('2026-08-23T21:00:00.000Z'),
    })

    const result = await service.getNow('kids-club')
    expect(result?.program).toBeNull()
    expect(result?.next?.scheduledStart).toBe('2026-08-23T22:30:00.000Z')
    expect(await service.getNow('missing')).toBeNull()
  })

  test('keeps an all-day station scheduled late in the day with one short video', async () => {
    const repository = mock<IMediaRepository>()
    repository.getAll.mockResolvedValue([
      { ...video(1, 'Bluey (2018)'), durationSeconds: 30 },
    ])
    const allDayPolicy: LibraryPolicyDocument = {
      ...policy,
      channels: [
        {
          id: 'all-day',
          name: 'All Day',
          enabled: true,
          timezone: 'UTC',
          slots: [
            {
              days: ['sun'],
              start: '00:00',
              end: '24:00',
              groups: ['comfort'],
            },
          ],
        },
      ],
    }
    const service = new ChannelService(repository, allDayPolicy, {
      now: () => new Date('2026-08-23T23:59:15.000Z'),
    })

    const result = await service.getNow('all-day')

    expect(result?.program?.mediaId).toBe(1)
    expect(result?.program?.scheduledStart).toBe('2026-08-23T23:59:00.000Z')
    expect(result?.program?.offsetSeconds).toBe(15)
  })

  test('keeps whole all-day episodes continuous across midnight', async () => {
    const repository = mock<IMediaRepository>()
    repository.getAll.mockResolvedValue([
      { ...video(1, 'Bluey (2018)'), durationSeconds: 420 },
    ])
    const allDayPolicy: LibraryPolicyDocument = {
      ...policy,
      channels: [
        {
          id: 'continuous',
          name: 'Continuous Station',
          enabled: true,
          timezone: 'UTC',
          slots: [
            {
              days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
              start: '00:00',
              end: '24:00',
              groups: ['comfort'],
            },
          ],
        },
      ],
    }
    const now = new Date('2026-08-23T23:57:00.000Z')
    const service = new ChannelService(repository, allDayPolicy, {
      now: () => now,
    })

    const result = await service.getNow('continuous')
    const startMs = Date.parse(result?.program?.scheduledStart ?? '')
    const endMs = Date.parse(result?.program?.scheduledEnd ?? '')

    expect(result?.program?.mediaId).toBe(1)
    expect(startMs).toBeLessThanOrEqual(now.getTime())
    expect(endMs).toBeGreaterThan(now.getTime())
    expect(endMs - startMs).toBe(420_000)
  })

  test('schedules measured interludes as ordinary deterministic all-day timeline items', async () => {
    const repository = mock<IMediaRepository>()
    repository.getAll.mockResolvedValue([
      { ...video(1, 'Bluey (2018)'), durationSeconds: 600 },
      interlude(90, 37),
    ])
    const allDayPolicy: LibraryPolicyDocument = {
      ...policy,
      channels: [
        {
          id: 'bumper-loop',
          name: 'Bumper Loop',
          enabled: true,
          timezone: 'UTC',
          slots: [
            {
              days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
              start: '00:00',
              end: '24:00',
              groups: ['comfort'],
            },
          ],
        },
      ],
    }
    const clock = { now: () => new Date('2020-01-01T00:10:05.000Z') }
    const first = await new ChannelService(
      repository,
      allDayPolicy,
      clock,
      undefined,
      { enabled: true, frequency: 1 }
    ).getNow('bumper-loop')
    const second = await new ChannelService(
      repository,
      allDayPolicy,
      clock,
      undefined,
      { enabled: true, frequency: 1 }
    ).getNow('bumper-loop')

    expect(first).toEqual(second)
    expect(first?.program).toMatchObject({
      mediaId: 90,
      type: 'interlude',
      collectionTitle: 'Interlude',
      durationSeconds: 37,
      durationMs: 37_000,
      sourceStartSeconds: 0,
      sourceDurationSeconds: 37,
      transitionIn: 'hard_cut',
      transitionOut: 'hard_cut',
      offsetSeconds: 5,
    })
    expect(first?.program?.scheduledStart).toBe('2020-01-01T00:10:00.000Z')
    expect(first?.next).toMatchObject({ mediaId: 1, type: 'program' })
    expect(first?.next?.scheduledStart).toBe('2020-01-01T00:10:37.000Z')
  })

  test('honors every-N frequency across a continuous cycle boundary', async () => {
    const repository = mock<IMediaRepository>()
    repository.getAll.mockResolvedValue([
      { ...video(1, 'Bluey (2018)'), durationSeconds: 60 },
      interlude(90, 10),
    ])
    const allDayPolicy: LibraryPolicyDocument = {
      ...policy,
      channels: [
        {
          id: 'every-two',
          name: 'Every Two',
          enabled: true,
          timezone: 'UTC',
          slots: [
            {
              days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
              start: '00:00',
              end: '24:00',
              groups: ['comfort'],
            },
          ],
        },
      ],
    }
    const guide = await new ChannelService(
      repository,
      allDayPolicy,
      { now: () => new Date('2020-01-01T00:00:00.000Z') },
      undefined,
      { enabled: true, frequency: 2 }
    ).getGuide('every-two', 1)
    const types = guide?.programs.slice(0, 9).map((item) => item.type)

    expect(types).toEqual([
      'program',
      'program',
      'interlude',
      'program',
      'program',
      'interlude',
      'program',
      'program',
      'interlude',
    ])
  })

  test('preserves the original schedule when interludes are unavailable', async () => {
    const repository = mock<IMediaRepository>()
    repository.getAll.mockResolvedValue([
      { ...video(1, 'Bluey (2018)'), durationSeconds: 420 },
    ])
    const allDayPolicy: LibraryPolicyDocument = {
      ...policy,
      channels: [
        {
          id: 'no-bumpers',
          name: 'No Bumpers',
          enabled: true,
          timezone: 'UTC',
          slots: [
            {
              days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
              start: '00:00',
              end: '24:00',
              groups: ['comfort'],
            },
          ],
        },
      ],
    }
    const clock = { now: () => new Date('2026-08-23T23:57:00.000Z') }
    const disabled = await new ChannelService(
      repository,
      allDayPolicy,
      clock
    ).getGuide('no-bumpers', 1)
    const enabledButEmpty = await new ChannelService(
      repository,
      allDayPolicy,
      clock,
      undefined,
      { enabled: true, frequency: 1 }
    ).getGuide('no-bumpers', 1)

    expect(enabledButEmpty?.programs).toEqual(disabled?.programs)
    expect(enabledButEmpty?.programs.every((item) => item.type === 'program')).toBe(
      true
    )
  })

  test('keeps a due interlude inside a bounded slot and exposes it as now/next', async () => {
    const repository = mock<IMediaRepository>()
    repository.getAll.mockResolvedValue([
      { ...video(1, 'Bluey (2018)'), durationSeconds: 600 },
      interlude(90, 30),
    ])
    const service = new ChannelService(
      repository,
      policy,
      { now: () => new Date('2026-08-23T22:40:10.000Z') },
      undefined,
      { enabled: true, frequency: 1 }
    )
    const now = await service.getNow('kids-club')

    expect(now?.program).toMatchObject({
      mediaId: 90,
      type: 'interlude',
      scheduledStart: '2026-08-23T22:40:00.000Z',
      scheduledEnd: '2026-08-23T22:40:30.000Z',
      offsetSeconds: 10,
    })
    expect(now?.next).toMatchObject({
      mediaId: 1,
      type: 'program',
      scheduledStart: '2026-08-23T22:40:30.000Z',
    })
  })

  test('handles a five-second all-day video without exhausting the schedule builder', async () => {
    const repository = mock<IMediaRepository>()
    repository.getAll.mockResolvedValue([
      { ...video(1, 'Bluey (2018)'), durationSeconds: 5 },
    ])
    const allDayPolicy: LibraryPolicyDocument = {
      ...policy,
      channels: [
        {
          id: 'short-loop',
          name: 'Short Loop Station',
          enabled: true,
          timezone: 'UTC',
          slots: [
            {
              days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
              start: '00:00',
              end: '24:00',
              groups: ['comfort'],
            },
          ],
        },
      ],
    }
    const service = new ChannelService(repository, allDayPolicy, {
      now: () => new Date('2026-08-23T12:00:00.000Z'),
    })

    const now = await service.getNow('short-loop')
    const guide = await service.getGuide('short-loop', 1)

    expect(now?.program?.mediaId).toBe(1)
    expect(guide?.programs.length).toBeGreaterThan(0)
    expect(guide?.programs.length).toBeLessThanOrEqual(20_000)
    expect(guide?.truncated).toBe(false)
    expect(Date.parse(guide?.coverageEnd ?? '')).toBeGreaterThanOrEqual(
      Date.parse(guide?.requestedEnd ?? '')
    )
  })

  test('marks a safety-capped guide as truncated with an exact coverage boundary', async () => {
    const repository = mock<IMediaRepository>()
    repository.getAll.mockResolvedValue([
      { ...video(1, 'Bluey (2018)'), durationSeconds: 1 },
    ])
    const allDayPolicy: LibraryPolicyDocument = {
      ...policy,
      channels: [
        {
          id: 'one-second-loop',
          name: 'One Second Loop',
          enabled: true,
          timezone: 'UTC',
          slots: [
            {
              days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
              start: '00:00',
              end: '24:00',
              groups: ['comfort'],
            },
          ],
        },
      ],
    }
    const service = new ChannelService(repository, allDayPolicy, {
      now: () => new Date('2026-08-23T12:00:00.000Z'),
    })

    const guide = await service.getGuide('one-second-loop', 24)

    expect(guide?.programs).toHaveLength(20_000)
    expect(guide?.truncated).toBe(true)
    expect(guide?.coverageEnd).toBe(
      guide?.programs[guide.programs.length - 1]?.scheduledEnd
    )
    expect(Date.parse(guide?.coverageEnd ?? '')).toBeLessThan(
      Date.parse(guide?.requestedEnd ?? '')
    )
  })

  test('changes the timeline revision when collection group assignments change', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-channel-revision-'))
    try {
      const repository = mock<IMediaRepository>()
      repository.getAll.mockResolvedValue([
        video(1, 'Bluey (2018)'),
        video(2, 'Numberblocks'),
      ])
      const mappedChannel = {
        id: 'mapped',
        name: 'Mapped Station',
        enabled: true,
        timezone: 'UTC',
        slots: [
          {
            days: ['sun'] as const,
            start: '00:00',
            end: '24:00',
            groups: ['generated'],
          },
        ],
      }
      const store = new ChannelConfigurationStore(
        join(directory, 'channels.json')
      )
      store.save({
        channels: [mappedChannel],
        manuallyOffAir: [],
        collectionGroups: [
          {
            rootId: 'tv',
            collectionTitle: 'Bluey (2018)',
            groups: ['generated'],
          },
        ],
      })
      const clock = { now: () => new Date('2026-08-23T12:00:00.000Z') }
      const bluey = await new ChannelService(
        repository,
        policy,
        clock,
        store
      ).getNow('mapped')

      store.save({
        channels: [mappedChannel],
        manuallyOffAir: [],
        collectionGroups: [
          {
            rootId: 'tv',
            collectionTitle: 'Numberblocks',
            groups: ['generated'],
          },
        ],
      })
      const numberblocks = await new ChannelService(
        repository,
        policy,
        clock,
        store
      ).getNow('mapped')

      expect(bluey?.program?.mediaId).toBe(1)
      expect(numberblocks?.program?.mediaId).toBe(2)
      expect(bluey?.timelineRevision).not.toBe(numberblocks?.timelineRevision)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('uses durable collection identity without trusting a reused SQLite ID', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-channel-identity-'))
    try {
      const channel = {
        id: 'durable',
        name: 'Durable Station',
        enabled: true,
        timezone: 'UTC',
        slots: [
          {
            days: ['sun'] as const,
            start: '00:00',
            end: '24:00',
            groups: ['generated'],
          },
        ],
      }
      const store = new ChannelConfigurationStore(
        join(directory, 'channels.json')
      )
      store.save({
        channels: [channel],
        manuallyOffAir: [],
        collectionGroups: [
          {
            collectionId: 1,
            collectionIdentityKey: 'bluey-stable',
            libraryKind: 'tv',
            rootId: 'tv',
            collectionTitle: 'Bluey (2018)',
            groups: ['generated'],
          },
        ],
      })
      const clock = { now: () => new Date('2026-08-23T12:00:00.000Z') }
      const reusedIdRepository = mock<IMediaRepository>()
      reusedIdRepository.getAll.mockResolvedValue([
        {
          ...video(2, 'Numberblocks'),
          collectionId: 1,
          collectionIdentityKey: 'numberblocks-stable',
        },
      ])
      const renamedCollectionRepository = mock<IMediaRepository>()
      renamedCollectionRepository.getAll.mockResolvedValue([
        {
          ...video(3, 'Bluey Renamed'),
          collectionId: 77,
          collectionIdentityKey: 'bluey-stable',
        },
      ])

      expect(
        (await new ChannelService(
          reusedIdRepository,
          policy,
          clock,
          store
        ).getNow('durable'))?.program
      ).toBeNull()
      expect(
        (await new ChannelService(
          renamedCollectionRepository,
          policy,
          clock,
          store
        ).getNow('durable'))?.program?.mediaId
      ).toBe(3)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('applies channel edits immediately and restores persisted off-air state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-channel-service-'))
    try {
      const repository = mock<IMediaRepository>()
      const store = new ChannelConfigurationStore(
        join(directory, 'channels.json'),
        policy.channels
      )
      const service = new ChannelService(repository, policy, undefined, store)
      service.create({
        id: 'cartoons',
        name: 'Cartoon Classics',
        enabled: true,
        timezone: 'America/New_York',
        slots: [
          {
            days: ['sat'],
            start: '08:00',
            end: '10:00',
            groups: ['comfort'],
          },
        ],
      })

      expect(service.list().channels.map((channel) => channel.id)).toEqual([
        'kids-club',
        'cartoons',
      ])
      expect(service.setOnAir('cartoons', false)).toBe(true)
      expect(
        service.list().channels.find((channel) => channel.id === 'cartoons')
      ).toMatchObject({ onAir: false, manuallyOffAir: true })

      const restored = new ChannelService(repository, policy, undefined, store)
      expect(restored.isOnAir('cartoons')).toBe(false)
      expect(restored.setEnabled('cartoons', false)).toBe(true)
      expect(restored.list().channels.map((channel) => channel.id)).not.toContain(
        'cartoons'
      )
      expect(restored.delete('cartoons')).toBe(true)
      expect(
        restored.administrationSnapshot().channels.map((channel) => channel.id)
      ).toEqual(['kids-club'])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('applies Auto setup to an existing channel without changing its state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-channel-auto-update-'))
    try {
      const repository = mock<IMediaRepository>()
      const store = new ChannelConfigurationStore(
        join(directory, 'channels.json'),
        policy.channels
      )
      const service = new ChannelService(repository, policy, undefined, store)
      service.stationAutomationCatalog = async () => ({
        collections: [
          {
            id: 8,
            rootId: 'tv',
            identityKey: 'bluey-2018',
            collectionTitle: 'Bluey (2018)',
            displayTitle: 'Bluey',
            libraryKind: 'tv',
            genres: ['Animation'],
            networks: ['ABC Kids'],
            studios: ['Ludo Studio'],
            eligibleFiles: 12,
          },
        ],
        genres: [{ name: 'Animation', collections: 1 }],
        networks: [{ name: 'ABC Kids', collections: 1 }],
        studios: [{ name: 'Ludo Studio', collections: 1 }],
        presets: [],
        truncated: false,
      })
      expect(service.setOnAir('kids-club', false)).toBe(true)
      expect(service.setEnabled('kids-club', false)).toBe(true)

      const result = await service.updateAutomatedStation('kids-club', {
        id: 'kids-club',
        name: 'Bluey All Day',
        timezone: 'UTC',
        preset: 'custom',
        airtime: 'all-day',
        collectionIds: [8],
      })

      expect(result?.channel).toMatchObject({
        id: 'kids-club',
        name: 'Bluey All Day',
        enabled: false,
        timezone: 'UTC',
      })
      expect(result?.channel.slots).toHaveLength(1)
      expect(result?.channel.slots[0]).toMatchObject({
        start: '00:00',
        end: '24:00',
      })
      const generatedGroup = result?.channel.slots[0]?.groups[0]
      expect(generatedGroup).toStartWith('toasttv-auto-')
      expect(service.administrationSnapshot().manuallyOffAir).toContain(
        'kids-club'
      )

      const restored = new ChannelService(repository, policy, undefined, store)
      expect(
        restored.administrationSnapshot().channels.find(
          (channel) => channel.id === 'kids-club'
        )
      ).toMatchObject({ name: 'Bluey All Day', enabled: false })
      expect(restored.administrationSnapshot().programmingGroups).toContain(
        generatedGroup as string
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
