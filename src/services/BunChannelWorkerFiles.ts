import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
} from 'node:fs/promises'
import { join } from 'node:path'
import type { ChannelWorkerFiles } from './ContinuousChannelWorkerManager'
import {
  localChannelSegmentName,
  parseHlsMediaPlaylist,
} from './HlsPlaylistReadiness'

/** Filesystem adapter for channel output. FFmpeg handles active-window deletes. */
export class BunChannelWorkerFiles implements ChannelWorkerFiles {
  constructor(private readonly orphanMaximumAgeMs = 10 * 60_000) {}

  async prepareOutput(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true })
  }

  async sourceExists(path: string): Promise<boolean> {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }

  async cleanupOutput(directory: string): Promise<void> {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    const cutoff = Date.now() - this.orphanMaximumAgeMs
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && (/\.tmp$/i.test(entry.name) || /^segment-\d+\.ts$/i.test(entry.name)))
        .map(async (entry) => {
          const path = join(directory, entry.name)
          try {
            if ((await stat(path)).mtimeMs < cutoff) await unlink(path)
          } catch {
            // Concurrent FFmpeg deletion is expected.
          }
        })
    )
  }

  async waitForFreshSegment(
    directory: string,
    minimumModifiedAt: number,
    isCurrent?: () => boolean,
    minimumSegmentCount = 2
  ): Promise<void> {
    const playlistPath = join(directory, 'index.m3u8')
    const requiredSegmentCount = Math.max(1, minimumSegmentCount)
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (isCurrent && !isCurrent()) return
      try {
        const playlistInfo = await stat(playlistPath)
        if (
          playlistInfo.size <= 0 ||
          playlistInfo.mtimeMs < minimumModifiedAt
        ) {
          throw new Error('Playlist is not fresh yet')
        }
        const playlist = parseHlsMediaPlaylist(
          await readFile(playlistPath, 'utf8')
        )
        if (!playlist.wellFormed) {
          throw new Error('Playlist rewrite is incomplete')
        }
        let freshSegmentCount = 0
        const seen = new Set<string>()
        for (const uri of playlist.segmentUris) {
          const name = localChannelSegmentName(uri)
          if (!name || seen.has(name)) continue
          seen.add(name)
          try {
            const segmentInfo = await stat(join(directory, name))
            if (
              segmentInfo.isFile() &&
              segmentInfo.size > 0 &&
              segmentInfo.mtimeMs >= minimumModifiedAt
            ) {
              freshSegmentCount += 1
            }
          } catch {
            // FFmpeg may rotate a referenced segment between read and stat.
          }
        }
        if (freshSegmentCount >= requiredSegmentCount) {
          return
        }
      } catch {
        // The playlist, its complete rewrite, or referenced segments may not
        // exist yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(
      'Channel encoder did not publish a complete playlist with enough fresh segments in time'
    )
  }
}
