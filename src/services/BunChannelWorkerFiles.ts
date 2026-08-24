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
}
