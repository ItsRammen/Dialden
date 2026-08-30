/**
 * ToastTV Type Definitions
 *
 * Core interfaces and types used across the application.
 * All external dependencies should implement these interfaces for DI.
 */

// --- Media Types ---

export type MediaType = 'video' | 'interlude' | 'intro' | 'outro' | 'offair'

export type Compatibility = 'compatible' | 'marginal' | 'incompatible'

export type LibraryKind = 'tv' | 'movie' | 'other'

export type PolicyDecision = 'allow' | 'review' | 'block'

export type OverrideDecision = 'allow' | 'block' | null

export type MetadataMatchStatus =
  | 'pending'
  | 'matched'
  | 'ambiguous'
  | 'unmatched'
  | 'manual'
  | 'error'
  | 'not_configured'

export type MetadataRatingStatus = 'resolved' | 'missing' | 'ambiguous'

export interface MetadataCandidateRecord {
  readonly provider: string
  readonly externalId: string
  readonly mediaType: 'movie' | 'tv'
  readonly title: string
  readonly originalTitle?: string
  readonly year?: number
  readonly posterPath?: string
  /**
   * Kept so a later reviewer — a person or the assistant — can tell two
   * same-titled candidates apart without re-querying the provider.
   */
  readonly overview?: string
  readonly popularity?: number
  /** Minutes, when the provider was asked for detail. Compared to the file. */
  readonly runtimeMinutes?: number
  readonly confidence: number
}

import type { AudienceBand } from './policy/audienceBands'

export interface MediaCollection {
  readonly id: number
  readonly rootId: string
  readonly libraryKind: LibraryKind
  readonly identityKey: string
  readonly sourceTitle: string
  readonly parsedTitle: string
  readonly year: number | null
  readonly present: boolean
  readonly metadataProvider: string | null
  readonly metadataExternalId: string | null
  readonly metadataStatus: MetadataMatchStatus
  readonly metadataLocked: boolean
  readonly metadataTitle: string | null
  readonly metadataOriginalTitle: string | null
  readonly metadataYear: number | null
  readonly overview: string | null
  readonly posterPath: string | null
  readonly backdropPath: string | null
  readonly genres: readonly string[]
  /** Original broadcasters/platform networks supplied by the metadata provider. */
  readonly networks?: readonly string[]
  /** Production companies/studios supplied by the metadata provider. */
  readonly studios?: readonly string[]
  readonly certification: string | null
  readonly certificationRegion: string | null
  /**
   * The youngest audience the certification suits, derived rather than
   * stored: it is a pure function of the certification, so deriving it on
   * read means it can never disagree with the rating it came from.
   */
  readonly audienceBand: AudienceBand | null
  readonly ratingStatus: MetadataRatingStatus
  readonly matchConfidence: number | null
  readonly metadataCandidates: readonly MetadataCandidateRecord[]
  readonly metadataError: string | null
  readonly policyDecision: PolicyDecision
  readonly policyReason: string
  readonly policyProfileId: string
  readonly parentOverride: OverrideDecision
  readonly effectiveDecision: PolicyDecision
  readonly decisionSource: 'parent' | 'policy' | 'fail_closed'
  readonly fileCount: number
  readonly seasonCount: number
  readonly episodeCount: number
  readonly readyFileCount: number
  readonly failedFileCount: number
  readonly legacyOverrideCount: number
  readonly scheduleEligibleCount: number
  readonly rootAvailable: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

export interface CollectionUpsertInput {
  readonly rootId: string
  readonly libraryKind: LibraryKind
  readonly identityKey: string
  readonly sourceTitle: string
  readonly parsedTitle: string
  readonly year: number | null
}

export interface CollectionListOptions {
  readonly kind?: LibraryKind
  readonly effectiveDecision?: PolicyDecision
  readonly metadataStatus?: MetadataMatchStatus
  /** Only collections whose metadata match or certification needs review. */
  readonly metadataReview?: boolean
  readonly search?: string
  readonly limit?: number
  readonly offset?: number
  readonly presentOnly?: boolean
  /** Only collections with at least one currently schedulable media row. */
  readonly scheduleEligibleOnly?: boolean
}

export interface CollectionMetadataUpdate {
  readonly provider: string
  readonly externalId: string | null
  readonly status: MetadataMatchStatus
  readonly locked?: boolean
  readonly title?: string | null
  readonly originalTitle?: string | null
  readonly year?: number | null
  readonly overview?: string | null
  readonly posterPath?: string | null
  readonly backdropPath?: string | null
  readonly genres?: readonly string[]
  readonly networks?: readonly string[]
  readonly studios?: readonly string[]
  readonly certification?: string | null
  readonly certificationRegion?: string | null
  readonly ratingStatus?: MetadataRatingStatus
  readonly matchConfidence?: number | null
  readonly candidates?: readonly MetadataCandidateRecord[]
  readonly error?: string | null
  readonly matchedAt?: string | null
}

export interface EpisodeMetadataUpdate {
  readonly seasonNumber: number
  readonly episodeNumber: number
  readonly title: string
  readonly overview?: string | null
  readonly airDate?: string | null
  readonly stillPath?: string | null
}

export interface LibrarySummary {
  readonly tvCollections: number
  readonly tvEpisodes: number
  readonly movieCollections: number
  readonly interludeFiles: number
  readonly totalFiles: number
  readonly approvedCollections: number
  readonly reviewCollections: number
  readonly blockedCollections: number
  readonly unmatchedCollections: number
  readonly metadataPendingCollections: number
  readonly metadataMatchedCollections: number
  readonly metadataReviewCollections: number
  readonly probeFailedFiles: number
  /** Total duration of approved, available, non-interlude video files. */
  readonly eligibleDurationSeconds: number
}

export type LibraryScanStatus =
  | 'idle'
  | 'discovering'
  | 'scanning'
  | 'completed'
  | 'failed'

export interface LibraryScanState {
  readonly status: LibraryScanStatus
  readonly currentRoot: string | null
  readonly currentFile: string | null
  readonly discoveredFiles: number
  readonly processedFiles: number
  readonly indexedFiles: number
  readonly failedFiles: number
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly error: string | null
}

export type LibraryScanEventType =
  | 'library.scan.started'
  | 'library.scan.progress'
  | 'library.scan.root.completed'
  | 'library.scan.root.unavailable'
  | 'library.scan.completed'
  | 'library.scan.failed'

export interface LibraryScanEvent {
  readonly type: LibraryScanEventType
  readonly state: LibraryScanState
}

export type MetadataProviderHealth =
  | 'not_configured'
  | 'unverified'
  | 'connected'
  | 'degraded'

export interface MetadataJobState {
  readonly status: 'idle' | 'running' | 'completed' | 'failed' | 'not_configured'
  /** Connection health observed by this server process, never inferred from a key alone. */
  readonly providerHealth: MetadataProviderHealth
  /** Redacted, user-safe health detail. Provider credentials must never appear here. */
  readonly providerMessage: string | null
  readonly total: number
  readonly processed: number
  readonly matched: number
  readonly needsReview: number
  readonly failed: number
  readonly currentCollectionId: number | null
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly error: string | null
}

/**
 * One independently mounted media library. The stable root ID and relative
 * path form a container-path-independent media locator.
 */
export interface MediaRootConfig {
  readonly id: string
  readonly directory: string
  readonly kind: LibraryKind
  /**
   * Exact, case-insensitive top-level collection names approved by the legacy
   * fallback policy. Missing/undefined policy never implies approval.
   */
  readonly approvedCollections?: readonly string[]
}

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
  /** Null until the file has been probed for an audio stream. */
  readonly hasAudio?: boolean | null
  readonly audioCodec?: string | null
  /** FFmpeg pixel format (e.g. yuv420p, yuv420p10le). Null until probed. */
  readonly pixelFormat?: string | null
  // Root-aware library identity and kid-safe playback policy.
  readonly rootId?: string
  readonly relativePath?: string
  readonly libraryKind?: LibraryKind
  readonly collectionTitle?: string
  /** Provider-normalized collection title, when metadata matching succeeded. */
  readonly collectionMetadataTitle?: string | null
  readonly collectionGenres?: readonly string[]
  readonly policyEnabled?: boolean
  readonly playbackOverride?: boolean | null
  /** False until this configured root completes a successful current scan. */
  readonly rootAvailable?: boolean
  readonly playbackEnabled?: boolean
  readonly collectionId?: number | null
  /** Durable collection identity from (root, kind, identity key). */
  readonly collectionIdentityKey?: string | null
  readonly seasonNumber?: number | null
  readonly episodeNumber?: number | null
  readonly episodeTitle?: string | null
  readonly episodeMetadataTitle?: string | null
  readonly episodeOverview?: string | null
  readonly episodeAirDate?: string | null
  readonly episodeStillPath?: string | null
}

/** Filters supported by the file-level Advanced Files catalog. */
export type MediaFileListFilter =
  | 'all'
  | 'approved'
  | 'blocked'
  | 'errors'
  | 'videos'
  | 'interludes'

/** Bounded database query for one page of the file-level catalog. */
export interface MediaFileListOptions {
  readonly filter: MediaFileListFilter
  readonly search?: string
  readonly limit: number
  readonly offset: number
  /** Configured singleton assets that should remain at the top of the list. */
  readonly prioritizedIds?: readonly number[]
}

export interface MediaFilePage {
  readonly items: readonly MediaItem[]
  readonly total: number
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
  readonly roots?: readonly MediaRootConfig[]
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
  /** Clear queued future items without interrupting the current item. */
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
  /** Optional stronger readiness check for mounted/network directories. */
  isReadableDirectory?(path: string): boolean
  getMtime(path: string): number | null // Unix timestamp in ms
  watch(
    directory: string,
    callback: (event: 'add' | 'change' | 'remove', path: string) => void,
    onError?: (error: unknown) => void
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
  /** Null when the file could not be inspected at all. */
  readonly hasAudio: boolean | null
  readonly audioCodec: string | null
  /** FFmpeg pixel format; bit-depth decisions derive from this. */
  readonly pixelFormat?: string | null
}

export interface IDateTimeProvider {
  now(): Date
  today(): string // YYYY-MM-DD
}

/**
 * Thumbnail generation (Phase 5)
 */
export interface IThumbnailClient {
  generateAll(
    items: ReadonlyArray<{ id: number; path: string }>,
    maxItems?: number
  ): Promise<void>
}
