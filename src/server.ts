/**
 * ToastTV Admin Web Server
 *
 * Slimmed-down server that mounts controllers.
 * All route logic is in controllers/.
 */

import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import type { ToastTVDaemon } from './daemon'
import { renderDashboard } from './templates/dashboard'
import { MediaService } from './services/MediaService'
import type { PlaybackService } from './services/PlaybackService'
import { DashboardEventService } from './services/DashboardEventService'
import { ThumbnailClient } from './clients/ThumbnailClient'
import { createPlaybackController } from './controllers/PlaybackController'
import { createLibraryController } from './controllers/LibraryController'
import { createSettingsController } from './controllers/SettingsController'
import { createDashboardController } from './controllers/DashboardController'
import { EventsController } from './controllers/EventsController'
import { createHealthController } from './controllers/HealthController'
import { getDataDirectory } from './config/paths'
import { ChannelService } from './services/ChannelService'
import { createChannelController } from './controllers/ChannelController'

export interface ServerResult {
  app: Hono
  playbackService: PlaybackService
}

export function createServer(daemon: ToastTVDaemon): ServerResult {
  const app = new Hono()

  // --- Get Services from Daemon ---
  const configService = daemon.getConfigService()
  const playbackService = daemon.getPlaybackService()
  const updateService = daemon.getUpdateService()
  const thumbnailClient = new ThumbnailClient()
  const dashboardEventService = new DashboardEventService()
  const channelService = new ChannelService(
    daemon.getRepository(),
    daemon.getLibraryPolicy()
  )

  // Inject event service for SSE dashboard updates
  playbackService.setEventService(dashboardEventService)

  const mediaService = new MediaService(
    daemon.getRepository(),
    daemon.getIndexer(),
    configService,
    thumbnailClient
  )

  // --- Mount Static Files ---
  app.use('/*', serveStatic({ root: './public' }))
  app.use('/thumbnails/*', serveStatic({ root: getDataDirectory() }))

  // --- Mount Controllers ---
  const playbackController = createPlaybackController({
    playback: playbackService,
    media: mediaService,
  })

  const libraryController = createLibraryController({
    config: configService,
    media: mediaService,
    playlist: daemon.getEngine(),
    playback: playbackService,
    mediaWritable: !daemon.isMediaReadOnly,
  })

  const settingsController = createSettingsController({
    config: configService,
    media: mediaService,
    hardware: daemon.getHardwareService(),
    update: updateService,
  })

  const dashboardController = createDashboardController({
    playback: playbackService,
    media: mediaService,
  })

  const healthController = createHealthController({
    database: daemon.getRepository(),
  })

  const channelController = createChannelController({
    channels: channelService,
  })

  const eventsController = new EventsController(
    playbackService,
    dashboardEventService
  )

  // Mount all controllers at root
  app.route('/', playbackController)
  app.route('/', libraryController)
  app.route('/', settingsController)
  app.route('/', dashboardController)
  app.route('/', healthController)
  app.route('/', channelController)

  // SSE endpoint for real-time dashboard updates
  app.get('/events/dashboard', (c) => eventsController.handleDashboardSSE(c))

  // --- Dashboard (home page) ---
  app.get('/', (c) => {
    const updateInfo = updateService.getUpdateInfo()
    return c.html(renderDashboard(updateInfo?.updateAvailable))
  })

  return { app, playbackService }
}
