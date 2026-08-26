import { access, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChannelWorkerFiles } from './ContinuousChannelWorkerManager'

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
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (isCurrent && !isCurrent()) return
      try {
        const entries = await readdir(directory, { withFileTypes: true })
        let freshSegmentCount = 0
        for (const entry of entries) {
          if (!entry.isFile() || !/^segment-\d{13}\.ts$/i.test(entry.name)) {
            continue
          }
          try {
            if (
              (await stat(join(directory, entry.name))).mtimeMs >=
              minimumModifiedAt
            ) {
              freshSegmentCount += 1
            }
          } catch {
            // FFmpeg may rotate the segment between readdir and stat.
          }
        }
        if (freshSegmentCount >= Math.max(1, minimumSegmentCount)) {
          return
        }
      } catch {
        // The output directory or first atomic segment may not exist yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('Channel encoder did not produce enough fresh segments in time')
  }
}
