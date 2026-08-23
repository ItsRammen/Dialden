/**
 * Thumbnail Client
 *
 * Extracts video thumbnails using ffmpeg.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { spawn } from 'bun'
import { getDataPath } from '../config/paths'

const THUMBNAIL_WIDTH = 320
const THUMBNAIL_TIME = '00:00:05' // 5 seconds into video

export class ThumbnailClient {
  constructor(private readonly thumbnailDirectory = getDataPath('thumbnails')) {
    // Ensure thumbnail directory exists
    if (!existsSync(this.thumbnailDirectory)) {
      mkdirSync(this.thumbnailDirectory, { recursive: true })
    }
  }

  /**
   * Get thumbnail path for a video (generates if missing)
   */
  async getThumbnail(
    videoPath: string,
    videoId: number
  ): Promise<string | null> {
    const thumbPath = this.getThumbnailPath(videoId)

    if (existsSync(thumbPath)) {
      return thumbPath
    }

    // Generate thumbnail
    const success = await this.generateThumbnail(videoPath, thumbPath)
    return success ? thumbPath : null
  }

  /**
   * Get web-accessible thumbnail URL
   */
  getThumbnailUrl(videoId: number): string {
    return `/thumbnails/${videoId}.jpg`
  }

  private getThumbnailPath(videoId: number): string {
    return join(this.thumbnailDirectory, `${videoId}.jpg`)
  }

  private async generateThumbnail(
    videoPath: string,
    outputPath: string
  ): Promise<boolean> {
    try {
      const proc = spawn(
        [
          'ffmpeg',
          '-y',
          '-ss',
          THUMBNAIL_TIME,
          '-i',
          videoPath,
          '-vframes',
          '1',
          '-vf',
          `scale=${THUMBNAIL_WIDTH}:-1`,
          '-q:v',
          '5',
          outputPath,
        ],
        {
          stdout: 'ignore',
          stderr: 'ignore',
        }
      )

      const exitCode = await proc.exited
      return exitCode === 0
    } catch {
      console.log(`Failed to generate thumbnail for ${basename(videoPath)}`)
      return false
    }
  }

  /**
   * Generate thumbnails for multiple videos
   */
  async generateAll(
    items: ReadonlyArray<{ id: number; path: string }>,
    maxItems = Number.POSITIVE_INFINITY
  ): Promise<void> {
    // First, count how many are missing
    const missing = items
      .filter((item) => !existsSync(this.getThumbnailPath(item.id)))
      .slice(0, maxItems)

    if (missing.length === 0) return // Nothing to do, stay quiet

    console.log(`Generating ${missing.length} missing thumbnails...`)

    let generated = 0
    for (const item of missing) {
      const thumbPath = this.getThumbnailPath(item.id)
      const success = await this.generateThumbnail(item.path, thumbPath)
      if (success) generated++
    }

    console.log(`Generated ${generated} thumbnails`)
  }
}

export const thumbnailClient = new ThumbnailClient()
