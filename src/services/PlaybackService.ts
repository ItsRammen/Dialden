/**
 * Playback Service
 *
 * Handles session control, player playback, and the playback loop.
 * Delegates to MpvClient (via IMediaPlayer) and PlaylistEngine.
 */

import type { PlaylistEngine } from './PlaylistEngine'
import type {
  MediaItem,
  PlaybackStatus,
  IMediaPlayer,
  GuideData,
} from '../types'
import type { DashboardEventService } from './DashboardEventService'
import type { ConfigService } from './ConfigService'
import type { IMediaRepository } from '../repositories/IMediaRepository'
import { logger } from '../utils/logger'
import { cleanFilename } from '../utils/cleanFilename'

export interface PlaybackServiceDeps {
  player: IMediaPlayer
  engine: PlaylistEngine
  config: ConfigService
  media: IMediaRepository
  events?: DashboardEventService
  localPlaybackEnabled?: boolean
}

export class LocalPlaybackDisabledError extends Error {
  constructor() {
    super('Local playback is disabled in this deployment')
    this.name = 'LocalPlaybackDisabledError'
  }
}

export class PlaybackService {
  private running = false
  private offAirMode = false

  private readonly player: IMediaPlayer
  private readonly engine: PlaylistEngine
  private readonly config: ConfigService
  private readonly media: IMediaRepository
  private readonly localPlaybackEnabled: boolean
  private events?: DashboardEventService

  constructor(deps: PlaybackServiceDeps) {
    this.player = deps.player
    this.engine = deps.engine
    this.config = deps.config
    this.media = deps.media
    this.events = deps.events
    this.localPlaybackEnabled = deps.localPlaybackEnabled ?? true
  }

  /**
   * Set the event service for SSE dashboard updates.
   * Called by server after daemon creates the base service.
   */
  setEventService(events: DashboardEventService): void {
    this.events = events
  }

  // --- Session Info ---

  get isSessionActive(): boolean {
    return this.engine.isSessionActive
  }

  get isLocalPlaybackAvailable(): boolean {
    return this.localPlaybackEnabled
  }

  get isOffAir(): boolean {
    return this.offAirMode
  }

  get sessionInfo(): {
    startedAt: Date | null
    limitMinutes: number
    resetHour: number
    elapsedMs: number
    remainingMs: number
  } {
    return this.engine.sessionInfo
  }

  /**
   * Get daily quota remaining in minutes (null = unlimited)
   */
  get quotaRemainingMinutes(): number | null {
    return this.engine.getQuotaRemainingMinutes()
  }

  /**
   * Check if quota is currently skipped for today
   */
  get isQuotaSkipped(): boolean {
    return this.engine.isQuotaSkipped()
  }

  /**
   * Package current playback state for the TV guide overlay.
   * Returns a plain data object — no IPC or player coupling.
   */
  async getGuideData(): Promise<GuideData> {
    const current = this.engine.getCurrentVideo()
    const queue = this.engine.peekQueue(1)
    const nextItem = queue[0]
    const session = this.engine.sessionInfo
    const status = await this.player.getStatus()

    const sessionMinutes =
      session.limitMinutes === 0
        ? -1
        : Math.max(0, Math.floor(session.remainingMs / 60000))

    return {
      now: current ? cleanFilename(current.filename) : '—',
      nowPosition: status.positionSeconds,
      nowDuration: status.durationSeconds,
      next: nextItem ? cleanFilename(nextItem.filename) : null,
      nextDuration: nextItem ? nextItem.durationSeconds : 0,
      sessionMinutes,
      isOffAir: this.offAirMode,
      resetHour: session.resetHour,
    }
  }

  /**
   * Skip quota for today and exit off-air mode
   */
  async skipQuotaAndResume(): Promise<void> {
    this.assertLocalPlaybackEnabled()
    this.engine.skipQuotaForToday()

    if (this.offAirMode) {
      this.offAirMode = false
      await this.player.setLoop(false)

      // Start a fresh session
      const firstVideo = await this.engine.startSession()
      if (firstVideo) {
        await this.playVideo(firstVideo)

        // Broadcast session start for dashboard refresh
        this.events?.broadcast({
          type: 'sessionStart',
          sessionRemainingMs: this.engine.sessionInfo.remainingMs,
          queue: this.peekQueue(10).map((v) => ({
            id: v.id,
            filename: v.filename,
            isInterlude: v.isInterlude,
            durationSeconds: v.durationSeconds,
          })),
        })

        // Pre-queue second video for gapless playback
        const secondVideo = this.engine.peekQueue(1)[0]
        if (secondVideo) {
          const queued = await this.enqueueCurrentlyPlayable(secondVideo.id)
          if (queued) logger.info(`Pre-queued: ${queued.filename}`)
        }
      }
    } else {
      // If just expired but not yet in off-air loop (rare race), ensure we continue
      this.events?.broadcast({
        type: 'sessionStart',
        sessionRemainingMs: this.engine.sessionInfo.remainingMs,
        queue: this.peekQueue(10).map((v) => ({
          id: v.id,
          filename: v.filename,
          isInterlude: v.isInterlude,
          durationSeconds: v.durationSeconds,
        })),
      })
    }
  }

  // --- Playback Control ---

  /**
   * Start a new viewing session
   */
  async startSession(): Promise<void> {
    this.assertLocalPlaybackEnabled()

    if (this.engine.isSessionActive) {
      console.warn('Session already active')
      return
    }

    // Ensure Player loop is disabled for normal session
    await this.player.setLoop(false)

    // Exit off-air mode if active
    this.offAirMode = false

    const firstVideo = await this.engine.startSession()

    // Emit session start event with queue
    this.events?.resetPlayingState()
    const remaining =
      this.engine.sessionInfo.limitMinutes * 60 * 1000 -
      this.engine.sessionInfo.elapsedMs
    const queue = this.peekQueue(10).map((v) => ({
      id: v.id,
      filename: v.filename,
      isInterlude: v.isInterlude,
      durationSeconds: v.durationSeconds,
    }))
    this.events?.broadcast({
      type: 'sessionStart',
      sessionRemainingMs: remaining,
      queue,
    })

    if (firstVideo) {
      await this.playVideo(firstVideo)
    }
  }

  /**
   * End the current session
   */
  async endSession(): Promise<void> {
    this.assertLocalPlaybackEnabled()
    await this.engine.endSession()
    await this.player.stop()
    this.events?.resetPlayingState()
    this.events?.broadcast({ type: 'sessionEnd' })
    console.log('Session ended')
  }

  /**
   * Skip to next video
   */
  async skip(): Promise<void> {
    this.assertLocalPlaybackEnabled()
    const next = await this.engine.getNextVideo()
    if (next) {
      await this.playVideo(next)
    }
  }

  /**
   * Pause playback
   */
  async pause(): Promise<void> {
    this.assertLocalPlaybackEnabled()
    await this.player.pause()
    // Check actual state and emit
    const status = await this.player.getStatus()
    this.events?.broadcastPlayingState(status.isPlaying)
  }

  /**
   * Stop playback and end session
   */
  async stop(): Promise<void> {
    this.assertLocalPlaybackEnabled()
    await this.player.stop()
    await this.engine.endSession()
    this.offAirMode = false
    this.events?.resetPlayingState()
    this.events?.broadcast({ type: 'sessionEnd' })
  }

  // --- Status ---

  /**
   * Get current playback status from player
   */
  async getStatus(): Promise<PlaybackStatus | null> {
    try {
      return await this.player.getStatus()
    } catch {
      return null
    }
  }

  /**
   * Get upcoming videos in queue
   */
  peekQueue(count = 5): MediaItem[] {
    return this.engine.peekQueue(count)
  }

  /**
   * Rebuild the player's native future queue after policy or mount changes.
   * The currently playing item is deliberately left alone.
   */
  async reconcilePrequeue(): Promise<void> {
    if (!this.localPlaybackEnabled) return
    try {
      await this.player.clear()
      const candidate = this.engine.peekQueue(1)[0]
      if (!candidate) return
      await this.enqueueCurrentlyPlayable(candidate.id)
    } catch (error) {
      logger.warn(`Unable to reconcile player prequeue: ${String(error)}`)
    }
  }

  /**
   * Alias for peekQueue (legacy)
   */
  getQueue(count = 5): MediaItem[] {
    return this.peekQueue(count)
  }

  /**
   * Shuffle upcoming queue
   */
  async shuffleQueue(): Promise<void> {
    this.assertLocalPlaybackEnabled()
    await this.engine.shuffleQueue()
    // Emit queue update
    const queue = this.peekQueue(10).map((v) => ({
      id: v.id,
      filename: v.filename,
      isInterlude: v.isInterlude,
      durationSeconds: v.durationSeconds,
    }))
    this.events?.broadcast({ type: 'queueUpdate', queue })
  }

  /**
   * Get currently playing video
   */
  getCurrentMedia(): MediaItem | null {
    return this.engine.getCurrentVideo()
  }

  getSessionInfo() {
    return this.engine.sessionInfo
  }

  // --- Internal ---

  private async playVideo(video: MediaItem): Promise<void> {
    const current = await this.playCurrentlyPlayable(video.id)
    if (!current) return

    // Logo is re-applied by Lua's file-loaded handler reading /tmp/toasttv-logo.json

    // Emit track start event with updated queue
    const queue = this.peekQueue(10).map((v) => ({
      id: v.id,
      filename: v.filename,
      isInterlude: v.isInterlude,
      durationSeconds: v.durationSeconds,
    }))
    this.events?.broadcast({
      type: 'trackStart',
      trackId: current.id,
      filename: current.filename,
      duration: current.durationSeconds,
      queue,
    })

    // PRE-QUEUE NEXT
    // When manually playing a video (start/skip), we must ensure the NEXT video is queued
    // otherwise player will stop after this one.
    const nextInQueue = this.engine.peekQueue(1)[0]
    if (nextInQueue) {
      const queued = await this.enqueueCurrentlyPlayable(nextInQueue.id)
      if (queued) logger.info(`Pre-queued (manual play): ${queued.filename}`)
    } else {
      // If no more videos, try to enqueue off-air loop?
      const appConfig = await this.config.get()
      if (appConfig.session.offAirAssetId) {
        const offAirMedia = await this.enqueueCurrentlyPlayable(
          appConfig.session.offAirAssetId
        )
        if (offAirMedia) {
          logger.info(
            `Pre-queued off-air (manual play): ${offAirMedia.filename}`
          )
        }
      }
    }
  }

  // NOTE: "Last video badge" feature removed - runtime logo control not fully supported in simple overlay

  /**
   * Enter off-air mode - play the configured off-air asset on loop
   */
  private async enterOffAirMode(): Promise<void> {
    const appConfig = await this.config.get()
    const offAirAssetId = appConfig.session.offAirAssetId

    if (!offAirAssetId) {
      logger.info('No off-air asset configured, stopping playback')
      await this.player.stop()
      return
    }

    const mediaItem = await this.playCurrentlyPlayable(offAirAssetId)
    if (!mediaItem) {
      logger.warn(`Off-air asset ID ${offAirAssetId} is unavailable or blocked`)
      await this.player.stop()
      return
    }

    this.offAirMode = true
    logger.info(`Entering off-air mode with: ${mediaItem.filename}`)

    // Playback was authorized against the current repository row above.
    await this.player.setLoop(true)

    // Broadcast off-air state to frontend
    this.events?.broadcast({
      type: 'sync',
      sessionActive: false,
      isOffAir: true,
      resetHour: this.engine.sessionInfo.resetHour,
      trackId: mediaItem.id,
      filename: mediaItem.filename,
      duration: mediaItem.durationSeconds,
      position: 0,
      isPlaying: true,
      sessionRemainingMs: 0,
      sessionStartedAt: null,
      sessionLimitMs: 0,
      queue: [],
    })
  }

  // --- Lifecycle ---

  /**
   * Connect to player
   */
  async connect(): Promise<void> {
    await this.player.connect()
  }

  /**
   * Disconnect from player
   */
  async disconnect(): Promise<void> {
    await this.player.disconnect()
  }

  /**
   * Start the playback loop (non-blocking)
   */
  startLoop(): void {
    this.assertLocalPlaybackEnabled()
    this.running = true
    void this.runPlaybackLoop()
  }

  /**
   * Stop the playback loop
   */
  stopLoop(): void {
    this.running = false
  }

  private assertLocalPlaybackEnabled(): void {
    if (!this.localPlaybackEnabled) {
      throw new LocalPlaybackDisabledError()
    }
  }

  /**
   * Main playback loop - monitors player and handles track transitions.
   * This is a "Sync Loop" that detects when player auto-advances to the next
   * queued video, then immediately enqueues the following video to maintain
   * a seamless playback buffer.
   */
  private async runPlaybackLoop(): Promise<void> {
    // Track state for transition detection
    let lastPosition = 0
    let disconnectedLogged = false
    let lastIsPlaying = false

    while (this.running) {
      // In off-air mode, just keep looping (player handles the loop)
      if (this.offAirMode) {
        await Bun.sleep(1000)
        continue
      }

      if (!this.engine.isSessionActive) {
        await Bun.sleep(1000)
        continue
      }

      try {
        const status = await this.player.getStatus()
        disconnectedLogged = false // Connection active

        // Get current video from Engine (single source of truth)
        const currentVideo = this.engine.getCurrentVideo()

        // Detect Pause/Resume changes
        if (status.isPlaying !== lastIsPlaying) {
          // If we have a current video, broadcast the state change
          if (currentVideo) {
            this.events?.broadcast({
              type: status.isPlaying ? 'playing' : 'paused',
            })
          }
          lastIsPlaying = status.isPlaying
        }

        const wasPlaying = currentVideo !== null

        // If player stopped entirely (not playing, nothing enqueued), session may be over
        if (
          !status.isPlaying &&
          status.state !== 'paused' &&
          wasPlaying &&
          lastPosition > 3
        ) {
          // Wait a moment to confirm player truly stopped (not just buffering between tracks)
          await Bun.sleep(800)
          const recheck = await this.player.getStatus()
          if (!recheck.isPlaying && recheck.state !== 'paused') {
            // Player has stopped - session complete
            logger.info(
              'Player stopped, session complete, entering off-air mode'
            )
            await this.enterOffAirMode()
            lastPosition = 0
            continue
          }
        }

        // FILE-BASED TRANSITION DETECTION
        // Compare MPV's actual file vs Engine's tracked current video
        const currentPath = currentVideo?.path ?? null
        const playerPath = status.currentFile
          ? decodeURIComponent(status.currentFile)
          : null

        // Transition detected when MPV is playing a DIFFERENT file than Engine tracks
        const fileChanged =
          playerPath &&
          currentPath &&
          status.isPlaying &&
          !playerPath.endsWith(currentPath)

        if (fileChanged) {
          logger.debug('Loop', `Track transition detected (file mismatch)`)

          // Advance Engine state - this updates currentVideo inside Engine
          const next = await this.engine.getNextVideo()

          if (next) {
            lastPosition = status.positionSeconds // Reset position tracking
            disconnectedLogged = false

            // Broadcast track change
            const queue = this.peekQueue(10).map((v) => ({
              id: v.id,
              filename: v.filename,
              isInterlude: v.isInterlude,
              durationSeconds: v.durationSeconds,
            }))
            this.events?.broadcast({
              type: 'trackStart',
              trackId: next.id,
              filename: next.filename,
              duration: next.durationSeconds,
              queue,
            })

            // Logo is re-applied by Lua's file-loaded handler reading /tmp/toasttv-logo.json

            // PRE-QUEUE: Immediately enqueue the following video
            const upcoming = this.engine.peekQueue(1)[0]
            if (upcoming) {
              const queued = await this.enqueueCurrentlyPlayable(upcoming.id)
              if (queued) logger.info(`Pre-queued: ${queued.filename}`)
            } else {
              // No more videos - enqueue off-air if available
              const appConfig = await this.config.get()
              if (appConfig.session.offAirAssetId) {
                const offAirMedia = await this.enqueueCurrentlyPlayable(
                  appConfig.session.offAirAssetId
                )
                if (offAirMedia) {
                  logger.info(`Pre-queued off-air: ${offAirMedia.filename}`)
                }
              }
            }
          } else {
            // No next video - enter off-air mode
            logger.info('Session complete, entering off-air mode')
            await this.enterOffAirMode()
          }
        } else {
          // No transition - just update tracking
          lastPosition = status.positionSeconds
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        const isPlayerError =
          msg.includes('Not connected') || msg.includes('ECONNREFUSED')

        if (isPlayerError) {
          if (!disconnectedLogged) {
            console.error(
              `❌ Player Connection Lost: ${msg}\n   -> Please restart MPV/Player manually to resume playback.`
            )
            disconnectedLogged = true
          }
          await Bun.sleep(5000)
          continue
        }
        logger.error('Playback loop error:', error)
      }

      await Bun.sleep(500)
    }
  }

  /**
   * Resolve an engine/config media ID through the current repository row at
   * the final player boundary. Cached queue objects are never authorization
   * records and their absolute paths are never sent to MPV.
   */
  private async resolveCurrentlyPlayable(
    mediaId: number
  ): Promise<MediaItem | null> {
    if (
      !this.localPlaybackEnabled ||
      !Number.isSafeInteger(mediaId) ||
      mediaId <= 0
    ) {
      return null
    }

    try {
      const current = await this.media.getById(mediaId)
      if (
        !current ||
        current.id !== mediaId ||
        typeof current.path !== 'string' ||
        current.path.trim().length === 0 ||
        current.rootAvailable !== true ||
        current.playbackEnabled !== true ||
        current.mediaType !== 'video' ||
        current.isInterlude !== false ||
        typeof current.durationSeconds !== 'number' ||
        !Number.isFinite(current.durationSeconds) ||
        current.durationSeconds <= 0
      ) {
        logger.warn(`Refusing local playback for ineligible media ID ${mediaId}`)
        return null
      }
      return current
    } catch (error) {
      logger.warn(
        `Unable to authorize local playback for media ID ${mediaId}: ${String(error)}`
      )
      return null
    }
  }

  private async playCurrentlyPlayable(
    mediaId: number
  ): Promise<MediaItem | null> {
    const current = await this.resolveCurrentlyPlayable(mediaId)
    if (!current) return null
    await this.player.play(current.path)
    return current
  }

  private async enqueueCurrentlyPlayable(
    mediaId: number
  ): Promise<MediaItem | null> {
    const current = await this.resolveCurrentlyPlayable(mediaId)
    if (!current) return null
    await this.player.enqueue(current.path)
    return current
  }
}
