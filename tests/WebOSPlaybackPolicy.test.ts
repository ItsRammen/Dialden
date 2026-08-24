import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const policy = require(join(import.meta.dir, '..', 'clients', 'webos', 'playback-policy.js')) as {
  choose: (now: unknown, serverUrl: string, failedLiveUrl: string | null, clientId?: string) => {
    mode: string
    url: string
    seekToProgramOffset: boolean
  } | null
  shouldReload: (active: unknown, next: unknown) => boolean
  expectedDirectPosition: (program: unknown, elapsedSinceResponseMs: number) => number
  isPlaybackStable: (video: unknown) => boolean
  loadMediaElement: (video: unknown, url: string) => boolean
  resetMediaElement: (video: unknown) => void
}

function now(channelId: string, programId: string, offsetMs = 420_000) {
  return {
    serverTimeMs: 1_000_000,
    channelId,
    liveStream: {
      mode: 'hls',
      url: `/api/v1/channels/${channelId}/live/index.m3u8`,
    },
    program: {
      id: programId,
      title: programId,
      offsetMs,
      playback: {
        mode: 'direct',
        url: `/api/v1/media/${programId}`,
        sourceOffsetAtPlaybackZeroMs: 120_000,
      },
    },
  }
}

describe('LG webOS channel playback policy', () => {
  test('does not reload the stable channel URL when same-channel program metadata advances', () => {
    const first = policy.choose(now('kids', 'episode-a'), 'http://toasttv:1993', null, 'living-room')
    const next = policy.choose(now('kids', 'bumper-a', 0), 'http://toasttv:1993', null, 'living-room')

    expect(first).toEqual({
      mode: 'channel-hls',
      url: 'http://toasttv:1993/api/v1/channels/kids/live/index.m3u8?clientId=living-room',
      seekToProgramOffset: false,
    })
    expect(policy.shouldReload(first, next)).toBe(false)
  })

  test('reloads when changing to a different channel stream', () => {
    const kids = policy.choose(now('kids', 'episode-a'), 'http://toasttv:1993', null)
    const movies = policy.choose(now('movies', 'movie-a'), 'http://toasttv:1993', null)

    expect(policy.shouldReload(kids, movies)).toBe(true)
  })

  test('preserves server query parameters when adding the viewer lease identity', () => {
    const response = now('kids', 'episode-a')
    response.liveStream.url = '/api/v1/channels/kids/live/index.m3u8?profile=webos'

    expect(policy.choose(response, 'http://toasttv:1993', null, 'tv 1')?.url).toBe(
      'http://toasttv:1993/api/v1/channels/kids/live/index.m3u8?profile=webos&clientId=tv%201'
    )
  })

  test('keeps the normalized HLS contract while its worker warms up', () => {
    const response = now('kids', 'episode-a', 420_000)
    const failedUrl = 'http://toasttv:1993/api/v1/channels/kids/live/index.m3u8'
    const source = policy.choose(response, 'http://toasttv:1993', failedUrl)

    expect(response.program.offsetMs).toBe(420_000)
    expect(response.program.playback.sourceOffsetAtPlaybackZeroMs).toBe(120_000)
    expect(policy.expectedDirectPosition(response.program, 5_000)).toBe(305)
    expect(source).toEqual({
      mode: 'channel-hls',
      url: 'http://toasttv:1993/api/v1/channels/kids/live/index.m3u8',
      seekToProgramOffset: false,
    })
  })

  test('keeps direct playback compatible when the live contract is absent', () => {
    const response = now('kids', 'episode-a')
    delete (response as { liveStream?: unknown }).liveStream

    expect(policy.choose(response, 'http://toasttv:1993', null)).toMatchObject({
      mode: 'direct',
      seekToProgramOffset: true,
    })
  })

  test('fully releases the existing LG media source before loading another station', () => {
    const calls: string[] = []
    let currentSrc = 'http://toasttv:1993/api/v1/channels/kids/live/index.m3u8'
    const video = {
      muted: false,
      pause() {
        calls.push('pause')
      },
      removeAttribute(name: string) {
        calls.push(`remove:${name}`)
        if (name === 'src') currentSrc = ''
      },
      load() {
        calls.push(`load:${currentSrc || 'empty'}`)
      },
    }
    Object.defineProperty(video, 'src', {
      get: () => currentSrc,
      set: (value: string) => {
        currentSrc = value
        calls.push(`src:${value}`)
      },
    })

    const movies = 'http://toasttv:1993/api/v1/channels/movies/live/index.m3u8'
    expect(policy.loadMediaElement(video, movies)).toBe(true)
    expect(video.muted).toBe(true)
    expect(calls).toEqual([
      'pause',
      'remove:src',
      'load:empty',
      `src:${movies}`,
      `load:${movies}`,
    ])
  })

  test('accepts healthy playback even when LG cannot confirm an HLS live-edge seek', () => {
    expect(
      policy.isPlaybackStable({
        paused: false,
        readyState: 3,
        seeking: true,
        seekable: { length: 0 },
      })
    ).toBe(true)
    expect(policy.isPlaybackStable({ paused: true, readyState: 4 })).toBe(false)
    expect(policy.isPlaybackStable({ paused: false, readyState: 2 })).toBe(false)
  })
})
