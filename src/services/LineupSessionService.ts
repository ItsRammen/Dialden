import { createHash } from 'node:crypto'
import {
  isStreamableChannelWorkerState,
  type ChannelWorkerClock,
  type ContinuousChannelWorkerState,
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
  readonly maximumSessions?: number
  readonly clock?: ChannelWorkerClock
}

interface LineupSessionRecord {
  ownerId?: string
  leaseId: string
  channelIds: string[]
  heldChannelIds: Set<string>
  expiresAt: number
  closeTimer: unknown
}

interface LineupOpening {
  preferredChannelId?: string
  ownerId?: string
  cancelled: boolean
  previous?: LineupOpening
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
  private readonly maximumSessions: number
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
    this.maximumSessions = options.maximumSessions ?? 64
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
    if (!Number.isSafeInteger(this.maximumSessions) || this.maximumSessions < 1) {
      throw new Error('Lineup session capacity must be positive')
    }
  }

  /**
   * Opens (or refreshes) the caller's lineup. Resolves once the preferred
   * channel is watchable; the remaining channels start in the background,
   * ordered outward from the preferred position to make nearby zaps hot first.
   */
  open(
    clientId: string,
    preferredChannelId?: string,
    ownerId?: string
  ): Promise<LineupSessionSnapshotEntry> {
    assertSafeLeaseIdentifier(clientId, 'Client ID')
    if (ownerId !== undefined) assertSafeLeaseIdentifier(ownerId, 'Owner ID')
    if (
      !this.sessions.has(clientId) &&
      !this.openings.has(clientId) &&
      new Set([...this.sessions.keys(), ...this.openings.keys()]).size >=
        this.maximumSessions
    ) {
      throw new Error('Lineup session capacity is full')
    }
    const current = this.openings.get(clientId)
    if (
      current &&
      current.preferredChannelId === preferredChannelId &&
      current.ownerId === ownerId
    ) {
      return current.promise
    }
    // webOS can dispatch duplicate visibility/startup events. Serialize a
    // changed preference and share an identical in-flight open so two requests
    // for one TV can never replace and release each other's worker lease.
    const opening: LineupOpening = {
      preferredChannelId,
      ownerId,
      cancelled: false,
      previous: current,
      promise: Promise.resolve(undefined as never),
    }
    this.openings.set(clientId, opening)
    const waitForCurrent = current?.promise.catch(() => undefined)
    opening.promise = (waitForCurrent ?? Promise.resolve()).then(() =>
      this.openOnce(clientId, preferredChannelId, ownerId, opening)
    )
    const promise = opening.promise
    void promise.then(
      () => this.finishOpening(clientId, opening),
      () => this.finishOpening(clientId, opening)
    )
    return promise
  }

  private async openOnce(
    clientId: string,
    preferredChannelId?: string,
    ownerId?: string,
    opening?: LineupOpening
  ): Promise<LineupSessionSnapshotEntry> {
    if (opening && !this.openingIsCurrent(clientId, opening)) {
      throw new Error('Lineup session open was superseded')
    }
    const available = this.availableChannelIds().filter((channelId) =>
      /^[a-zA-Z0-9._-]{1,100}$/.test(channelId)
    )
    if (available.length === 0) {
      throw new Error('No channels are currently on air')
    }
    const ordered = this.orderFromPreferred(available, preferredChannelId)
    const existing = this.sessions.get(clientId)
    if (existing) this.clock.clearTimeout(existing.closeTimer)
    const leaseId = ownerId
      ? `lineup:${createHash('sha256')
          .update(`${clientId}\0${ownerId}`)
          .digest('hex')
          .slice(0, 32)}`
      : clientId
    const sameLease = existing?.leaseId === leaseId
    const desiredHeld = new Set(
      ordered.slice(0, this.maximumConcurrentWorkers)
    )
    const heldChannelIds = new Set(
      [...(sameLease ? existing?.heldChannelIds ?? [] : [])].filter((channelId) =>
        desiredHeld.has(channelId)
      )
    )
    if (existing) {
      if (this.sessions.get(clientId) === existing) {
        this.sessions.delete(clientId)
      }
      await Promise.all(
        [...existing.heldChannelIds]
          .filter((channelId) => !sameLease || !desiredHeld.has(channelId))
          .map((channelId) =>
            this.workers
              .releaseSession(channelId, existing.leaseId)
              .catch(() => undefined)
          )
      )
    }

    if (opening && !this.openingIsCurrent(clientId, opening)) {
      await Promise.all(
        [...heldChannelIds].map((channelId) =>
          this.workers
            .releaseSession(channelId, leaseId)
            .catch(() => undefined)
        )
      )
      throw new Error('Lineup session open was superseded')
    }

    const record: LineupSessionRecord = {
      ownerId,
      leaseId,
      channelIds: ordered,
      heldChannelIds,
      expiresAt: this.clock.now().getTime() + this.ttlMs,
      closeTimer: undefined,
    }
    record.closeTimer = this.expiryTimer(clientId, record)
    this.sessions.set(clientId, record)

    const [preferred, ...rest] = ordered
    const background = rest.slice(
      0,
      Math.max(0, this.maximumConcurrentWorkers - 1)
    )
    try {
      await this.workers.holdSession(preferred!, leaseId)
      if (
        this.sessions.get(clientId) !== record ||
        (opening && !this.openingIsCurrent(clientId, opening))
      ) {
        await this.workers
          .releaseSession(preferred!, leaseId)
          .catch(() => undefined)
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
      if (
        this.sessions.get(clientId) !== record ||
        (opening && !this.openingIsCurrent(clientId, opening))
      ) {
        throw new Error('Lineup session open was superseded')
      }
      return this.describe(clientId, record)
    } catch (error) {
      // The record is installed before the blocking preferred-channel start so
      // heartbeats can observe it. A capacity/startup failure must be fully
      // transactional instead of leaving an empty, refreshable ghost session.
      if (this.sessions.get(clientId) === record) {
        await this.closeRecord(clientId, record)
      }
      throw error
    }
  }

  private finishOpening(clientId: string, opening: LineupOpening): void {
    if (this.openings.get(clientId) === opening) this.openings.delete(clientId)
  }

  private openingIsCurrent(clientId: string, opening: LineupOpening): boolean {
    return !opening.cancelled
  }

  /** Heartbeat-driven liveness. Unknown sessions are ignored. */
  refresh(clientId: string): boolean {
    const record = this.sessions.get(clientId)
    if (!record) return false
    this.clock.clearTimeout(record.closeTimer)
    record.expiresAt = this.clock.now().getTime() + this.ttlMs
    record.closeTimer = this.expiryTimer(clientId, record)
    for (const channelId of record.heldChannelIds) {
      this.workers.refreshSession(channelId, record.leaseId)
    }
    return true
  }

  async close(clientId: string, ownerId?: string): Promise<void> {
    assertSafeLeaseIdentifier(clientId, 'Client ID')
    if (ownerId !== undefined) assertSafeLeaseIdentifier(ownerId, 'Owner ID')
    const opening = this.openings.get(clientId)
    const closesNewestOpening =
      opening !== undefined &&
      (ownerId === undefined || opening.ownerId === ownerId)
    let candidate = opening
    while (candidate) {
      if (
        closesNewestOpening ||
        ownerId === undefined ||
        candidate.ownerId === ownerId
      ) {
        candidate.cancelled = true
      }
      candidate = candidate.previous
    }
    const record = this.sessions.get(clientId)
    if (
      record &&
      (closesNewestOpening ||
        ownerId === undefined ||
        record.ownerId === ownerId)
    ) {
      await this.closeRecord(clientId, record)
    }
    if (opening) await opening.promise.catch(() => undefined)
  }

  private async closeRecord(
    clientId: string,
    record: LineupSessionRecord
  ): Promise<void> {
    if (this.sessions.get(clientId) !== record) return
    this.sessions.delete(clientId)
    this.clock.clearTimeout(record.closeTimer)
    await Promise.all(
      [...record.heldChannelIds].map((channelId) =>
        this.workers
          .releaseSession(channelId, record.leaseId)
          .catch(() => undefined)
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
      if (state && isStreamableChannelWorkerState(state)) {
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
        await this.workers.holdSession(channelId, record.leaseId)
        if (this.sessions.get(clientId) === record) {
          record.heldChannelIds.add(channelId)
        } else {
          await this.workers.releaseSession(channelId, record.leaseId)
        }
      } catch {
        // A speculative channel remains available for an on-demand tune.
      }
    }
    this.startQueue = this.startQueue.then(task, task)
  }

  private async expire(
    clientId: string,
    record: LineupSessionRecord,
    expectedExpiresAt: number
  ): Promise<void> {
    if (record.expiresAt !== expectedExpiresAt) return
    await this.closeRecord(clientId, record)
  }

  private expiryTimer(
    clientId: string,
    record: LineupSessionRecord
  ): unknown {
    const expectedExpiresAt = record.expiresAt
    return this.clock.setTimeout(() => {
      void this.expire(clientId, record, expectedExpiresAt)
    }, this.ttlMs)
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

function assertSafeLeaseIdentifier(value: string, label: string): void {
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(value)) {
    throw new Error(`${label} is not a safe lineup identifier`)
  }
}
