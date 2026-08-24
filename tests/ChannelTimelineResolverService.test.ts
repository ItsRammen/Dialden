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
