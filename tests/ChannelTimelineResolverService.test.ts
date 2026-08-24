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
  test('resolves custom and inherited channel video overlays', async () => {
    const base = {
      getNow: async () => null,
      getGuide: async () => null,
      administrationSnapshot: () => ({
        channels: [
          {
            id: 'kids',
            name: 'Kids',
            enabled: true,
            timezone: 'UTC',
            slots: [],
            branding: {
              mode: 'custom' as const,
              opacity: 204,
              position: 8 as const,
              x: 20,
              y: 30,
              sizePercent: 14,
            },
          },
          {
            id: 'family',
            name: 'Family',
            enabled: true,
            timezone: 'UTC',
            slots: [],
          },
        ],
        manuallyOffAir: [],
        programmingGroups: [],
        configurationError: null,
      }),
    }
    const resolver = new ChannelTimelineResolverService(
      base,
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
          opacity: 128,
          position: 2,
          x: 8,
          y: 9,
        },
      }),
      { path: (id) => `/data/channel-logos/${id}.png` }
    )

    expect(await resolver.overlay('kids')).toEqual({
      sourcePath: '/data/channel-logos/kids.png',
      opacity: 0.8,
      position: 8,
      x: 20,
      y: 30,
      sizePercent: 14,
    })
    expect(await resolver.overlay('family')).toMatchObject({
      sourcePath: '/data/logo.png',
      position: 2,
      x: 8,
      y: 9,
      sizePercent: 12,
    })
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

  test('splits a playing item at a scheduled branding boundary', async () => {
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
      branding: { mode: 'inherit' as const, opacity: 210, position: 2 as const, x: 24, y: 24, sizePercent: 12 },
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
    expect(window).toHaveLength(2)
    expect(window[0]).toMatchObject({ sourceOffsetSeconds: 1500, sourceDurationSeconds: 300, overlay: { sourcePath: '/logos/kids--nick.png' } })
    expect(window[1]).toMatchObject({ sourceOffsetSeconds: 1800, sourceDurationSeconds: 1800, overlay: { sourcePath: '/logos/kids--adult-swim.png' } })
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
