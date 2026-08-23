/**
 * Media Indexer Service
 *
 * Scans media directories and updates the repository index.
 * Supports convention-based intro/outro detection via filename patterns.
 */

import type { IMediaRepository } from '../repositories/IMediaRepository'
import type { MediaItemInput } from '../repositories/IMediaRepository'
import { getFilename } from '../clients/FilesystemClient'
import { isAbsolute, relative } from 'node:path'
import type {
  IFileSystem,
  IMediaProbe,
  IThumbnailClient,
  InterludeConfig,
  MediaConfig,
  MediaMetadata,
  MediaType,
  Compatibility,
  LibraryScanEvent,
  LibraryScanEventType,
  LibraryScanState,
  MediaRootConfig,
} from '../types'
import type { IHardwareDetectionService } from './HardwareDetectionService'
import type { HardwareProfile } from '../config/hardwareProfiles'
import {
  deriveCollectionIdentity,
  type CollectionIdentity,
} from '../domain/CollectionIdentity'

export class MediaIndexer {
  private scanPromise: Promise<number> | null = null
  private rescanRequested = false
  private readonly scanCompleteListeners = new Set<
    (count: number) => void | Promise<void>
  >()
  private readonly scanStartListeners = new Set<() => void | Promise<void>>()
  private readonly scanEventListeners = new Set<
    (event: LibraryScanEvent) => void | Promise<void>
  >()
  private scanState: LibraryScanState = {
    status: 'idle',
    currentRoot: null,
    currentFile: null,
    discoveredFiles: 0,
    processedFiles: 0,
    indexedFiles: 0,
    failedFiles: 0,
    startedAt: null,
    completedAt: null,
    error: null,
  }
  private hardwareProfile: HardwareProfile | null = null

  constructor(
    private readonly mediaConfig: MediaConfig,
    private readonly interludeConfig: InterludeConfig,
    private readonly repository: IMediaRepository,
    private readonly filesystem: IFileSystem,
    private readonly mediaProbe: IMediaProbe,
    private readonly thumbnailClient?: IThumbnailClient,
    private readonly hardwareDetection?: IHardwareDetectionService
  ) {
    // Cache hardware profile for compatibility checking
    if (this.hardwareDetection) {
      this.hardwareProfile = this.hardwareDetection.getProfile()
    }
  }

  async scanAll(): Promise<number> {
    if (this.scanPromise) {
      // Coalesce callers onto the active scan, but request one more pass so a
      // parent approval or watcher event that arrived mid-scan is not lost.
      this.rescanRequested = true
      return this.scanPromise
    }

    const activeScan = this.scanUntilSettled()
    this.scanPromise = activeScan
    try {
      return await activeScan
    } finally {
      if (this.scanPromise === activeScan) this.scanPromise = null
    }
  }

  onScanComplete(
    listener: (count: number) => void | Promise<void>
  ): () => void {
    this.scanCompleteListeners.add(listener)
    return () => this.scanCompleteListeners.delete(listener)
  }

  onScanStart(listener: () => void | Promise<void>): () => void {
    this.scanStartListeners.add(listener)
    return () => this.scanStartListeners.delete(listener)
  }

  getScanState(): LibraryScanState {
    return { ...this.scanState }
  }

  onScanEvent(
    listener: (event: LibraryScanEvent) => void | Promise<void>
  ): () => void {
    this.scanEventListeners.add(listener)
    return () => this.scanEventListeners.delete(listener)
  }

  private async scanUntilSettled(): Promise<number> {
    let total = 0
    try {
      while (true) {
        this.rescanRequested = false
        total = await this.scanOnce()
        if (this.rescanRequested) continue
        for (const listener of this.scanCompleteListeners) {
          try {
            await listener(total)
          } catch (error) {
            console.error('Post-scan refresh failed', error)
          }
        }
        // A watcher event can arrive while a completion listener is refreshing
        // consumers. Run it before resolving the shared promise.
        if (!this.rescanRequested) return total
      }
    } catch (error) {
      this.scanState = {
        ...this.scanState,
        status: 'failed',
        currentRoot: null,
        currentFile: null,
        completedAt: new Date().toISOString(),
        error: this.errorMessage(error),
      }
      await this.emitScanEvent('library.scan.failed')
      throw error
    }
  }

  private async scanOnce(): Promise<number> {
    this.scanState = {
      status: 'discovering',
      currentRoot: null,
      currentFile: null,
      discoveredFiles: 0,
      processedFiles: 0,
      indexedFiles: 0,
      failedFiles: 0,
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
    }
    await this.emitScanEvent('library.scan.started')
    let videoCount = 0
    let interludeCount = 0
    let removed = 0

    const roots = this.getMediaRoots()
    const interludeRoot: MediaRootConfig = {
      id: 'interludes',
      directory: this.interludeConfig.directory,
      kind: 'other',
    }
    // Quarantine every root before walking any one of them. A large first
    // root cannot leave later roots temporarily eligible via stale paths.
    await Promise.all([
      ...roots.map((root) =>
        this.repository.setRootAvailable(root.id, false)
      ),
      this.repository.setRootAvailable(interludeRoot.id, false),
    ])
    for (const listener of this.scanStartListeners) {
      try {
        await listener()
      } catch (error) {
        console.error('Scan-start refresh failed', error)
      }
    }
    for (const root of roots) {
      const relativePaths: string[] = []
      if (!this.isRootReady(root.directory)) {
        console.warn(
          `Media root unavailable; preserving its index: ${root.id} (${root.directory})`
        )
        continue
      }

      try {
        const excludePaths = this.isWithinRoot(
          root.directory,
          this.interludeConfig.directory
        )
          ? [this.interludeConfig.directory]
          : []
        videoCount += await this.scanDirectory(
          root,
          false,
          relativePaths,
          excludePaths
        )
        removed +=
          (await this.repository.removeNotInRootPaths(
            root.id,
            relativePaths
          )) ?? 0
        await this.repository.setRootAvailable(root.id, true)
        await this.emitScanEvent('library.scan.root.completed')
      } catch (error) {
        console.error(
          `Media root scan failed; preserving its index: ${root.id}`,
          error
        )
      }
    }

    if (this.isRootReady(interludeRoot.directory)) {
      const relativePaths: string[] = []
      try {
        interludeCount = await this.scanDirectory(
          interludeRoot,
          true,
          relativePaths
        )
        removed +=
          (await this.repository.removeNotInRootPaths(
            interludeRoot.id,
            relativePaths
          )) ?? 0
        await this.repository.setRootAvailable(interludeRoot.id, true)
        await this.emitScanEvent('library.scan.root.completed')
      } catch (error) {
        console.error(
          'Interlude root scan failed; preserving its index',
          error
        )
      }
    }

    const total = videoCount + interludeCount
    console.log(
      `Indexed ${total} files (${videoCount} library, ${interludeCount} interludes), removed ${removed} stale`
    )
    this.scanState = {
      ...this.scanState,
      status: 'completed',
      currentRoot: null,
      currentFile: null,
      completedAt: new Date().toISOString(),
    }
    await this.emitScanEvent('library.scan.completed')
    return total
  }

  /**
   * Recalculate compatibility for all existing media without re-probing.
   * Uses stored metadata (codec, height, fps, bitrate).
   * Called when hardware profile changes.
   */
  async recalculateCompatibility(): Promise<number> {
    if (!this.hardwareProfile) {
      return 0 // No profile means all are 'compatible'
    }

    const allMedia = await this.repository.getAll()
    const updates: Array<{ id: number; compatibility: Compatibility }> = []

    for (const item of allMedia) {
      const metadata: MediaMetadata = {
        durationSeconds: item.durationSeconds,
        codec: item.codec,
        width: item.width,
        height: item.height,
        fps: null, // Not stored currently, use null
        bitrateMbps: null, // Not stored currently, use null
      }

      const newCompatibility = this.checkCompatibility(metadata)
      if (newCompatibility !== item.compatibility) {
        updates.push({ id: item.id, compatibility: newCompatibility })
      }
    }

    if (updates.length > 0) {
      await this.repository.updateCompatibilityBatch(updates)
      console.log(`Recalculated compatibility: ${updates.length} files updated`)
    }

    return updates.length
  }

  private async scanDirectory(
    root: MediaRootConfig,
    isInterlude: boolean,
    outRelativePaths: string[],
    excludePaths: string[] = []
  ): Promise<number> {
    const files = this.filesystem.listFiles(
      root.directory,
      this.mediaConfig.supportedExtensions,
      excludePaths
    )
    this.scanState = {
      ...this.scanState,
      status: 'scanning',
      currentRoot: root.id,
      currentFile: null,
      discoveredFiles: this.scanState.discoveredFiles + files.length,
    }
    await this.emitScanEvent('library.scan.progress')
    const rawDescriptors = files.map((filePath) => ({
      filePath,
      relativePath: this.getRelativePath(root, filePath),
    }))
    const [existingPathMap, locatorMap] = await Promise.all([
      this.repository.getByPaths(files),
      this.repository.getByRootRelativePaths(
        root.id,
        rawDescriptors.map((descriptor) => descriptor.relativePath)
      ),
    ])
    // Some third-party/test repository adapters may predate the locator API.
    const existingLocatorMap = locatorMap ?? new Map()
    const identities = new Map<string, CollectionIdentity>()
    for (const descriptor of rawDescriptors) {
      const identity = this.deriveIdentity(root, descriptor.relativePath)
      if (identity) identities.set(identity.identityKey, identity)
    }
    const collectionInputs = [...identities.values()].map((identity) => ({
      rootId: root.id,
      libraryKind: root.kind,
      identityKey: identity.identityKey,
      sourceTitle: identity.sourceTitle,
      parsedTitle: identity.title,
      year: identity.year,
    }))
    const collectionRows =
      typeof this.repository.upsertCollections === 'function'
        ? ((await this.repository.upsertCollections(collectionInputs)) ?? [])
        : []
    const collectionsByKey = new Map(
      collectionRows.map((collection) => [collection.identityKey, collection])
    )
    const descriptors = rawDescriptors.map(({ filePath, relativePath }) => {
      const identity = this.deriveIdentity(root, relativePath)
      const collection = identity
        ? collectionsByKey.get(identity.identityKey)
        : undefined
      const collectionTitle = identity?.sourceTitle ?? getFilename(filePath)
      const policyEnabled = collection?.effectiveDecision === 'allow'
      const existing =
        existingLocatorMap.get(relativePath) ?? existingPathMap.get(filePath)
      const mtime = this.filesystem.getMtime(filePath)
      // Technical indexing is independent from parental approval. Probe every
      // new or changed file so unknown collections can be reviewed without
      // ever making them eligible for playback.
      const shouldProbe = true
      const needsProbe =
        shouldProbe &&
        (!existing ||
          existing.mtime === null ||
          existing.mtime !== mtime ||
          existing.durationSeconds <= 0)

      outRelativePaths.push(relativePath)
      return {
        filePath,
        relativePath,
        collectionTitle,
        identity,
        collection,
        policyEnabled,
        existing,
        mtime,
        shouldProbe,
        needsProbe,
      }
    })

    const filesToProbe = descriptors
      .filter((descriptor) => descriptor.needsProbe)
      .map((descriptor) => descriptor.filePath)
    for (const descriptor of descriptors) {
      if (!descriptor.needsProbe) {
        await this.recordScanFile(
          root.id,
          descriptor.relativePath,
          (descriptor.existing?.durationSeconds ?? 0) > 0
        )
      }
    }
    const descriptorByPath = new Map(
      descriptors.map((descriptor) => [descriptor.filePath, descriptor])
    )
    const CONCURRENCY = 4
    const metadataResults = await this.probeParallel(
      filesToProbe,
      CONCURRENCY,
      async (filePath, result) => {
        const descriptor = descriptorByPath.get(filePath)
        await this.recordScanFile(
          root.id,
          descriptor?.relativePath ?? getFilename(filePath),
          (result?.durationSeconds ?? 0) > 0
        )
      }
    )

    const probedByPath = new Map<string, MediaMetadata | null>()
    for (let i = 0; i < filesToProbe.length; i++) {
      const path = filesToProbe[i]
      if (path) probedByPath.set(path, metadataResults[i] ?? null)
    }

    const itemsToUpsert: MediaItemInput[] = descriptors.map((descriptor) => {
      const filename = getFilename(descriptor.filePath)
      const probeResult = probedByPath.get(descriptor.filePath)
      const probeSucceeded = probeResult !== undefined && probeResult !== null
      const probeFailed = descriptor.needsProbe && probeResult === null
      const previousMetadata: MediaMetadata = {
        durationSeconds: descriptor.existing?.durationSeconds ?? 0,
        codec: descriptor.existing?.codec ?? null,
        width: descriptor.existing?.width ?? null,
        height: descriptor.existing?.height ?? null,
        fps: null,
        bitrateMbps: null,
      }
      const metadata = probeFailed
        ? { ...previousMetadata, durationSeconds: 0 }
        : (probeResult ?? previousMetadata)
      const mediaType =
        root.kind === 'other'
          ? this.detectMediaType(filename, isInterlude)
          : 'video'
      const { start: dateStart, end: dateEnd } = this.detectDates(filename)
      const warning = probeSucceeded
        ? this.generateWarning(metadata.codec)
        : (descriptor.existing?.warning ?? this.generateWarning(metadata.codec))
      const compatibility = probeSucceeded
        ? this.checkCompatibility(metadata)
        : (descriptor.existing?.compatibility ?? this.checkCompatibility(metadata))
      // A file with unreadable current metadata cannot safely enter a
      // schedule. Existing codec/compatibility details remain visible, but a
      // zero duration technically gates playback and the stale mtime retries.
      const policyEnabled =
        descriptor.policyEnabled &&
        (!probeFailed || descriptor.existing !== undefined)

      return {
        path: descriptor.filePath,
        filename,
        durationSeconds: metadata.durationSeconds,
        isInterlude: mediaType === 'interlude',
        mediaType,
        dateStart,
        dateEnd,
        codec: metadata.codec,
        width: metadata.width,
        height: metadata.height,
        warning,
        mtime: probeFailed || !descriptor.shouldProbe
          ? (descriptor.existing?.mtime ?? null)
          : descriptor.mtime,
        compatibility,
        rootId: root.id,
        relativePath: descriptor.relativePath,
        libraryKind: root.kind,
        collectionTitle: descriptor.collectionTitle,
        policyEnabled,
        playbackOverride: descriptor.existing?.playbackOverride ?? null,
        rootAvailable: false,
        playbackEnabled:
          descriptor.existing?.playbackOverride ?? policyEnabled,
        collectionId: descriptor.collection?.id ?? null,
        seasonNumber: descriptor.identity?.seasonNumber ?? null,
        episodeNumber: descriptor.identity?.episodeNumber ?? null,
        episodeTitle: descriptor.identity?.episodeTitle ?? null,
      }
    })

    if (itemsToUpsert.length > 0) {
      await this.repository.upsertBatch(itemsToUpsert)

      if (typeof this.repository.reconcileCollections === 'function') {
        await this.repository.reconcileCollections(
          root.id,
          [...identities.keys()]
        )
      }

      if (this.thumbnailClient && filesToProbe.length > 0) {
        const paths = filesToProbe
        const insertedMap = await this.repository.getByPaths(paths)
        const thumbnailItems = Array.from(insertedMap.values()).map((item) => ({
          id: item.id,
          path: item.path,
        }))
        // Do not block a large first-time Plex scan on thousands of FFmpeg
        // thumbnail jobs. Library page visits fill the remaining cache in
        // bounded batches.
        try {
          await this.thumbnailClient.generateAll(thumbnailItems, 12)
        } catch (error) {
          console.error('Thumbnail generation failed after library scan', error)
        }
      }
    } else {
      if (typeof this.repository.reconcileCollections === 'function') {
        await this.repository.reconcileCollections(root.id, [])
      }
    }

    const approvedCount = descriptors.filter(
      (descriptor) =>
        descriptor.existing?.playbackOverride ?? descriptor.policyEnabled
    ).length
    console.log(
      `Scanned root ${root.id}: ${files.length} files, ${approvedCount} playback eligible, ${filesToProbe.length} probed`
    )

    return files.length
  }

  private getMediaRoots(): readonly MediaRootConfig[] {
    return this.mediaConfig.roots?.length
      ? this.mediaConfig.roots
      : [
          {
            id: 'media',
            directory: this.mediaConfig.directory,
            kind: 'other',
          },
        ]
  }

  private deriveIdentity(
    root: MediaRootConfig,
    relativePath: string
  ): CollectionIdentity | null {
    if (root.kind === 'tv' || root.kind === 'movie') {
      return deriveCollectionIdentity({
        libraryKind: root.kind,
        relativePath,
      })
    }
    // Interludes and station assets remain file-level inventory. TMDB and
    // collection parental decisions apply only to shows and movies.
    return null
  }

  private async emitScanEvent(type: LibraryScanEventType): Promise<void> {
    const event: LibraryScanEvent = { type, state: this.getScanState() }
    for (const listener of this.scanEventListeners) {
      try {
        await listener(event)
      } catch (error) {
        console.error(`Library scan event listener failed (${type})`, error)
      }
    }
  }

  private async recordScanFile(
    rootId: string,
    relativePath: string,
    indexed: boolean
  ): Promise<void> {
    this.scanState = {
      ...this.scanState,
      currentRoot: rootId,
      currentFile: relativePath,
      processedFiles: this.scanState.processedFiles + 1,
      indexedFiles: this.scanState.indexedFiles + (indexed ? 1 : 0),
      failedFiles: this.scanState.failedFiles + (indexed ? 0 : 1),
    }
    await this.emitScanEvent('library.scan.progress')
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private getRelativePath(root: MediaRootConfig, filePath: string): string {
    const value = relative(root.directory, filePath)
    if (!value || value.startsWith('..') || isAbsolute(value)) {
      throw new Error(`Media path escapes root ${root.id}: ${filePath}`)
    }
    return value.replace(/\\/g, '/')
  }

  private isWithinRoot(rootPath: string, candidatePath: string): boolean {
    const value = relative(rootPath, candidatePath)
    return value === '' || (!value.startsWith('..') && !isAbsolute(value))
  }

  private isRootReady(directory: string): boolean {
    if (!this.filesystem.exists(directory)) return false
    return this.filesystem.isReadableDirectory?.(directory) !== false
  }

  private emptyMetadata(): MediaMetadata {
    return {
      durationSeconds: 0,
      codec: null,
      width: null,
      height: null,
      fps: null,
      bitrateMbps: null,
    }
  }

  /**
   * Probe multiple files in parallel with concurrency limit
   * Returns full metadata including codec and resolution for HEVC detection
   */
  private async probeParallel(
    files: string[],
    concurrency: number,
    onResult?: (
      filePath: string,
      result: MediaMetadata | null
    ) => void | Promise<void>
  ): Promise<Array<MediaMetadata | null>> {
    const results: Array<MediaMetadata | null> = []

    for (let i = 0; i < files.length; i += concurrency) {
      const batch = files.slice(i, i + concurrency)
      const batchResults = await Promise.all(
        batch.map(async (filePath) => {
          try {
            return await this.mediaProbe.getMetadata(filePath)
          } catch (error) {
            console.error(`Failed to probe ${filePath}:`, error)
            return null
          }
        })
      )
      if (onResult) {
        for (let index = 0; index < batch.length; index++) {
          const filePath = batch[index]
          if (filePath) await onResult(filePath, batchResults[index] ?? null)
        }
      }
      results.push(...batchResults)
    }

    return results
  }

  /**
   * Generate warning for incompatible codecs (e.g., HEVC on Pi Zero 2 W)
   */
  private generateWarning(codec: string | null): string | null {
    if (!this.hardwareProfile) return null
    if (!codec) return null
    const lowerCodec = codec.toLowerCase()
    if (
      lowerCodec === 'hevc' ||
      lowerCodec === 'h265' ||
      lowerCodec === 'h.265'
    ) {
      return 'HEVC may not play smoothly on Raspberry Pi Zero 2 W'
    }
    return null
  }

  /**
   * Check compatibility against detected hardware profile.
   * Returns 'compatible', 'marginal', or 'incompatible'.
   */
  private checkCompatibility(metadata: MediaMetadata): Compatibility {
    const profile = this.hardwareProfile
    if (!profile) {
      // No hardware detection available — assume compatible
      return 'compatible'
    }

    const codec = metadata.codec?.toLowerCase() ?? ''
    const height = metadata.height ?? 0
    const fps = metadata.fps ?? 0
    const bitrate = metadata.bitrateMbps ?? 0

    // INCOMPATIBLE: Hard blocks - won't play
    const isHevc = codec === 'hevc' || codec === 'h265' || codec === 'h.265'

    // H.265/HEVC on devices without hardware decode
    if (isHevc && profile.codecs.h265 === 'none') {
      return 'incompatible'
    }

    // Resolution exceeds codec-specific device max
    const maxHeight = isHevc ? profile.maxHeightH265 : profile.maxHeightH264
    if (maxHeight === 0 || height > maxHeight) {
      return 'incompatible'
    }

    // MARGINAL: Soft limits - may stutter
    // 1080p60 on devices that only support 1080p30
    if (height >= 1080 && fps > profile.maxFps1080p) {
      return 'marginal'
    }

    // Bitrate exceeds recommended maximum
    if (bitrate > 0 && bitrate > profile.maxBitrateMbps) {
      return 'marginal'
    }

    return 'compatible'
  }

  /**
   * Detect media type from filename conventions.
   * Patterns:
   * - `_intro` or `_splash` → intro
   * - `_outro` → outro
   * - `_bedtime` or `_offair` → offair
   */
  private detectMediaType(filename: string, isInterlude: boolean): MediaType {
    const lower = filename.toLowerCase()
    if (lower.includes('_intro') || lower.includes('_splash')) return 'intro'
    if (lower.includes('_outro')) return 'outro'
    if (lower.includes('_bedtime') || lower.includes('_offair')) return 'offair'
    return isInterlude ? 'interlude' : 'video'
  }

  async refresh(): Promise<number> {
    return this.scanAll()
  }

  private detectDates(filename: string): {
    start: string | null
    end: string | null
  } {
    const lower = filename.toLowerCase()

    // Seasonal definitions (MM-DD)
    if (lower.includes('xmas') || lower.includes('christmas')) {
      return { start: '12-01', end: '12-26' }
    }
    if (lower.includes('halloween')) {
      return { start: '10-01', end: '10-31' }
    }
    if (lower.includes('easter')) {
      return { start: '03-20', end: '04-30' }
    }
    if (lower.includes('spring')) {
      return { start: '03-01', end: '05-31' }
    }
    if (lower.includes('summer')) {
      return { start: '06-01', end: '08-31' }
    }
    if (lower.includes('autumn') || lower.includes('fall')) {
      return { start: '09-01', end: '11-30' }
    }
    if (lower.includes('winter')) {
      return { start: '12-01', end: '02-28' }
    }

    return { start: null, end: null }
  }

  // --- File Watcher Integration ---

  private watcher: import('./FileWatcherService').FileWatcherService | null =
    null

  /**
   * Start watching media directories for changes
   */
  startWatching(): void {
    if (this.watcher) return // Already watching

    // Dynamically import to avoid circular dependency
    const { FileWatcherService } = require('./FileWatcherService')

    const watcher = new FileWatcherService(
      this.filesystem,
      [
        ...new Set([
          ...this.getMediaRoots().map((root) => root.directory),
          this.interludeConfig.directory,
        ]),
      ],
      this.mediaConfig.supportedExtensions
    )

    watcher.on('batch', (paths: string[]) => {
      this.indexBatch(paths).catch(console.error)
    })

    watcher.start()
    this.watcher = watcher
    console.log('MediaIndexer: File watcher started')
  }

  /**
   * Stop watching media directories
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.stop()
      this.watcher = null
      console.log('MediaIndexer: File watcher stopped')
    }
  }

  /**
   * Index a batch of changed file paths (from file watcher)
   */
  async indexBatch(paths: string[]): Promise<number> {
    if (paths.length === 0) return 0

    // A policy change can affect every episode in a collection, while a remove
    // must be reconciled only inside its own root. Reuse the authoritative
    // root-aware scan instead of maintaining a second, weaker indexing path.
    return this.scanAll()
  }
}
