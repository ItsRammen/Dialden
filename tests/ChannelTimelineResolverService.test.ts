import { describe, expect, test } from 'bun:test'
import { ChannelTimelineResolverService } from '../src/services/ChannelTimelineResolverService'
import type {
  ChannelNowResult,
  ScheduledProgram,
} from '../src/services/ChannelService'
import type { MediaItem } from '../src/types'

function program(
  id: string,
  mediaId: number,
  start: string,
  end: string,
  type: ScheduledProgram['type'] = 'program'
): ScheduledProgram {
  return {
    id,
    channelId: 'kids',
    mediaId,
    title: id,
    collectionTitle: id,
    scheduledStart: start,
    scheduledEnd: end,
    durationSeconds: (Date.parse(end) - Date.parse(start)) / 1000,
    durationMs: Date.parse(end) - Date.parse(start),
    type,
    sourceStartSeconds: 0,
    sourceDurationSeconds: (Date.parse(end) - Date.parse(start)) / 1000,
    transitionIn: 'hard_cut',
    transitionOut: 'hard_cut',
  }
}

describe('ChannelTimelineResolverService', () => {
  test('emits one clean-video position per program', async () => {
    const episode = program(
      'episode-a',
      1,
      '2026-08-24T19:30:00.000Z',
      '2026-08-24T20:30:00.000Z'
    )
    const now: ChannelNowResult = {
      channelId: 'kids',
      serverTime: '2026-08-24T19:55:00.000Z',
      serverTimeMs: Date.parse('2026-08-24T19:55:00.000Z'),
      timezone: 'UTC',
      timelineRevision: 'r-brand',
      program: {
        ...episode,
        playback: { mode: 'direct', url: '/media/1', sourceOffsetAtPlaybackZeroMs: 0 },
        offsetMs: 1_500_000,
        offsetSeconds: 1_500,
      },
      next: null,
    }
    const channel = {
      id: 'kids', name: 'Kids', enabled: true, timezone: 'UTC',
      branding: { mode: 'inherit' as const, burnIn: true, opacity: 210, position: 2 as const, x: 24, y: 24, sizePercent: 12 },
      slots: [
        { days: ['mon' as const], start: '00:00', end: '20:00', groups: ['kids'], branding: { mode: 'custom' as const, logoId: 'nick' } },
        { days: ['mon' as const], start: '20:00', end: '24:00', groups: ['kids'], branding: { mode: 'custom' as const, logoId: 'adult-swim' } },
      ],
    }
    const resolver = new ChannelTimelineResolverService(
      {
        getNow: async () => now,
        getGuide: async () => ({
          channelId: 'kids', serverTime: now.serverTime, serverTimeMs: now.serverTimeMs,
          timezone: 'UTC', timelineRevision: 'r-brand', requestedEnd: episode.scheduledEnd,
          coverageEnd: episode.scheduledEnd, truncated: false, programs: [episode],
        }),
        administrationSnapshot: () => ({ channels: [channel], manuallyOffAir: [], programmingGroups: ['kids'], configurationError: null }),
      },
      { resolveForChannelWorker: async () => ({ path: '/media/1.mkv', size: 1, mimeType: 'video/x-matroska', lastModified: new Date(0) }) },
      { getById: async () => null },
      async () => ({ session: { limitMinutes: 0, resetHour: 6, introVideoId: null, outroVideoId: null, offAirAssetId: null } }),
      { path: (id, logoId) => `/logos/${id}--${logoId}.png` }
    )

    const window = await resolver.resolveWindow('kids', new Date(now.serverTime), 2)
    expect(window).toHaveLength(1)
    expect(window[0]).toMatchObject({
      scheduleItemId: 'episode-a',
      sourceOffsetSeconds: 1500,
      sourceDurationSeconds: 2100,
    })
    expect(window[0]).not.toHaveProperty('overlay')
  })

  test('resolves effective app logo metadata for channel and scheduled branding', async () => {
    const channel = {
      id: 'kids',
      name: 'Kids',
      enabled: true,
      timezone: 'UTC',
      branding: {
        mode: 'custom' as const,
        opacity: 210,
        position: 2 as const,
        x: 24,
        y: 24,
        sizePercent: 12,
      },
      slots: [
        {
          days: ['mon' as const],
          start: '18:00',
          end: '20:00',
          groups: ['kids'],
          branding: { mode: 'custom' as const, logoId: 'nick' },
        },
        {
          days: ['mon' as const],
          start: '20:00',
          end: '21:00',
          groups: ['kids'],
          branding: { mode: 'off' as const },
        },
        {
          days: ['mon' as const],
          start: '21:00',
          end: '22:00',
          groups: ['kids'],
          branding: { mode: 'inherit' as const },
        },
      ],
    }
    const resolver = new ChannelTimelineResolverService(
      {
        getGuide: async () => null,
        administrationSnapshot: () => ({
          channels: [
            channel,
            {
              ...channel,
              id: 'missing',
              name: 'Missing',
              slots: [],
            },
            {
              ...channel,
              id: 'hidden',
              name: 'Hidden',
              branding: { ...channel.branding, mode: 'off' as const },
              slots: [],
            },
          ],
          manuallyOffAir: [],
          programmingGroups: ['kids'],
          configurationError: null,
        }),
      },
      { resolveForChannelWorker: async () => null },
      { getById: async () => null },
      async () => ({
        session: {
          limitMinutes: 0,
          resetHour: 6,
          introVideoId: null,
          outroVideoId: null,
          offAirAssetId: null,
        },
        logo: {
          enabled: true,
          imagePath: '/data/logo.png',
          opacity: 210,
          position: 2,
          x: 24,
          y: 24,
        },
      }),
      {
        path: (id, logoId) => `/logos/${id}${logoId ? `--${logoId}` : ''}.png`,
        has: (id, logoId) => id !== 'missing' && logoId !== 'missing',
      },
      (path) => path === '/data/logo.png'
    )

    expect(
      await resolver.presentation('kids', new Date('2026-08-24T17:00:00.000Z'))
    ).toEqual({ enabled: true, logoUrl: '/channels/kids/logo' })
    expect(
      await resolver.presentation('kids', new Date('2026-08-24T19:00:00.000Z'))
    ).toEqual({
      enabled: true,
      logoUrl: '/channels/kids/logo?variant=nick',
    })
    expect(
      await resolver.presentation('kids', new Date('2026-08-24T20:30:00.000Z'))
    ).toEqual({ enabled: false })
    expect(
      await resolver.presentation('kids', new Date('2026-08-24T21:30:00.000Z'))
    ).toEqual({ enabled: true, logoUrl: '/logo' })
    expect(await resolver.presentation('missing')).toEqual({ enabled: false })
    expect(await resolver.presentation('hidden')).toEqual({ enabled: false })
  })

  test('hints hardware decode only for 8-bit h264 sources a QSV backend can handle', async () => {
    const episodeA = program(
      'episode-a',
      1,
      '2026-08-24T12:00:00.000Z',
      '2026-08-24T12:30:00.000Z'
    )
    const bumper = program(
      'bumper',
      2,
      '2026-08-24T12:30:00.000Z',
      '2026-08-24T12:30:20.000Z',
      'interlude'
    )
    const guide = () => ({
      channelId: 'kids',
      serverTime: '2026-08-24T12:05:00.000Z',
      serverTimeMs: Date.parse('2026-08-24T12:05:00.000Z'),
      timezone: 'UTC',
      timelineRevision: 'revision-1',
      requestedEnd: bumper.scheduledEnd,
      coverageEnd: bumper.scheduledEnd,
      truncated: false,
      programs: [episodeA, bumper],
    })
    const resolveMedia = {
      resolveForChannelWorker: async (id: number) => ({
        path: `/media/${id}.mkv`,
        size: 1,
        mimeType: 'video/x-matroska',
        lastModified: new Date(0),
      }),
    }
    const buildResolver = (
      hardware: boolean,
      mediaById: Map<number, Partial<MediaItem>>
    ) =>
      new ChannelTimelineResolverService(
        { getGuide: async () => guide() },
        resolveMedia,
        { getById: async (id) => (mediaById.get(id) ?? null) as MediaItem | null },
        undefined,
        undefined,
        () => true,
        () => hardware
      )

    const base: Array<[string, Partial<MediaItem>, 'hw' | 'sw']> = [
      ['8-bit h264', { codec: 'h264', compatibility: 'compatible', pixelFormat: 'yuv420p' }, 'hw'],
      ['10-bit h264 (Hi10P)', { codec: 'h264', compatibility: 'compatible', pixelFormat: 'yuv420p10le' }, 'sw'],
      ['unknown pixel format', { codec: 'h264', compatibility: 'compatible' }, 'sw'],
      ['non-h264', { codec: 'mpeg4', compatibility: 'marginal', pixelFormat: 'yuv420p' }, 'sw'],
      ['incompatible h264', { codec: 'h264', compatibility: 'incompatible', pixelFormat: 'yuv420p' }, 'sw'],
    ]
    const hardwareWindow = await buildResolver(true, new Map([
      [1, base[0]![1]],
      [2, { codec: 'mpeg4', compatibility: 'marginal', pixelFormat: 'yuv420p' }],
    ])).resolveWindow('kids', new Date(), 2)
    expect(hardwareWindow[0]).toMatchObject({ decodeHint: 'hw' })
    expect(hardwareWindow[1]).toMatchObject({ decodeHint: 'sw' })

    for (const [label, item, expected] of base.slice(1)) {
      const window = await buildResolver(true, new Map([[1, item]])).resolveWindow(
        'kids',
        new Date(),
        1
      )
      expect(`${label} → ${String(window[0]?.decodeHint)}`).toBe(
        `${label} → ${expected}`
      )
    }

    const softwareResult = await buildResolver(false, new Map([
      [1, { codec: 'h264', compatibility: 'compatible', pixelFormat: 'yuv420p' }],
    ])).resolveWindow('kids', new Date(), 1)
    expect(softwareResult[0]).toMatchObject({ decodeHint: 'sw' })
  })

  test('resolves the live offset plus bumper and next episode as one window', async () => {
    const episodeA = program(
      'episode-a',
      1,
      '2026-08-24T12:00:00.000Z',
      '2026-08-24T12:30:00.000Z'
    )
    const bumper = program(
      'bumper',
      2,
      '2026-08-24T12:30:00.000Z',
      '2026-08-24T12:30:20.000Z',
      'interlude'
    )
    const episodeB = program(
      'episode-b',
      3,
      '2026-08-24T12:30:20.000Z',
      '2026-08-24T13:00:20.000Z'
    )
    const now: ChannelNowResult = {
      channelId: 'kids',
      serverTime: '2026-08-24T12:05:00.000Z',
      serverTimeMs: Date.parse('2026-08-24T12:05:00.000Z'),
      timezone: 'UTC',
      timelineRevision: 'revision-1',
      program: {
        ...episodeA,
        playback: {
          mode: 'direct',
          url: '/api/v1/media/1/stream',
          sourceOffsetAtPlaybackZeroMs: 0,
        },
        offsetMs: 300_000,
        offsetSeconds: 300,
      },
      next: bumper,
    }
    const resolver = new ChannelTimelineResolverService(
      {
        getNow: async () => now,
        getGuide: async () => ({
          channelId: 'kids',
          serverTime: now.serverTime,
          serverTimeMs: now.serverTimeMs,
          timezone: 'UTC',
          timelineRevision: 'revision-1',
          requestedEnd: '2026-08-24T18:00:00.000Z',
          coverageEnd: episodeB.scheduledEnd,
          truncated: false,
          programs: [episodeA, bumper, episodeB],
        }),
      },
      {
        resolveForChannelWorker: async (id) => ({
          path: `/media/${id}.mkv`,
          size: 1,
          mimeType: 'video/x-matroska',
          lastModified: new Date(0),
        }),
      },
      { getById: async () => null }
    )

    const window = await resolver.resolveWindow('kids', new Date(), 3)

    expect(window.map((item) => item.scheduleItemId)).toEqual([
      'episode-a',
      'bumper',
      'episode-b',
    ])
    expect(window[0]).toMatchObject({
      sourceOffsetSeconds: 300,
      sourceDurationSeconds: 1500,
      nextScheduleItemId: 'bumper',
    })
    expect(window[1]).toMatchObject({
      type: 'interlude',
      sourceOffsetSeconds: 0,
      sourceDurationSeconds: 20,
    })
  })

  test('cannot mix a stale now result with a newer guide at a program boundary', async () => {
    const bluey = program(
      'bluey',
      1,
      '2026-08-24T11:30:00.000Z',
      '2026-08-24T12:00:00.000Z'
    )
    const magicSchoolBus = program(
      'magic-school-bus',
      2,
      '2026-08-24T12:00:00.000Z',
      '2026-08-24T12:30:00.000Z'
    )
    let nowCalls = 0
    const resolver = new ChannelTimelineResolverService(
      {
        getNow: async () => {
          nowCalls += 1
          return null
        },
        getGuide: async () => ({
          channelId: 'kids',
          serverTime: '2026-08-24T12:00:01.000Z',
          serverTimeMs: Date.parse('2026-08-24T12:00:01.000Z'),
          timezone: 'UTC',
          timelineRevision: 'boundary-revision',
          requestedEnd: '2026-08-24T14:00:00.000Z',
          coverageEnd: magicSchoolBus.scheduledEnd,
          truncated: false,
          programs: [bluey, magicSchoolBus],
        }),
      },
      {
        resolveForChannelWorker: async (id) => ({
          path: `/media/${id}.mkv`,
          size: 1,
          mimeType: 'video/x-matroska',
          lastModified: new Date(0),
        }),
      },
      { getById: async () => null }
    )

    const window = await resolver.resolveWindow('kids', new Date(), 1)

    expect(nowCalls).toBe(0)
    expect(window[0]).toMatchObject({
      scheduleItemId: 'magic-school-bus',
      sourcePath: '/media/2.mkv',
      sourceOffsetSeconds: 1,
    })
  })

  test('explains an empty worker window when a scan has quarantined the scheduled root', async () => {
    const episode = program(
      'rocket-power',
      789755,
      '2026-08-26T11:35:05.000Z',
      '2026-08-26T11:47:06.000Z'
    )
    const resolver = new ChannelTimelineResolverService(
      {
        getGuide: async () => ({
          channelId: 'Nickelodeon',
          serverTime: '2026-08-26T11:42:41.000Z',
          serverTimeMs: Date.parse('2026-08-26T11:42:41.000Z'),
          timezone: 'Asia/Taipei',
          timelineRevision: 'revision-1',
          requestedEnd: episode.scheduledEnd,
          coverageEnd: episode.scheduledEnd,
          truncated: false,
          programs: [episode],
        }),
      },
      { resolveForChannelWorker: async () => null },
      {
        getById: async () =>
          ({
            id: 789755,
            rootId: 'tv',
            relativePath: 'Rocket Power/Season 01/episode.mkv',
            rootAvailable: false,
            playbackEnabled: true,
            durationSeconds: 721,
          }) as MediaItem,
      }
    )

    expect(
      await resolver.resolveWindow(
        'Nickelodeon',
        new Date('2026-08-26T11:42:41.000Z'),
        1
      )
    ).toEqual([])
    expect(resolver.unavailableReason('Nickelodeon')).toBe(
      'Scheduled media 789755 for channel Nickelodeon is unavailable: library root tv is unavailable (a library scan may be in progress)'
    )
  })

  test('resolves the configured off-air asset as an emergency fallback', async () => {
    const resolver = new ChannelTimelineResolverService(
      { getNow: async () => null, getGuide: async () => null },
      {
        resolveForChannelWorker: async () => ({
          path: '/media/standby.mp4',
          size: 1,
          mimeType: 'video/mp4',
          lastModified: new Date(0),
        }),
      },
      {
        getById: async () =>
          ({ id: 9, durationSeconds: 30 } as MediaItem),
      },
      async () => ({
        session: {
          limitMinutes: 0,
          resetHour: 6,
          offAirAssetId: 9,
          introVideoId: null,
          outroVideoId: null,
        },
      })
    )

    const fallback = await resolver.fallback('kids', null, new Date())

    expect(fallback).toMatchObject({
      scheduleItemId: 'kids:fallback:9',
      sourcePath: '/media/standby.mp4',
      sourceDurationSeconds: 30,
      type: 'offair',
    })
  })

  test('loops fallback for the complete missing schedule range', async () => {
    const resolver = new ChannelTimelineResolverService(
      { getNow: async () => null, getGuide: async () => null },
      {
        resolveForChannelWorker: async () => ({
          path: '/media/standby.mp4',
          size: 1,
          mimeType: 'video/mp4',
          lastModified: new Date(0),
        }),
      },
      { getById: async () => ({ id: 9, durationSeconds: 30 } as MediaItem) },
      async () => ({
        session: {
          limitMinutes: 0,
          resetHour: 6,
          offAirAssetId: 9,
          introVideoId: null,
          outroVideoId: null,
        },
      })
    )

    const fallback = await resolver.fallback(
      'kids',
      {
        scheduleItemId: 'missing',
        sourcePath: '/media/missing.mkv',
        sourceOffsetSeconds: 300,
        sourceDurationSeconds: 900,
        timelineRevision: 'r1',
        type: 'program',
      },
      new Date()
    )

    expect(fallback).toMatchObject({
      sourceDurationSeconds: 900,
      loopSource: true,
    })
  })
})


test('generated schedule cards resolve without a catalog row and support joining mid-card', async () => {
  const card = { ...program('card', 0, '2026-08-24T19:30:00Z', '2026-08-24T19:30:30Z', 'bumper'), generated: 'schedule-card' as const }
  const episode = program('episode', 1, '2026-08-24T19:30:30Z', '2026-08-24T20:00:00Z')
  const programs = [card, episode]
  const lookedUp: number[] = []
  const resolver = new ChannelTimelineResolverService(
    { getGuide: async () => ({ channelId: 'kids', serverTime: '2026-08-24T19:30:10Z', serverTimeMs: Date.parse('2026-08-24T19:30:10Z'), timezone: 'UTC', timelineRevision: 'cards', requestedEnd: episode.scheduledEnd, coverageEnd: episode.scheduledEnd, truncated: false, programs }) },
    { resolveForChannelWorker: async (id) => { lookedUp.push(id); return { path: '/episode.mkv', size: 1, mimeType: 'video/x-matroska', lastModified: new Date(0) } } },
    { getById: async () => null }, undefined, undefined, () => true, () => false,
    { resolve: async (request) => { expect(request.programs).toBe(programs); expect(request.program).toBe(card); return '/cards/card.mp4' } }
  )
  const result = await resolver.resolveWindow('kids', new Date('2026-08-24T19:30:10Z'), 2)
  expect(lookedUp).toEqual([1])
  expect(result).toHaveLength(2)
  expect(result[0]).toMatchObject({ sourcePath: '/cards/card.mp4', sourceOffsetSeconds: 10, sourceDurationSeconds: 20, type: 'bumper' })
  expect(result[1]).toMatchObject({ sourcePath: '/episode.mkv', sourceOffsetSeconds: 0 })
})
