/**
 * Media Repository Interface
 *
 * Defines the contract for media persistence operations.
 * Implementations can use SQLite, PostgreSQL, or any other storage.
 */

import type {
  MediaItem,
  MediaType,
  Compatibility,
  CollectionListOptions,
  CollectionMetadataUpdate,
  EpisodeMetadataUpdate,
  CollectionUpsertInput,
  LibrarySummary,
  MediaCollection,
  MediaFileListOptions,
  MediaFilePage,
  OverrideDecision,
  PolicyDecision,
} from '../types'

/**
 * Input type for creating/updating media items.
 * Omits the auto-generated id field.
 */
export type MediaItemInput = Omit<MediaItem, 'id'>

export interface IMediaRepository {
  /**
   * Initialize the repository (create tables, run migrations, etc.)
   */
  initialize(): Promise<void>

  /**
   * Close the repository connection
   */
  close(): Promise<void>

  // --- Read Operations ---

  /**
   * Get all media items sorted by filename
   */
  getAll(): Promise<MediaItem[]>

  /** Query one bounded, filtered page for the Advanced Files UI. */
  getMediaPage(options: MediaFileListOptions): Promise<MediaFilePage>

  /**
   * Get a single media item by ID
   */
  getById(id: number): Promise<MediaItem | null>

  /**
   * Get a single media item by path
   */
  getByPath(path: string): Promise<MediaItem | null>

  /**
   * Get all videos (mediaType === 'video')
   */
  getAllVideos(): Promise<MediaItem[]>

  /**
   * Get interludes active on a given date
   * @param currentDate - YYYY-MM-DD format
   */
  getInterludes(currentDate: string): Promise<MediaItem[]>

  /**
   * Get media item by type (for singletons like intro/outro)
   */
  getByType(type: MediaType): Promise<MediaItem | null>

  // --- Collection catalog ---

  upsertCollections(
    collections: readonly CollectionUpsertInput[]
  ): Promise<MediaCollection[]>

  reconcileCollections(
    rootId: string,
    presentIdentityKeys: readonly string[]
  ): Promise<number>

  getCollections(options?: CollectionListOptions): Promise<MediaCollection[]>

  getCollectionById(id: number): Promise<MediaCollection | null>

  getCollectionMedia(id: number): Promise<MediaItem[]>

  getLibrarySummary(): Promise<LibrarySummary>

  updateCollectionPolicy(
    id: number,
    decision: PolicyDecision,
    reason: string,
    profileId?: string
  ): Promise<boolean>

  updateCollectionOverride(
    id: number,
    decision: OverrideDecision
  ): Promise<boolean>

  updateCollectionMetadata(
    id: number,
    metadata: CollectionMetadataUpdate
  ): Promise<boolean>

  updateCollectionEpisodeMetadata(
    id: number,
    episodes: readonly EpisodeMetadataUpdate[]
  ): Promise<number>

  getCollectionsNeedingMetadata(limit?: number): Promise<MediaCollection[]>

  // --- Write Operations ---

  /**
   * Insert or update a media item by path
   * On conflict, preserves user settings (type, dates)
   */
  upsertMedia(item: MediaItemInput): Promise<void>

  /**
   * Delete a media item by ID
   */
  deleteMedia(id: number): Promise<void>

  /**
   * Toggle interlude status for a media item
   */
  toggleInterlude(id: number, isInterlude: boolean): Promise<void>

  /**
   * Update the media type for an item
   */
  updateMediaType(id: number, mediaType: MediaType): Promise<void>

  /**
   * Reset all items of a given type back to 'video'
   * Used when setting a new intro/outro (singleton pattern)
   */
  resetMediaType(mediaType: MediaType): Promise<void>

  /**
   * Update scheduling dates for an interlude
   */
  updateDates(
    id: number,
    dateStart: string | null,
    dateEnd: string | null
  ): Promise<void>

  /**
   * Override whether an indexed item can be selected for playback. Null
   * returns the item to the library policy decision.
   */
  updatePlaybackOverride(
    id: number,
    enabled: boolean | null
  ): Promise<void>

  /** Fail closed for rows created before managed roots/policy existed. */
  restrictPlaybackToRoots(rootIds: string[]): Promise<number>

  /**
   * Apply the configured collection allow-list to already indexed rows before
   * any playback service can use them. Manual overrides remain valid only in
   * roots that are still configured.
   */
  synchronizePlaybackPolicy(
    roots: ReadonlyArray<{
      id: string
      approvedCollections?: readonly string[]
    }>
  ): Promise<number>

  /** Gate a root without deleting its catalog or parent overrides. */
  setRootAvailable(rootId: string, available: boolean): Promise<void>

  // --- Batch Operations (for parallel scanning) ---

  /**
   * Get multiple media items by paths in a single query
   * Returns a Map for O(1) lookups
   */
  getByPaths(paths: string[]): Promise<Map<string, MediaItem>>

  /** Get existing rows by their stable locator within one configured root. */
  getByRootRelativePaths(
    rootId: string,
    relativePaths: string[]
  ): Promise<Map<string, MediaItem>>

  /**
   * Insert or update multiple media items in a single transaction
   */
  upsertBatch(items: MediaItemInput[]): Promise<void>

  /**
   * Remove media items by paths
   */
  removeByPaths(paths: string[]): Promise<number>

  /**
   * Remove all media entries whose paths are not in the given list
   * Used during rescan to clean up deleted files
   */
  removeNotInPaths(validPaths: string[]): Promise<number>

  /**
   * Reconcile only one successfully scanned root. Unavailable roots must not
   * call this method, preventing another healthy mount from deleting its rows.
   */
  removeNotInRootPaths(
    rootId: string,
    validRelativePaths: string[]
  ): Promise<number>

  // --- Settings (DB-First Config) ---

  /**
   * Get a configuration value by key
   */
  getSetting(key: string): Promise<string | null>

  /**
   * Set a configuration value
   */
  setSetting(key: string, value: string): Promise<void>

  /**
   * Get all configuration settings as a key-value map
   */
  getAllSettings(): Promise<Record<string, string>>

  /**
   * Update compatibility for multiple items in a single transaction.
   * Used when hardware profile changes.
   */
  updateCompatibilityBatch(
    updates: Array<{ id: number; compatibility: Compatibility }>
  ): Promise<number>
}
