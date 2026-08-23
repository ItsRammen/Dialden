/**
 * Update Service
 *
 * Owns update state: version checking, caching, and triggering updates.
 * Streams update output to a log file for post-restart retrieval.
 */

import { spawn } from 'bun'
import {
  existsSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
} from 'node:fs'
import type { IUpdateClient } from '../clients/UpdateClient'
import { logger } from '../utils/logger'
import packageJson from '../../package.json'
import { getDataPath } from '../config/paths'

const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour
const UPDATE_SCRIPT = '/opt/toasttv/scripts/update.sh'

export interface UpdateServiceOptions {
  enabled?: boolean
  updateLogPath?: string
}

/** Returns true if `remote` is a strictly newer semver than `current`. */
function isNewerVersion(remote: string, current: string): boolean {
  const r = remote.split('.').map(Number)
  const c = current.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const rv = r[i] ?? 0
    const cv = c[i] ?? 0
    if (rv > cv) return true
    if (rv < cv) return false
  }
  return false
}

export interface UpdateInfo {
  readonly currentVersion: string
  readonly latestVersion: string | null
  readonly updateAvailable: boolean
}

export class UpdateService {
  private cachedInfo: UpdateInfo | null = null
  private lastCheckAt = 0
  private updating = false
  private readonly enabled: boolean
  private readonly updateLogPath: string

  constructor(
    private readonly client: IUpdateClient,
    options: UpdateServiceOptions = {}
  ) {
    this.enabled = options.enabled ?? true
    this.updateLogPath = options.updateLogPath ?? getDataPath('update.log')
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  get currentVersion(): string {
    return packageJson.version
  }

  /**
   * Check for available updates. Caches result for 1 hour.
   * Returns null on failure (never throws).
   */
  async checkForUpdate(): Promise<UpdateInfo | null> {
    if (!this.enabled) return null

    const now = Date.now()

    // Return cached result if fresh
    if (this.cachedInfo && now - this.lastCheckAt < CACHE_TTL_MS) {
      return this.cachedInfo
    }

    const currentVersion: string = packageJson.version
    const latestVersion = await this.client.fetchLatestVersion()

    if (!latestVersion) {
      return this.cachedInfo // Return stale cache (or null) on failure
    }

    const updateAvailable = isNewerVersion(latestVersion, currentVersion)

    this.cachedInfo = { currentVersion, latestVersion, updateAvailable }
    this.lastCheckAt = now

    if (updateAvailable) {
      logger.info(
        'Update',
        `Update available: ${currentVersion} → ${latestVersion}`
      )
    } else {
      logger.debug('Update', `Up to date (${currentVersion})`)
    }

    return this.cachedInfo
  }

  /**
   * Get cached update info synchronously (for layout footer).
   * Returns null if no check has been performed yet.
   */
  getUpdateInfo(): UpdateInfo | null {
    return this.cachedInfo
  }

  /**
   * Whether an update is currently in progress.
   */
  get isUpdating(): boolean {
    return this.updating
  }

  /**
   * Trigger the update script. Streams output line-by-line via callback
   * and writes to the update log file for post-restart retrieval.
   *
   * Returns immediately after spawning. The callback receives each line
   * of stdout/stderr as it arrives, plus a final 'close' event.
   */
  triggerUpdate(onLine: (line: string) => void, onClose: () => void): void {
    if (!this.enabled) {
      onLine('[!] In-container updates are disabled. Redeploy the Docker image.')
      onClose()
      return
    }

    if (this.updating) {
      onLine('[!] Update already in progress')
      onClose()
      return
    }

    this.updating = true

    // Truncate log file
    writeFileSync(this.updateLogPath, '')

    const writeLine = (line: string) => {
      appendFileSync(this.updateLogPath, line + '\n')
      onLine(line)
    }

    writeLine('⟩ Starting update...')

    try {
      const devScript = process.env['DEV_UPDATE_SCRIPT']
      const cmd = devScript ? [devScript] : [UPDATE_SCRIPT]

      const proc = spawn(cmd, {
        stdout: 'pipe',
        stderr: 'pipe',
      })

      // Stream stdout
      this.streamLines(proc.stdout, writeLine)

      // Stream stderr (merged into same output)
      this.streamLines(proc.stderr, writeLine)

      // Handle process exit
      proc.exited
        .then((exitCode) => {
          this.updating = false
          if (exitCode === 0) {
            writeLine('⟩ Update complete. Restarting...')
          } else {
            writeLine(`⟩ Update failed (exit code: ${exitCode})`)
          }
          onClose()
        })
        .catch(() => {
          this.updating = false
          writeLine('⟩ Update process error')
          onClose()
        })
    } catch (error) {
      this.updating = false
      writeLine(`⟩ Failed to start update: ${error}`)
      onClose()
    }
  }

  /**
   * Read the update log file (for post-restart retrieval).
   */
  getUpdateLog(): string | null {
    try {
      if (!existsSync(this.updateLogPath)) return null
      return readFileSync(this.updateLogPath, 'utf-8')
    } catch {
      return null
    }
  }

  /**
   * Stream a ReadableStream line-by-line to a callback.
   */
  private streamLines(
    stream: ReadableStream<Uint8Array>,
    onLine: (line: string) => void
  ): void {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    const read = (): void => {
      reader
        .read()
        .then(({ done, value }) => {
          if (done) {
            // Flush remaining buffer
            if (buffer) onLine(buffer)
            return
          }

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (line.trim()) onLine(line)
          }

          read()
        })
        .catch(() => {
          // Stream ended (e.g. process killed during restart)
          if (buffer) onLine(buffer)
        })
    }

    read()
  }
}
