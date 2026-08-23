/**
 * Filesystem and Media Probe Clients
 *
 * Thin wrappers around OS/CLI tools to enable mocking in tests.
 */

import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  statSync,
  watch as fsWatch,
} from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  FileWatcher,
  IFileSystem,
  IMediaProbe,
  MediaMetadata,
} from '../types'

export class FilesystemClient implements IFileSystem {
  listFiles(
    directory: string,
    extensions: readonly string[],
    excludePaths: string[] = []
  ): string[] {
    const files: string[] = []

    const absExcludes = excludePaths.map((path) => resolve(path))
    const supported = new Set(extensions.map((extension) => extension.toLowerCase()))
    const pending = [resolve(directory)]

    while (pending.length > 0) {
      const current = pending.pop()
      if (!current) continue
      // readdirSync deliberately propagates a traversal failure. The indexer
      // will preserve this root instead of mistaking an incomplete NAS walk
      // for deleted media.
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const file = join(current, entry.name)
        const excluded = absExcludes.some((excludedPath) => {
          const child = relative(excludedPath, file)
          return (
            child === '' || (!child.startsWith('..') && !isAbsolute(child))
          )
        })
        if (excluded) continue
        if (entry.isDirectory()) {
          pending.push(file)
        } else if (
          entry.isFile() &&
          supported.has(extname(entry.name).toLowerCase())
        ) {
          files.push(file)
        }
      }
    }

    return files.sort()
  }

  exists(path: string): boolean {
    return existsSync(path)
  }

  isReadableDirectory(path: string): boolean {
    try {
      if (!statSync(path).isDirectory()) return false
      accessSync(path, constants.R_OK)
      // Force one real enumeration. Glob implementations can otherwise turn
      // permission/stale-mount failures into an ambiguous empty result.
      readdirSync(path, { withFileTypes: true })
      return true
    } catch {
      return false
    }
  }

  getMtime(path: string): number | null {
    try {
      const stats = statSync(path)
      return stats.mtimeMs
    } catch {
      return null
    }
  }

  /**
   * Watch a directory for file changes (stateless wrapper for fs.watch)
   */
  watch(
    directory: string,
    callback: (event: 'add' | 'change' | 'remove', path: string) => void
  ): FileWatcher {
    const watcher = fsWatch(
      directory,
      { recursive: true },
      (eventType, filename) => {
        if (!filename) return
        const fullPath = join(directory, filename)
        // fs.watch only knows 'rename' (add/delete) and 'change'
        // We simplify: 'rename' → 'add' (caller checks existence), 'change' → 'change'
        callback(eventType === 'rename' ? 'add' : 'change', fullPath)
      }
    )

    return {
      close: () => watcher.close(),
    }
  }
}

export class FFProbeClient implements IMediaProbe {
  async getDuration(filePath: string): Promise<number> {
    const metadata = await this.getMetadata(filePath)
    return metadata.durationSeconds
  }

  async getMetadata(filePath: string): Promise<MediaMetadata> {
    const proc = Bun.spawn([
      'ffprobe',
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'format=duration:stream=codec_name,width,height',
      '-of',
      'json',
      filePath,
    ])

    const output = await new Response(proc.stdout).text()
    const exitCode = await proc.exited

    if (exitCode !== 0) {
      throw new Error(`ffprobe failed for ${filePath}`)
    }

    try {
      const data = JSON.parse(output) as {
        format?: { duration?: string; bit_rate?: string }
        streams?: Array<{
          codec_name?: string
          width?: number
          height?: number
          avg_frame_rate?: string
        }>
      }

      const duration = Math.floor(parseFloat(data.format?.duration ?? '0') || 0)
      const stream = data.streams?.[0]

      // Parse frame rate (e.g., "30000/1001" or "30/1")
      let fps: number | null = null
      if (stream?.avg_frame_rate) {
        const parts = stream.avg_frame_rate.split('/')
        const num = parseFloat(parts[0] ?? '0')
        const den = parseFloat(parts[1] ?? '1')
        if (den > 0) {
          fps = Math.round(num / den)
        }
      }

      // Parse bitrate in Mbps
      let bitrateMbps: number | null = null
      if (data.format?.bit_rate) {
        const bps = parseInt(data.format.bit_rate, 10)
        if (!Number.isNaN(bps)) {
          bitrateMbps = Math.round(bps / 1_000_000)
        }
      }

      return {
        durationSeconds: duration,
        codec: stream?.codec_name ?? null,
        width: stream?.width ?? null,
        height: stream?.height ?? null,
        fps,
        bitrateMbps,
      }
    } catch {
      return {
        durationSeconds: 0,
        codec: null,
        width: null,
        height: null,
        fps: null,
        bitrateMbps: null,
      }
    }
  }

  static async checkAvailable(): Promise<boolean> {
    try {
      const proc = Bun.spawn(['ffprobe', '-version'])
      await proc.exited
      return true
    } catch {
      return false
    }
  }
}

export function getFilename(path: string): string {
  return basename(path)
}

export function getExtension(path: string): string {
  return extname(path).toLowerCase()
}
