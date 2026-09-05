/**
 * Media Service
 *
 * Handles all media CRUD operations, indexing, and thumbnails.
 * Delegates data access to IMediaRepository.
 */

import type { IMediaRepository } from '../repositories/IMediaRepository'
import type { MediaIndexer } from './MediaIndexer'
import type { ConfigService } from './ConfigService'
import type { ThumbnailClient } from '../clients/ThumbnailClient'
import type {
  MediaFileListFilter,
  MediaItem,
  MediaType,
} from '../types'
import { getDataPath } from '../config/paths'

export interface MediaFilePageRequest {
  readonly filter: MediaFileListFilter
  readonly search: string
  readonly page: number
  readonly pageSize: number
  readonly prioritizedIds?: readonly number[]
}

export interface MediaFilePageResult {
  readonly items: readonly MediaItem[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
}

export class MediaService {
  constructor(
    private readonly repository: IMediaRepository,
    private readonly indexer: MediaIndexer,
    private readonly config: ConfigService,
    private readonly thumbnails: ThumbnailClient
  ) {}

  /**
   * Get media directory path.
   */
  getMediaDirectory(): string {
    return this.config.getMediaDirectory()
  }

  /**
   * Get all media items, sorted by Intro -> Outro -> Filename
   */
  async getAll(): Promise<MediaItem[]> {
    const media = await this.repository.getAll()
    const config = await this.config.get()
    
    const introId = config.session.introVideoId
    const outroId = config.session.outroVideoId

    return media.sort((a, b) => {
      // 1. Intro always first
      if (a.id === introId) return -1
      if (b.id === introId) return 1
      
      // 2. Outro always second
      if (a.id === outroId) return -1
      if (b.id === outroId) return 1
      
      // 3. Alphabetical
      return a.filename.localeCompare(b.filename)
    })
  }

  /**
   * Get media item by ID
   */
  async getById(id: number): Promise<MediaItem | null> {
    return this.repository.getById(id)
  }

  async getByPath(path: string): Promise<MediaItem | null> {
    return this.repository.getByPath(path)
  }

  /**
   * Get video count (excludes interludes)
   */
  async getVideoCount(): Promise<number> {
    const videos = await this.repository.getAllVideos()
    return videos.length
  }

  /**
   * Delete a media item
   */
  async delete(id: number): Promise<void> {
    await this.repository.deleteMedia(id)
  }

  /**
   * Toggle interlude status
   */
  async toggleInterlude(id: number, isInterlude: boolean): Promise<void> {
    await this.repository.toggleInterlude(id, isInterlude)
  }

  /**
   * Update media type. Intro/outro are singletons.
   */
  async updateType(id: number, mediaType: MediaType): Promise<void> {
    // Intro and outro are singletons - reset any existing one first
    if (mediaType === 'intro' || mediaType === 'outro') {
      await this.repository.resetMediaType(mediaType)
      // Clear dates for intro/outro as they cannot be scheduled
      await this.repository.updateDates(id, null, null)
    }
    await this.repository.updateMediaType(id, mediaType)
  }

  /**
   * Update scheduling dates for an interlude
   */
  async updateDates(
    id: number,
    dateStart: string | null,
    dateEnd: string | null
  ): Promise<void> {
    await this.repository.updateDates(id, dateStart, dateEnd)
  }

  /**
   * Get one bounded page for the file-level administration view. Filtering,
   * counting and pagination happen in SQLite rather than loading the catalog.
   */
  async getPage(options: MediaFilePageRequest): Promise<MediaFilePageResult> {
    const pageSize = Number.isSafeInteger(options.pageSize)
      ? Math.max(1, Math.min(250, options.pageSize))
      : 100
    const requestedPage = Number.isSafeInteger(options.page)
      ? Math.max(1, options.page)
      : 1
    const query = (page: number) =>
      this.repository.getMediaPage({
        filter: options.filter,
        search: options.search,
        limit: pageSize,
        offset: (page - 1) * pageSize,
        prioritizedIds: options.prioritizedIds,
      })

    let result = await query(requestedPage)
    const lastPage = Math.max(1, Math.ceil(result.total / pageSize))
    const page = Math.min(requestedPage, lastPage)
    if (page !== requestedPage) result = await query(page)

    return { ...result, page, pageSize }
  }

  async updatePlaybackOverride(
    id: number,
    enabled: boolean | null
  ): Promise<void> {
    await this.repository.updatePlaybackOverride(id, enabled)
  }

  /**
   * Rescan media directories
   */
  async rescan(): Promise<number> {
    return this.indexer.scanAll()
  }

  /**
   * Generate thumbnails for all media
   */
  async generateThumbnails(): Promise<void> {
    const media = await this.getAll()
    await this.generateThumbnailsFor(media)
  }

  /** Generate only the thumbnails needed by the currently visible page. */
  async generateThumbnailsFor(media: readonly MediaItem[]): Promise<void> {
    await this.thumbnails.generateAll(
      media
        .filter((item) => item.playbackEnabled === true)
        .map((m) => ({ id: m.id, path: m.path })),
      48
    )
  }

  /**
   * Upload a logo image file
   * @returns The path to the saved logo
   */
  async uploadLogo(file: File): Promise<string> {
    const buffer = await file.arrayBuffer()
    const logoPath = getDataPath('logo.png')
    await Bun.write(logoPath, buffer)
    return logoPath
  }
}
