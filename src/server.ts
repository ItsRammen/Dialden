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
import { createBumperAdministrationController } from './controllers/BumperAdministrationController'
import { BumperAdministrationService } from './services/BumperAdministrationService'
import { ArtworkCacheService } from './services/ArtworkCacheService'
import { createArtworkController } from './controllers/ArtworkController'
import { join } from 'node:path'
import { HeadlessDashboardService } from './services/HeadlessDashboardService'
import { renderHeadlessDashboard } from './templates/headlessDashboard'
import { createMetadataSettingsController } from './controllers/MetadataSettingsController'
import { createReviewAssistantController } from './controllers/ReviewAssistantController'
import { createReviewRunController } from './controllers/ReviewRunController'
import { loadPersistedReviewAssistantConfig } from './config/reviewAssistant'
import { OpenAiCompatibleReviewAssistant } from './services/review/OpenAiCompatibleReviewAssistant'
import { ClientPresenceService } from './services/ClientPresenceService'
import { ChannelQualityTierService } from './services/ChannelQualityTierService'
import { LineupSessionService } from './services/LineupSessionService'
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
import { createVirtualTunerStreamController } from './controllers/VirtualTunerStreamController'
import { VirtualTunerService } from './services/VirtualTunerService'
import { BunVirtualTunerFiles } from './services/BunVirtualTunerFiles'
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
    daemon.getIndexer().getPlaybackRoots()
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
  const qualityTier = new ChannelQualityTierService()
  const qualityDecision = qualityTier.resolve({
    hardwareAcceleration: transcodingStatus.hardwareAcceleration,
    enabledChannelCount: channelService
      .list()
      .channels.filter((channel) => channel.enabled).length,
  })
  const channelTimeline = new ChannelTimelineResolverService(
    channelService,
    mediaDeliveryService,
    daemon.getRepository(),
    () => configService.get(),
    channelLogos,
    undefined,
    () => transcodingStatus.activeBackend === 'intel-qsv'
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
      clientLeaseTtlMs: 45_000,
      idleTimeoutMs: 60_000,
      // Every speculative channel is a complete normalized encoder.
      // Running two of those beside the watched channel can starve CPU fallback
      // and make subsequent LG tunes appear to loop. QSV can sustain the two
      // adjacent hot channels; software mode starts only the requested channel.
      maximumWarmChannels: transcodingStatus.hardwareAcceleration ? 2 : 0,
      warmLeaseTtlMs: 60_000,
      profile: qualityDecision.profile,
    }
  )
  // One client presence holds the whole on-air lineup up. The session TTL is
  // deliberately far above the 15s heartbeat: a TV that briefly backgrounds or
  // drops Wi-Fi must not tear down every encoder, while an explicit close on
  // hide/exit keeps the common case clean.
  const lineupSessions = new LineupSessionService(
    channelWorkers,
    () =>
      channelService
        .list()
        .channels.filter((channel) => channel.enabled && channel.onAir)
        .map((channel) => channel.id),
    {
      ttlMs: 180_000,
      staggerDelayMs: 750,
      maximumConcurrentWorkers: qualityDecision.maximumConcurrentWorkers,
    }
  )
  const virtualTunerFiles = new BunVirtualTunerFiles(
    getDataPath('streams'),
    getDataPath('tuner-sessions')
  )
  // Tuner sessions are intentionally process-local. A crash cannot run their
  // normal close path, so remove only validated UUID directories before any
  // new session can publish into this output root.
  await virtualTunerFiles.cleanupOrphanSessions()
  const virtualTuners = new VirtualTunerService(
    channelWorkers,
    virtualTunerFiles,
    () =>
      channelService
        .list()
        .channels.filter((channel) => channel.enabled && channel.onAir)
        .map((channel) => channel.id),
    {
      ttlMs: 180_000,
      // The window is the switch latency: a player cannot buffer past the live
      // edge it is offered, and a seamless cut cannot reach the screen until
      // the media already buffered ahead of it has played out. Four one-second
      // segments keeps that drain short enough for the seamless path to beat a
      // decoder re-attach. Retained bytes stay generous for a lagging reader.
      playlistWindowSegments: 4,
      retainedSegmentCount: 30,
    }
  )
  const reconcileGeneratedStations = async (): Promise<void> => {
    channelService.invalidateScheduleCatalog()
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

  indexer.onScanEvent((event) => {
    // A large multi-root scan can spend minutes on later roots. Publish each
    // root availability transition to scheduling immediately so /now and
    // worker resolution share the same catalog throughout the pass.
    if (
      event.type === 'library.scan.root.completed' ||
      event.type === 'library.scan.root.unavailable'
    ) {
      channelService.invalidateScheduleCatalog()
    }
    dashboardEventService.broadcast(event)
  })
  metadataService.onEvent((event) => {
    if (
      event.type === 'library.metadata.completed' ||
      event.type === 'library.metadata.failed'
    ) {
      channelService.invalidateScheduleCatalog()
    }
    dashboardEventService.broadcast(event)
  })

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
  app.use('/tv/*', async (c, next) => {
    await next()
    // The hosted TV preview uses unversioned asset names. Never let a browser
    // retain an older switching state machine after the server is upgraded.
    c.header('Cache-Control', 'no-store')
  })
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
    qualityTier: () => qualityDecision,
    localPlaybackEnabled: !runtime.headless,
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
    // Logos are client chrome only; changing one never restarts video workers.
    onLogoUpdated: async () => {},
    onLibraryMonitoringUpdated: (intervalMinutes) => {
      daemon.configureLibrarySafetyScan(intervalMinutes)
    },
    libraryMonitoring: () => daemon.getLibraryMonitoringStatus(),
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
    suggestChannelLineup: async (request, signal) => {
      const config = await loadPersistedReviewAssistantConfig(
        daemon.getRepository()
      )
      return new OpenAiCompatibleReviewAssistant(config).suggestChannelLineup(
        request,
        signal
      )
    },
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
    lineup: lineupSessions,
    tuners: virtualTuners,
  })
  const virtualTunerStreamController =
    createVirtualTunerStreamController(virtualTuners)

  const collectionLibraryController = createCollectionLibraryController({
    library: collectionLibraryService,
    indexer,
    metadata: metadataService,
    refreshSchedules: async () => {
      channelService.invalidateScheduleCatalog()
      await daemon.getEngine().refreshCache(true)
      await playbackService.reconcilePrequeue()
    },
  })
  const collectionLibraryPageController = createCollectionLibraryPageController({
    library: collectionLibraryService,
    metadata: metadataService,
    refreshSchedules: async () => {
      channelService.invalidateScheduleCatalog()
      await daemon.getEngine().refreshCache(true)
      await playbackService.reconcilePrequeue()
    },
    updateAvailable: () => updateService.getUpdateInfo()?.updateAvailable,
  })
  const bumperAdministrationController = createBumperAdministrationController({
    bumpers: new BumperAdministrationService(
      mediaService,
      async () => (await configService.get()).library.stationAssetsWritable === true,
      {
        render: async (command) => {
          const child = Bun.spawn([...command], {
            stdout: 'ignore',
            stderr: 'pipe',
          })
          let timedOut = false
          const timeout = setTimeout(() => {
            timedOut = true
            child.kill()
          }, 120_000)
          try {
            const [code, stderr] = await Promise.all([
              child.exited,
              new Response(child.stderr).text(),
            ])
            return {
              code,
              stderr: timedOut
                ? `Bumper render timed out after 120 seconds. ${stderr}`
                : stderr,
            }
          } finally {
            clearTimeout(timeout)
          }
        },
      }
    ),
    library: collectionLibraryService,
    writable: async () => (await configService.get()).library.stationAssetsWritable === true,
    setWritable: async (enabled) => configService.update({ library: { stationAssetsWritable: enabled } }),
    refreshSchedules: async () => {
      channelService.invalidateScheduleCatalog()
      await daemon.getEngine().refreshCache(true)
      await playbackService.reconcilePrequeue()
      await Promise.all(
        channelWorkers
          .listStates()
          .filter((state) => state.viewerCount > 0)
          .map((state) =>
            channelWorkers.restart(
              state.channelId,
              'Bumper assets changed'
            )
          )
      )
    },
    updateAvailable: () => updateService.getUpdateInfo()?.updateAvailable,
  })
  const artworkController = createArtworkController(artworkService)
  /* The assistant is optional: with nothing configured these routes simply
     report it as off, and deterministic policy carries on unchanged. */
  const reviewAssistantController = createReviewAssistantController({
    store: daemon.getRepository(),
  })
  /* Automated review shares the library's own write paths, so a decision it
     makes is indistinguishable from the same decision made by hand -- except
     in the audit trail, which is what makes a run reversible. */
  const reviewRunController = createReviewRunController({
    library: collectionLibraryService,
    metadata: metadataService,
    audit: daemon.getRepository(),
    assistantStore: daemon.getRepository(),
    refreshSchedules: async () => {
      channelService.invalidateScheduleCatalog()
      await daemon.getEngine().refreshCache(true)
      await playbackService.reconcilePrequeue()
    },
  })
  const metadataSettingsController = createMetadataSettingsController(
    metadataService,
    async () => {
      channelService.invalidateScheduleCatalog()
      await reconcileGeneratedStations()
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
    },
    daemon.getRepository()
  )
  const clientPresenceController = createClientPresenceController({
    presence: clientPresenceService,
    onPresenceChanged: async (current, previous) => {
      // A heartbeat keeps the client's entire lineup alive, not just the
      // watched channel. Unknown sessions (legacy clients) are a no-op.
      lineupSessions.refresh(current.clientId)
      virtualTuners.refreshByClient(current.clientId)
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
  app.route('/', reviewAssistantController)
  app.route('/', reviewRunController)
  app.route('/', playbackController)
  app.route('/', libraryController)
  app.route('/', settingsController)
  app.route('/', dashboardController)
  app.route('/', healthController)
  app.route('/', channelController)
  app.route('/', channelStreamController)
  app.route('/', virtualTunerStreamController)
  app.route('/', mediaController)
  app.route('/', collectionLibraryController)
  app.route('/', collectionLibraryPageController)
  app.route('/', bumperAdministrationController)
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
