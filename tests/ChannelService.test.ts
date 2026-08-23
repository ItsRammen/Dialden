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

describe('ChannelService', () => {
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
})
