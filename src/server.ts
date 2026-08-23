/**
 * ToastTV Admin Web Server
 *
 * Slimmed-down server that mounts controllers.
 * All route logic is in controllers/.
 */

import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { cors } from 'hono/cors'
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
import { getDataDirectory, getDataPath } from './config/paths'
import { ChannelService } from './services/ChannelService'
import { ChannelConfigurationStore } from './services/ChannelConfigurationStore'
import { createChannelController } from './controllers/ChannelController'
import { MediaDeliveryService } from './services/MediaDeliveryService'
import { createMediaController } from './controllers/MediaController'
import { CollectionLibraryService } from './services/CollectionLibraryService'
import { createCollectionLibraryController } from './controllers/CollectionLibraryController'
import { createCollectionLibraryPageController } from './controllers/CollectionLibraryPageController'
import { ArtworkCacheService } from './services/ArtworkCacheService'
import { createArtworkController } from './controllers/ArtworkController'
import { join } from 'node:path'
import { HeadlessDashboardService } from './services/HeadlessDashboardService'
import { renderHeadlessDashboard } from './templates/headlessDashboard'
import { createMetadataSettingsController } from './controllers/MetadataSettingsController'
import { ClientPresenceService } from './services/ClientPresenceService'
import { createClientPresenceController } from './controllers/ClientPresenceController'
import { mutationOriginGuard } from './middleware/mutationOriginGuard'

export interface ServerResult {
  app: Hono
  playbackService: PlaybackService
}

/** Allow the credentialless packaged TV app to call only the read-only v1 API. */
export function applyClientApiCors(app: Hono): void {
  app.use(
    '/api/v1/*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'HEAD', 'OPTIONS'],
      allowHeaders: ['Accept', 'Content-Type', 'If-Range', 'Range'],
      exposeHeaders: [
        'Accept-Ranges',
        'Content-Length',
        'Content-Range',
        'Content-Type',
        'Last-Modified',
      ],
      maxAge: 86400,
    })
  )
}

export function createServer(daemon: ToastTVDaemon): ServerResult {
  const app = new Hono()
  app.use('*', mutationOriginGuard)

  // --- Get Services from Daemon ---
  const configService = daemon.getConfigService()
  const playbackService = daemon.getPlaybackService()
  const updateService = daemon.getUpdateService()
  const thumbnailClient = new ThumbnailClient()
  const dashboardEventService = new DashboardEventService()
  const channelService = new ChannelService(
    daemon.getRepository(),
    daemon.getLibraryPolicy(),
    undefined,
    new ChannelConfigurationStore(
      getDataPath('channels.json'),
      daemon.getLibraryPolicy()?.channels ?? []
    )
  )
  const mediaDeliveryService = new MediaDeliveryService(
    daemon.getRepository(),
    daemon.getMediaRoots()
  )
  const collectionLibraryService = new CollectionLibraryService(
    daemon.getRepository()
  )
  const metadataService = daemon.getMetadataService()
  const indexer = daemon.getIndexer()
  const artworkService = new ArtworkCacheService(
    join(getDataDirectory(), 'artwork')
  )
  const clientPresenceService = new ClientPresenceService()
  const headlessDashboardService = new HeadlessDashboardService(
    daemon.getRepository(),
    channelService,
    indexer,
    metadataService,
    daemon.getPublicMetadataConfig(),
    clientPresenceService
  )

  indexer.onScanEvent((event) => dashboardEventService.broadcast(event))
  metadataService.onEvent((event) => dashboardEventService.broadcast(event))

  // Packaged webOS apps run from a different origin. This versioned client API
  // is read-only and the server is already restricted to a trusted LAN.
  applyClientApiCors(app)

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
  app.get('/tv', (c) => c.redirect('/tv/'))
  app.use(
    '/tv/*',
    serveStatic({
      root: './clients/webos',
      rewriteRequestPath: (requestPath) => requestPath.replace(/^\/tv/, ''),
    })
  )

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

  const mediaController = createMediaController({
    media: mediaDeliveryService,
  })

  const collectionLibraryController = createCollectionLibraryController({
    library: collectionLibraryService,
    indexer,
    metadata: metadataService,
    metadataConfig: daemon.getPublicMetadataConfig(),
    refreshSchedules: async () => {
      await daemon.getEngine().refreshCache(true)
      await playbackService.reconcilePrequeue()
    },
  })
  const collectionLibraryPageController = createCollectionLibraryPageController({
    library: collectionLibraryService,
    metadata: metadataService,
    refreshSchedules: async () => {
      await daemon.getEngine().refreshCache(true)
      await playbackService.reconcilePrequeue()
    },
    updateAvailable: () => updateService.getUpdateInfo()?.updateAvailable,
  })
  const artworkController = createArtworkController(artworkService)
  const metadataSettingsController = createMetadataSettingsController(
    metadataService,
    daemon.getPublicMetadataConfig()
  )
  const clientPresenceController = createClientPresenceController({
    presence: clientPresenceService,
  })

  const eventsController = new EventsController(
    playbackService,
    dashboardEventService,
    indexer,
    metadataService
  )

  // Mount all controllers at root
  app.route('/', playbackController)
  app.route('/', libraryController)
  app.route('/', settingsController)
  app.route('/', dashboardController)
  app.route('/', healthController)
  app.route('/', channelController)
  app.route('/', mediaController)
  app.route('/', collectionLibraryController)
  app.route('/', collectionLibraryPageController)
  app.route('/', artworkController)
  app.route('/', metadataSettingsController)
  app.route('/', clientPresenceController)

  // SSE endpoint for real-time dashboard updates
  app.get('/events/dashboard', (c) => eventsController.handleDashboardSSE(c))

  // --- Dashboard (home page) ---
  app.get('/', async (c) => {
    const updateInfo = updateService.getUpdateInfo()
    if (!daemon.isLocalPlaybackEnabled) {
      return c.html(
        renderHeadlessDashboard(
          await headlessDashboardService.build(updateInfo?.updateAvailable)
        )
      )
    }
    return c.html(renderDashboard(updateInfo?.updateAvailable))
  })

  return { app, playbackService }
}
