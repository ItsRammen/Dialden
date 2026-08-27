import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  copyFile,
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import type { VirtualTunerFiles } from './VirtualTunerService'
import {
  spliceMpegTsSegment,
  type MpegTsTransportState,
} from './MpegTsTransportSplicer'

const SAFE_CHANNEL_ID = /^[a-zA-Z0-9._-]{1,100}$/
const SAFE_SESSION_ID = /^[a-f0-9-]{36}$/
const SAFE_SEGMENT_NAME = /^segment-\d{13}\.ts$/

/**
 * Preserves shared-worker segments with hard links when both outputs share a
 * filesystem. A byte copy is the portable fallback. Source unlink/rotation
 * therefore cannot make an already-advertised tuner segment disappear.
 */
export class BunVirtualTunerFiles implements VirtualTunerFiles {
  constructor(
    private readonly channelOutputRoot: string,
    private readonly tunerOutputRoot: string
  ) {}

  /** Sessions are process-local, so every UUID directory is orphaned on boot. */
  async cleanupOrphanSessions(): Promise<void> {
    await mkdir(this.tunerOutputRoot, { recursive: true })
    const entries = await readdir(this.tunerOutputRoot, { withFileTypes: true })
    await Promise.all(
      entries
        .filter(
          (entry) => entry.isDirectory() && SAFE_SESSION_ID.test(entry.name)
        )
        .map((entry) =>
          rm(join(this.tunerOutputRoot, entry.name), {
            recursive: true,
            force: true,
          })
        )
    )
  }

  async prepareSession(sessionId: string): Promise<void> {
    await mkdir(this.sessionDirectory(sessionId), { recursive: true })
  }

  readChannelPlaylist(channelId: string): Promise<string> {
    this.assertChannelId(channelId)
    return readFile(
      join(this.channelOutputRoot, channelId, 'live', 'index.m3u8'),
      'utf8'
    )
  }

  async preserveSegment(
    channelId: string,
    sourceName: string,
    sessionId: string,
    outputName: string
  ): Promise<void> {
    this.assertChannelId(channelId)
    this.assertSegmentName(sourceName)
    this.assertSegmentName(outputName)
    const source = join(this.channelOutputRoot, channelId, 'live', sourceName)
    const target = this.segmentPath(sessionId, outputName)
    const sourceStat = await stat(source)
    if (!sourceStat.isFile() || sourceStat.size <= 0) {
      throw new Error(`Source segment ${sourceName} is empty`)
    }
    try {
      await link(source, target)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        throw new Error(`Virtual tuner segment ${outputName} already exists`)
      }
      // Docker bind mounts, Windows development hosts, and separate Unraid
      // filesystems can reject hard links even though both paths are readable.
      if (
        code !== 'EXDEV' &&
        code !== 'EPERM' &&
        code !== 'EACCES' &&
        code !== 'ENOTSUP'
      ) {
        throw error
      }
      const temporary = join(
        this.sessionDirectory(sessionId),
        `.${outputName}.${randomUUID()}.tmp`
      )
      try {
        await copyFile(source, temporary, fsConstants.COPYFILE_EXCL)
        const copied = await stat(temporary)
        if (!copied.isFile() || copied.size !== sourceStat.size) {
          throw new Error(`Copied segment ${sourceName} is incomplete`)
        }
        // Only a fully copied file is ever renamed to the advertised URI.
        await rename(temporary, target)
      } catch (copyError) {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw copyError
      }
    }
  }

  async spliceSegment(
    channelId: string,
    sourceName: string,
    sessionId: string,
    outputName: string,
    durationSeconds: number,
    state: MpegTsTransportState
  ): Promise<MpegTsTransportState> {
    this.assertChannelId(channelId)
    this.assertSegmentName(sourceName)
    this.assertSegmentName(outputName)
    const source = join(this.channelOutputRoot, channelId, 'live', sourceName)
    const target = this.segmentPath(sessionId, outputName)
    const sourceStat = await stat(source)
    if (!sourceStat.isFile() || sourceStat.size <= 0) {
      throw new Error(`Source segment ${sourceName} is empty`)
    }
    const rewritten = spliceMpegTsSegment(
      await readFile(source),
      durationSeconds,
      state
    )
    const temporary = join(
      this.sessionDirectory(sessionId),
      `.${outputName}.${randomUUID()}.tmp`
    )
    try {
      await writeFile(temporary, rewritten.bytes, { flag: 'wx' })
      const saved = await stat(temporary)
      if (!saved.isFile() || saved.size !== rewritten.bytes.byteLength) {
        throw new Error(`Rewritten segment ${sourceName} is incomplete`)
      }
      await rename(temporary, target)
      return rewritten.state
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async removeSegment(sessionId: string, outputName: string): Promise<void> {
    try {
      await unlink(this.segmentPath(sessionId, outputName))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  async removeSession(sessionId: string): Promise<void> {
    // sessionDirectory validates the UUID and always resolves beneath the
    // explicitly configured tuner root before this scoped recursive removal.
    await rm(this.sessionDirectory(sessionId), { recursive: true, force: true })
  }

  segmentPath(sessionId: string, outputName: string): string {
    this.assertSegmentName(outputName)
    return join(this.sessionDirectory(sessionId), outputName)
  }

  async segmentExists(sessionId: string, outputName: string): Promise<boolean> {
    try {
      const value = await stat(this.segmentPath(sessionId, outputName))
      return value.isFile() && value.size > 0
    } catch {
      return false
    }
  }

  async sourcePresentationIsFresh(
    channelId: string,
    sourceNames: readonly string[],
    maximumAgeMs: number,
    minimumModifiedAtMs: number
  ): Promise<boolean> {
    this.assertChannelId(channelId)
    if (sourceNames.length < 2 || new Set(sourceNames).size !== sourceNames.length) {
      return false
    }
    const now = Date.now()
    const minimumFreshAt = Math.max(
      Number.isFinite(minimumModifiedAtMs) ? minimumModifiedAtMs : 0,
      now - Math.max(1_000, maximumAgeMs)
    )
    try {
      const liveDirectory = join(this.channelOutputRoot, channelId, 'live')
      const playlist = await stat(join(liveDirectory, 'index.m3u8'))
      if (!playlist.isFile() || playlist.size <= 0 || playlist.mtimeMs < minimumFreshAt) {
        return false
      }
      const segmentStats = await Promise.all(
        sourceNames.map(async (sourceName) => {
          this.assertSegmentName(sourceName)
          return stat(join(liveDirectory, sourceName))
        })
      )
      return segmentStats.every(
        (segment) =>
          segment.isFile() &&
          segment.size > 0 &&
          segment.mtimeMs >= minimumFreshAt
      )
    } catch {
      return false
    }
  }

  private sessionDirectory(sessionId: string): string {
    if (!SAFE_SESSION_ID.test(sessionId)) {
      throw new Error('Unsafe virtual tuner session path')
    }
    return join(this.tunerOutputRoot, sessionId)
  }

  private assertChannelId(channelId: string): void {
    if (!SAFE_CHANNEL_ID.test(channelId)) {
      throw new Error('Unsafe channel output path')
    }
  }

  private assertSegmentName(segmentName: string): void {
    if (!SAFE_SEGMENT_NAME.test(segmentName)) {
      throw new Error('Unsafe virtual tuner segment path')
    }
  }
}
