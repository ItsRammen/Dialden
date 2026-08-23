/**
 * ToastTV Daemon Entry Point
 *
 * Wires all components together and runs the main playback loop.
 */

import * as path from 'node:path'
import { ConfigRepository } from './repositories/ConfigRepository'
import type { AppConfig, DeepPartial } from './repositories/ConfigRepository'
import { MediaRepository } from './repositories/MediaRepository'
import { FilesystemClient } from './clients/FilesystemClient'
import { FFProbeClient } from './clients/FilesystemClient'
import { MpvClient } from './clients/MpvClient'
import { DisabledMediaPlayer } from './clients/DisabledMediaPlayer'
import { CECClient, CEC_KEYS } from './clients/CECClient'
import { thumbnailClient } from './clients/ThumbnailClient'

import { MediaIndexer } from './services/MediaIndexer'
import {
  PlaylistEngine,
  SystemDateTimeProvider,
} from './services/PlaylistEngine'
import { SessionManager } from './services/SessionManager'
import { ConfigService } from './services/ConfigService'
import { PlaybackService } from './services/PlaybackService'
import { TVDetectionService } from './services/TVDetectionService'
import { HardwareDetectionService } from './services/HardwareDetectionService'
import { UpdateService } from './services/UpdateService'
import { UpdateClient } from './clients/UpdateClient'
import type { MediaItem, ToastTVConfig, IMediaPlayer } from './types'
import { loadLibraryConfig } from './config/library'
import type { LibraryPolicyDocument } from './config/library'

export class ToastTVDaemon {
  private running = false

  private readonly appConfig: ConfigRepository
  private repository: MediaRepository | null = null
  private player: IMediaPlayer | null = null
  private indexer: MediaIndexer | null = null
  private engine: PlaylistEngine | null = null
  private playbackService: PlaybackService | null = null
  private configService: ConfigService | null = null
  private detectionService: TVDetectionService | null = null
  private cecClient: CECClient | null = null
  private hardwareService: HardwareDetectionService | null = null
  private updateService: UpdateService | null = null
  private readonly localPlaybackEnabled: boolean
  private readonly mediaReadOnly: boolean
  private managedLibrary = false
  private libraryPolicy: LibraryPolicyDocument | null = null
  private scanTask: Promise<void> | null = null
  private stopping = false

  constructor(
    configPath = './data/config.json',
    options: { localPlaybackEnabled?: boolean; mediaReadOnly?: boolean } = {}
  ) {
    this.appConfig = new ConfigRepository(configPath)
    this.localPlaybackEnabled = options.localPlaybackEnabled ?? true
    this.mediaReadOnly = options.mediaReadOnly ?? false
  }

  get isLocalPlaybackEnabled(): boolean {
    return this.localPlaybackEnabled
  }

  get isMediaReadOnly(): boolean {
    return this.mediaReadOnly || this.managedLibrary
  }

  getMediaDirectory(): string {
    return this.appConfig.getBootstrap().paths.media
  }

  getSessionInfo(): {
    startedAt: Date | null
    limitMinutes: number
    elapsedMs: number
  } {
    if (!this.engine) return { startedAt: null, limitMinutes: 30, elapsedMs: 0 }
    return this.engine.sessionInfo
  }

  // --- Getters for DI (used by server to create services) ---
  async getConfig(): Promise<AppConfig> {
    return this.appConfig.get()
  }

  updateConfig(partial: DeepPartial<AppConfig>): void {
    this.appConfig.update(partial)
  }

  // --- Getters for DI (used by server to create services) ---

  getRepository(): MediaRepository {
    if (!this.repository) throw new Error('Daemon not started')
    return this.repository
  }

  getLibraryPolicy(): LibraryPolicyDocument | null {
    return this.libraryPolicy
  }

  getIndexer(): MediaIndexer {
    if (!this.indexer) throw new Error('Daemon not started')
    return this.indexer
  }

  getPlayer(): IMediaPlayer {
    if (!this.player) throw new Error('Daemon not started')
    return this.player
  }

  getEngine(): PlaylistEngine {
    if (!this.engine) throw new Error('Daemon not started')
    return this.engine
  }

  getConfigManager(): ConfigRepository {
    return this.appConfig
  }

  getPlaybackService(): PlaybackService {
    if (!this.playbackService) throw new Error('Daemon not started')
    return this.playbackService
  }

  getConfigService(): ConfigService {
    if (!this.configService) throw new Error('Daemon not started')
    return this.configService
  }

  getHardwareService(): HardwareDetectionService | undefined {
    return this.hardwareService ?? undefined
  }

  getUpdateService(): UpdateService {
    if (!this.updateService) {
      const updateSetting = process.env.TOASTTV_UPDATES_ENABLED
        ?.trim()
        .toLowerCase()
      const explicitlyDisabled = new Set(['0', 'false', 'no', 'off']).has(
        updateSetting ?? ''
      )
      this.updateService = new UpdateService(new UpdateClient(), {
        enabled: this.localPlaybackEnabled && !explicitlyDisabled,
      })
    }
    return this.updateService
  }

  /**
   * Initialize components (DB, Services). Fast.
   * Call this before starting the web server.
   */
  async init(): Promise<void> {
    console.log('ToastTV daemon initializing...')

    // 1. Initialize DB from bootstrap config
    const bootstrap = this.appConfig.getBootstrap()
    this.repository = new MediaRepository(bootstrap.paths.database)
    await this.repository.initialize()

    // Managed TV/movie libraries are default-deny. Rows from a legacy
    // single-root database remain visible but cannot enter playback until the
    // root-aware scan applies the active policy.
    const libraryConfig = loadLibraryConfig(bootstrap.paths.media)
    this.libraryPolicy = libraryConfig.policy
    this.managedLibrary = libraryConfig.roots.some(
      (root) => root.approvedCollections !== undefined
    )
    // Quarantine every persisted absolute path until its configured root is
    // scanned in this process. This also safely migrates pre-root `legacy`
    // rows in the original single-library mode.
    await this.repository.synchronizePlaybackPolicy([
      ...libraryConfig.roots,
      { id: 'interludes' },
    ])

    // 2. Initialize Config (Seed DB defaults)
    await this.appConfig.initialize(this.repository)
    const runtimeConfig = await this.appConfig.get()

    // 3. Initialize Services
    const playerConfig = {
      ...runtimeConfig.mpv,
      reconnectDelayMs: 2000,
      maxReconnectAttempts: 10,
    }
    this.player = this.localPlaybackEnabled
      ? new MpvClient(playerConfig)
      : new DisabledMediaPlayer()

    const filesystem = new FilesystemClient()
    const mediaProbe = new FFProbeClient()

    // Media Indexer uses runtime config for logic but bootstrap config for paths
    const mediaConfig = {
      directory: bootstrap.paths.media,
      supportedExtensions: ['.mp4', '.mkv', '.avi', '.mov', '.webm'],
      databasePath: bootstrap.paths.database,
      roots: libraryConfig.roots,
    }

    // Default interlude directory to 'interludes' inside media directory if not specified
    const interludeConfig = {
      ...runtimeConfig.interlude,
      directory: path.join(bootstrap.paths.media, 'interludes'),
    }

    // Local player compatibility is only meaningful for the legacy Pi mode.
    // Remote-client capability negotiation will replace this in server mode.
    if (this.localPlaybackEnabled) {
      this.hardwareService = new HardwareDetectionService()
      this.hardwareService.detect() // Cache the profile on init
    }

    this.indexer = new MediaIndexer(
      mediaConfig,
      interludeConfig,
      this.repository,
      filesystem,
      mediaProbe,
      thumbnailClient,
      this.hardwareService ?? undefined
    )

    this.engine = new PlaylistEngine(
      this.appConfig,
      this.repository,
      new SessionManager(new SystemDateTimeProvider()),
      new SystemDateTimeProvider()
    )
    this.indexer.onScanStart(async () => {
      await this.engine?.refreshCache()
      await this.playbackService?.reconcilePrequeue()
    })
    this.indexer.onScanComplete(async () => {
      await this.engine?.refreshCache(true)
      await this.playbackService?.reconcilePrequeue()
    })

    console.log('Components initialized.')
  }

  /**
   * Start background tasks (Scanning, MPV Connection). Slow.
   * Call this AFTER starting the web server to ensure fast UI availability.
   */
  async start(): Promise<void> {
    if (!this.player || !this.indexer || !this.repository || !this.engine) {
      throw new Error('Daemon not initialized. Call init() first.')
    }

    console.log('ToastTV background services starting...')
    this.stopping = false

    // 4. Connect to the local player, or initialize the disabled adapter.
    await this.player.connect()

    // 5. Create ConfigService (needed for PlaybackService)
    this.configService = new ConfigService(this.appConfig)

    // 6. Check if hardware profile changed - recalculate compatibility if so
    if (
      this.localPlaybackEnabled &&
      this.hardwareService &&
      this.repository
    ) {
      const currentProfile = this.hardwareService.detect().profileKey
      const lastProfile = await this.repository.getSetting('last_profile_key')

      if (lastProfile !== currentProfile) {
        console.log(
          `Hardware profile changed: ${lastProfile ?? 'none'} → ${currentProfile}`
        )
        await this.indexer.recalculateCompatibility()
        await this.repository.setSetting('last_profile_key', currentProfile)
      }
    }

    // 7. Run scan in background (non-blocking)
    // Dashboard may show stale/empty library briefly on first launch
    this.scanTask = this.indexer
      .scanAll()
      .then(async (count) => {
        if (this.stopping) return

        console.log(`Background scan complete: ${count} files`)
        // Discover special media after scan completes
        const allMedia = await this.repository?.getAll()
        if (allMedia) {
          await this.configService?.discoverSpecialMedia(allMedia)
        }
        // Start file watcher for real-time updates
        if (!this.stopping) {
          this.indexer?.startWatching()
        }
      })
      .catch((e) => {
        console.error('Background scan failed:', e)
      })

    // 7. Create PlaybackService (needed for CEC and server)
    this.playbackService = new PlaybackService({
      player: this.player,
      engine: this.engine,
      config: this.configService,
      media: this.repository,
      localPlaybackEnabled: this.localPlaybackEnabled,
      // Note: No DashboardEventService here - server can set it later if needed
    })

    // Get fresh config for logo settings
    const runtimeConfig = await this.appConfig.get()

    // Apply MPV-only settings when local playback is enabled.
    if (this.localPlaybackEnabled && runtimeConfig.logo) {
      // Map AppConfig structure (imagePath) to LogoConfig structure (filePath)
      await this.player.updateLogo({
        filePath: runtimeConfig.logo.imagePath,
        opacity: runtimeConfig.logo.opacity,
        position: runtimeConfig.logo.position,
        x: runtimeConfig.logo.x,
        y: runtimeConfig.logo.y,
      })
    }

    if (this.localPlaybackEnabled) {
      // Try to start TV detection (CEC + heartbeat)
      try {
        await this.initializeDetection(runtimeConfig)
      } catch (e) {
        console.log('TV Detection not available (this is optional):', e)
      }
    } else {
      console.log('Headless mode: MPV, CEC, and Pi hardware detection disabled')
    }

    this.running = true
    console.log('ToastTV daemon fully operational')

    // Check for updates in background (non-blocking)
    this.getUpdateService()
      .checkForUpdate()
      .catch(() => {
        // Silently ignore - update check is best-effort
      })
  }

  private async initializeDetection(config: AppConfig): Promise<void> {
    if (!this.playbackService) return
    const playback = this.playbackService

    // Create clients based on config
    let cec: CECClient | null = null

    if (config.detection.cecEnabled) {
      try {
        cec = new CECClient()
        this.cecClient = cec

        // Wire up remote control buttons (separate from detection)
        cec.onKeyPress(CEC_KEYS.PLAY, () => {
          console.log('CEC: PLAY - starting session')
          void playback.startSession()
        })

        cec.onKeyPress(CEC_KEYS.PAUSE, () => {
          console.log('CEC: PAUSE - toggling pause')
          void playback.pause()
        })

        cec.onKeyPress(CEC_KEYS.STOP, () => {
          console.log('CEC: STOP - ending session')
          void playback.endSession()
        })

        cec.onKeyPress(CEC_KEYS.FORWARD, () => {
          console.log('CEC: FORWARD - skipping to next video')
          void playback.skip()
        })

        cec.onKeyPress(CEC_KEYS.RIGHT, () => {
          console.log('CEC: RIGHT - skipping to next video')
          void playback.skip()
        })

        cec.onKeyPress(CEC_KEYS.SELECT, () => {
          if (playback.isSessionActive) {
            console.log('CEC: SELECT - toggling pause')
            void playback.pause()
          } else {
            console.log('CEC: SELECT - starting session')
            void playback.startSession()
          }
        })

        cec.onKeyPress(CEC_KEYS.UP, () => {
          console.log('CEC: UP - showing TV guide')
          void (async () => {
            const data = await playback.getGuideData()
            await this.player?.showGuide?.(data)
          })()
        })

        await cec.start()
        console.log('CEC listener started')
      } catch (e) {
        console.log('CEC not available:', e)
        cec = null
      }
    }

    // Create detection service
    this.detectionService = new TVDetectionService({
      cec,
      config: config.detection,
    })

    // Wire detection to playback
    this.detectionService.onTVActive(() => {
      console.log('TV Active: Starting session')
      void playback.startSession()
    })

    this.detectionService.onTVInactive(() => {
      console.log('TV Inactive: Ending session')
      void playback.endSession()
    })

    await this.detectionService.start()
    console.log('TV Detection Service started')
  }

  async stop(): Promise<void> {
    console.log('ToastTV daemon stopping...')
    this.running = false
    this.stopping = true

    this.playbackService?.stopLoop()
    this.indexer?.stopWatching()

    if (this.scanTask) {
      await this.scanTask
      this.scanTask = null
    }

    // Stop detection service
    if (this.detectionService) {
      this.detectionService.stop()
    }

    // Stop clients
    if (this.cecClient) {
      await this.cecClient.stop()
    }

    if (this.engine && this.engine.isSessionActive) {
      await this.engine.endSession()
    }

    if (this.player) {
      try {
        await this.player.stop()
      } catch (e) {
        /* ignore */
      }

      try {
        await this.player.disconnect()
      } catch (e) {
        /* ignore */
      }
    }

    if (this.repository) {
      await this.repository.close()
    }

    console.log('ToastTV daemon stopped')
  }
}
