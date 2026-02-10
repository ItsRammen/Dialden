/**
 * ToastTV Type Definitions
 *
 * Core interfaces and types used across the application.
 * All external dependencies should implement these interfaces for DI.
 */

// --- Media Types ---

export type MediaType = 'video' | 'interlude' | 'intro' | 'outro' | 'offair'

export type Compatibility = 'compatible' | 'marginal' | 'incompatible'

export interface MediaItem {
  readonly id: number
  readonly path: string
  readonly filename: string
  readonly durationSeconds: number
  readonly isInterlude: boolean // Kept for compatibility - true if type is interlude
  readonly mediaType: MediaType
  readonly dateStart: string | null
  readonly dateEnd: string | null
  // Extended metadata (Phase 3)
  readonly codec: string | null
  readonly width: number | null
  readonly height: number | null
  readonly warning: string | null
  // Delta scanning (Phase 4)
  readonly mtime: number | null // Unix timestamp in ms
  // Hardware compatibility
  readonly compatibility: Compatibility
}

export interface PlaybackStatus {
  readonly isPlaying: boolean
  readonly state: 'playing' | 'paused' | 'stopped'
  readonly currentFile: string | null
  readonly positionSeconds: number
  readonly durationSeconds: number
}

// --- Configuration ---

export interface PlayerConfig {
  readonly ipcSocket: string
  readonly reconnectDelayMs: number
  readonly maxReconnectAttempts: number
}

export interface SessionConfig {
  readonly limitMinutes: number
  readonly introVideoId: number | null
  readonly outroVideoId: number | null
}

export interface InterludeConfig {
  readonly enabled: boolean
  readonly frequency: number
  readonly directory: string
}

export interface LogoConfig {
  readonly filePath: string | null
  readonly opacity: number
  readonly position: number
  readonly x?: number
  readonly y?: number
}

export interface MediaConfig {
  readonly directory: string
  readonly supportedExtensions: readonly string[]
  readonly databasePath: string
}

export interface ToastTVConfig {
  readonly mpv: PlayerConfig
  readonly media: MediaConfig
  readonly session: SessionConfig
  readonly interlude: InterludeConfig
  readonly logo: LogoConfig
}

// --- TV Guide Overlay ---

export interface GuideData {
  readonly now: string
  readonly nowPosition: number
  readonly nowDuration: number
  readonly next: string | null
  readonly nextDuration: number
  readonly sessionMinutes: number // -1 = unlimited
  readonly isOffAir: boolean
  readonly resetHour: number
}

// --- Interfaces for DI ---

export interface IMediaPlayer {
  readonly isConnected: boolean
  connect(): Promise<void>
  disconnect(): Promise<void>

  play(path: string): Promise<void>
  enqueue(path: string): Promise<void>
  clear(): Promise<void>
  pause(): Promise<void>
  stop(): Promise<void>
  next(): Promise<void>
  setLoop(enabled: boolean): Promise<void>
  getStatus(): Promise<PlaybackStatus>
  updateLogo(config: LogoConfig): Promise<void>
  /** Optional: show TV guide overlay (MPV-specific) */
  showGuide?(data: GuideData): Promise<void>
}

export interface IFileSystem {
  listFiles(
    directory: string,
    extensions: readonly string[],
    excludePaths?: string[]
  ): string[]
  exists(path: string): boolean
  getMtime(path: string): number | null // Unix timestamp in ms
  watch(
    directory: string,
    callback: (event: 'add' | 'change' | 'remove', path: string) => void
  ): FileWatcher
}

/**
 * Handle returned by watch() for cleanup
 */
export interface FileWatcher {
  close(): void
}

export interface IMediaProbe {
  getDuration(filePath: string): Promise<number>
  getMetadata(filePath: string): Promise<MediaMetadata>
}

/**
 * Metadata extracted from media files via ffprobe
 */
export interface MediaMetadata {
  readonly durationSeconds: number
  readonly codec: string | null
  readonly width: number | null
  readonly height: number | null
  readonly fps: number | null
  readonly bitrateMbps: number | null
}

export interface IDateTimeProvider {
  now(): Date
  today(): string // YYYY-MM-DD
}

/**
 * Thumbnail generation (Phase 5)
 */
export interface IThumbnailClient {
  generateAll(items: ReadonlyArray<{ id: number; path: string }>): Promise<void>
}
