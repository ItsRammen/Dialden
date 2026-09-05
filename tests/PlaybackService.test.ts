/**
 * PlaybackService Tests
 *
 * Tests for playback control and Player interaction.
 */

import { describe, expect, test, beforeEach } from 'bun:test'
import { mock, type MockProxy } from 'jest-mock-extended'
import { PlaybackService } from '../src/services/PlaybackService'
import type { PlaylistEngine } from '../src/services/PlaylistEngine'
import type { IMediaPlayer, MediaItem, PlaybackStatus } from '../src/types'
import type { ConfigService } from '../src/services/ConfigService'
import type { IMediaRepository } from '../src/repositories/IMediaRepository'
import type { DashboardEventService } from '../src/services/DashboardEventService'

// Builder for MediaItem
const createMediaItemBuilder = (override?: Partial<MediaItem>): MediaItem => ({
  id: 1,
  path: '/media/show.mp4',
  filename: 'show.mp4',
  durationSeconds: 600,
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
  rootAvailable: true,
  playbackEnabled: true,
  ...override,
})

describe('PlaybackService', () => {
  let player: MockProxy<IMediaPlayer>
  let engine: MockProxy<PlaylistEngine>
  let config: MockProxy<ConfigService>
  let media: MockProxy<IMediaRepository>
  let events: MockProxy<DashboardEventService>
  let service: PlaybackService

  beforeEach(() => {
    player = mock<IMediaPlayer>()
    engine = mock<PlaylistEngine>()
    config = mock<ConfigService>()
    media = mock<IMediaRepository>()
    events = mock<DashboardEventService>()

    // Default setups
    // Default setups
    player.connect.mockResolvedValue()
    player.disconnect.mockResolvedValue()
    player.play.mockResolvedValue()
    player.pause.mockResolvedValue()
    player.stop.mockResolvedValue()
    player.setLoop.mockResolvedValue()
    player.enqueue.mockResolvedValue()

    // Default engine state
    // @ts-ignore
    engine.isSessionActive = false
    // @ts-ignore
    engine.sessionInfo = {
      startedAt: null,
      limitMinutes: 30,
      elapsedMs: 0,
    }

    config.get.mockResolvedValue({
      session: { offAirAssetId: null },
    } as any)
    media.getById.mockImplementation(async (id) =>
      createMediaItemBuilder({ id })
    )

    service = new PlaybackService({ player, engine, config, media, events })
  })

  test('startSession() starts engine and plays first video', async () => {
    const video = createMediaItemBuilder()
    engine.startSession.mockResolvedValue(video)
    engine.peekQueue.mockReturnValue([])

    await service.startSession()

    expect(engine.startSession).toHaveBeenCalled()
    expect(player.play).toHaveBeenCalledWith(video.path)
    expect(player.setLoop).toHaveBeenCalledWith(false)
    expect(events.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'sessionStart',
      })
    )
  })

  test('startSession() does nothing if already active', async () => {
    // @ts-ignore
    engine.isSessionActive = true

    await service.startSession()

    expect(engine.startSession).not.toHaveBeenCalled()
  })

  test('endSession() stops player and ends engine session', async () => {
    // @ts-ignore
    engine.isSessionActive = true

    await service.endSession()

    expect(engine.endSession).toHaveBeenCalled()
    expect(player.stop).toHaveBeenCalled()
    expect(events.broadcast).toHaveBeenCalledWith({ type: 'sessionEnd' })
  })

  test('skip() plays next video from engine', async () => {
    const nextVideo = createMediaItemBuilder({ id: 2, filename: 'next.mp4' })
    engine.getNextVideo.mockResolvedValue(nextVideo)
    engine.peekQueue.mockReturnValue([])

    await service.skip()

    expect(engine.getNextVideo).toHaveBeenCalled()
    expect(player.play).toHaveBeenCalledWith(nextVideo.path)
  })

  test('re-resolves stale engine paths before play and enqueue', async () => {
    const staleFirst = createMediaItemBuilder({
      id: 7,
      path: '/stale/first.mp4',
      filename: 'stale-first.mp4',
    })
    const staleNext = createMediaItemBuilder({
      id: 8,
      path: '/stale/next.mp4',
      filename: 'stale-next.mp4',
    })
    const currentFirst = createMediaItemBuilder({
      id: 7,
      path: '/media/current/first.mp4',
      filename: 'current-first.mp4',
    })
    const currentNext = createMediaItemBuilder({
      id: 8,
      path: '/media/current/next.mp4',
      filename: 'current-next.mp4',
    })
    engine.startSession.mockResolvedValue(staleFirst)
    engine.peekQueue.mockImplementation((count) =>
      count === 1 ? [staleNext] : []
    )
    media.getById.mockImplementation(async (id) =>
      id === 7 ? currentFirst : id === 8 ? currentNext : null
    )

    await service.startSession()

    expect(player.play).toHaveBeenCalledWith(currentFirst.path)
    expect(player.play).not.toHaveBeenCalledWith(staleFirst.path)
    expect(player.enqueue).toHaveBeenCalledWith(currentNext.path)
    expect(player.enqueue).not.toHaveBeenCalledWith(staleNext.path)
  })

  const ineligibleCurrentRows: Array<
    readonly [string, Partial<MediaItem> | null]
  > = [
    ['a missing row', null],
    ['missing root availability', { rootAvailable: undefined }],
    ['an unavailable root', { rootAvailable: false }],
    ['missing playback approval', { playbackEnabled: undefined }],
    ['blocked playback', { playbackEnabled: false }],
    ['a non-video media type', { mediaType: 'intro' }],
    ['an interlude flag', { isInterlude: true }],
    ['missing interlude state', { isInterlude: undefined }],
    ['zero duration', { durationSeconds: 0 }],
    ['non-finite duration', { durationSeconds: Number.NaN }],
    ['an empty current path', { path: '' }],
    ['a mismatched current ID', { id: 99 }],
  ]

  for (const [label, override] of ineligibleCurrentRows) {
    test(`startSession() fails closed for ${label}`, async () => {
      const queued = createMediaItemBuilder({ id: 7, path: '/stale/show.mp4' })
      engine.startSession.mockResolvedValue(queued)
      engine.peekQueue.mockReturnValue([])
      media.getById.mockResolvedValue(
        override === null ? null : createMediaItemBuilder({ id: 7, ...override })
      )

      await service.startSession()

      expect(player.play).not.toHaveBeenCalled()
      expect(player.enqueue).not.toHaveBeenCalled()
    })
  }

  test('startSession() fails closed when current authorization lookup throws', async () => {
    engine.startSession.mockResolvedValue(createMediaItemBuilder({ id: 7 }))
    engine.peekQueue.mockReturnValue([])
    media.getById.mockRejectedValue(new Error('database unavailable'))

    await service.startSession()

    expect(player.play).not.toHaveBeenCalled()
    expect(player.enqueue).not.toHaveBeenCalled()
  })

  test('does not enqueue a newly blocked queue item after playing current media', async () => {
    const first = createMediaItemBuilder({ id: 7 })
    const next = createMediaItemBuilder({ id: 8, path: '/stale/next.mp4' })
    engine.startSession.mockResolvedValue(first)
    engine.peekQueue.mockImplementation((count) => (count === 1 ? [next] : []))
    media.getById.mockImplementation(async (id) =>
      id === 7
        ? first
        : id === 8
          ? { ...next, playbackEnabled: false }
          : null
    )

    await service.startSession()

    expect(player.play).toHaveBeenCalledWith(first.path)
    expect(player.enqueue).not.toHaveBeenCalled()
  })

  test('pause() delegates to Player and broadcasts state', async () => {
    player.getStatus.mockResolvedValue({
      isPlaying: false,
      currentFile: 'test.mp4',
      positionSeconds: 10,
      durationSeconds: 100,
      state: 'paused',
    })

    await service.pause()

    expect(player.pause).toHaveBeenCalled()
    expect(events.broadcastPlayingState).toHaveBeenCalledWith(false)
  })

  test('stop() stops Player and ends session', async () => {
    await service.stop()

    expect(player.stop).toHaveBeenCalled()
    expect(engine.endSession).toHaveBeenCalled()
    expect(events.broadcast).toHaveBeenCalledWith({ type: 'sessionEnd' })
  })

  test('getStatus() returns Player status', async () => {
    const status: PlaybackStatus = {
      isPlaying: true,
      currentFile: '/media/show.mp4',
      positionSeconds: 30,
      durationSeconds: 600,
      state: 'playing',
    }
    player.getStatus.mockResolvedValue(status)

    const result = await service.getStatus()

    expect(result).toEqual(status)
  })

  test('getStatus() returns null on Player error', async () => {
    player.getStatus.mockRejectedValue(new Error('Player not connected'))

    const result = await service.getStatus()

    expect(result).toBeNull()
  })

  test('peekQueue() returns upcoming videos', () => {
    const videos = [
      createMediaItemBuilder({ id: 1 }),
      createMediaItemBuilder({ id: 2 }),
    ]
    engine.peekQueue.mockReturnValue(videos)

    const result = service.peekQueue(2)

    expect(result).toEqual(videos)
    expect(engine.peekQueue).toHaveBeenCalledWith(2)
  })

  test('reconcilePrequeue removes a stale MPV item and queues only current eligibility', async () => {
    const queued = createMediaItemBuilder({ id: 7, path: '/old/show.mp4' })
    const current = createMediaItemBuilder({
      id: 7,
      path: '/media/tv/Show/episode.mkv',
      playbackEnabled: true,
    })
    engine.peekQueue.mockReturnValue([queued])
    media.getById.mockResolvedValue(current)

    await service.reconcilePrequeue()

    expect(player.clear).toHaveBeenCalled()
    expect(player.enqueue).toHaveBeenCalledWith(current.path)

    player.enqueue.mockClear()
    media.getById.mockResolvedValue({ ...current, playbackEnabled: false })
    await service.reconcilePrequeue()
    expect(player.enqueue).not.toHaveBeenCalled()
  })

  test('shuffleQueue() delegates to engine', async () => {
    engine.peekQueue.mockReturnValue([])

    await service.shuffleQueue()

    expect(engine.shuffleQueue).toHaveBeenCalled()
    expect(events.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'queueUpdate',
      })
    )
  })

  test('getCurrentMedia() delegates to engine.getCurrentVideo()', async () => {
    const video = createMediaItemBuilder()

    // Before session, engine returns null
    engine.getCurrentVideo.mockReturnValue(null)
    expect(service.getCurrentMedia()).toBeNull()

    // After session start, engine tracks current video
    engine.startSession.mockResolvedValue(video)
    engine.peekQueue.mockReturnValue([])
    engine.getCurrentVideo.mockReturnValue(video)

    await service.startSession()

    expect(service.getCurrentMedia()).toEqual(video)
    expect(engine.getCurrentVideo).toHaveBeenCalled()
  })

  test('isSessionActive reflects engine state', () => {
    // @ts-ignore
    engine.isSessionActive = true
    expect(service.isSessionActive).toBe(true)

    // @ts-ignore
    engine.isSessionActive = false
    expect(service.isSessionActive).toBe(false)
  })
})
