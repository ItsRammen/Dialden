/**
 * Media Indexer Service
 *
 * Scans media directories and updates the repository index.
 * Supports convention-based intro/outro detection via filename patterns.
 */

import type { IMediaRepository } from '../repositories/IMediaRepository'
import type { MediaItemInput } from '../repositories/IMediaRepository'
import { parseNickstoryAssetFilename } from './StationAssetService'
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

/*
 * Probing is ffprobe per file over the media mount, so a scan takes as many
 * batches as it can inside this budget and the next scan picks up the rest.
 * Raise TOASTTV_PROBE_BACKFILL_MS to converge a large library in fewer passes.
 */
const PROBE_BACKFILL_BATCH = 200
const PROBE_BACKFILL_BUDGET_MS = (() => {
  const raw = Number.parseInt(process.env.TOASTTV_PROBE_BACKFILL_MS ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
})()

const SCAN_PROGRESS_EVENT_INTERVAL_MS = 200

interface ScanEventClock {
  nowMs(): number
}

const MONOTONIC_SCAN_EVENT_CLOCK: ScanEventClock = {
  nowMs: () => performance.now(),
}

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
  private lastProgressEventAtMs: number | null = null

  constructor(
    private readonly mediaConfig: MediaConfig,
    private readonly interludeConfig: InterludeConfig,
    private readonly repository: IMediaRepository,
    private readonly filesystem: IFileSystem,
    private readonly mediaProbe: IMediaProbe,
    private readonly thumbnailClient?: IThumbnailClient,
    private readonly hardwareDetection?: IHardwareDetectionService,
    private readonly scanEventClock: ScanEventClock = MONOTONIC_SCAN_EVENT_CLOCK
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
    // Each authoritative pass gets one immediate discovery update. Subsequent
    // per-file updates are coalesced so a large library cannot flood SSE
    // clients with tens of thousands of DOM updates in a few seconds.
    this.lastProgressEventAtMs = null
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
    const interludeRoot = this.getInterludeRoot()
    // Startup already quarantines persisted rows before the initial scan.
    // Routine watcher/safety scans must keep a previously verified root live
    // while it is walked; taking every root offline here makes an otherwise
    // healthy schedule disagree with delivery for the duration of the scan.
    for (const listener of this.scanStartListeners) {
      try {
        await listener()
      } catch (error) {
        console.error('Scan-start refresh failed', error)
      }
    }
    for (const root of roots) {
      const relativePaths: string[] = []
      this.scanState = {
        ...this.scanState,
        currentRoot: root.id,
        currentFile: null,
      }
      if (!this.isRootReady(root.directory)) {
        await this.repository.setRootAvailable(root.id, false)
        console.warn(
          `Media root unavailable; preserving its index: ${root.id} (${root.directory})`
        )
        await this.emitScanEvent('library.scan.root.unavailable')
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
        await this.repository.setRootAvailable(root.id, false)
        console.error(
          `Media root scan failed; preserving its index: ${root.id}`,
          error
        )
        await this.emitScanEvent('library.scan.root.unavailable')
      }
    }

    this.scanState = {
      ...this.scanState,
      currentRoot: interludeRoot.id,
      currentFile: null,
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
        await this.repository.setRootAvailable(interludeRoot.id, false)
        console.error(
          'Interlude root scan failed; preserving its index',
          error
        )
        await this.emitScanEvent('library.scan.root.unavailable')
      }
    } else {
      await this.repository.setRootAvailable(interludeRoot.id, false)
      await this.emitScanEvent('library.scan.root.unavailable')
    }

    const total = videoCount + interludeCount
    console.log(
      `Indexed ${total} files (${videoCount} library, ${interludeCount} interludes), removed ${removed} stale`
    )
    await this.backfillMediaProbes()
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
   * Fills in rows indexed before audio, pixel-format or frame-rate probing
   * existed.
   *
   * This used to do a single batch of 80 per scan, which converges a handful of
   * stragglers but not a library: 21k unprobed rows would have needed 262
   * scans. It now keeps taking batches until the library is complete or the
   * time budget runs out, so a few scans finish the job while a single scan
   * still cannot run away.
   */
  private async backfillMediaProbes(): Promise<void> {
    if (typeof this.repository.listMissingAudioProbe !== 'function') return
    const deadline = Date.now() + PROBE_BACKFILL_BUDGET_MS
    let updatedTotal = 0
    let exhaustedBudget = false
    /* A file ffprobe cannot read is never written back, so it stays pending
       and the next query returns it again. Batching in a loop turned that into
       a spin: the same unreadable files, over and over, for the whole budget,
       and the scan never finished. Remembering what this run has already tried
       ends the pass instead. They are retried on the next scan, which is what
       a single batch per scan used to do. */
    const attempted = new Set<number>()

    /* The file loop has finished but the scan is not over: probing 21k rows
       takes minutes, and without this the progress bar sits frozen at
       "22547 / 22547" the whole time, which reads as a hang. Re-point the
       same counters at the probe so the bar keeps moving. */
    const pendingAtStart = await this.countMissingProbes()
    if (pendingAtStart > 0) {
      this.scanState = {
        ...this.scanState,
        discoveredFiles: pendingAtStart,
        processedFiles: 0,
        currentRoot: 'media probe',
        currentFile: 'Reading media details…',
      }
      await this.emitScanEvent('library.scan.progress')
    }

    while (Date.now() < deadline) {
      const batch = await this.backfillProbeBatch(attempted)
      if (batch === null) return
      if (batch === 0) break
      updatedTotal += batch
    }
    if (Date.now() >= deadline) exhaustedBudget = true

    if (updatedTotal > 0) {
      const remaining = await this.countMissingProbes()
      console.log(
        `Backfilled media probe for ${updatedTotal} files` +
          (remaining > 0
            ? `; ${remaining} still to go${exhaustedBudget ? ' (time budget reached, the next scan continues)' : ''}`
            : '; library complete')
      )
    }
  }

  /**
   * How many rows still lack one of the probed fields. A real count: this was
   * a capped list, which reported the cap as the remainder and so said "500
   * still to go" whether five hundred or twenty thousand were left.
   */
  async countMissingProbes(): Promise<number> {
    if (typeof this.repository.countMissingProbe !== 'function') return 0
    try {
      return await this.repository.countMissingProbe()
    } catch {
      return 0
    }
  }

  /** One batch. Returns rows updated, 0 when complete, null on a query error. */
  private async backfillProbeBatch(attempted: Set<number>): Promise<number | null> {
    let queried: Awaited<ReturnType<IMediaRepository['listMissingAudioProbe']>> | undefined
    try {
      queried = await this.repository.listMissingAudioProbe(PROBE_BACKFILL_BATCH)
    } catch (error) {
      console.error('Media probe backfill query failed', error)
      return null
    }
    if (!Array.isArray(queried) || queried.length === 0) return 0
    // Everything the query still returns has already been tried this run.
    const pending = queried.filter((item) => !attempted.has(item.id))
    if (pending.length === 0) return 0
    for (const item of pending) attempted.add(item.id)
    const results = await this.probeParallel(
      pending.map((item) => item.path),
      4
    )
    let updated = 0
    for (let index = 0; index < pending.length; index++) {
      const item = pending[index]
      const metadata = results[index]
      if (!item || !metadata) continue
      if (typeof metadata.hasAudio === 'boolean') {
        await this.repository.updateAudioProbe(
          item.id,
          metadata.hasAudio,
          metadata.audioCodec
        )
      }
      /* The same probe already carries the pixel format and frame rate. They
         were being discarded, so rows selected for a missing pixel format were
         re-probed on every scan without ever converging. */
      if (typeof this.repository.updateVideoProbe === 'function') {
        await this.repository.updateVideoProbe(
          item.id,
          metadata.pixelFormat ?? null,
          typeof metadata.fps === 'number' && Number.isFinite(metadata.fps)
            ? metadata.fps
            : null
        )
      }
      updated += 1
      /* Throttled to 200ms inside emitScanEvent, so a batch of 200 files
         produces a handful of events rather than two hundred. */
      this.scanState = {
        ...this.scanState,
        processedFiles: this.scanState.processedFiles + 1,
        currentFile: getFilename(item.path),
      }
      await this.emitScanEvent('library.scan.progress')
    }
    return updated
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
        hasAudio: item.hasAudio ?? null,
        audioCodec: item.audioCodec ?? null,
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
      isInterlude ? [...this.mediaConfig.supportedExtensions, '.m4v'] : this.mediaConfig.supportedExtensions,
      excludePaths
    ).filter((file) => !isInterlude || !this.getRelativePath(root, file).split('/').some(
      (part) => part.startsWith('.') || part.toLowerCase() === 'rejected_downloads'
    ))
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
      const policyEnabled = collection?.effectiveDecision === 'allow' ||
        (isInterlude && parseNickstoryAssetFilename(getFilename(filePath)) !== null)
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
        hasAudio: descriptor.existing?.hasAudio ?? null,
        audioCodec: descriptor.existing?.audioCodec ?? null,
        pixelFormat: descriptor.existing?.pixelFormat ?? null,
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
        hasAudio: metadata.hasAudio,
        audioCodec: metadata.audioCodec,
        pixelFormat: metadata.pixelFormat ?? null,
        fps: typeof metadata.fps === 'number' && Number.isFinite(metadata.fps)
          ? metadata.fps
          : null,
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

      // A rescan can discover episode coordinates that an older parser did
      // not understand (or add another episode to an already matched show).
      // Queue only those existing TMDB identities for refresh; the detached
      // metadata worker will fetch the relevant season and attach canonical
      // episode names after scan completion.
      const episodeRefreshes = new Map<number, (typeof descriptors)[number]>()
      for (const descriptor of descriptors) {
        const { collection, identity, existing } = descriptor
        if (
          root.kind !== 'tv' ||
          !collection?.metadataExternalId ||
          collection.metadataStatus === 'pending' ||
          identity?.seasonNumber == null ||
          identity.episodeNumber == null
        ) {
          continue
        }
        if (
          !existing ||
          existing.collectionId !== collection.id ||
          existing.seasonNumber !== identity.seasonNumber ||
          existing.episodeNumber !== identity.episodeNumber
        ) {
          episodeRefreshes.set(collection.id, descriptor)
        }
      }
      for (const { collection } of episodeRefreshes.values()) {
        if (!collection?.metadataExternalId) continue
        await this.repository.updateCollectionMetadata(collection.id, {
          provider: collection.metadataProvider ?? 'tmdb',
          externalId: collection.metadataExternalId,
          status: 'pending',
          error: null,
        })
      }

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

  /** Use the same root IDs and directories for indexing and channel playback. */
  getPlaybackRoots(): readonly MediaRootConfig[] {
    return [...this.getMediaRoots(), this.getInterludeRoot()]
  }

  private getInterludeRoot(): MediaRootConfig {
    return {
      id: 'interludes',
      directory: this.interludeConfig.directory,
      kind: 'other',
    }
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
    if (type === 'library.scan.progress') {
      const nowMs = this.scanEventClock.nowMs()
      if (
        this.lastProgressEventAtMs !== null &&
        nowMs - this.lastProgressEventAtMs < SCAN_PROGRESS_EVENT_INTERVAL_MS
      ) {
        return
      }
      this.lastProgressEventAtMs = nowMs
    }

    // Started, root availability, completed, and failed events are never
    // throttled. They carry the current full state, so listeners always see
    // the affected root and final counters even when progress was coalesced.
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
      hasAudio: null,
      audioCodec: null,
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
            /* One line. Passing the error object prints the bundle's source
               around the throw site, which for a handful of unreadable files
               buries every other log line on the box. */
            console.error(
              `Failed to probe ${filePath}: ${
                error instanceof Error ? error.message : String(error)
              }`
            )
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
  private watcherStartedAt: string | null = null
  private lastWatcherEventAt: string | null = null

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
      this.lastWatcherEventAt = new Date().toISOString()
      this.indexBatch(paths).catch(console.error)
    })

    watcher.start()
    this.watcher = watcher
    this.watcherStartedAt = new Date().toISOString()
    console.log('MediaIndexer: File watcher started')
  }

  /**
   * Stop watching media directories
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.stop()
      this.watcher = null
      this.watcherStartedAt = null
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

  getWatcherState(): {
    active: boolean
    startedAt: string | null
    lastEventAt: string | null
  } {
    return {
      active: this.watcher !== null,
      startedAt: this.watcherStartedAt,
      lastEventAt: this.lastWatcherEventAt,
    }
  }
}
