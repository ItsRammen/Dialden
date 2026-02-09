/**
 * Media Indexer Service
 *
 * Scans media directories and updates the repository index.
 * Supports convention-based intro/outro detection via filename patterns.
 */

import type { IMediaRepository } from '../repositories/IMediaRepository'
import { getFilename } from '../clients/FilesystemClient'
import type {
  IFileSystem,
  IMediaProbe,
  IThumbnailClient,
  InterludeConfig,
  MediaConfig,
  MediaMetadata,
  MediaType,
} from '../types'

export class MediaIndexer {
  private scanInProgress = false

  constructor(
    private readonly mediaConfig: MediaConfig,
    private readonly interludeConfig: InterludeConfig,
    private readonly repository: IMediaRepository,
    private readonly filesystem: IFileSystem,
    private readonly mediaProbe: IMediaProbe,
    private readonly thumbnailClient?: IThumbnailClient
  ) {}

  async scanAll(): Promise<number> {
    if (this.scanInProgress) {
      console.log('Scan already in progress, skipping')
      return 0
    }
    this.scanInProgress = true

    try {
      const videoPaths: string[] = []
      const interludePaths: string[] = []

      // Scan videos (exclude interlude directory to prevent double counting)
      const videoCount = await this.scanDirectory(
        this.mediaConfig.directory,
        false,
        videoPaths,
        [this.interludeConfig.directory]
      )

      // Scan interludes
      const interludeCount = await this.scanDirectory(
        this.interludeConfig.directory,
        true,
        interludePaths
      )

      // Remove DB entries for files that no longer exist
      const allValidPaths = [...videoPaths, ...interludePaths]
      const removed = await this.repository.removeNotInPaths(allValidPaths)

      const total = videoCount + interludeCount
      console.log(
        `Indexed ${total} files (${videoCount} videos, ${interludeCount} interludes), removed ${removed} stale`
      )
      return total
    } finally {
      this.scanInProgress = false
    }
  }

  private async scanDirectory(
    directory: string,
    isInterlude: boolean,
    outPaths: string[],
    excludePaths: string[] = []
  ): Promise<number> {
    if (!this.filesystem.exists(directory)) {
      console.warn(`Directory not found: ${directory}`)
      return 0
    }

    const files = this.filesystem.listFiles(
      directory,
      this.mediaConfig.supportedExtensions,
      excludePaths
    )

    if (files.length === 0) return 0

    // 1. Batch lookup existing entries
    const existingMap = await this.repository.getByPaths(files)

    // 2. Separate new files from existing ones, and check mtime for delta scanning
    const newFiles: string[] = []
    const existingFiles: string[] = []
    const changedFiles: string[] = [] // Files with changed mtime

    for (const filePath of files) {
      const existing = existingMap.get(filePath)
      if (existing) {
        // Check if file has changed (mtime comparison)
        const currentMtime = this.filesystem.getMtime(filePath)
        if (existing.mtime !== null && currentMtime === existing.mtime) {
          // File unchanged, skip re-probing
          existingFiles.push(filePath)
        } else {
          // File changed or mtime was never recorded
          changedFiles.push(filePath)
        }
      } else {
        newFiles.push(filePath)
      }
    }

    // 3. Parallel probe new + changed files with concurrency limit
    const CONCURRENCY = 4 // Pi Zero 2 W has 4 cores
    const filesToProbe = [...newFiles, ...changedFiles]
    const metadataResults = await this.probeParallel(filesToProbe, CONCURRENCY)

    // 4. Build items for batch upsert
    const itemsToUpsert: Array<{
      path: string
      filename: string
      durationSeconds: number
      isInterlude: boolean
      mediaType: MediaType
      dateStart: string | null
      dateEnd: string | null
      codec: string | null
      width: number | null
      height: number | null
      warning: string | null
      mtime: number | null
    }> = []

    // Add new + changed files
    for (let i = 0; i < filesToProbe.length; i++) {
      const filePath = filesToProbe[i]
      if (!filePath) continue // TypeScript guard
      const filename = getFilename(filePath)
      const metadata = metadataResults[i] ?? {
        durationSeconds: 0,
        codec: null,
        width: null,
        height: null,
      }
      const mediaType = this.detectMediaType(filename, isInterlude)
      const { start: dateStart, end: dateEnd } = this.detectDates(filename)
      const warning = this.generateWarning(metadata.codec)
      const mtime = this.filesystem.getMtime(filePath)

      itemsToUpsert.push({
        path: filePath,
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
        mtime,
      })

      console.log(
        `Indexed: ${filename} (${metadata.durationSeconds}s) [${mediaType}]`
      )
    }

    // Add unchanged existing files to outPaths only (no re-upsert needed)
    for (const filePath of existingFiles) {
      outPaths.push(filePath)
    }

    // 5. Batch upsert new files
    if (itemsToUpsert.length > 0) {
      await this.repository.upsertBatch(itemsToUpsert)

      // 6. Generate thumbnails for newly indexed files (Phase 5)
      if (this.thumbnailClient) {
        const paths = itemsToUpsert.map((item) => item.path)
        const insertedMap = await this.repository.getByPaths(paths)
        const thumbnailItems = Array.from(insertedMap.values()).map((item) => ({
          id: item.id,
          path: item.path,
        }))
        await this.thumbnailClient.generateAll(thumbnailItems)
      }
    }

    // Add new file paths to outPaths
    outPaths.push(...filesToProbe)

    return files.length
  }

  /**
   * Probe multiple files in parallel with concurrency limit
   * Returns full metadata including codec and resolution for HEVC detection
   */
  private async probeParallel(
    files: string[],
    concurrency: number
  ): Promise<MediaMetadata[]> {
    const results: MediaMetadata[] = []

    for (let i = 0; i < files.length; i += concurrency) {
      const batch = files.slice(i, i + concurrency)
      const batchResults = await Promise.all(
        batch.map(async (filePath) => {
          try {
            return await this.mediaProbe.getMetadata(filePath)
          } catch (error) {
            console.error(`Failed to probe ${filePath}:`, error)
            return {
              durationSeconds: 0,
              codec: null,
              width: null,
              height: null,
            }
          }
        })
      )
      results.push(...batchResults)
    }

    return results
  }

  /**
   * Generate warning for incompatible codecs (e.g., HEVC on Pi Zero 2 W)
   */
  private generateWarning(codec: string | null): string | null {
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
      [this.mediaConfig.directory, this.interludeConfig.directory],
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

    // Filter to existing files only (removes may report deleted files)
    const existingPaths = paths.filter((p) => this.filesystem.exists(p))
    const deletedPaths = paths.filter((p) => !this.filesystem.exists(p))

    // Remove deleted files from DB
    if (deletedPaths.length > 0) {
      const removed = await this.repository.removeByPaths(deletedPaths)
      console.log(`MediaIndexer: Removed ${removed} deleted files`)
    }

    if (existingPaths.length === 0) return 0

    // Check which files are new vs existing
    const existingMap = await this.repository.getByPaths(existingPaths)
    const newPaths = existingPaths.filter((p) => !existingMap.has(p))

    if (newPaths.length === 0) return 0

    // Probe new files
    const metadataResults = await this.probeParallel(newPaths, 4)

    const items: Array<{
      path: string
      filename: string
      durationSeconds: number
      isInterlude: boolean
      mediaType: MediaType
      dateStart: string | null
      dateEnd: string | null
      codec: string | null
      width: number | null
      height: number | null
      warning: string | null
      mtime: number | null
    }> = []

    for (let i = 0; i < newPaths.length; i++) {
      const filePath = newPaths[i]
      if (!filePath) continue
      const filename = getFilename(filePath)
      const metadata = metadataResults[i] ?? {
        durationSeconds: 0,
        codec: null,
        width: null,
        height: null,
      }
      const isInterlude = filePath.startsWith(this.interludeConfig.directory)
      const mediaType = this.detectMediaType(filename, isInterlude)
      const { start: dateStart, end: dateEnd } = this.detectDates(filename)
      const warning = this.generateWarning(metadata.codec)
      const mtime = this.filesystem.getMtime(filePath)

      items.push({
        path: filePath,
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
        mtime,
      })

      console.log(
        `Indexed (watch): ${filename} (${metadata.durationSeconds}s) [${mediaType}]`
      )
    }

    if (items.length > 0) {
      await this.repository.upsertBatch(items)

      // Generate thumbnails for newly indexed files (Phase 5)
      if (this.thumbnailClient) {
        const paths = items.map((item) => item.path)
        const insertedMap = await this.repository.getByPaths(paths)
        const thumbnailItems = Array.from(insertedMap.values()).map((item) => ({
          id: item.id,
          path: item.path,
        }))
        await this.thumbnailClient.generateAll(thumbnailItems)
      }
    }

    return items.length
  }
}
