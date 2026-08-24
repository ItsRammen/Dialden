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
import { ContinuousChannelWorkerManager } from './services/ContinuousChannelWorkerManager'
import { FfmpegContinuousHlsPipelineFactory } from './services/FfmpegContinuousHlsPipelineFactory'
import {
  resolveFfmpegTranscodingBackend,
  type FfmpegTranscodingStatus,
} from './services/FfmpegTranscodingBackend'
import { ChannelLogoStore } from './services/ChannelLogoStore'
import { BunChannelWorkerFiles } from './services/BunChannelWorkerFiles'
import { ChannelTimelineResolverService } from './services/ChannelTimelineResolverService'
import { createChannelStreamController } from './controllers/ChannelStreamController'
import { loadRuntimeConfig, type RuntimeConfig } from './config/runtime'

export interface ServerResult {
  app: Hono
  playbackService: PlaybackService
  channelWorkers: ContinuousChannelWorkerManager
  transcodingStatus: FfmpegTranscodingStatus
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

export async function restartChangedChannelWorkers(
  changedChannelIds: readonly string[],
  workers: Pick<ContinuousChannelWorkerManager, 'listStates' | 'restart'>
): Promise<void> {
  const changed = new Set(changedChannelIds)
  await Promise.all(
    workers
      .listStates()
      .filter((state) => changed.has(state.channelId))
      .map((state) =>
        workers.restart(
          state.channelId,
          'Automated channel lineup changed after a library scan'
        )
      )
  )
}

export async function createServer(
  daemon: ToastTVDaemon,
  runtime: RuntimeConfig = loadRuntimeConfig()
): Promise<ServerResult> {
  const app = new Hono()
  app.use('*', mutationOriginGuard)

  // --- Get Services from Daemon ---
  const configService = daemon.getConfigService()
  const playbackService = daemon.getPlaybackService()
  const updateService = daemon.getUpdateService()
  const thumbnailClient = new ThumbnailClient()
  const dashboardEventService = new DashboardEventService()
  const appConfig = await configService.get()
  const channelService = new ChannelService(
    daemon.getRepository(),
    daemon.getLibraryPolicy(),
    undefined,
    new ChannelConfigurationStore(
      getDataPath('channels.json'),
      daemon.getLibraryPolicy()?.channels ?? []
    ),
    appConfig.interlude
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
  const channelLogos = new ChannelLogoStore(getDataPath('channel-logos'))
  const transcodingStatus = await resolveFfmpegTranscodingBackend({
    mode: runtime.transcodingMode,
    qsvDevice: runtime.qsvDevice,
  })
  const channelTimeline = new ChannelTimelineResolverService(
    channelService,
    mediaDeliveryService,
    daemon.getRepository(),
    () => configService.get(),
    channelLogos
  )
  const channelWorkers = new ContinuousChannelWorkerManager(
    channelTimeline,
    new FfmpegContinuousHlsPipelineFactory(
      'ffmpeg',
      undefined,
      undefined,
      undefined,
      transcodingStatus
    ),
    new BunChannelWorkerFiles(),
    {
      outputRoot: getDataPath('streams'),
      clientLeaseTtlMs: 15_000,
      idleTimeoutMs: 60_000,
      // Every speculative channel is a complete normalized 1080p encoder.
      // Running two of those beside the watched channel can starve CPU fallback
      // and make subsequent LG tunes appear to loop. QSV can sustain the two
      // adjacent hot channels; software mode starts only the requested channel.
      maximumWarmChannels: transcodingStatus.hardwareAcceleration ? 2 : 0,
      warmLeaseTtlMs: 60_000,
    }
  )
  const reconcileGeneratedStations = async (): Promise<void> => {
    try {
      const changedChannelIds =
        await channelService.reconcileAutomatedStations()
      if (changedChannelIds.length === 0) return
      await daemon.getEngine().refreshCache(true)
      await playbackService.reconcilePrequeue()
      await restartChangedChannelWorkers(changedChannelIds, channelWorkers)
    } catch (error) {
      // A failed catalog read must never make an otherwise healthy scan or
      // server startup fail. The next scan will retry the same reconciliation.
      console.error('Automated channel reconciliation failed', error)
    }
  }
  indexer.onScanComplete(reconcileGeneratedStations)
  // The initial background scan starts before the web server is constructed.
  // Reconcile immediately when it completed before this listener was attached.
  if (indexer.getScanState().status === 'completed') {
    await reconcileGeneratedStations()
  }
  const headlessDashboardService = new HeadlessDashboardService(
    daemon.getRepository(),
    channelService,
    indexer,
    metadataService,
    () => daemon.getPublicMetadataConfig(),
    clientPresenceService,
    channelWorkers
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
    transcodingStatus,
    update: updateService,
    onInterludeUpdated: async (policy) => {
      channelService.setInterludePolicy(policy)
      await Promise.all(
        channelWorkers
          .listStates()
          .filter((state) => state.viewerCount > 0)
          .map((state) =>
            channelWorkers.restart(
              state.channelId,
              'Interlude schedule configuration changed'
            )
          )
      )
    },
    onLogoUpdated: async () => {
      const inherited = new Set(
        channelService
          .administrationSnapshot()
          .channels.filter(
            (channel) =>
              channel.branding?.burnIn === true &&
              (channel.branding.mode === 'inherit' ||
                channel.slots.some(
                  (slot) => slot.branding?.mode === 'inherit'
                ))
          )
          .map((channel) => channel.id)
      )
      await Promise.all(
        channelWorkers
          .listStates()
          .filter(
            (state) => state.viewerCount > 0 && inherited.has(state.channelId)
          )
          .map((state) =>
            channelWorkers.restart(
              state.channelId,
              'Default channel branding changed'
            )
          )
      )
    },
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
    logos: channelLogos,
    branding: channelTimeline,
    onChannelChanged: async (channelId, mode) => {
      if (mode === 'deactivate') {
        await channelWorkers.deactivate(channelId)
      } else {
        await channelWorkers.restart(
          channelId,
          'Channel schedule or branding configuration changed'
        )
      }
    },
  })

  const mediaController = createMediaController({
    media: mediaDeliveryService,
  })
  const channelStreamController = createChannelStreamController({
    channels: channelService,
    workers: channelWorkers,
    outputRoot: getDataPath('streams'),
  })

  const collectionLibraryController = createCollectionLibraryController({
    library: collectionLibraryService,
    indexer,
    metadata: metadataService,
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
    async () => {
      await daemon.getEngine().refreshCache(true)
      await playbackService.reconcilePrequeue()
      await Promise.all(
        channelWorkers
          .listStates()
          .filter((state) => state.viewerCount > 0)
          .map((state) =>
            channelWorkers.restart(
              state.channelId,
              'Library metadata and policy re-evaluation completed'
            )
          )
      )
    }
  )
  const clientPresenceController = createClientPresenceController({
    presence: clientPresenceService,
    onPresenceChanged: async (current, previous) => {
      const changedChannel = previous?.channelId !== current.channelId
      const usesChannelWorker =
        current.playbackMode === 'transcode' ||
        current.playbackMode === 'buffering'
      if (
        previous?.channelId &&
        (changedChannel || !usesChannelWorker)
      ) {
        channelWorkers.leave(previous.channelId, current.clientId)
      }
      const configuredChannel = current.channelId
        ? channelService
            .list()
            .channels.some((channel) => channel.id === current.channelId)
        : false
      if (current.channelId && usesChannelWorker && configuredChannel) {
        await channelWorkers.touch(current.channelId, current.clientId)
      }
    },
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
  app.route('/', channelStreamController)
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

  return { app, playbackService, channelWorkers, transcodingStatus }
}
