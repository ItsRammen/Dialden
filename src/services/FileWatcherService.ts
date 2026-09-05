/**
 * File Watcher Service
 *
 * Watches media directories for file changes and batches them
 * using debouncing to avoid overwhelming the indexer.
 * Per ARCHITECTURE.md: This is a Service (stateful), not a Client.
 */

import { EventEmitter } from 'node:events'
import type { FileWatcher, IFileSystem } from '../types'

/* A recursive watch walks the whole tree, so one unreadable entry anywhere
   under a root can fail the watch for all of it. That used to disable change
   detection for that root until someone restarted the container -- a single
   file taking a 22,000-file library's live updates with it. The cause is often
   transient (a file appearing mid-walk, a share hiccup, a permission that
   differs inside the container), so the watch is re-established instead. */
const WATCH_RETRY_BASE_MS = 5_000
const WATCH_RETRY_MAX_MS = 300_000
/** Log the first few attempts, then stay quiet so a dead root cannot spam. */
const WATCH_RETRY_QUIET_AFTER = 3

export class FileWatcherService extends EventEmitter {
  private watchers: FileWatcher[] = []
  private pending: Set<string> = new Set()
  private debounceTimer: Timer | null = null
  private readonly debounceMs = 2000 // Wait 2s after last event
  private readonly retryTimers = new Map<string, Timer>()
  private readonly retryCounts = new Map<string, number>()
  private stopped = false

  constructor(
    private readonly filesystem: IFileSystem,
    private readonly directories: string[],
    private readonly extensions: readonly string[],
    private readonly schedule: (fn: () => void, ms: number) => Timer = setTimeout,
    private readonly unschedule: (timer: Timer) => void = clearTimeout
  ) {
    super()
  }

  start(): void {
    this.stopped = false
    for (const dir of this.directories) this.watchRoot(dir)
  }

  private watchRoot(dir: string): void {
    if (this.stopped) return
    if (!this.filesystem.exists(dir)) {
      console.warn(`FileWatcher: Skipping non-existent directory: ${dir}`)
      return
    }

    try {
      let watcher: FileWatcher | null = null
      watcher = this.filesystem.watch(
        dir,
        (_event, path) => {
          // Filter by extension
          const normalizedPath = path.toLowerCase()
          if (
            !this.extensions.some((ext) =>
              normalizedPath.endsWith(ext.toLowerCase())
            )
          ) return

          this.pending.add(path)
          this.resetDebounce()
        },
        (error) => {
          const message = error instanceof Error ? error.message : String(error)
          if (watcher) {
            watcher.close()
            this.watchers = this.watchers.filter((active) => active !== watcher)
          }
          this.scheduleRetry(dir, message)
        }
      )
      this.watchers.push(watcher)
      // A root that recovers starts its backoff afresh.
      this.retryCounts.delete(dir)
      console.log(`FileWatcher: Watching ${dir}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.scheduleRetry(dir, message)
    }
  }

  private scheduleRetry(dir: string, message: string): void {
    if (this.stopped) return
    const attempt = (this.retryCounts.get(dir) ?? 0) + 1
    this.retryCounts.set(dir, attempt)
    const delay = Math.min(
      WATCH_RETRY_MAX_MS,
      WATCH_RETRY_BASE_MS * 2 ** (attempt - 1)
    )
    if (attempt <= WATCH_RETRY_QUIET_AFTER) {
      console.error(
        `FileWatcher: Watch failed for ${dir}; retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}): ${message}`
      )
    } else if (attempt === WATCH_RETRY_QUIET_AFTER + 1) {
      console.error(
        `FileWatcher: Watch for ${dir} still failing; retrying quietly every ${Math.round(WATCH_RETRY_MAX_MS / 1000)}s at most. A library scan still picks up changes.`
      )
    }

    const existing = this.retryTimers.get(dir)
    if (existing) this.unschedule(existing)
    this.retryTimers.set(
      dir,
      this.schedule(() => {
        this.retryTimers.delete(dir)
        this.watchRoot(dir)
      }, delay)
    )
  }

  private resetDebounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)

    this.debounceTimer = setTimeout(() => {
      const batch = [...this.pending]
      this.pending.clear()
      if (batch.length > 0) {
        this.emit('batch', batch)
      }
    }, this.debounceMs)
  }

  stop(): void {
    this.stopped = true
    for (const timer of this.retryTimers.values()) this.unschedule(timer)
    this.retryTimers.clear()
    this.retryCounts.clear()
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    for (const w of this.watchers) w.close()
    this.watchers = []
    this.pending.clear()
    console.log('FileWatcher: Stopped')
  }
}
