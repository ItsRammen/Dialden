import type {
  ChannelWorkerClock,
  ContinuousChannelWorkerState,
} from './ContinuousChannelWorkerManager'

const SYSTEM_CLOCK: ChannelWorkerClock = {
  now: () => new Date(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface LineupWorkers {
  holdSession(
    channelId: string,
    clientId: string
  ): Promise<ContinuousChannelWorkerState>
  whenReady(channelId: string): Promise<ContinuousChannelWorkerState>
  refreshSession(channelId: string, clientId: string): boolean
  releaseSession(channelId: string, clientId: string): Promise<void>
  getState(channelId: string): ContinuousChannelWorkerState | null
}

export interface LineupSessionServiceOptions {
  /** Survives a dropped heartbeat window; must exceed the presence TTL. */
  readonly ttlMs?: number
  readonly staggerDelayMs?: number
  /** Includes the preferred channel; remaining channels start on demand. */
  readonly maximumConcurrentWorkers?: number
  readonly clock?: ChannelWorkerClock
}

interface LineupSessionRecord {
  channelIds: string[]
  heldChannelIds: Set<string>
  expiresAt: number
  closeTimer: unknown
}

interface LineupOpening {
  preferredChannelId?: string
  promise: Promise<LineupSessionSnapshotEntry>
}

export interface LineupSessionSnapshotEntry {
  readonly clientId: string
  readonly channelIds: readonly string[]
  readonly ready: number
  readonly pending: number
  readonly expiresAt: string
}

export interface LineupSessionSnapshot {
  readonly sessions: readonly LineupSessionSnapshotEntry[]
  readonly totalSessions: number
}

/**
 * Owns "a client is present, therefore the lineup should be up." The preferred
 * channel blocks until it is watchable; every other on-air channel receives a
 * session lease and a staggered background start so tuning anywhere becomes
 * attach-only. When the last session lease lapses, the manager tears the
 * idle lineup down.
 */
export class LineupSessionService {
  private readonly ttlMs: number
  private readonly staggerDelayMs: number
  private readonly maximumConcurrentWorkers: number
  private readonly clock: ChannelWorkerClock
  private readonly sessions = new Map<string, LineupSessionRecord>()
  private readonly openings = new Map<string, LineupOpening>()
  private startQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly workers: LineupWorkers,
    private readonly availableChannelIds: () => readonly string[],
    options: LineupSessionServiceOptions = {}
  ) {
    this.ttlMs = options.ttlMs ?? 180_000
    this.staggerDelayMs = options.staggerDelayMs ?? 750
    this.maximumConcurrentWorkers =
      options.maximumConcurrentWorkers ?? Number.MAX_SAFE_INTEGER
    this.clock = options.clock ?? SYSTEM_CLOCK
    if (!Number.isFinite(this.ttlMs) || this.ttlMs < 30_000) {
      throw new Error('Lineup session TTL must be at least 30 seconds')
    }
    if (!Number.isFinite(this.staggerDelayMs) || this.staggerDelayMs < 0) {
      throw new Error('Lineup stagger delay cannot be negative')
    }
    if (
      !Number.isSafeInteger(this.maximumConcurrentWorkers) ||
      this.maximumConcurrentWorkers < 1
    ) {
      throw new Error('Lineup concurrency must be at least one worker')
    }
  }

  /**
   * Opens (or refreshes) the caller's lineup. Resolves once the preferred
   * channel is watchable; the remaining channels start in the background,
   * ordered outward from the preferred position to make nearby zaps hot first.
   */
  open(
    clientId: string,
    preferredChannelId?: string
  ): Promise<LineupSessionSnapshotEntry> {
    const current = this.openings.get(clientId)
    if (current && current.preferredChannelId === preferredChannelId) {
      return current.promise
    }

    // webOS can dispatch duplicate visibility/startup events. Serialize a
    // changed preference and share an identical in-flight open so two requests
    // for one TV can never replace and release each other's worker lease.
    const currentPromise = current?.promise
    const promise = currentPromise
      ? currentPromise
          .catch(() => undefined)
          .then(() => this.openOnce(clientId, preferredChannelId))
      : this.openOnce(clientId, preferredChannelId)
    const opening: LineupOpening = { preferredChannelId, promise }
    this.openings.set(clientId, opening)
    void promise.then(
      () => this.finishOpening(clientId, opening),
      () => this.finishOpening(clientId, opening)
    )
    return promise
  }

  private async openOnce(
    clientId: string,
    preferredChannelId?: string
  ): Promise<LineupSessionSnapshotEntry> {
    const available = this.availableChannelIds().filter((channelId) =>
      /^[a-zA-Z0-9._-]{1,100}$/.test(channelId)
    )
    if (available.length === 0) {
      throw new Error('No channels are currently on air')
    }
    const ordered = this.orderFromPreferred(available, preferredChannelId)
    const existing = this.sessions.get(clientId)
    if (existing) this.clock.clearTimeout(existing.closeTimer)
    const desiredHeld = new Set(
      ordered.slice(0, this.maximumConcurrentWorkers)
    )
    const heldChannelIds = new Set(
      [...(existing?.heldChannelIds ?? [])].filter((channelId) =>
        desiredHeld.has(channelId)
      )
    )
    if (existing) {
      await Promise.all(
        [...existing.heldChannelIds]
          .filter((channelId) => !desiredHeld.has(channelId))
          .map((channelId) =>
            this.workers.releaseSession(channelId, clientId).catch(() => undefined)
          )
      )
    }

    const record: LineupSessionRecord = {
      channelIds: ordered,
      heldChannelIds,
      expiresAt: this.clock.now().getTime() + this.ttlMs,
      closeTimer: this.clock.setTimeout(() => {
        void this.expire(clientId)
      }, this.ttlMs),
    }
    this.sessions.set(clientId, record)

    const [preferred, ...rest] = ordered
    const background = rest.slice(
      0,
      Math.max(0, this.maximumConcurrentWorkers - 1)
    )
    await this.workers.holdSession(preferred!, clientId)
    if (this.sessions.get(clientId) !== record) {
      await this.workers.releaseSession(preferred!, clientId).catch(() => undefined)
      throw new Error('Lineup session closed during startup')
    }
    record.heldChannelIds.add(preferred!)
    const openedAt = this.clock.now()
    let cursor = 0
    for (const channelId of background) {
      cursor += 1
      // Absolute deadlines measured from open(), so a queued start never
      // drifts because an earlier task finished late.
      this.enqueueStart(
        clientId,
        record,
        channelId,
        openedAt.getTime() + cursor * this.staggerDelayMs
      )
    }

    await this.workers.whenReady(preferred!)
    return this.describe(clientId, record)
  }

  private finishOpening(clientId: string, opening: LineupOpening): void {
    if (this.openings.get(clientId) === opening) this.openings.delete(clientId)
  }

  /** Heartbeat-driven liveness. Unknown sessions are ignored. */
  refresh(clientId: string): boolean {
    const record = this.sessions.get(clientId)
    if (!record) return false
    this.clock.clearTimeout(record.closeTimer)
    record.expiresAt = this.clock.now().getTime() + this.ttlMs
    record.closeTimer = this.clock.setTimeout(() => {
      void this.expire(clientId)
    }, this.ttlMs)
    for (const channelId of record.heldChannelIds) {
      this.workers.refreshSession(channelId, clientId)
    }
    return true
  }

  async close(clientId: string): Promise<void> {
    const record = this.sessions.get(clientId)
    if (!record) return
    this.sessions.delete(clientId)
    this.clock.clearTimeout(record.closeTimer)
    await Promise.all(
      [...record.heldChannelIds].map((channelId) =>
        this.workers.releaseSession(channelId, clientId).catch(() => undefined)
      )
    )
  }

  snapshot(): LineupSessionSnapshot {
    return {
      sessions: [...this.sessions.entries()].map(([clientId, record]) =>
        this.describe(clientId, record)
      ),
      totalSessions: this.sessions.size,
    }
  }

  private describe(
    clientId: string,
    record: LineupSessionRecord
  ): LineupSessionSnapshotEntry {
    let ready = 0
    for (const channelId of record.channelIds) {
      const state = this.workers.getState(channelId)
      if (
        state &&
        (state.status === 'live' ||
          state.status === 'idle' ||
          state.status === 'transitioning')
      ) {
        ready += 1
      }
    }
    return {
      clientId,
      channelIds: record.channelIds,
      ready,
      pending: record.channelIds.length - ready,
      expiresAt: new Date(record.expiresAt).toISOString(),
    }
  }

  private enqueueStart(
    clientId: string,
    record: LineupSessionRecord,
    channelId: string,
    dueAtMs: number
  ): void {
    const task = async () => {
      const remaining = dueAtMs - this.clock.now().getTime()
      if (remaining > 0) {
        await new Promise<void>((resolve) => {
          this.clock.setTimeout(resolve, remaining)
        })
      }
      // The session may have closed or expired while this start was queued.
      if (this.sessions.get(clientId) !== record) return
      try {
        await this.workers.holdSession(channelId, clientId)
        if (this.sessions.get(clientId) === record) {
          record.heldChannelIds.add(channelId)
        } else {
          await this.workers.releaseSession(channelId, clientId)
        }
      } catch {
        // A speculative channel remains available for an on-demand tune.
      }
    }
    this.startQueue = this.startQueue.then(task, task)
  }

  private async expire(clientId: string): Promise<void> {
    await this.close(clientId)
  }

  private orderFromPreferred(
    available: readonly string[],
    preferredChannelId?: string
  ): string[] {
    const preferredIndex = preferredChannelId
      ? available.indexOf(preferredChannelId)
      : -1
    const startIndex = preferredIndex >= 0 ? preferredIndex : 0
    const ordered: string[] = []
    for (let offset = 0; offset < available.length; offset += 1) {
      const forward = (startIndex + offset) % available.length
      ordered.push(available[forward]!)
    }
    return ordered
  }
}
