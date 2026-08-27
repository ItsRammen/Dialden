import { randomUUID } from 'node:crypto'
import type {
  ChannelWorkerClock,
  ContinuousChannelWorkerState,
} from './ContinuousChannelWorkerManager'
import { isStreamableChannelWorkerState } from './ContinuousChannelWorkerManager'
import {
  MpegTsTransportIncompatibleError,
  type MpegTsTransportState,
} from './MpegTsTransportSplicer'

const SAFE_CLIENT_ID = /^[a-zA-Z0-9._:-]{1,160}$/
const SAFE_OWNER_ID = /^[a-zA-Z0-9._:-]{1,160}$/
const SAFE_CHANNEL_ID = /^[a-zA-Z0-9._-]{1,100}$/
const SAFE_SESSION_ID = /^[a-f0-9-]{36}$/
const SOURCE_SEGMENT_NAME = /^segment-(\d{13})\.ts$/
const VIRTUAL_SEGMENT_NAME = /^segment-\d{13}\.ts$/
// Native TV HLS implementations commonly wait for a third segment before
// starting a live presentation. Keep a fourth complete segment as headroom so
// a revisioned tuner attach does not have to wait for the next worker reload.
// This is only a preferred advertised window: cold workers may still become
// ready with minimumReadySegments and are never delayed to fill it.
const PREFERRED_JOIN_SEGMENTS = 4

const SYSTEM_CLOCK: ChannelWorkerClock = {
  now: () => new Date(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface VirtualTunerWorkers {
  holdSession(
    channelId: string,
    clientId: string
  ): Promise<ContinuousChannelWorkerState>
  whenReady(channelId: string): Promise<ContinuousChannelWorkerState>
  refreshSession(channelId: string, clientId: string): boolean
  releaseSession(channelId: string, clientId: string): Promise<void>
  restart?(
    channelId: string,
    reason?: string
  ): Promise<ContinuousChannelWorkerState | null>
}

export interface VirtualTunerFiles {
  prepareSession(sessionId: string): Promise<void>
  readChannelPlaylist(channelId: string): Promise<string>
  preserveSegment(
    channelId: string,
    sourceName: string,
    sessionId: string,
    outputName: string
  ): Promise<void>
  /** Rewrites one compatible TS segment onto the viewer's transport clock. */
  spliceSegment?(
    channelId: string,
    sourceName: string,
    sessionId: string,
    outputName: string,
    durationSeconds: number,
    state: MpegTsTransportState
  ): Promise<MpegTsTransportState>
  removeSegment(sessionId: string, outputName: string): Promise<void>
  removeSession(sessionId: string): Promise<void>
  segmentPath(sessionId: string, outputName: string): string
  segmentExists(sessionId: string, outputName: string): Promise<boolean>
  /** Production adapter proves the muxer playlist and newest source files are live. */
  sourcePresentationIsFresh?(
    channelId: string,
    sourceNames: readonly string[],
    maximumAgeMs: number,
    minimumModifiedAtMs: number
  ): Promise<boolean>
}

export interface VirtualTunerServiceOptions {
  readonly ttlMs?: number
  readonly playlistWindowSegments?: number
  /** Retains already-advertised segments briefly for a lagging HLS reader. */
  readonly retainedSegmentCount?: number
  readonly minimumReadySegments?: number
  readonly readinessAttempts?: number
  readonly readinessDelayMs?: number
  /** Maximum time an already-published edge may be served without advancing. */
  readonly staleEdgeGraceMs?: number
  readonly maximumSessions?: number
  readonly manifestBasePath?: string
  readonly clock?: ChannelWorkerClock
  readonly sleep?: (delayMs: number) => Promise<void>
}

export interface VirtualTunerDescriptor {
  readonly mode: 'stable-hls'
  readonly sessionId: string
  readonly manifestUrl: string
  readonly channelId: string
  readonly revision: number
  /** New clients must issue tune request IDs strictly above this value. */
  readonly requestIdFloor: number
}

export interface VirtualTunerTuneResult extends VirtualTunerDescriptor {
  readonly requestId: number
  /** Immutable target-only window published by this committed request. */
  readonly switchBoundary: VirtualTunerSwitchBoundary
}

export interface VirtualTunerSwitchBoundary {
  /** Tuner revision that owns this window. */
  readonly revision: number
  /** First virtual sequence advertised at the atomic switch boundary. */
  readonly firstMediaSequence: number
  /** Last virtual sequence advertised at the atomic switch boundary. */
  readonly lastMediaSequence: number
  readonly segmentCount: number
  /** Fixed EXT-X-TARGETDURATION used throughout this tuner session. */
  readonly targetDurationSeconds: number
  /** Sum of the actual EXTINF durations in the committed window. */
  readonly durationSeconds: number
  /** Seamless keeps one decoder clock; discontinuity uses the guarded fallback. */
  readonly transportMode: 'seamless' | 'discontinuity'
}

export class VirtualTunerSessionNotFoundError extends Error {
  constructor(message = 'Virtual tuner session not found') {
    super(message)
    this.name = 'VirtualTunerSessionNotFoundError'
  }
}

export class VirtualTunerStaleRequestError extends Error {
  constructor(message = 'A newer channel tune superseded this request') {
    super(message)
    this.name = 'VirtualTunerStaleRequestError'
  }
}

export class VirtualTunerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VirtualTunerUnavailableError'
  }
}

interface ParsedSourceSegment {
  readonly sourceName: string
  readonly sourceSequence: number
  readonly durationSeconds: number
  readonly discontinuityBefore: boolean
}

export interface ParsedSourcePlaylist {
  readonly targetDurationSeconds: number
  readonly segments: readonly ParsedSourceSegment[]
}

interface VirtualSegment {
  readonly sequence: number
  readonly outputName: string
  readonly sourceKey: string
  readonly durationSeconds: number
  readonly discontinuityBefore: boolean
}

interface StagedSegments {
  readonly segments: VirtualSegment[]
  readonly nextSequence: number
  readonly transportState?: MpegTsTransportState
  readonly transportMode: 'seamless' | 'discontinuity'
}

interface CurrentEdgeStage {
  readonly parsed: ParsedSourcePlaylist
  readonly staged: StagedSegments
  readonly revision: number
}

interface PendingTune {
  readonly channelId: string
  readonly promise: Promise<VirtualTunerTuneResult>
}

interface VirtualTunerRecord {
  readonly sessionId: string
  readonly clientId: string
  readonly ownerId: string
  readonly ownerEpoch: number
  readonly leaseId: string
  channelId: string
  revision: number
  nextSequence: number
  nextOutputId: number
  entries: VirtualSegment[]
  retained: VirtualSegment[]
  discontinuitySequence: number
  targetDurationSeconds: number
  lastEdgeAdvancedAt: number
  sourceCursor?: {
    readonly channelId: string
    readonly revision: number
    readonly lastSequence: number
  }
  sourceKeys: Set<string>
  cleanupPending: Set<string>
  expiresAt: number
  closeTimer: unknown
  closed: boolean
  highestRequestId: number
  lastCommittedRequestId: number
  lastCommittedTune?: VirtualTunerTuneResult
  transportState?: MpegTsTransportState
  transportMode: 'unknown' | 'seamless' | 'discontinuity'
  pendingTunes: Map<number, PendingTune>
  operation: Promise<void>
}

interface VirtualTunerOpening {
  readonly ownerId: string
  readonly ownerEpoch: number
  readonly channelId: string
  cancelled: boolean
  promise: Promise<VirtualTunerDescriptor>
}

export type VirtualTunerCloseResult = 'closed' | 'ignored' | 'none'

/**
 * A zero-transcode, per-viewer HLS presentation over shared channel workers.
 *
 * Each session owns one stable manifest URL. Channel changes append preserved
 * segments from another already-normalized channel after an HLS discontinuity;
 * segment bytes are linked/copied, never decoded or encoded again. The relay
 * intentionally does not rewrite MPEG-TS timestamps or PIDs. Consequently this
 * is a capability that must be validated on physical LG models, not a claim of
 * gapless playback on every HLS implementation.
 */
export class VirtualTunerService {
  private readonly ttlMs: number
  private readonly playlistWindowSegments: number
  private readonly retainedSegmentCount: number
  private readonly minimumReadySegments: number
  private readonly readinessAttempts: number
  private readonly readinessDelayMs: number
  private readonly staleEdgeGraceMs: number
  private readonly maximumSessions: number
  private readonly manifestBasePath: string
  private readonly clock: ChannelWorkerClock
  private readonly sleep: (delayMs: number) => Promise<void>
  private readonly sessions = new Map<string, VirtualTunerRecord>()
  private readonly clientSessions = new Map<string, string>()
  private readonly openings = new Map<string, VirtualTunerOpening>()
  private readonly recoveries = new Map<
    string,
    Promise<ContinuousChannelWorkerState | null>
  >()

  constructor(
    private readonly workers: VirtualTunerWorkers,
    private readonly files: VirtualTunerFiles,
    private readonly availableChannelIds: () => readonly string[],
    options: VirtualTunerServiceOptions = {}
  ) {
    this.ttlMs = options.ttlMs ?? 180_000
    this.playlistWindowSegments = options.playlistWindowSegments ?? 10
    this.retainedSegmentCount =
      options.retainedSegmentCount ?? this.playlistWindowSegments * 3
    this.minimumReadySegments = options.minimumReadySegments ?? 2
    this.readinessAttempts = options.readinessAttempts ?? 120
    this.readinessDelayMs = options.readinessDelayMs ?? 100
    this.staleEdgeGraceMs = options.staleEdgeGraceMs ?? 15_000
    this.maximumSessions = options.maximumSessions ?? 64
    this.manifestBasePath = (
      options.manifestBasePath ?? '/api/v1/tuner-sessions'
    ).replace(/\/$/, '')
    this.clock = options.clock ?? SYSTEM_CLOCK
    this.sleep =
      options.sleep ??
      ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)))

    if (!Number.isFinite(this.ttlMs) || this.ttlMs < 30_000) {
      throw new Error('Virtual tuner TTL must be at least 30 seconds')
    }
    if (
      !Number.isSafeInteger(this.playlistWindowSegments) ||
      this.playlistWindowSegments < 4 ||
      this.playlistWindowSegments > 30
    ) {
      throw new Error('Virtual tuner playlist window must contain 4 to 30 segments')
    }
    if (
      !Number.isSafeInteger(this.retainedSegmentCount) ||
      this.retainedSegmentCount < this.playlistWindowSegments ||
      this.retainedSegmentCount > 120
    ) {
      throw new Error('Virtual tuner retained segment count is invalid')
    }
    if (
      !Number.isSafeInteger(this.minimumReadySegments) ||
      this.minimumReadySegments < 2 ||
      this.minimumReadySegments > this.playlistWindowSegments
    ) {
      throw new Error('Virtual tuner needs at least two ready segments')
    }
    if (!Number.isSafeInteger(this.readinessAttempts) || this.readinessAttempts < 1) {
      throw new Error('Virtual tuner readiness attempts must be positive')
    }
    if (!Number.isFinite(this.staleEdgeGraceMs) || this.staleEdgeGraceMs < 0) {
      throw new Error('Virtual tuner stale-edge grace must not be negative')
    }
    if (!Number.isSafeInteger(this.maximumSessions) || this.maximumSessions < 1) {
      throw new Error('Virtual tuner session capacity must be positive')
    }
  }

  /** Duplicate startup requests for one launch share the same in-flight open. */
  open(
    clientId: string,
    ownerId: string,
    channelId: string,
    ownerEpoch = 0
  ): Promise<VirtualTunerDescriptor> {
    this.assertClientId(clientId)
    this.assertOwnerId(ownerId)
    if (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 0) {
      throw new Error('Owner epoch must be a non-negative safe integer')
    }
    this.assertAvailableChannel(channelId)
    if (
      !this.clientSessions.has(clientId) &&
      !this.openings.has(clientId) &&
      new Set([...this.clientSessions.keys(), ...this.openings.keys()]).size >=
        this.maximumSessions
    ) {
      throw new VirtualTunerUnavailableError(
        'Virtual tuner session capacity is full'
      )
    }
    const current = this.openings.get(clientId)
    const existingSessionId = this.clientSessions.get(clientId)
    const existingRecord = existingSessionId
      ? this.sessions.get(existingSessionId)
      : undefined
    const currentOwner =
      current && !current.cancelled
        ? current.ownerId
        : existingRecord && !existingRecord.closed
          ? existingRecord.ownerId
          : undefined
    const currentOwnerEpoch =
      current && !current.cancelled
        ? current.ownerEpoch
        : existingRecord && !existingRecord.closed
          ? existingRecord.ownerEpoch
          : undefined
    if (
      currentOwner !== undefined &&
      ((currentOwner === ownerId && currentOwnerEpoch !== ownerEpoch) ||
        (currentOwner !== ownerId &&
          currentOwnerEpoch !== undefined &&
          ownerEpoch <= currentOwnerEpoch))
    ) {
      throw new VirtualTunerStaleRequestError(
        'Tuner owner takeover did not match the current launch'
      )
    }
    if (
      current &&
      !current.cancelled &&
      current.ownerId === ownerId &&
      current.ownerEpoch === ownerEpoch &&
      current.channelId === channelId
    ) {
      return current.promise
    }
    if (current) current.cancelled = true

    const opening: VirtualTunerOpening = {
      ownerId,
      ownerEpoch,
      channelId,
      cancelled: false,
      promise: Promise.resolve(undefined as never),
    }
    this.openings.set(clientId, opening)
    opening.promise = Promise.resolve().then(() =>
      this.openForOwner(clientId, ownerId, ownerEpoch, channelId, opening)
    )
    void opening.promise.finally(() => {
      if (this.openings.get(clientId) === opening) this.openings.delete(clientId)
    }).catch(() => undefined)
    return opening.promise
  }

  tune(
    clientId: string,
    ownerId: string,
    sessionId: string,
    channelId: string,
    requestId: number
  ): Promise<VirtualTunerTuneResult> {
    this.assertClientId(clientId)
    this.assertOwnerId(ownerId)
    this.assertSessionId(sessionId)
    this.assertAvailableChannel(channelId)
    if (!Number.isSafeInteger(requestId) || requestId < 0) {
      throw new Error('Tune requestId must be a non-negative safe integer')
    }
    const record = this.sessions.get(sessionId)
    if (
      !record ||
      record.closed ||
      record.clientId !== clientId ||
      record.ownerId !== ownerId
    ) {
      throw new VirtualTunerSessionNotFoundError()
    }

    const duplicate = record.pendingTunes.get(requestId)
    if (duplicate) {
      if (duplicate.channelId !== channelId) {
        throw new VirtualTunerStaleRequestError('Tune requestId was already used')
      }
      return duplicate.promise
    }
    if (requestId < record.highestRequestId) {
      throw new VirtualTunerStaleRequestError()
    }
    if (requestId === record.lastCommittedRequestId) {
      if (
        !record.lastCommittedTune ||
        record.lastCommittedTune.channelId !== channelId ||
        record.channelId !== channelId ||
        record.revision !== record.lastCommittedTune.switchBoundary.revision
      ) {
        throw new VirtualTunerStaleRequestError('Tune requestId was already committed')
      }
      // A playlist poll may have slid the live window since the first response.
      // Idempotent retries must still return the original commit boundary.
      return Promise.resolve(record.lastCommittedTune)
    }
    if (requestId === record.highestRequestId) {
      throw new VirtualTunerStaleRequestError('Tune requestId was already used')
    }

    // Reserve synchronously. A higher request can now supersede this one while
    // its destination is being staged, before any manifest mutation commits.
    record.highestRequestId = requestId
    const promise = this.tuneConcurrent(record, channelId, requestId)
    record.pendingTunes.set(requestId, { channelId, promise })
    void promise.finally(() => {
      if (record.pendingTunes.get(requestId)?.promise === promise) {
        record.pendingTunes.delete(requestId)
      }
    }).catch(() => undefined)
    return promise
  }

  /** HLS playlist reads count as liveness and pull in the channel's new edge. */
  async playlist(sessionId: string): Promise<string> {
    this.assertSessionId(sessionId)
    const record = this.sessions.get(sessionId)
    if (!record || record.closed) throw new VirtualTunerSessionNotFoundError()
    this.refreshRecord(record)
    return this.withLock(record, async () => {
      if (record.closed || this.sessions.get(sessionId) !== record) {
        throw new VirtualTunerSessionNotFoundError()
      }
      try {
        const edge = await this.stageCurrentEdge(record)
        if (edge.staged.segments.length > 0) {
          record.revision = edge.revision
          await this.commitStaged(record, edge.staged)
          record.lastEdgeAdvancedAt = this.clock.now().getTime()
        }
        this.rememberSourceSnapshot(
          record,
          record.channelId,
          edge.revision,
          edge.parsed
        )
        this.assertFreshEdge(record)
      } catch (error) {
        // Preserve the outgoing window only through a bounded muxer/NAS
        // transient. Serving a dead static manifest forever makes native HLS
        // loop old media while appearing healthy.
        if (record.entries.length === 0 || this.edgeIsStale(record)) {
          if (this.workers.restart) {
            void this.restartWorker(
              record.channelId,
              'Virtual tuner live edge stopped advancing'
            ).catch(() => undefined)
          }
          throw new VirtualTunerUnavailableError(
            error instanceof Error
              ? `Tuner live edge is unavailable: ${error.message}`
              : 'Tuner live edge is unavailable'
          )
        }
      }
      return renderVirtualPlaylist(
        record.entries,
        record.discontinuitySequence,
        record.targetDurationSeconds
      )
    })
  }

  async segmentPath(sessionId: string, outputName: string): Promise<string | null> {
    if (
      !SAFE_SESSION_ID.test(sessionId) ||
      !VIRTUAL_SEGMENT_NAME.test(outputName)
    ) {
      return null
    }
    const record = this.sessions.get(sessionId)
    if (!record || record.closed) return null
    this.refreshRecord(record)
    if (
      ![...record.entries, ...record.retained].some(
        (segment) => segment.outputName === outputName
      )
    ) {
      return null
    }
    if (!(await this.files.segmentExists(sessionId, outputName))) return null
    return this.files.segmentPath(sessionId, outputName)
  }

  refreshByClient(clientId: string): boolean {
    const sessionId = this.clientSessions.get(clientId)
    const record = sessionId ? this.sessions.get(sessionId) : undefined
    if (!record || record.closed) return false
    this.refreshRecord(record)
    return true
  }

  refresh(sessionId: string): boolean {
    const record = this.sessions.get(sessionId)
    if (!record || record.closed) return false
    this.refreshRecord(record)
    return true
  }

  async closeByClient(
    clientId: string,
    ownerId?: string,
    expectedSessionId?: string
  ): Promise<VirtualTunerCloseResult> {
    this.assertClientId(clientId)
    if (ownerId !== undefined) this.assertOwnerId(ownerId)
    if (expectedSessionId !== undefined) this.assertSessionId(expectedSessionId)

    const opening = this.openings.get(clientId)
    if (opening && !opening.cancelled) {
      if (ownerId !== undefined && opening.ownerId !== ownerId) return 'ignored'
      opening.cancelled = true
      await opening.promise.catch(() => undefined)
    }

    const sessionId = this.clientSessions.get(clientId)
    if (!sessionId) return opening ? 'closed' : 'none'
    const record = this.sessions.get(sessionId)
    if (!record || record.closed) return 'none'
    if (
      (ownerId !== undefined && record.ownerId !== ownerId) ||
      (expectedSessionId !== undefined && record.sessionId !== expectedSessionId)
    ) {
      return 'ignored'
    }
    await this.close(sessionId)
    return 'closed'
  }

  async close(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId)
    if (!record || record.closed) return
    record.closed = true
    this.sessions.delete(sessionId)
    if (this.clientSessions.get(record.clientId) === sessionId) {
      this.clientSessions.delete(record.clientId)
    }
    this.clock.clearTimeout(record.closeTimer)
    await Promise.all(
      [...record.pendingTunes.values()].map((pending) =>
        pending.promise.catch(() => undefined)
      )
    )
    await record.operation.catch(() => undefined)
    await this.workers
      .releaseSession(record.channelId, record.leaseId)
      .catch(() => undefined)
    await this.files.removeSession(sessionId).catch((error) => {
      console.warn(
        `Virtual tuner ${sessionId} cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    })
  }

  descriptorForClient(clientId: string): VirtualTunerDescriptor | null {
    const sessionId = this.clientSessions.get(clientId)
    const record = sessionId ? this.sessions.get(sessionId) : undefined
    return record && !record.closed ? this.describe(record) : null
  }

  private async openForOwner(
    clientId: string,
    ownerId: string,
    ownerEpoch: number,
    channelId: string,
    opening: VirtualTunerOpening
  ): Promise<VirtualTunerDescriptor> {
    const existingId = this.clientSessions.get(clientId)
    const existing = existingId ? this.sessions.get(existingId) : undefined
    if (existing && !existing.closed) {
      if (existing.ownerId !== ownerId) {
        await this.close(existing.sessionId)
        this.assertOpeningCurrent(clientId, opening)
      } else {
        this.refreshRecord(existing)
        // Reopen is also the recovery path after a stable-manifest 503. Even a
        // same-channel tuner must prove a newer live edge rather than returning
        // the descriptor for a dead static window.
        let descriptor: VirtualTunerDescriptor
        try {
          descriptor = await this.retuneForOpen(existing, channelId, opening)
        } catch (error) {
          if (
            !(error instanceof VirtualTunerStaleRequestError) &&
            !opening.cancelled &&
            this.openings.get(clientId) === opening &&
            this.sessions.get(existing.sessionId) === existing
          ) {
            await this.close(existing.sessionId)
          }
          throw error
        }
        this.assertOpeningCurrent(clientId, opening)
        return descriptor
      }
    }
    return this.openOnce(clientId, ownerId, ownerEpoch, channelId, opening)
  }

  private async openOnce(
    clientId: string,
    ownerId: string,
    ownerEpoch: number,
    channelId: string,
    opening: VirtualTunerOpening
  ): Promise<VirtualTunerDescriptor> {
    const sessionId = randomUUID()
    const record: VirtualTunerRecord = {
      sessionId,
      clientId,
      ownerId,
      ownerEpoch,
      leaseId: `tuner:${sessionId}`,
      channelId,
      revision: 1,
      nextSequence: 1,
      nextOutputId: 1,
      entries: [],
      retained: [],
      discontinuitySequence: 0,
      targetDurationSeconds: 0,
      lastEdgeAdvancedAt: this.clock.now().getTime(),
      sourceKeys: new Set(),
      cleanupPending: new Set(),
      expiresAt: 0,
      closeTimer: undefined,
      closed: false,
      highestRequestId: -1,
      lastCommittedRequestId: -1,
      transportMode: 'unknown',
      pendingTunes: new Map(),
      operation: Promise.resolve(),
    }
    try {
      await this.files.prepareSession(sessionId)
      this.assertOpeningCurrent(clientId, opening)
      await this.workers.holdSession(channelId, record.leaseId)
      this.assertOpeningCurrent(clientId, opening)
      const worker = await this.workers.whenReady(channelId)
      this.assertWorkerReady(worker)
      this.assertOpeningCurrent(clientId, opening)
      const parsed = await this.readReadyEdge(
        channelId,
        undefined,
        undefined,
        worker.startedAt ? Date.parse(worker.startedAt) : 0
      )
      this.assertOpeningCurrent(clientId, opening)
      record.targetDurationSeconds = playlistTargetDuration(parsed)
      const staged = await this.preserveParsed(
        record,
        channelId,
        record.revision,
        preparedLiveEdge(parsed, this.minimumReadySegments),
        false
      )
      this.assertOpeningCurrent(clientId, opening)
      await this.commitStaged(record, staged)
      record.lastEdgeAdvancedAt = this.clock.now().getTime()
      this.rememberSourceSnapshot(
        record,
        channelId,
        record.revision,
        parsed
      )
      this.assertOpeningCurrent(clientId, opening)
      this.sessions.set(sessionId, record)
      this.clientSessions.set(clientId, sessionId)
      this.refreshRecord(record)
      return this.describe(record)
    } catch (error) {
      record.closed = true
      await this.workers
        .releaseSession(channelId, record.leaseId)
        .catch(() => undefined)
      await this.files.removeSession(sessionId).catch(() => undefined)
      throw error
    }
  }

  private async retuneForOpen(
    record: VirtualTunerRecord,
    channelId: string,
    opening: VirtualTunerOpening
  ): Promise<VirtualTunerDescriptor> {
    // Visibility/recovery opens are an internal health operation. They must
    // never consume the public request-ID namespace because the TV cannot
    // learn the new floor until this request returns. Snapshot that namespace
    // instead; any real zap that reserves an ID supersedes this work.
    const requestIdFloor = record.highestRequestId
    const isCurrent = () =>
      !record.closed &&
      this.sessions.get(record.sessionId) === record &&
      !opening.cancelled &&
      this.openings.get(record.clientId) === opening &&
      record.highestRequestId === requestIdFloor &&
      record.pendingTunes.size === 0
    if (!isCurrent()) throw new VirtualTunerStaleRequestError()

    if (channelId === record.channelId) {
      const worker = await this.workers.whenReady(channelId)
      this.assertWorkerReady(worker)
      const observedCursor = record.sourceCursor?.lastSequence ?? -1
      const parsed = await this.readReadyEdge(
        channelId,
        isCurrent,
        (candidate) =>
          (candidate.segments.at(-1)?.sourceSequence ?? -1) > observedCursor,
        worker.startedAt ? Date.parse(worker.startedAt) : 0
      )
      if (!isCurrent()) throw new VirtualTunerStaleRequestError()
      return this.withLock(record, async () => {
        if (!isCurrent()) throw new VirtualTunerStaleRequestError()
        const edge = await this.stageParsedCurrentEdge(record, parsed)
        if (edge.staged.segments.length > 0) {
          record.revision = edge.revision
          await this.commitStaged(record, edge.staged)
          record.lastEdgeAdvancedAt = this.clock.now().getTime()
        }
        this.rememberSourceSnapshot(record, channelId, edge.revision, parsed)
        this.assertFreshEdge(record)
        if (!isCurrent()) throw new VirtualTunerStaleRequestError()
        this.refreshRecord(record)
        return this.describe(record)
      })
    }

    const candidateLeaseId = `${record.leaseId}:reopen:${randomUUID()}`
    await this.workers.holdSession(channelId, candidateLeaseId)
    try {
      const worker = await this.workers.whenReady(channelId)
      this.assertWorkerReady(worker)
      const parsed = await this.readReadyEdge(
        channelId,
        isCurrent,
        undefined,
        worker.startedAt ? Date.parse(worker.startedAt) : 0
      )
      this.assertCompatibleTargetDuration(record, parsed)
      if (!isCurrent()) throw new VirtualTunerStaleRequestError()
      return await this.withLock(record, async () => {
        if (!isCurrent()) throw new VirtualTunerStaleRequestError()
        const previousChannelId = record.channelId
        const nextRevision = record.revision + 1
        const staged = await this.preserveParsed(
          record,
          channelId,
          nextRevision,
          preparedLiveEdge(parsed, this.minimumReadySegments),
          true
        )
        let committed = false
        let transitioned = false
        try {
          if (!isCurrent()) throw new VirtualTunerStaleRequestError()
          await this.workers.holdSession(channelId, record.leaseId)
          if (!isCurrent()) throw new VirtualTunerStaleRequestError()
          record.channelId = channelId
          record.revision = nextRevision
          transitioned = true
          record.sourceKeys.clear()
          await this.commitStaged(record, staged, true)
          committed = true
          record.lastEdgeAdvancedAt = this.clock.now().getTime()
          this.rememberSourceSnapshot(record, channelId, nextRevision, parsed)
          if (!isCurrent()) throw new VirtualTunerStaleRequestError()
          this.refreshRecord(record)
          await this.workers
            .releaseSession(previousChannelId, record.leaseId)
            .catch(() => undefined)
          return this.describe(record)
        } catch (error) {
          if (!committed) await this.discardStaged(record, staged)
          if (transitioned) {
            await this.workers
              .releaseSession(previousChannelId, record.leaseId)
              .catch(() => undefined)
          }
          if (record.channelId !== channelId) {
            await this.workers
              .releaseSession(channelId, record.leaseId)
              .catch(() => undefined)
          }
          throw error
        }
      })
    } finally {
      await this.workers
        .releaseSession(channelId, candidateLeaseId)
        .catch(() => undefined)
    }
  }

  private async tuneConcurrent(
    record: VirtualTunerRecord,
    channelId: string,
    requestId: number
  ): Promise<VirtualTunerTuneResult> {
    if (record.closed || this.sessions.get(record.sessionId) !== record) {
      throw new VirtualTunerSessionNotFoundError()
    }
    if (requestId !== record.highestRequestId) {
      throw new VirtualTunerStaleRequestError()
    }
    if (channelId === record.channelId) {
      const worker = await this.workers.whenReady(channelId)
      this.assertWorkerReady(worker)
      const observedCursor = record.sourceCursor?.lastSequence ?? -1
      const parsed = await this.readReadyEdge(
        channelId,
        () => !record.closed && requestId === record.highestRequestId,
        (candidate) =>
          (candidate.segments.at(-1)?.sourceSequence ?? -1) > observedCursor,
        worker.startedAt ? Date.parse(worker.startedAt) : 0
      )
      this.assertCurrentRequest(record, requestId)
      return this.withLock(record, async () => {
        this.assertCurrentRequest(record, requestId)
        const edge = await this.stageParsedCurrentEdge(record, parsed)
        if (edge.staged.segments.length > 0) {
          record.revision = edge.revision
          await this.commitStaged(record, edge.staged)
          record.lastEdgeAdvancedAt = this.clock.now().getTime()
        }
        this.rememberSourceSnapshot(
          record,
          channelId,
          edge.revision,
          parsed
        )
        this.assertFreshEdge(record)
        this.assertCurrentRequest(record, requestId)
        const result = this.rememberCommittedTune(record, requestId)
        this.refreshRecord(record)
        return result
      })
    }

    // Candidate holds are request-scoped: releasing a superseded attempt can
    // never remove the newer request's hold, even when both target one channel.
    const candidateLeaseId = `${record.leaseId}:candidate:${requestId}`
    await this.workers.holdSession(channelId, candidateLeaseId)
    try {
      const worker = await this.workers.whenReady(channelId)
      this.assertWorkerReady(worker)
      const parsed = await this.readReadyEdge(
        channelId,
        () => !record.closed && requestId === record.highestRequestId,
        undefined,
        worker.startedAt ? Date.parse(worker.startedAt) : 0
      )
      this.assertCompatibleTargetDuration(record, parsed)
      this.assertCurrentRequest(record, requestId)

      return await this.withLock(record, async () => {
        this.assertCurrentRequest(record, requestId)
        const previousChannelId = record.channelId
        if (previousChannelId === channelId) {
          const result = this.rememberCommittedTune(record, requestId)
          this.refreshRecord(record)
          return result
        }

        const nextRevision = record.revision + 1
        const staged = await this.preserveParsed(
          record,
          channelId,
          nextRevision,
          preparedLiveEdge(parsed, this.minimumReadySegments),
          true
        )
        let committed = false
        let transitioned = false
        try {
          // Segment preservation can yield to a newer request. The following
          // check is the atomic manifest commit boundary.
          this.assertCurrentRequest(record, requestId)
          await this.workers.holdSession(channelId, record.leaseId)
          this.assertCurrentRequest(record, requestId)
          record.channelId = channelId
          record.revision = nextRevision
          transitioned = true
          record.sourceKeys.clear()
          // A seamless splice shares one decoder timeline with the outgoing
          // window, so that window must keep sliding normally. Dropping the
          // entries the player is currently positioned in would show a native
          // reader an unexplained media-sequence jump with nothing marking it,
          // which is exactly the resync this mode exists to avoid.
          await this.commitStaged(
            record,
            staged,
            staged.transportMode !== 'seamless'
          )
          committed = true
          record.lastEdgeAdvancedAt = this.clock.now().getTime()
          this.rememberSourceSnapshot(
            record,
            channelId,
            nextRevision,
            parsed
          )
          this.assertCurrentRequest(record, requestId)
          const result = this.rememberCommittedTune(record, requestId)
          this.refreshRecord(record)
          await this.workers
            .releaseSession(previousChannelId, record.leaseId)
            .catch(() => undefined)
          return result
        } catch (error) {
          if (!committed) await this.discardStaged(record, staged)
          if (transitioned) {
            // The record now owns the target durable lease. Its outgoing lease
            // is no longer represented by record.channelId, so close() cannot
            // discover it after a close/supersession raced the async commit.
            await this.workers
              .releaseSession(previousChannelId, record.leaseId)
              .catch(() => undefined)
          }
          // If the durable target hold was acquired but never became current,
          // release it without disturbing the outgoing durable channel hold.
          if (record.channelId !== channelId) {
            await this.workers
              .releaseSession(channelId, record.leaseId)
              .catch(() => undefined)
          }
          throw error
        }
      })
    } finally {
      await this.workers
        .releaseSession(channelId, candidateLeaseId)
        .catch(() => undefined)
    }
  }

  private async readReadyEdge(
    channelId: string,
    isCurrent?: () => boolean,
    isAcceptable?: (playlist: ParsedSourcePlaylist) => boolean,
    minimumModifiedAtMs = 0,
    allowRecovery = true
  ): Promise<ParsedSourcePlaylist> {
    let lastError: unknown
    for (let attempt = 0; attempt < this.readinessAttempts; attempt += 1) {
      if (isCurrent && !isCurrent()) throw new VirtualTunerStaleRequestError()
      try {
        const parsed = parseSourcePlaylist(
          await this.files.readChannelPlaylist(channelId)
        )
        if (parsed.segments.length < this.minimumReadySegments) {
          throw new Error('Source playlist does not contain enough complete segments')
        }
        await this.assertSourcePresentationFresh(
          channelId,
          parsed,
          minimumModifiedAtMs
        )
        if (isAcceptable && !isAcceptable(parsed)) {
          throw new Error('Source playlist live edge has not advanced')
        }
        return parsed
      } catch (error) {
        lastError = error
        if (attempt + 1 < this.readinessAttempts) {
          await this.sleep(this.readinessDelayMs)
        }
      }
    }
    if (allowRecovery && this.workers.restart) {
      if (isCurrent && !isCurrent()) throw new VirtualTunerStaleRequestError()
      const recovered = await this.restartWorker(
        channelId,
        'Shared HLS live edge stopped advancing or became stale'
      )
      if (recovered) this.assertWorkerReady(recovered)
      return this.readReadyEdge(
        channelId,
        isCurrent,
        isAcceptable,
        recovered?.startedAt
          ? Date.parse(recovered.startedAt)
          : minimumModifiedAtMs,
        false
      )
    }
    throw new VirtualTunerUnavailableError(
      lastError instanceof Error
        ? `Channel presentation is not ready: ${lastError.message}`
        : 'Channel presentation is not ready'
    )
  }

  private restartWorker(
    channelId: string,
    reason: string
  ): Promise<ContinuousChannelWorkerState | null> {
    const current = this.recoveries.get(channelId)
    if (current) return current
    const recovery = this.workers.restart!(channelId, reason)
    this.recoveries.set(channelId, recovery)
    void recovery.finally(() => {
      if (this.recoveries.get(channelId) === recovery) {
        this.recoveries.delete(channelId)
      }
    }).catch(() => undefined)
    return recovery
  }

  private async stageCurrentEdge(
    record: VirtualTunerRecord
  ): Promise<CurrentEdgeStage> {
    const parsed = parseSourcePlaylist(
      await this.files.readChannelPlaylist(record.channelId)
    )
    if (parsed.segments.length < this.minimumReadySegments) {
      throw new Error('Source playlist does not contain enough complete segments')
    }
    await this.assertSourcePresentationFresh(record.channelId, parsed, 0)
    return this.stageParsedCurrentEdge(record, parsed)
  }

  private async assertSourcePresentationFresh(
    channelId: string,
    parsed: ParsedSourcePlaylist,
    minimumModifiedAtMs: number
  ): Promise<void> {
    if (!this.files.sourcePresentationIsFresh) return
    const newestNames = [
      ...new Set(
        parsed.segments
          .slice(-this.minimumReadySegments)
          .map((segment) => segment.sourceName)
      ),
    ]
    const maximumAgeMs = Math.max(
      5_000,
      playlistTargetDuration(parsed) * 3_000
    )
    if (
      newestNames.length < this.minimumReadySegments ||
      !(await this.files.sourcePresentationIsFresh(
        channelId,
        newestNames,
        maximumAgeMs,
        Number.isFinite(minimumModifiedAtMs) ? minimumModifiedAtMs : 0
      ))
    ) {
      throw new Error('Source playlist or newest segments are stale')
    }
  }

  private async stageParsedCurrentEdge(
    record: VirtualTunerRecord,
    parsed: ParsedSourcePlaylist
  ): Promise<CurrentEdgeStage> {
    this.assertCompatibleTargetDuration(record, parsed)
    let revision = record.revision
    let forceDiscontinuity = false
    const cursor = record.sourceCursor
    const firstSequence = parsed.segments[0]?.sourceSequence
    const lastSequence = parsed.segments.at(-1)?.sourceSequence
    if (
      cursor &&
      cursor.channelId === record.channelId &&
      cursor.revision === record.revision &&
      firstSequence !== undefined &&
      lastSequence !== undefined
    ) {
      if (lastSequence < cursor.lastSequence) {
        // ToastTV starts every worker from an epoch-derived increasing media
        // sequence. A lower edge inside one process-local tuner session is a
        // torn/old manifest read, not a legitimate reset to replay.
        throw new Error('Source playlist media sequence regressed')
      } else {
        const firstNew = parsed.segments.find(
          (segment) => segment.sourceSequence > cursor.lastSequence
        )
        if (
          firstNew &&
          firstNew.sourceSequence > cursor.lastSequence + 1
        ) {
          // The relay missed part of the worker's sliding window. Never join
          // that timestamp gap without a discontinuity marker.
          forceDiscontinuity = true
        }
      }
    }
    return {
      parsed,
      revision,
      staged: await this.preserveParsed(
        record,
        record.channelId,
        revision,
        parsed,
        forceDiscontinuity
      ),
    }
  }

  /**
   * The initial attach and every channel switch publish only the newest couple
   * of segments. Remember the entire source snapshot so an immediate manifest
   * refresh cannot append older entries after that live edge. Rebuilding from
   * the bounded source window plus retained virtual entries also prevents this
   * de-duplication set from growing during 24/7 playback.
   */
  private rememberSourceSnapshot(
    record: VirtualTunerRecord,
    channelId: string,
    revision: number,
    parsed: ParsedSourcePlaylist
  ): void {
    const remembered = new Set<string>()
    for (const source of parsed.segments) {
      remembered.add(`${revision}:${channelId}:${source.sourceName}`)
    }
    for (const segment of [...record.entries, ...record.retained]) {
      remembered.add(segment.sourceKey)
    }
    record.sourceKeys = remembered
    const lastSequence = parsed.segments.at(-1)?.sourceSequence
    if (lastSequence !== undefined) {
      record.sourceCursor = { channelId, revision, lastSequence }
    }
  }

  private async preserveParsed(
    record: VirtualTunerRecord,
    channelId: string,
    revision: number,
    parsed: ParsedSourcePlaylist,
    forceDiscontinuity: boolean
  ): Promise<StagedSegments> {
    // Entries already published on a rewritten clock cannot be followed by raw
    // source bytes without a marker: that is a real timestamp reset, and an
    // unsignalled one strands the decoder for the rest of the session.
    const continuingClock =
      record.transportState?.nextTimestamp90k !== undefined
    if (
      this.files.spliceSegment &&
      // A guarded discontinuity is already being published here, so this is the
      // one safe place to retry splicing after a transient incompatibility
      // latched the session into discontinuity mode.
      (record.transportMode !== 'discontinuity' || forceDiscontinuity)
    ) {
      try {
        return await this.preserveParsedMode(
          record,
          channelId,
          revision,
          parsed,
          forceDiscontinuity,
          true
        )
      } catch (error) {
        if (!(error instanceof MpegTsTransportIncompatibleError)) throw error
        console.info(
          `Virtual tuner ${record.sessionId} is using a discontinuity for ${channelId}: ${error.message}`
        )
      }
    }
    return this.preserveParsedMode(
      record,
      channelId,
      revision,
      parsed,
      forceDiscontinuity || continuingClock,
      false
    )
  }

  private async preserveParsedMode(
    record: VirtualTunerRecord,
    channelId: string,
    revision: number,
    parsed: ParsedSourcePlaylist,
    forceDiscontinuity: boolean,
    seamless: boolean
  ): Promise<StagedSegments> {
    const staged: VirtualSegment[] = []
    let transportState: MpegTsTransportState = record.transportState ?? {
      continuityCounters: {},
    }
    // Seamless output is only continuous when it extends an established clock.
    // Re-arming after a discontinuity latch starts a new one, so that first
    // boundary still needs its marker.
    const continuingClock = transportState.nextTimestamp90k !== undefined
    try {
      for (const source of parsed.segments) {
        const sourceKey = `${revision}:${channelId}:${source.sourceName}`
        if (record.sourceKeys.has(sourceKey)) continue
        // Reserve names before filesystem work and never roll the counter back.
        // If cleanup of a superseded attempt fails, no later channel can treat
        // those old bytes as its own segment via an EEXIST collision.
        const sequence = record.nextSequence + staged.length
        const outputId = record.nextOutputId
        record.nextOutputId += 1
        const outputName = `segment-${String(outputId).padStart(13, '0')}.ts`
        if (seamless && this.files.spliceSegment) {
          transportState = await this.files.spliceSegment(
            channelId,
            source.sourceName,
            record.sessionId,
            outputName,
            source.durationSeconds,
            transportState
          )
        } else {
          await this.files.preserveSegment(
            channelId,
            source.sourceName,
            record.sessionId,
            outputName
          )
        }
        staged.push({
          sequence,
          outputName,
          sourceKey,
          durationSeconds: source.durationSeconds,
          discontinuityBefore: seamless
            ? !continuingClock && forceDiscontinuity && staged.length === 0
            : (forceDiscontinuity && staged.length === 0) ||
              source.discontinuityBefore,
        })
      }
      return {
        segments: staged,
        nextSequence: record.nextSequence + staged.length,
        transportState: seamless ? transportState : undefined,
        transportMode: seamless ? 'seamless' : 'discontinuity',
      }
    } catch (error) {
      await this.cleanupSegments(
        record,
        staged.map((segment) => segment.outputName)
      )
      throw error
    }
  }

  private async commitStaged(
    record: VirtualTunerRecord,
    staged: StagedSegments,
    replaceAdvertised = false
  ): Promise<void> {
    record.nextSequence = staged.nextSequence
    record.transportState = staged.transportState
    record.transportMode = staged.transportMode
    for (const segment of staged.segments) record.sourceKeys.add(segment.sourceKey)
    // A discontinuity commit is a hard live-window cut. Keeping the outgoing
    // entries advertised lets a lagging native HLS player continue requesting
    // the old channel after the tune response has already identified the new
    // one. Retain their bytes for requests already in flight, but make the
    // prepared destination edge the only playable window for the next reload.
    // Seamless commits pass false here: their target shares the outgoing
    // timeline, so the window has to slide instead of being cut.
    const replaced = replaceAdvertised
      ? record.entries.splice(0, record.entries.length)
      : []
    record.entries.push(...staged.segments)
    const overflow = record.entries.splice(
      0,
      Math.max(0, record.entries.length - this.playlistWindowSegments)
    )
    const retiredNow = [...replaced, ...overflow]
    record.discontinuitySequence += retiredNow.filter(
      (segment) => segment.discontinuityBefore
    ).length
    record.retained.push(...retiredNow)
    const remove = record.retained.splice(
      0,
      Math.max(0, record.retained.length - this.retainedSegmentCount)
    )
    for (const segment of remove) record.sourceKeys.delete(segment.sourceKey)
    await this.cleanupSegments(
      record,
      remove.map((segment) => segment.outputName)
    )
  }

  private async discardStaged(
    record: VirtualTunerRecord,
    staged: StagedSegments
  ): Promise<void> {
    await this.cleanupSegments(
      record,
      staged.segments.map((segment) => segment.outputName)
    )
  }

  private async cleanupSegments(
    record: VirtualTunerRecord,
    outputNames: readonly string[]
  ): Promise<void> {
    const names = new Set([...record.cleanupPending, ...outputNames])
    record.cleanupPending.clear()
    for (const outputName of names) {
      try {
        await this.files.removeSegment(record.sessionId, outputName)
      } catch {
        record.cleanupPending.add(outputName)
      }
    }
    const retryLimit = this.retainedSegmentCount + this.playlistWindowSegments
    if (record.cleanupPending.size > retryLimit) {
      console.warn(
        `Virtual tuner ${record.sessionId} has ${record.cleanupPending.size} segment cleanup failures; closing the session`
      )
      queueMicrotask(() => void this.close(record.sessionId))
      throw new VirtualTunerUnavailableError(
        'Virtual tuner segment cleanup repeatedly failed'
      )
    }
  }

  private assertCurrentRequest(
    record: VirtualTunerRecord,
    requestId: number
  ): void {
    if (
      record.closed ||
      this.sessions.get(record.sessionId) !== record
    ) {
      throw new VirtualTunerSessionNotFoundError()
    }
    if (requestId !== record.highestRequestId) {
      throw new VirtualTunerStaleRequestError()
    }
  }

  private assertOpeningCurrent(
    clientId: string,
    opening: VirtualTunerOpening
  ): void {
    if (opening.cancelled || this.openings.get(clientId) !== opening) {
      throw new VirtualTunerStaleRequestError(
        'A newer app launch superseded this tuner open'
      )
    }
  }

  private assertCompatibleTargetDuration(
    record: VirtualTunerRecord,
    playlist: ParsedSourcePlaylist
  ): void {
    const required = playlistTargetDuration(playlist)
    if (required > record.targetDurationSeconds) {
      throw new VirtualTunerUnavailableError(
        `Channel segments require target duration ${required}, but this stable session is fixed at ${record.targetDurationSeconds}`
      )
    }
  }

  private edgeIsStale(record: VirtualTunerRecord): boolean {
    return (
      this.clock.now().getTime() - record.lastEdgeAdvancedAt >
      this.staleEdgeGraceMs
    )
  }

  private assertFreshEdge(record: VirtualTunerRecord): void {
    if (this.edgeIsStale(record)) {
      throw new VirtualTunerUnavailableError(
        'Channel source playlist stopped advancing'
      )
    }
  }

  private refreshRecord(record: VirtualTunerRecord): void {
    this.clock.clearTimeout(record.closeTimer)
    const expectedExpiresAt = this.clock.now().getTime() + this.ttlMs
    record.expiresAt = expectedExpiresAt
    record.closeTimer = this.clock.setTimeout(() => {
      if (
        !record.closed &&
        this.sessions.get(record.sessionId) === record &&
        record.expiresAt === expectedExpiresAt
      ) {
        void this.close(record.sessionId)
      }
    }, this.ttlMs)
    this.workers.refreshSession(record.channelId, record.leaseId)
  }

  private describe(record: VirtualTunerRecord): VirtualTunerDescriptor {
    return {
      mode: 'stable-hls',
      sessionId: record.sessionId,
      manifestUrl: `${this.manifestBasePath}/${encodeURIComponent(record.sessionId)}/live/index.m3u8`,
      channelId: record.channelId,
      revision: record.revision,
      requestIdFloor: record.highestRequestId,
    }
  }

  private rememberCommittedTune(
    record: VirtualTunerRecord,
    requestId: number
  ): VirtualTunerTuneResult {
    const first = record.entries[0]
    const last = record.entries.at(-1)
    if (!first || !last) {
      throw new VirtualTunerUnavailableError(
        'Virtual tuner committed an empty switch window'
      )
    }
    const switchBoundary: VirtualTunerSwitchBoundary = Object.freeze({
      revision: record.revision,
      firstMediaSequence: first.sequence,
      lastMediaSequence: last.sequence,
      segmentCount: record.entries.length,
      targetDurationSeconds: record.targetDurationSeconds,
      durationSeconds: record.entries.reduce(
        (total, entry) => total + entry.durationSeconds,
        0
      ),
      transportMode:
        record.transportMode === 'seamless' ? 'seamless' : 'discontinuity',
    })
    const result: VirtualTunerTuneResult = Object.freeze({
      ...this.describe(record),
      requestId,
      switchBoundary,
    })
    record.lastCommittedRequestId = requestId
    record.lastCommittedTune = result
    return result
  }

  private async withLock<T>(
    record: VirtualTunerRecord,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = record.operation
    let release!: () => void
    record.operation = new Promise<void>((resolve) => (release = resolve))
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private assertWorkerReady(worker: ContinuousChannelWorkerState): void {
    if (!isStreamableChannelWorkerState(worker)) {
      throw new VirtualTunerUnavailableError(
        worker.lastError ?? `Channel encoder is ${worker.status}`
      )
    }
  }

  private assertClientId(clientId: string): void {
    if (!SAFE_CLIENT_ID.test(clientId)) {
      throw new Error('Client ID is not a safe virtual tuner identifier')
    }
  }

  private assertOwnerId(ownerId: string): void {
    if (!SAFE_OWNER_ID.test(ownerId)) {
      throw new Error('Owner ID is not a safe virtual tuner identifier')
    }
  }

  private assertSessionId(sessionId: string): void {
    if (!SAFE_SESSION_ID.test(sessionId)) {
      throw new VirtualTunerSessionNotFoundError()
    }
  }

  private assertAvailableChannel(channelId: string): void {
    if (
      !SAFE_CHANNEL_ID.test(channelId) ||
      !this.availableChannelIds().includes(channelId)
    ) {
      throw new VirtualTunerUnavailableError('Channel is not currently on air')
    }
  }
}

/** Parses only the constrained TS playlist emitted by ToastTV's shared workers. */
export function parseSourcePlaylist(text: string): ParsedSourcePlaylist {
  if (!/^#EXTM3U(?:\r?\n|$)/.test(text)) {
    throw new Error('Source playlist is torn or malformed')
  }
  const lines = text.split(/\r?\n/)
  let targetDurationSeconds = 1
  let mediaSequence: number | undefined
  let mediaOrdinal = 0
  let durationSeconds: number | undefined
  let discontinuityBefore = false
  const segments: ParsedSourceSegment[] = []
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      const parsed = Number(line.slice('#EXT-X-TARGETDURATION:'.length))
      if (Number.isFinite(parsed) && parsed > 0) targetDurationSeconds = parsed
      continue
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const parsed = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length))
      if (Number.isSafeInteger(parsed) && parsed >= 0) mediaSequence = parsed
      continue
    }
    if (line === '#EXT-X-DISCONTINUITY') {
      discontinuityBefore = true
      continue
    }
    if (line.startsWith('#EXTINF:')) {
      if (durationSeconds !== undefined) {
        throw new Error('Source playlist has overlapping media entries')
      }
      const parsed = Number(line.slice('#EXTINF:'.length).split(',')[0])
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('Source playlist has an invalid media duration')
      }
      durationSeconds = parsed
      continue
    }
    if (!line || line.startsWith('#')) continue
    const sourceMatch = SOURCE_SEGMENT_NAME.exec(line)
    if (durationSeconds === undefined) {
      throw new Error('Source playlist has a media URI without EXTINF')
    }
    if (!sourceMatch) {
      throw new Error('Source playlist has an unsafe media URI')
    }
    segments.push({
      sourceName: line,
      sourceSequence:
        mediaSequence !== undefined
          ? mediaSequence + mediaOrdinal
          : Number(sourceMatch[1]),
      durationSeconds,
      discontinuityBefore,
    })
    mediaOrdinal += 1
    durationSeconds = undefined
    discontinuityBefore = false
  }
  if (durationSeconds !== undefined) {
    throw new Error('Source playlist has a dangling EXTINF entry')
  }
  return { targetDurationSeconds, segments }
}

function preparedLiveEdge(
  playlist: ParsedSourcePlaylist,
  minimumCount: number
): ParsedSourcePlaylist {
  return {
    targetDurationSeconds: playlist.targetDurationSeconds,
    // Do not wait for extra source segments: publish up to the preferred
    // cushion from the complete entries already present in this snapshot.
    // Subsequent stable-manifest polls append future worker segments.
    segments: playlist.segments.slice(
      -Math.max(2, minimumCount, PREFERRED_JOIN_SEGMENTS)
    ),
  }
}

export function renderVirtualPlaylist(
  entries: readonly Pick<
    VirtualSegment,
    'sequence' | 'outputName' | 'durationSeconds' | 'discontinuityBefore'
  >[],
  discontinuitySequence = 0,
  fixedTargetDurationSeconds?: number
): string {
  if (entries.length === 0) throw new Error('Virtual tuner has no segments')
  const requiredTargetDuration = Math.max(
    1,
    ...entries.map((entry) => Math.ceil(entry.durationSeconds))
  )
  const targetDuration = fixedTargetDurationSeconds ?? requiredTargetDuration
  if (targetDuration < requiredTargetDuration) {
    throw new Error('Fixed target duration is shorter than a media segment')
  }
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    `#EXT-X-MEDIA-SEQUENCE:${entries[0]!.sequence}`,
    // RFC 8216 requires this sequence once a discontinuity rolls out of a live
    // sliding window. Older LG documentation does not list the tag, but HLS
    // clients must ignore unknown tags; omitting it would make timestamp resets
    // ambiguous. Keep it standards-valid and verify the relay on physical TVs.
    `#EXT-X-DISCONTINUITY-SEQUENCE:${Math.max(0, discontinuitySequence)}`,
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-START:TIME-OFFSET=-2.0,PRECISE=YES',
  ]
  for (const entry of entries) {
    if (entry.discontinuityBefore) lines.push('#EXT-X-DISCONTINUITY')
    lines.push(`#EXTINF:${formatDuration(entry.durationSeconds)},`)
    lines.push(entry.outputName)
  }
  return `${lines.join('\n')}\n`
}

function playlistTargetDuration(playlist: ParsedSourcePlaylist): number {
  return Math.max(
    1,
    Math.ceil(playlist.targetDurationSeconds),
    ...playlist.segments.map((segment) => Math.ceil(segment.durationSeconds))
  )
}

function formatDuration(value: number): string {
  return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}
