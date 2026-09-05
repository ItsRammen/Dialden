import { describe, expect, test } from 'bun:test'
import { mock } from 'jest-mock-extended'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IMediaRepository } from '../src/repositories/IMediaRepository'
import {
  channelLockedHandoffGroup,
  type LibraryPolicyDocument,
} from '../src/config/library'
import type { MediaItem } from '../src/types'
import { ChannelService } from '../src/services/ChannelService'
import { ChannelConfigurationStore } from '../src/services/ChannelConfigurationStore'
import type { StationAutomationCatalog } from '../src/services/StationAutomationService'

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

function episode(
  id: number,
  collectionTitle: string,
  episodeNumber: number
): MediaItem {
  const token = `S01E${String(episodeNumber).padStart(2, '0')}`
  return {
    ...video(id, collectionTitle),
    path: `/media/tv/${collectionTitle}/Season 01/${collectionTitle} ${token}.mkv`,
    filename: `${collectionTitle} ${token}.mkv`,
    relativePath: `${collectionTitle}/Season 01/${collectionTitle} ${token}.mkv`,
    seasonNumber: 1,
    episodeNumber,
  }
}

function copiedNetworkCollection(
  id: number,
  displayTitle: string,
  identityKey: string,
  firstAirYear: number
): StationAutomationCatalog['collections'][number] {
  return {
    id,
    rootId: 'tv',
    identityKey,
    collectionTitle: `${displayTitle} (${firstAirYear})`,
    displayTitle,
    libraryKind: 'tv',
    genres: ['Animation', 'Comedy'],
    networks: ['Cartoon Network'],
    studios: ['Cartoon Network Studios'],
    firstAirYear,
    eligibleFiles: 24,
  }
}

function stationCatalog(
  collections: StationAutomationCatalog['collections']
): StationAutomationCatalog {
  return {
    collections,
    genres: [],
    networks: [],
    studios: [],
    presets: [],
    truncated: false,
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

  test('keeps combined episode names while hiding filename quality tokens', async () => {
    const repository = mock<IMediaRepository>()
    const filename =
      "Ryan's Mystery Playdate - S01E01-E02 - Ryan's Kick-Flipping Playdate + Ryan's Experimental Playdate-WEB-DL-1080p.mkv"
    repository.getAll.mockResolvedValue([
      {
        ...video(2, "Ryan's Mystery Playdate"),
        path: `/media/tv/Ryan's Mystery Playdate/Season 01/${filename}`,
        filename,
        relativePath: `Ryan's Mystery Playdate/Season 01/${filename}`,
        seasonNumber: 1,
        episodeNumber: 1,
        episodeTitle:
          "Ryan's Kick-Flipping Playdate + Ryan's Experimental Playdate-WEB-DL-1080p",
        // A provider may have metadata for only the first part of a combined
        // file. The current filename remains the complete display source.
        episodeMetadataTitle: "Ryan's Kick-Flipping Playdate",
      },
    ])
    const ryanPolicy: LibraryPolicyDocument = {
      ...policy,
      roots: {
        tv: {
          collections: [
            { name: "Ryan's Mystery Playdate", groups: ['comfort'] },
          ],
        },
      },
    }
    const service = new ChannelService(repository, ryanPolicy, {
      now: () => new Date('2026-08-23T22:35:00.000Z'),
    })

    expect((await service.getNow('kids-club'))?.program).toMatchObject({
      title:
        "Ryan's Kick-Flipping Playdate + Ryan's Experimental Playdate",
      collectionTitle: "Ryan's Mystery Playdate",
      episodeLabel: 'S01E01–E02',
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

  test('builds deterministic episode marathons without immediate replays', async () => {
    const catalog = [
      episode(1, 'Bluey (2018)', 1),
      episode(2, 'Bluey (2018)', 2),
      episode(3, 'Bluey (2018)', 3),
      episode(4, 'Bluey (2018)', 4),
      episode(5, 'Numberblocks', 1),
      episode(6, 'Numberblocks', 2),
      episode(7, 'Numberblocks', 3),
      episode(8, 'Numberblocks', 4),
    ]
    const marathon = { enabled: true, frequency: 2, episodeCount: 3 }
    const scenarios = [
      {
        now: '2020-01-01T00:00:00.000Z',
        slots: [
          {
            days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const,
            start: '00:00',
            end: '24:00',
            groups: ['comfort', 'learning'],
          },
        ],
      },
      {
        now: '2026-08-24T00:00:00.000Z',
        slots: [
          {
            days: ['mon'] as const,
            start: '00:00',
            end: '02:00',
            groups: ['comfort', 'learning'],
          },
        ],
      },
    ]

    for (const scenario of scenarios) {
      const marathonPolicy: LibraryPolicyDocument = {
        ...policy,
        channels: [
          {
            id: 'marathon',
            name: 'Marathon',
            enabled: true,
            timezone: 'UTC',
            slots: scenario.slots,
            marathon,
          },
        ],
      }
      const firstRepository = mock<IMediaRepository>()
      firstRepository.getAll.mockResolvedValue(catalog)
      const reversedRepository = mock<IMediaRepository>()
      reversedRepository.getAll.mockResolvedValue([...catalog].reverse())
      const clock = { now: () => new Date(scenario.now) }
      const first = await new ChannelService(
        firstRepository,
        marathonPolicy,
        clock
      ).getGuide('marathon', 2)
      const repeated = await new ChannelService(
        reversedRepository,
        marathonPolicy,
        clock
      ).getGuide('marathon', 2)
      const programs = first?.programs ?? []

      expect(programs.map((program) => program.mediaId)).toEqual(
        repeated?.programs.map((program) => program.mediaId) ?? []
      )
      expect(programs.length).toBeGreaterThan(8)
      expect(
        programs.slice(1).every(
          (program, index) => program.mediaId !== programs[index]?.mediaId
        )
      ).toBe(true)
      expect(
        programs.some(
          (program, index) =>
            program.collectionTitle === programs[index + 1]?.collectionTitle &&
            program.collectionTitle === programs[index + 2]?.collectionTitle
        )
      ).toBe(true)
    }
  })

  test('leaves ordinary ordering unchanged when marathon mode is absent or disabled', async () => {
    const repository = mock<IMediaRepository>()
    repository.getAll.mockResolvedValue([
      episode(1, 'Bluey (2018)', 1),
      episode(2, 'Bluey (2018)', 2),
      episode(3, 'Numberblocks', 1),
      episode(4, 'Numberblocks', 2),
    ])
    const baseChannel = policy.channels?.[0]
    expect(baseChannel).toBeDefined()
    const clock = { now: () => new Date('2026-08-23T22:30:00.000Z') }
    const ordinary = await new ChannelService(
      repository,
      policy,
      clock
    ).getGuide('kids-club', 1)
    const disabled = await new ChannelService(
      repository,
      {
        ...policy,
        roots: {
          tv: {
            collections: [
              {
                name: 'SpongeBob SquarePants (1999)',
                groups: ['comfort'],
              },
            ],
          },
        },
        channels: [
          {
            ...baseChannel!,
            marathon: { enabled: false, frequency: 2, episodeCount: 3 },
          },
        ],
      },
      clock
    ).getGuide('kids-club', 1)

    expect(disabled?.programs.map((program) => program.mediaId)).toEqual(
      ordinary?.programs.map((program) => program.mediaId)
    )
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

  test('returns a complete seven-day guide from the requested day boundary', async () => {
    const repository = mock<IMediaRepository>()
    repository.getAll.mockResolvedValue([
      { ...video(1, 'Bluey (2018)'), durationSeconds: 600 },
    ])
    const weeklyPolicy: LibraryPolicyDocument = {
      ...policy,
      channels: [
        {
          id: 'weekly',
          name: 'Weekly Station',
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
    const from = new Date('2026-08-23T00:00:00.000Z')
    const guide = await new ChannelService(repository, weeklyPolicy, {
      now: () => new Date('2026-08-23T12:00:00.000Z'),
    }).getGuide('weekly', 168, { from })

    expect(guide?.programs.length).toBeGreaterThan(1_000)
    expect(guide?.programs[0]?.scheduledStart).toBe(from.toISOString())
    expect(Date.parse(guide?.coverageEnd ?? '')).toBeGreaterThanOrEqual(
      from.getTime() + 168 * 60 * 60 * 1000
    )
    expect(guide?.truncated).toBe(false)
  })

  test('keeps earlier-today and late-week programs in a sparse weekly guide', async () => {
    const repository = mock<IMediaRepository>()
    repository.getAll.mockResolvedValue([video(1, 'Bluey (2018)')])
    const sparsePolicy: LibraryPolicyDocument = {
      ...policy,
      channels: [
        {
          id: 'sparse-week',
          name: 'Sparse Week',
          enabled: true,
          timezone: 'UTC',
          slots: [
            { days: ['sun'], start: '06:30', end: '07:00', groups: ['comfort'] },
            { days: ['sat'], start: '07:00', end: '08:00', groups: ['comfort'] },
          ],
        },
      ],
    }
    const now = new Date('2026-08-23T12:00:00.000Z')
    const guide = await new ChannelService(repository, sparsePolicy, {
      now: () => now,
    }).getGuide('sparse-week', 168, {
      from: new Date('2026-08-23T00:00:00.000Z'),
    })

    expect(guide?.programs[0]?.scheduledStart).toBe('2026-08-23T06:30:00.000Z')
    expect(Date.parse(guide?.programs[0]?.scheduledStart ?? '')).toBeLessThan(
      now.getTime()
    )
    expect(
      guide?.programs.some((item) => item.scheduledStart.startsWith('2026-08-29T'))
    ).toBe(true)
  })

  test('returns station-calendar day boundaries across daylight-saving changes', async () => {
    const repository = mock<IMediaRepository>()
    repository.getAll.mockResolvedValue([video(1, 'Bluey (2018)')])
    const baseChannel = policy.channels?.[0]
    if (!baseChannel) throw new Error('Expected the shared test channel')
    const service = new ChannelService(
      repository,
      {
        ...policy,
        channels: [
          {
            ...baseChannel,
            id: 'west-coast',
            timezone: 'America/Los_Angeles',
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
      },
      { now: () => new Date('2026-11-01T18:00:00.000Z') }
    )

    const guide = await service.getGuide('west-coast', 168, {
      from: new Date('2026-11-01T00:00:00.000Z'),
      calendarDays: true,
    })

    expect(guide?.dayStarts).toHaveLength(8)
    expect(guide?.dayStarts?.[0]).toBe('2026-11-01T07:00:00.000Z')
    expect(guide?.dayStarts?.[1]).toBe('2026-11-02T08:00:00.000Z')
    expect(guide?.requestedEnd).toBe(guide?.dayStarts?.[7])
    expect(Date.parse(guide?.coverageEnd ?? '')).toBeGreaterThanOrEqual(
      Date.parse(guide?.requestedEnd ?? '')
    )
  })

  test('builds all channel now/next snapshots from one repository read', async () => {
    const repository = mock<IMediaRepository>()
    repository.getAll.mockResolvedValue([video(1, 'Bluey (2018)')])
    const baseChannel = policy.channels?.[0]
    if (!baseChannel) throw new Error('Expected the shared test channel')
    const lineupPolicy: LibraryPolicyDocument = {
      ...policy,
      channels: [
        { ...baseChannel, id: 'one', name: 'One' },
        { ...baseChannel, id: 'two', name: 'Two' },
      ],
    }
    const snapshot = await new ChannelService(repository, lineupPolicy, {
      now: () => new Date('2026-08-23T22:35:00.000Z'),
    }).getLineupSchedule()

    expect(repository.getAll).toHaveBeenCalledTimes(1)
    expect(snapshot.schedules.map((item) => item.channelId)).toEqual([
      'one',
      'two',
    ])
    expect(snapshot.schedules.every((item) => item.program?.mediaId === 1)).toBe(
      true
    )
  })

  test('coalesces concurrent lineup, now, and guide catalog reads', async () => {
    const repository = mock<IMediaRepository>()
    repository.getAll.mockResolvedValue([video(1, 'Bluey (2018)')])
    const service = new ChannelService(repository, policy, {
      now: () => new Date('2026-08-23T22:35:00.000Z'),
    })

    const [first, second, now, guide] = await Promise.all([
      service.getLineupSchedule(),
      service.getLineupSchedule(),
      service.getNow('kids-club'),
      service.getGuide('kids-club', 24),
    ])

    expect(repository.getAll).toHaveBeenCalledTimes(1)
    expect(first.schedules).toEqual(second.schedules)
    expect(now?.program?.mediaId).toBe(1)
    expect(guide?.programs.some((item) => item.mediaId === 1)).toBe(true)
  })

  test('reuses compiled lineup programs while stamping fresh response time', async () => {
    const repository = mock<IMediaRepository>()
    repository.getAll.mockResolvedValue([video(1, 'Bluey (2018)')])
    let nowMs = Date.parse('2026-08-23T22:35:00.000Z')
    const service = new ChannelService(repository, policy, {
      now: () => new Date(nowMs),
    })

    const first = await service.getLineupSchedule()
    nowMs += 5_000
    const second = await service.getLineupSchedule()

    expect(repository.getAll).toHaveBeenCalledTimes(1)
    expect(second.serverTimeMs - first.serverTimeMs).toBe(5_000)
    expect(
      (second.schedules[0]?.program?.offsetMs ?? 0) -
        (first.schedules[0]?.program?.offsetMs ?? 0)
    ).toBe(5_000)
  })

  test('reuses a rolling guide inside its stable anchor while stamping fresh time', async () => {
    const repository = mock<IMediaRepository>()
    repository.getAll.mockResolvedValue([video(1, 'Bluey (2018)')])
    let nowMs = Date.parse('2026-08-23T22:31:00.000Z')
    const service = new ChannelService(repository, policy, {
      now: () => new Date(nowMs),
    })

    const first = await service.getGuide('kids-club', 8)
    nowMs += 2 * 60_000
    const second = await service.getGuide('kids-club', 8)

    expect(repository.getAll).toHaveBeenCalledTimes(1)
    expect(second?.programs).toBe(first?.programs)
    expect((second?.serverTimeMs ?? 0) - (first?.serverTimeMs ?? 0)).toBe(
      2 * 60_000
    )
  })

  test('yields guide compilation so streaming timers can keep advancing', async () => {
    const repository = mock<IMediaRepository>()
    repository.getAll.mockResolvedValue([video(1, 'Bluey (2018)')])
    const service = new ChannelService(repository, policy, {
      now: () => new Date('2026-08-23T22:35:00.000Z'),
    })
    await service.getNow('kids-club')

    let completed = false
    const pending = service
      .getGuide('kids-club', 168, {
        from: new Date('2026-08-23T00:00:00.000Z'),
      })
      .then((guide) => {
        completed = true
        return guide
      })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(completed).toBe(false)
    expect((await pending)?.programs.length).toBeGreaterThan(0)
  })

  test('invalidates cached schedules after the media catalog changes', async () => {
    const repository = mock<IMediaRepository>()
    repository.getAll
      .mockResolvedValueOnce([video(1, 'Bluey (2018)')])
      .mockResolvedValueOnce([video(2, 'Bluey (2018)')])
    const service = new ChannelService(repository, policy, {
      now: () => new Date('2026-08-23T22:35:00.000Z'),
    })

    expect((await service.getLineupSchedule()).schedules[0]?.program?.mediaId).toBe(1)
    expect((await service.getLineupSchedule()).schedules[0]?.program?.mediaId).toBe(1)
    service.invalidateScheduleCatalog()
    expect((await service.getLineupSchedule()).schedules[0]?.program?.mediaId).toBe(2)
    expect(repository.getAll).toHaveBeenCalledTimes(2)
  })

  test('discards an in-flight source snapshot invalidated by a scan', async () => {
    const repository = mock<IMediaRepository>()
    let releaseFirst: ((items: MediaItem[]) => void) | undefined
    repository.getAll
      .mockImplementationOnce(
        () =>
          new Promise<MediaItem[]>((resolve) => {
            releaseFirst = resolve
          })
      )
      .mockResolvedValueOnce([video(2, 'Bluey (2018)')])
    const service = new ChannelService(repository, policy, {
      now: () => new Date('2026-08-23T22:35:00.000Z'),
    })

    const pending = service.getLineupSchedule()
    await Promise.resolve()
    service.invalidateScheduleCatalog()
    releaseFirst?.([video(1, 'Bluey (2018)')])
    const result = await pending

    expect(result.schedules[0]?.program?.mediaId).toBe(2)
    expect(repository.getAll).toHaveBeenCalledTimes(2)
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

  test('fills the remainder of a bounded Nick slot instead of leaving the channel offline', async () => {
    const repository = mock<IMediaRepository>()
    const show = {
      ...video(1, 'SpongeBob SquarePants (1999)'),
      durationSeconds: 700,
    }
    const filler = {
      ...interlude(90, 60),
      filename: 'nick__filler-general__target-60s__v01.mp4',
    }
    repository.getAll.mockResolvedValue([show, filler])
    const service = new ChannelService(
      repository,
      {
        ...policy,
        channels: [
          {
            id: 'nick',
            name: 'Nick',
            enabled: true,
            timezone: 'UTC',
            slots: [
              {
                days: ['sun'],
                start: '06:30',
                end: '07:00',
                groups: ['comfort'],
              },
            ],
          },
        ],
      },
      { now: () => new Date('2026-08-23T06:30:00.000Z') },
      undefined,
      { enabled: true, frequency: 1 }
    )

    const guide = await service.getGuide('nick', 1)
    const programs = guide?.programs ?? []
    expect(programs[0]?.scheduledStart).toBe('2026-08-23T06:30:00.000Z')
    expect(programs.at(-1)?.scheduledEnd).toBe('2026-08-23T07:00:00.000Z')
    for (let index = 1; index < programs.length; index++) {
      expect(programs[index]?.scheduledStart).toBe(
        programs[index - 1]?.scheduledEnd
      )
    }
    expect(programs.filter((item) => item.type === 'interlude')).toHaveLength(7)
    expect(programs.at(-1)).toMatchObject({
      durationSeconds: 40,
      sourceDurationSeconds: 40,
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
        marathon: { enabled: true, frequency: 12, episodeCount: 4 },
      })

      expect(result?.channel).toMatchObject({
        id: 'kids-club',
        name: 'Bluey All Day',
        enabled: false,
        timezone: 'UTC',
        marathon: { enabled: true, frequency: 12, episodeCount: 4 },
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
      expect(await service.stationAutomationDraft('kids-club')).toMatchObject({
        id: 'kids-club',
        preset: 'custom',
        airtime: 'all-day',
        collectionIds: [8],
        marathon: { enabled: true, frequency: 12, episodeCount: 4 },
      })
      expect(
        (
          await service.updateAutomatedStation('kids-club', {
            id: 'kids-club',
            name: 'Bluey All Day',
            timezone: 'UTC',
            preset: 'custom',
            airtime: 'all-day',
            collectionIds: [8],
          })
        )?.channel.marathon
      ).toEqual({ enabled: true, frequency: 12, episodeCount: 4 })

      const restored = new ChannelService(repository, policy, undefined, store)
      expect(
        restored.administrationSnapshot().channels.find(
          (channel) => channel.id === 'kids-club'
        )
      ).toMatchObject({
        name: 'Bluey All Day',
        enabled: false,
        marathon: { enabled: true, frequency: 12, episodeCount: 4 },
      })
      expect(restored.administrationSnapshot().programmingGroups).toContain(
        generatedGroup as string
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('persists and reopens an exact copied-network recipe with durable refs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-network-copy-'))
    try {
      const repository = mock<IMediaRepository>()
      const store = new ChannelConfigurationStore(
        join(directory, 'channels.json'),
        policy.channels
      )
      const catalog = {
        collections: [
          {
            id: 81,
            rootId: 'tv',
            identityKey: 'ed-edd-n-eddy-1999',
            collectionTitle: 'Ed, Edd n Eddy (1999)',
            displayTitle: 'Ed, Edd n Eddy',
            libraryKind: 'tv' as const,
            genres: ['Animation', 'Comedy'],
            networks: ['Cartoon Network'],
            studios: ['Cartoon Network Studios'],
            firstAirYear: 1999,
            eligibleFiles: 24,
          },
          {
            id: 82,
            rootId: 'tv',
            identityKey: 'bluey-2018',
            collectionTitle: 'Bluey (2018)',
            displayTitle: 'Bluey',
            libraryKind: 'tv' as const,
            genres: ['Animation', 'Family'],
            networks: ['ABC Kids'],
            studios: ['Ludo Studio'],
            firstAirYear: 2018,
            eligibleFiles: 30,
          },
        ],
        genres: [],
        networks: [],
        studios: [],
        presets: [],
        truncated: false,
      }
      const service = new ChannelService(repository, policy, undefined, store)
      service.stationAutomationCatalog = async () => catalog

      const result = await service.createAutomatedStation({
        id: 'cn-copy',
        name: 'Cartoon Network 1997–Current',
        timezone: 'UTC',
        preset: 'network-copy',
        networkId: 'cartoon-network',
        eraStartYear: 1997,
        eraEndYear: 2026,
        selectionMode: 'explicit',
        collectionIds: [81],
        airtime: 'all-day',
        handoff: {
          identity: 'adult-swim',
          mode: 'locked-off-air',
          start: '21:00',
          end: '06:00',
        },
      })

      expect(result.collections.map((collection) => collection.displayTitle)).toEqual([
        'Ed, Edd n Eddy',
      ])
      expect(result.channel.automation).toEqual({
        preset: 'network-copy',
        airtime: 'all-day',
        networkId: 'cartoon-network',
        eraStartYear: 1997,
        eraEndYear: 2026,
        selectionMode: 'explicit',
        handoff: {
          identity: 'adult-swim',
          mode: 'locked-off-air',
          start: '21:00',
          end: '06:00',
        },
        collectionRefs: [
          {
            rootId: 'tv',
            libraryKind: 'tv',
            identityKey: 'ed-edd-n-eddy-1999',
          },
        ],
      })
      expect(result.channel.slots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            start: '00:00',
            end: '06:00',
            groups: [expect.stringContaining('-locked-after-hours')],
            branding: { mode: 'custom', logoId: 'adult-swim' },
          }),
          expect.objectContaining({
            start: '21:00',
            end: '24:00',
            groups: [expect.stringContaining('-locked-after-hours')],
            branding: { mode: 'custom', logoId: 'adult-swim' },
          }),
        ])
      )
      expect(
        store
          .load()
          .collectionGroups?.flatMap((assignment) => assignment.groups)
          .some((group) => group.endsWith('-locked-after-hours'))
      ).toBe(false)

      const restored = new ChannelService(repository, policy, undefined, store)
      restored.stationAutomationCatalog = async () => catalog
      expect(await restored.stationAutomationDraft('cn-copy')).toMatchObject({
        id: 'cn-copy',
        preset: 'network-copy',
        networkId: 'cartoon-network',
        eraStartYear: 1997,
        eraEndYear: 2026,
        selectionMode: 'explicit',
        collectionIds: [81],
        handoff: {
          identity: 'adult-swim',
          mode: 'locked-off-air',
          start: '21:00',
          end: '06:00',
        },
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('never schedules media assigned to the reserved locked handoff group', async () => {
    const repository = mock<IMediaRepository>()
    repository.getAll.mockResolvedValue([video(1, 'Bluey (2018)')])
    const channelId = 'cn-reserved'
    const lockedGroup = channelLockedHandoffGroup(channelId)
    const everyDay = [
      'sun',
      'mon',
      'tue',
      'wed',
      'thu',
      'fri',
      'sat',
    ] as const
    const lockedBranding = {
      mode: 'custom' as const,
      logoId: 'adult-swim',
    }
    const lockedPolicy: LibraryPolicyDocument = {
      version: 1,
      roots: {
        tv: {
          collections: [
            { name: 'Bluey (2018)', groups: [lockedGroup] },
          ],
        },
      },
      channels: [
        {
          id: channelId,
          name: 'Cartoon Network Reserved',
          enabled: true,
          timezone: 'UTC',
          slots: [
            {
              days: everyDay,
              start: '00:00',
              end: '06:00',
              groups: [lockedGroup],
              branding: lockedBranding,
            },
            {
              days: everyDay,
              start: '06:00',
              end: '21:00',
              groups: ['daytime'],
            },
            {
              days: everyDay,
              start: '21:00',
              end: '24:00',
              groups: [lockedGroup],
              branding: lockedBranding,
            },
          ],
          automation: {
            preset: 'network-copy',
            airtime: 'all-day',
            networkId: 'cartoon-network',
            eraStartYear: 1997,
            eraEndYear: 2026,
            selectionMode: 'automatic',
            handoff: {
              identity: 'adult-swim',
              mode: 'locked-off-air',
              start: '21:00',
              end: '06:00',
            },
          },
        },
      ],
    }
    const service = new ChannelService(repository, lockedPolicy, {
      now: () => new Date('2026-08-23T02:00:00.000Z'),
    })

    expect((await service.getNow(channelId))?.program).toBeNull()
  })

  test('reconciles automatic copied networks after scans and stays idempotent', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-auto-reconcile-'))
    try {
      const repository = mock<IMediaRepository>()
      const store = new ChannelConfigurationStore(
        join(directory, 'channels.json'),
        policy.channels
      )
      const dexter = copiedNetworkCollection(
        91,
        "Dexter's Laboratory",
        'dexters-laboratory-1996',
        1996
      )
      const ed = copiedNetworkCollection(
        92,
        'Ed, Edd n Eddy',
        'ed-edd-n-eddy-1999',
        1999
      )
      let catalog = stationCatalog([dexter])
      const service = new ChannelService(repository, policy, undefined, store)
      service.stationAutomationCatalog = async () => catalog

      const created = await service.createAutomatedStation({
        id: 'cn-auto',
        name: 'Cartoon Network Auto',
        timezone: 'UTC',
        preset: 'network-copy',
        networkId: 'cartoon-network',
        eraStartYear: 1997,
        eraEndYear: 2026,
        selectionMode: 'automatic',
        airtime: 'all-day',
      })
      expect(created.channel.automation).not.toHaveProperty('collectionRefs')
      expect(await service.reconcileAutomatedStations()).toEqual([])

      const beforeOfflinePass = store.load().collectionGroups
      catalog = stationCatalog([])
      expect(await service.reconcileAutomatedStations()).toEqual([])
      expect(store.load().collectionGroups).toEqual(beforeOfflinePass)

      catalog = stationCatalog([dexter, ed])
      expect(await service.reconcileAutomatedStations()).toEqual(['cn-auto'])
      expect(
        store
          .load()
          .collectionGroups?.map(
            (assignment) => assignment.collectionIdentityKey
          )
      ).toEqual(
        expect.arrayContaining([
          'dexters-laboratory-1996',
          'ed-edd-n-eddy-1999',
        ])
      )
      expect(await service.reconcileAutomatedStations()).toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('removes still-available titles that become ineligible without deleting the channel', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-auto-ineligible-'))
    try {
      const repository = mock<IMediaRepository>()
      const store = new ChannelConfigurationStore(
        join(directory, 'channels.json'),
        policy.channels
      )
      const original = copiedNetworkCollection(
        96,
        'Network Original',
        'network-original-2020',
        2020
      )
      let catalog = stationCatalog([original])
      const service = new ChannelService(repository, policy, undefined, store)
      service.stationAutomationCatalog = async () => catalog
      await service.createAutomatedStation({
        id: 'cn-recheck',
        name: 'Cartoon Network Recheck',
        timezone: 'UTC',
        preset: 'network-copy',
        networkId: 'cartoon-network',
        eraStartYear: 1997,
        eraEndYear: 2026,
        selectionMode: 'automatic',
        airtime: 'all-day',
      })
      expect(
        store.load().collectionGroups?.map(
          (assignment) => assignment.collectionIdentityKey
        )
      ).toContain('network-original-2020')

      catalog = stationCatalog([
        { ...original, networks: ['ABC Kids'], studios: ['Ludo Studio'] },
      ])
      expect(await service.reconcileAutomatedStations()).toEqual([
        'cn-recheck',
      ])
      expect(
        store.load().collectionGroups?.map(
          (assignment) => assignment.collectionIdentityKey
        )
      ).not.toContain('network-original-2020')
      expect(
        service
          .administrationSnapshot()
          .channels.some((channel) => channel.id === 'cn-recheck')
      ).toBe(true)
      expect(await service.reconcileAutomatedStations()).toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('preserves unavailable explicit refs and resolves them after a rescan', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-ref-reconcile-'))
    try {
      const repository = mock<IMediaRepository>()
      const store = new ChannelConfigurationStore(
        join(directory, 'channels.json'),
        policy.channels
      )
      const dexter = copiedNetworkCollection(
        101,
        "Dexter's Laboratory",
        'dexters-laboratory-1996',
        1996
      )
      const ed = copiedNetworkCollection(
        102,
        'Ed, Edd n Eddy',
        'ed-edd-n-eddy-1999',
        1999
      )
      let catalog = stationCatalog([dexter, ed])
      const service = new ChannelService(repository, policy, undefined, store)
      service.stationAutomationCatalog = async () => catalog
      await service.createAutomatedStation({
        id: 'cn-explicit',
        name: 'Cartoon Network Picks',
        timezone: 'UTC',
        preset: 'network-copy',
        networkId: 'cartoon-network',
        eraStartYear: 1997,
        eraEndYear: 2026,
        selectionMode: 'explicit',
        collectionIds: [101, 102],
        airtime: 'all-day',
      })

      catalog = stationCatalog([dexter])
      expect(await service.stationAutomationDraft('cn-explicit')).toMatchObject({
        collectionIds: [101],
        unavailableCollectionRefs: [
          {
            rootId: 'tv',
            libraryKind: 'tv',
            identityKey: 'ed-edd-n-eddy-1999',
          },
        ],
      })
      const updated = await service.updateAutomatedStation('cn-explicit', {
        id: 'cn-explicit',
        name: 'Cartoon Network Picks',
        timezone: 'UTC',
        preset: 'network-copy',
        networkId: 'cartoon-network',
        eraStartYear: 1997,
        eraEndYear: 2026,
        selectionMode: 'explicit',
        collectionIds: [101],
        airtime: 'all-day',
      })
      expect(updated?.channel.automation?.collectionRefs).toHaveLength(2)
      expect(
        store
          .load()
          .collectionGroups?.map(
            (assignment) => assignment.collectionIdentityKey
          )
      ).toContain('ed-edd-n-eddy-1999')

      const rescannedEd = { ...ed, id: 202 }
      catalog = stationCatalog([dexter, rescannedEd])
      expect(await service.reconcileAutomatedStations()).toEqual([
        'cn-explicit',
      ])
      expect(await service.stationAutomationDraft('cn-explicit')).toMatchObject({
        collectionIds: [101, 202],
      })
      expect(
        (await service.stationAutomationDraft('cn-explicit'))
          ?.unavailableCollectionRefs
      ).toBeUndefined()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('reconciles general recipes while keeping hand-picked AI-style selections durable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-general-recipes-'))
    try {
      const repository = mock<IMediaRepository>()
      const store = new ChannelConfigurationStore(
        join(directory, 'channels.json'),
        policy.channels
      )
      const pbs = {
        ...copiedNetworkCollection(301, 'PBS Show', 'pbs-show', 2020),
        networks: ['PBS Kids'],
        genres: ['Family'],
      }
      const cbbc = {
        ...copiedNetworkCollection(302, 'CBBC Show', 'cbbc-show', 2021),
        networks: ['CBBC'],
        genres: ['Children'],
      }
      let catalog = stationCatalog([pbs])
      const service = new ChannelService(repository, policy, undefined, store)
      service.stationAutomationCatalog = async () => catalog

      const recipe = await service.createAutomatedStation({
        id: 'public-kids',
        name: 'Public Kids',
        timezone: 'UTC',
        preset: 'public-kids-mix',
        selectionMode: 'automatic',
        airtime: 'all-day',
      })
      expect(recipe.channel.automation).toMatchObject({
        preset: 'public-kids-mix',
        selectionMode: 'automatic',
      })

      await service.createAutomatedStation({
        id: 'ai-picks',
        name: 'AI Picks',
        timezone: 'UTC',
        preset: 'custom',
        selectionMode: 'explicit',
        collectionIds: [301],
        airtime: 'all-day',
      })
      expect(
        service.administrationSnapshot().channels.find((item) => item.id === 'ai-picks')
          ?.automation?.collectionRefs
      ).toEqual([
        { rootId: 'tv', libraryKind: 'tv', identityKey: 'pbs-show' },
      ])

      catalog = stationCatalog([pbs, cbbc])
      expect(await service.reconcileAutomatedStations()).toEqual(['public-kids'])
      expect(
        (await service.stationAutomationDraft('ai-picks'))?.collectionIds
      ).toEqual([301])
      expect(
        (await service.stationAutomationDraft('public-kids'))?.collectionIds
      ).toEqual(expect.arrayContaining([301, 302]))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
