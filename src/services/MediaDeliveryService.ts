import { realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import type { IMediaRepository } from '../repositories/IMediaRepository'
import type { MediaItem, MediaRootConfig } from '../types'

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

export interface ResolvedMediaFile {
  readonly path: string
  readonly size: number
  readonly mimeType: string
  readonly lastModified: Date
}

/**
 * Resolves a database media ID back through its configured root and stable
 * relative locator. Absolute database paths are intentionally never served.
 */
export class MediaDeliveryService {
  private readonly rootsById: ReadonlyMap<string, MediaRootConfig>

  constructor(
    private readonly repository: IMediaRepository,
    roots: readonly MediaRootConfig[]
  ) {
    this.rootsById = new Map(roots.map((root) => [root.id, root]))
  }

  async resolve(mediaId: number): Promise<ResolvedMediaFile | null> {
    const item = await this.repository.getById(mediaId)
    if (!item || !this.isPlaybackEligible(item)) return null

    const root = item.rootId ? this.rootsById.get(item.rootId) : undefined
    const relativePath = item.relativePath
    if (!root || !relativePath || !this.isSafeRelativePath(relativePath)) {
      return null
    }

    try {
      const configuredRoot = resolve(root.directory)
      const rootPath = realpathSync(configuredRoot)
      const candidatePath = resolve(rootPath, ...relativePath.split('/'))
      if (!this.isWithin(rootPath, candidatePath)) return null

      // Re-resolve immediately before delivery so a file or parent directory
      // replaced by a symlink after indexing cannot escape the media mount.
      // The configured Docker mount is read-only; host-side writers remain a
      // deployment trust boundary and should not mutate files during playback.
      const realCandidate = realpathSync(candidatePath)
      if (!this.isWithin(rootPath, realCandidate)) return null

      const stat = statSync(realCandidate)
      if (!stat.isFile() || stat.size <= 0) return null

      const mimeType = MIME_TYPES[extname(realCandidate).toLowerCase()]
      if (!mimeType) return null

      return {
        path: realCandidate,
        size: stat.size,
        mimeType,
        lastModified: stat.mtime,
      }
    } catch {
      // Missing/unreadable roots and stale catalog rows are normal on NAS
      // mounts. Fail closed without leaking an absolute host path.
      return null
    }
  }

  private isPlaybackEligible(item: MediaItem): boolean {
    return (
      item.mediaType === 'video' &&
      !item.isInterlude &&
      item.durationSeconds > 0 &&
      item.rootAvailable === true &&
      item.playbackEnabled === true
    )
  }

  private isSafeRelativePath(value: string): boolean {
    if (
      value.includes('\0') ||
      value.includes('\\') ||
      isAbsolute(value) ||
      /^[a-z]:[\\/]/i.test(value)
    ) {
      return false
    }
    const segments = value.split('/')
    return segments.every(
      (segment) => segment.length > 0 && segment !== '.' && segment !== '..'
    )
  }

  private isWithin(rootPath: string, candidatePath: string): boolean {
    const child = relative(rootPath, candidatePath)
    return child !== '' && !child.startsWith('..') && !isAbsolute(child)
  }
}
