import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { mock } from 'jest-mock-extended'
import { createPlaybackController } from '../src/controllers/PlaybackController'
import type { IMediaRepository } from '../src/repositories/IMediaRepository'
import type { ConfigService } from '../src/services/ConfigService'
import type { MediaService } from '../src/services/MediaService'
import {
  LocalPlaybackDisabledError,
  PlaybackService,
} from '../src/services/PlaybackService'
import type { PlaylistEngine } from '../src/services/PlaylistEngine'
import type { IMediaPlayer } from '../src/types'
import { ToastTVDaemon } from '../src/daemon'

function createHeadlessPlaybackService(): {
  playback: PlaybackService
  engine: ReturnType<typeof mock<PlaylistEngine>>
  player: ReturnType<typeof mock<IMediaPlayer>>
} {
  const player = mock<IMediaPlayer>()
  const engine = mock<PlaylistEngine>()
  const config = mock<ConfigService>()
  const media = mock<IMediaRepository>()

  return {
    playback: new PlaybackService({
      player,
      engine,
      config,
      media,
      localPlaybackEnabled: false,
    }),
    engine,
    player,
  }
}

describe('Headless playback', () => {
  test('service rejects local playback without mutating session state', async () => {
    const { playback, engine, player } = createHeadlessPlaybackService()

    expect(playback.isLocalPlaybackAvailable).toBe(false)
    await expect(playback.startSession()).rejects.toBeInstanceOf(
      LocalPlaybackDisabledError
    )
    expect(engine.startSession).not.toHaveBeenCalled()
    expect(player.play).not.toHaveBeenCalled()
  })

  test('legacy playback route returns service unavailable', async () => {
    const { playback, engine } = createHeadlessPlaybackService()
    const controller = createPlaybackController({
      playback,
      media: mock<MediaService>(),
    })
    const app = new Hono()
    app.route('/', controller)

    const response = await app.request('/api/session/start', {
      method: 'POST',
    })

    expect(response.status).toBe(503)
    expect(await response.text()).toContain('Local playback is disabled')
    expect(engine.startSession).not.toHaveBeenCalled()
  })

  test('headless mode disables the bare-metal updater by default', () => {
    const daemon = new ToastTVDaemon('./missing-config.json', {
      localPlaybackEnabled: false,
    })

    expect(daemon.getUpdateService().isEnabled).toBe(false)
  })
})
