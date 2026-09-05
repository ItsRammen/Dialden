export type ChannelWorkerStatus =
  | 'starting'
  | 'live'
  | 'transitioning'
  | 'idle'
  | 'error'
  | 'stopped'

export interface ChannelTimelinePosition {
  readonly scheduleItemId: string
  readonly nextScheduleItemId?: string
  readonly sourcePath: string
  readonly sourceOffsetSeconds: number
  readonly sourceDurationSeconds?: number
  /** Set false for silent media so the pipeline synthesizes normalized audio. */
  readonly hasAudio?: boolean
  /** Zero-based audio-stream ordinal selected from the source container. */
  readonly audioStreamIndex?: number
  /**
   * 'hw' marks a source the hardware decoder is known to handle. Currently
   * dormant: per-input QSV decode produced exit-218 failures under lineup
   * contention, so factories decode everything on CPU and use QSV for the
   * final encode only. Hints are still derived (bit-depth gated) so a
   * measured re-enable attempt needs no resolver changes.
   */
  readonly decodeHint?: 'hw' | 'sw'
  /**
   * Source geometry, so a hardware graph can compute its own letterbox. vpp_qsv
   * has no aspect-preserving fit, so the pad is a composite at fixed offsets
   * and those offsets have to be known before the command is built. Undefined
   * for a row the library has not measured.
   */
  readonly sourceWidth?: number
  readonly sourceHeight?: number
  /** Loop a finite emergency asset until the scheduled replacement range ends. */
  readonly loopSource?: boolean
  readonly timelineRevision: string
  readonly type:
    | 'program'
    | 'movie'
    | 'bumper'
    | 'ident'
    | 'interlude'
    | 'short'
    | 'offair'
}

export interface ChannelTimelineResolver {
  resolve(channelId: string, at: Date): Promise<ChannelTimelinePosition | null>
  /** Ordered current + lookahead items consumed without restarting the HLS output. */
  resolveWindow?(
    channelId: string,
    at: Date,
    minimumItems: number
  ): Promise<readonly ChannelTimelinePosition[]>
  fallback?(
    channelId: string,
    missing: ChannelTimelinePosition | null,
    at: Date
  ): Promise<ChannelTimelinePosition | null>
  /**
   * Human-readable, path-safe detail for the most recent empty resolution.
   * Implementations should not expose absolute media paths here.
   */
  unavailableReason?(channelId: string): string | null
}

export interface ChannelWorkerClock {
  now(): Date
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ChannelWorkerFiles {
  prepareOutput(directory: string): Promise<void> | void
  sourceExists(path: string): Promise<boolean> | boolean
  /** Remove orphaned/expired output while preserving the active rolling window. */
  cleanupOutput(directory: string): Promise<void> | void
  /** Wait for a fresh playlist whose complete entries reference usable segments. */
  waitForFreshSegment?(
    directory: string,
    minimumModifiedAt: number,
    isCurrent?: () => boolean,
    minimumSegmentCount?: number
  ): Promise<void> | void
}

export interface ChannelPipelineExit {
  readonly code: number | null
  readonly signal?: string
  readonly error?: string
}

export interface ChannelPipelineHandle {
  readonly completed: Promise<ChannelPipelineExit>
  stop(): Promise<void> | void
  /** The FFmpeg process, so its CPU time can be attributed to this channel. */
  readonly pid?: number
}

export interface ChannelPipelineRequest {
  readonly channelId: string
  readonly outputDirectory: string
  readonly playlistPath: string
  readonly playlistUrl: string
  readonly position: ChannelTimelinePosition
  /**
   * Ordered normalized sources for the persistent feeder/segmenter. A factory
   * must transition through this sequence without replacing the playlist.
   */
  readonly sequence: readonly ChannelTimelinePosition[]
  readonly profile: ContinuousHlsProfile
  /** Existing output must be appended to atomically; never replace the URL. */
  /** False for a cold worker so stale playlists are replaced before tuning. */
  readonly appendToExistingPlaylist: boolean
}

export interface ChannelPipelineFactory {
  start(request: ChannelPipelineRequest): Promise<ChannelPipelineHandle>
}

export interface ContinuousHlsProfile {
  readonly videoCodec: 'h264'
  readonly audioCodec: 'aac'
  readonly audioChannels: 2
  readonly segmentSeconds: number
  readonly playlistWindowSegments: number
  readonly maximumWidth: number
  readonly maximumHeight: number
}

export interface ContinuousChannelWorkerState {
  readonly channelId: string
  readonly status: ChannelWorkerStatus
  readonly viewerCount: number
  /** True when an open lineup session — not a direct viewer — holds this worker. */
  readonly sessionHeld?: boolean
  readonly currentScheduleItemId?: string
  readonly nextScheduleItemId?: string
  readonly sourceOffsetSeconds?: number
  readonly timelineRevision?: string
  readonly startedAt?: string
  readonly outputUrl: string
  readonly transcoding: boolean
  readonly usingFallback: boolean
  readonly idleSince?: string
  readonly lastError?: string
}

/** Only these settled states have a validated, actively published HLS output. */
export function isStreamableChannelWorkerState(
  state: Pick<ContinuousChannelWorkerState, 'status' | 'transcoding'>
): boolean {
  return (
    state.transcoding === true &&
    (state.status === 'live' || state.status === 'idle')
  )
}

export interface ContinuousChannelWorkerManagerOptions {
  readonly outputRoot: string
  readonly idleTimeoutMs?: number
  readonly restartDelayMs?: number
  readonly clientLeaseTtlMs?: number
  /** Maximum number of zero-viewer channels kept ready for fast tuning. */
  readonly maximumWarmChannels?: number
  readonly warmLeaseTtlMs?: number
  /** How long a session lease survives without a heartbeat refresh. */
  readonly sessionLeaseTtlMs?: number
  readonly maximumViewerLeasesPerChannel?: number
  readonly maximumWarmLeasesPerChannel?: number
  readonly maximumSessionLeasesPerChannel?: number
  readonly profile?: Partial<ContinuousHlsProfile>
}

interface WorkerRecord {
  state: ContinuousChannelWorkerState
  pipeline?: ChannelPipelineHandle
  stopping?: Promise<void>
  generation: number
  startup?: Promise<void>
  idleTimer?: unknown
  restartTimer?: unknown
  anonymousViewers: number
  leases: Map<string, { expiresAt: number; timer: unknown }>
  warmLeases: Map<string, { expiresAt: number; timer: unknown }>
  sessionLeases: Map<string, { expiresAt: number; timer: unknown }>
  lastWarmedAt?: number
  appendNextStart: boolean
}

const SYSTEM_CLOCK: ChannelWorkerClock = {
  now: () => new Date(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const DEFAULT_PROFILE: ContinuousHlsProfile = {
  videoCodec: 'h264',
  audioCodec: 'aac',
  audioChannels: 2,
  segmentSeconds: 1,
  playlistWindowSegments: 8,
  maximumWidth: 1920,
  maximumHeight: 1080,
}

/**
 * Owns one on-demand output pipeline per channel, regardless of viewer count.
 * The schedule remains authoritative: every start/restart resolves "now" again.
 */
export class ContinuousChannelWorkerManager {
  private readonly records = new Map<string, WorkerRecord>()
  private warmQueue: Promise<void> = Promise.resolve()
  private readonly idleTimeoutMs: number
  private readonly restartDelayMs: number
  private readonly profile: ContinuousHlsProfile
  private readonly clientLeaseTtlMs: number
  private readonly maximumWarmChannels: number
  private readonly warmLeaseTtlMs: number
  private readonly sessionLeaseTtlMs: number
  private readonly maximumViewerLeasesPerChannel: number
  private readonly maximumWarmLeasesPerChannel: number
  private readonly maximumSessionLeasesPerChannel: number

  constructor(
    private readonly timeline: ChannelTimelineResolver,
    private readonly pipelines: ChannelPipelineFactory,
    private readonly files: ChannelWorkerFiles,
    private readonly options: ContinuousChannelWorkerManagerOptions,
    private readonly clock: ChannelWorkerClock = SYSTEM_CLOCK
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 90_000
    this.restartDelayMs = options.restartDelayMs ?? 1_000
    this.clientLeaseTtlMs = options.clientLeaseTtlMs ?? 45_000
    this.maximumWarmChannels = options.maximumWarmChannels ?? 2
    this.warmLeaseTtlMs = options.warmLeaseTtlMs ?? 30_000
    this.sessionLeaseTtlMs = options.sessionLeaseTtlMs ?? 180_000
    this.maximumViewerLeasesPerChannel =
      options.maximumViewerLeasesPerChannel ?? 128
    this.maximumWarmLeasesPerChannel =
      options.maximumWarmLeasesPerChannel ?? 64
    this.maximumSessionLeasesPerChannel =
      // At the declared 64-TV capacity a popular channel can carry one
      // lineup hold, one durable tuner hold and one in-flight candidate hold
      // per TV. Keep the defensive worker cap above that worst-case 192.
      options.maximumSessionLeasesPerChannel ?? 256
    if (this.idleTimeoutMs < 10_000 || this.idleTimeoutMs > 600_000) {
      throw new Error('Channel worker idle timeout must be between 10 seconds and 10 minutes')
    }
    if (this.restartDelayMs < 0) {
      throw new Error('Channel worker restart delay cannot be negative')
    }
    if (this.clientLeaseTtlMs < 10_000 || this.clientLeaseTtlMs > 120_000) {
      throw new Error('Channel client lease TTL must be between 10 and 120 seconds')
    }
    if (this.maximumWarmChannels < 0 || this.maximumWarmChannels > 16) {
      throw new Error('At most sixteen channels may be kept warm')
    }
    if (this.warmLeaseTtlMs < 10_000 || this.warmLeaseTtlMs > 60_000) {
      throw new Error('Channel warm lease TTL must be between 10 and 60 seconds')
    }
    if (this.sessionLeaseTtlMs < 30_000 || this.sessionLeaseTtlMs > 600_000) {
      throw new Error('Channel session lease TTL must be between 30 seconds and 10 minutes')
    }
    for (const [label, value] of [
      ['viewer', this.maximumViewerLeasesPerChannel],
      ['warm', this.maximumWarmLeasesPerChannel],
      ['session', this.maximumSessionLeasesPerChannel],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
        throw new Error(`Channel ${label} lease capacity is invalid`)
      }
    }
    this.profile = { ...DEFAULT_PROFILE, ...options.profile }
  }

  async acquire(channelId: string): Promise<ContinuousChannelWorkerState> {
    const record = this.record(channelId)
    record.anonymousViewers += 1
    record.state = {
      ...record.state,
      viewerCount: record.anonymousViewers + record.leases.size,
      idleSince: undefined,
    }
    if (record.idleTimer !== undefined) {
      this.clock.clearTimeout(record.idleTimer)
      record.idleTimer = undefined
    }
    if (record.stopping) await record.stopping
    if (record.startup) {
      await record.startup
    } else if (!record.pipeline && record.restartTimer === undefined) {
      await this.ensureStarted(record)
    }
    return this.snapshot(record)
  }

  release(channelId: string): ContinuousChannelWorkerState | null {
    const record = this.records.get(channelId)
    if (!record) return null
    record.anonymousViewers = Math.max(0, record.anonymousViewers - 1)
    const viewerCount = record.anonymousViewers + record.leases.size
    record.state = { ...record.state, viewerCount }
    this.enterIdleIfUnused(record)
    return this.snapshot(record)
  }

  /** Idempotent viewer heartbeat for an HLS URL carrying a stable clientId. */
  async touch(channelId: string, clientId: string): Promise<ContinuousChannelWorkerState> {
    if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(clientId)) {
      throw new Error('Client ID is not a safe viewer lease identifier')
    }
    const record = this.record(channelId)
    const existing = record.leases.get(clientId)
    if (!existing && record.leases.size >= this.maximumViewerLeasesPerChannel) {
      throw new Error('Channel viewer lease capacity is full')
    }
    if (existing) this.clock.clearTimeout(existing.timer)
    const expiresAt = this.clock.now().getTime() + this.clientLeaseTtlMs
    const timer = this.clock.setTimeout(() => this.expireLease(record, clientId, expiresAt), this.clientLeaseTtlMs)
    record.leases.set(clientId, { expiresAt, timer })
    record.state = {
      ...record.state,
      viewerCount: record.anonymousViewers + record.leases.size,
      idleSince: undefined,
    }
    if (record.idleTimer !== undefined) {
      this.clock.clearTimeout(record.idleTimer)
      record.idleTimer = undefined
    }
    if (record.stopping) await record.stopping
    if (record.startup) {
      await record.startup
    } else if (!record.pipeline && record.restartTimer === undefined) {
      await this.ensureStarted(record)
    }
    return this.snapshot(record)
  }

  leave(channelId: string, clientId: string): ContinuousChannelWorkerState | null {
    const record = this.records.get(channelId)
    const lease = record?.leases.get(clientId)
    if (!record || !lease) return record ? this.snapshot(record) : null
    this.clock.clearTimeout(lease.timer)
    record.leases.delete(clientId)
    record.state = { ...record.state, viewerCount: record.anonymousViewers + record.leases.size }
    this.enterIdleIfUnused(record)
    return this.snapshot(record)
  }

  /**
   * Registers a session-scoped demand marker and kicks a background start.
   * Session leases never count as viewers, so dashboard figures stay honest,
   * and the returned snapshot does not wait for the first HLS segment: the
   * lineup spin-up staggers these starts deliberately.
   */
  async holdSession(
    channelId: string,
    clientId: string
  ): Promise<ContinuousChannelWorkerState> {
    if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(clientId)) {
      throw new Error('Client ID is not a safe session lease identifier')
    }
    const record = this.record(channelId)
    if (
      !record.sessionLeases.has(clientId) &&
      record.sessionLeases.size >= this.maximumSessionLeasesPerChannel
    ) {
      throw new Error('Channel session lease capacity is full')
    }
    this.renewSessionLease(record, clientId)
    record.state = { ...record.state, idleSince: undefined }
    if (record.idleTimer !== undefined) {
      this.clock.clearTimeout(record.idleTimer)
      record.idleTimer = undefined
    }
    if (record.stopping) await record.stopping
    if (!record.pipeline && record.restartTimer === undefined && !record.startup) {
      void this.ensureStarted(record).catch(() => {
        // A failed speculative start is surfaced through state.lastError; the
        // next explicit tune or heartbeat retry takes the blocking path.
      })
    }
    return this.snapshot(record)
  }

  /** Blocking readiness for the one channel a client is actively joining. */
  async whenReady(channelId: string): Promise<ContinuousChannelWorkerState> {
    const record = this.record(channelId)
    if (record.stopping) await record.stopping
    if (record.startup) {
      await record.startup
    } else if (!record.pipeline && record.restartTimer === undefined) {
      await this.ensureStarted(record)
    }
    return this.snapshot(record)
  }

  hasSessionLease(channelId: string, clientId: string): boolean {
    return this.records.get(channelId)?.sessionLeases.has(clientId) ?? false
  }

  refreshSession(channelId: string, clientId: string): boolean {
    const record = this.records.get(channelId)
    if (!record || !record.sessionLeases.has(clientId)) return false
    this.renewSessionLease(record, clientId)
    return true
  }

  async releaseSession(channelId: string, clientId: string): Promise<void> {
    const record = this.records.get(channelId)
    const lease = record?.sessionLeases.get(clientId)
    if (!record || !lease) return
    this.clock.clearTimeout(lease.timer)
    record.sessionLeases.delete(clientId)
    if (
      record.sessionLeases.size === 0 &&
      record.warmLeases.size === 0 &&
      record.state.viewerCount === 0
    ) {
      await this.stopRecord(record, 'stopped')
      return
    }
    this.enterIdleIfUnused(record)
  }

  private renewSessionLease(record: WorkerRecord, clientId: string): void {
    const existing = record.sessionLeases.get(clientId)
    if (existing) this.clock.clearTimeout(existing.timer)
    const expiresAt = this.clock.now().getTime() + this.sessionLeaseTtlMs
    const timer = this.clock.setTimeout(
      () => this.expireSessionLease(record, clientId, expiresAt),
      this.sessionLeaseTtlMs
    )
    record.sessionLeases.set(clientId, { expiresAt, timer })
  }

  private async expireSessionLease(
    record: WorkerRecord,
    clientId: string,
    expiresAt: number
  ): Promise<void> {
    const lease = record.sessionLeases.get(clientId)
    if (!lease || lease.expiresAt !== expiresAt) return
    record.sessionLeases.delete(clientId)
    if (
      record.sessionLeases.size === 0 &&
      record.warmLeases.size === 0 &&
      record.state.viewerCount === 0
    ) {
      console.info(
        `Channel ${record.state.channelId} lineup session lapsed — stopping encoder`
      )
      await this.stopRecord(record, 'stopped')
      return
    }
    this.enterIdleIfUnused(record)
  }

  /**
   * Replaces one client's speculative warm set. Warm leases never count as
   * viewers and are globally capped, so channel surfing cannot start an
   * unbounded number of FFmpeg processes.
   */
  async warm(
    channelIds: readonly string[],
    clientId: string
  ): Promise<ContinuousChannelWorkerState[]> {
    let release!: () => void
    const predecessor = this.warmQueue
    this.warmQueue = new Promise<void>((resolve) => (release = resolve))
    await predecessor
    try {
      return await this.reconcileWarm(channelIds, clientId)
    } finally {
      release()
    }
  }

  private async reconcileWarm(
    channelIds: readonly string[],
    clientId: string
  ): Promise<ContinuousChannelWorkerState[]> {
    if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(clientId)) {
      throw new Error('Client ID is not a safe warm lease identifier')
    }
    const desired = new Set(
      channelIds.slice(0, Math.min(2, this.maximumWarmChannels))
    )
    const released: Promise<void>[] = []
    for (const record of this.records.values()) {
      if (!desired.has(record.state.channelId)) {
        released.push(this.removeWarmLease(record, clientId))
      }
    }
    await Promise.all(released)
    if (this.maximumWarmChannels === 0) return []

    for (const channelId of desired) {
      const record = this.record(channelId)
      if (
        !record.warmLeases.has(clientId) &&
        record.warmLeases.size >= this.maximumWarmLeasesPerChannel
      ) {
        throw new Error('Channel warm lease capacity is full')
      }
    }

    const desiredRecords: WorkerRecord[] = []
    for (const channelId of desired) {
      const record = this.record(channelId)
      if (
        record.state.viewerCount === 0 &&
        record.warmLeases.size === 0 &&
        record.sessionLeases.size === 0
      ) {
        await this.makeWarmCapacity(record)
      }
      const existing = record.warmLeases.get(clientId)
      if (existing) this.clock.clearTimeout(existing.timer)
      const expiresAt = this.clock.now().getTime() + this.warmLeaseTtlMs
      const timer = this.clock.setTimeout(
        () => this.expireWarmLease(record, clientId, expiresAt),
        this.warmLeaseTtlMs
      )
      record.warmLeases.set(clientId, { expiresAt, timer })
      record.lastWarmedAt = this.clock.now().getTime()
      if (record.idleTimer !== undefined) {
        this.clock.clearTimeout(record.idleTimer)
        record.idleTimer = undefined
      }
      desiredRecords.push(record)
    }
    // Starting NAS-backed FFmpeg workers can involve source checks and probes.
    // Start both bounded neighbours concurrently so one slow mount cannot make
    // the other side of the channel list cold.
    await Promise.all(
      desiredRecords.map(async (record) => {
        if (record.stopping) await record.stopping
        if (!record.pipeline && record.restartTimer === undefined) {
          await this.ensureStarted(record)
        }
        // A previous speculative start can be invalidated while this warm
        // request is waiting for it. Re-check after that startup settles.
        if (!record.pipeline && record.restartTimer === undefined) {
          await this.ensureStarted(record)
        }
      })
    )
    return desiredRecords.map((record) => this.snapshot(record))
  }

  /** Explicit crash/configuration recovery hook; position is recalculated at restart time. */
  async restart(channelId: string, reason = 'Pipeline restart requested'): Promise<ContinuousChannelWorkerState | null> {
    const record = this.records.get(channelId)
    if (!record) return null
    record.state = { ...record.state, status: 'transitioning', lastError: reason }
    record.appendNextStart = false
    await this.stopPipeline(record)
    if (this.hasDemand(record)) await this.ensureStarted(record)
    return this.snapshot(record)
  }

  /** Stops a removed, disabled, or off-air channel and drops all leases. */
  async deactivate(channelId: string): Promise<ContinuousChannelWorkerState | null> {
    const record = this.records.get(channelId)
    if (!record) return null
    for (const lease of record.leases.values()) this.clock.clearTimeout(lease.timer)
    for (const lease of record.warmLeases.values()) this.clock.clearTimeout(lease.timer)
    for (const lease of record.sessionLeases.values()) this.clock.clearTimeout(lease.timer)
    record.leases.clear()
    record.warmLeases.clear()
    record.sessionLeases.clear()
    record.anonymousViewers = 0
    record.state = { ...record.state, viewerCount: 0 }
    await this.stopRecord(record, 'stopped', false)
    return this.snapshot(record)
  }

  getState(channelId: string): ContinuousChannelWorkerState | null {
    const record = this.records.get(channelId)
    return record ? this.snapshot(record) : null
  }

  /** Running pipelines and their processes, for the resource monitor. */
  listPipelineProcesses(): Array<{ channelId: string; pid: number }> {
    const running: Array<{ channelId: string; pid: number }> = []
    for (const [channelId, record] of this.records) {
      const pid = record.pipeline?.pid
      if (typeof pid === 'number' && pid > 0) running.push({ channelId, pid })
    }
    return running.sort((left, right) => left.channelId.localeCompare(right.channelId))
  }

  listStates(): ContinuousChannelWorkerState[] {
    return [...this.records.values()]
      .map((record) => this.snapshot(record))
      .sort((left, right) => left.channelId.localeCompare(right.channelId))
  }

  async shutdown(): Promise<void> {
    for (const record of this.records.values()) {
      for (const lease of record.warmLeases.values()) {
        this.clock.clearTimeout(lease.timer)
      }
      record.warmLeases.clear()
      for (const lease of record.sessionLeases.values()) {
        this.clock.clearTimeout(lease.timer)
      }
      record.sessionLeases.clear()
    }
    await Promise.all(
      [...this.records.values()].map((record) =>
        this.stopRecord(record, 'stopped', false)
      )
    )
  }

  private record(channelId: string): WorkerRecord {
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(channelId)) {
      throw new Error('Channel ID is not safe for a stream path')
    }
    const existing = this.records.get(channelId)
    if (existing) return existing
    const created: WorkerRecord = {
      generation: 0,
      anonymousViewers: 0,
      leases: new Map(),
      warmLeases: new Map(),
      sessionLeases: new Map(),
      appendNextStart: false,
      state: {
        channelId,
        status: 'stopped',
        viewerCount: 0,
        outputUrl: `/api/v1/channels/${encodeURIComponent(channelId)}/live/index.m3u8`,
        transcoding: false,
        usingFallback: false,
      },
    }
    this.records.set(channelId, created)
    return created
  }

  private async ensureStarted(record: WorkerRecord): Promise<void> {
    if (record.stopping) await record.stopping
    if (record.startup) return record.startup
    if (record.pipeline) return
    record.startup = this.startRecord(record).finally(() => {
      record.startup = undefined
    })
    return record.startup
  }

  private async startRecord(record: WorkerRecord): Promise<void> {
    const generation = ++record.generation
    const startedAt = this.clock.now()
    const appendToExistingPlaylist = record.appendNextStart
    record.appendNextStart = false
    record.state = {
      ...record.state,
      status: 'starting',
      startedAt: startedAt.toISOString(),
      idleSince: undefined,
      lastError: undefined,
    }
    const outputDirectory = `${this.options.outputRoot.replace(/[\\/]+$/, '')}/${record.state.channelId}/live`
    try {
      await this.files.prepareOutput(outputDirectory)
      try {
        void Promise.resolve(this.files.cleanupOutput(outputDirectory)).catch(
          () => undefined
        )
      } catch {
        // Cleanup must never block or fail a spawn.
      }
      let sequence = this.timeline.resolveWindow
        ? [...(await this.timeline.resolveWindow(record.state.channelId, startedAt, 3))]
        : []
      let position = sequence[0] ?? (await this.timeline.resolve(record.state.channelId, startedAt))
      if (sequence.length === 0 && position) sequence = [position]
      let usingFallback = false
      const availableSequence: ChannelTimelinePosition[] = []
      // The resolver already stats every window item before returning it, so a
      // second NAS round trip per lookahead item would only delay the spawn.
      // The live item alone is re-verified because its offset must be exact.
      const [head, ...tail] = sequence
      if (head) {
        if (await this.files.sourceExists(head.sourcePath)) {
          availableSequence.push(head)
        } else {
          const fallback = (await this.timeline.fallback?.(record.state.channelId, head, startedAt)) ?? null
          usingFallback = true
          if (fallback && (await this.files.sourceExists(fallback.sourcePath))) {
            availableSequence.push(fallback)
          } else {
            throw new Error(`Scheduled source is missing: ${head.sourcePath}`)
          }
        }
      }
      availableSequence.push(...tail)
      if (!position && availableSequence.length === 0) {
        const fallback = (await this.timeline.fallback?.(record.state.channelId, null, startedAt)) ?? null
        usingFallback = true
        if (fallback && (await this.files.sourceExists(fallback.sourcePath))) availableSequence.push(fallback)
      }
      sequence = availableSequence
      position = sequence[0] ?? null
      if (!position) {
        throw new Error(
          this.timeline.unavailableReason?.(record.state.channelId) ??
            'No scheduled source is available'
        )
      }
      const activePosition: ChannelTimelinePosition = position
      if (sequence.length === 0) sequence = [activePosition]
      const outputReadyAfter = this.clock.now().getTime()
      const pipeline = await this.pipelines.start({
        channelId: record.state.channelId,
        outputDirectory,
        playlistPath: `${outputDirectory}/index.m3u8`,
        playlistUrl: record.state.outputUrl,
        position: activePosition,
        sequence,
        profile: this.profile,
        appendToExistingPlaylist,
      })
      if (generation !== record.generation) {
        await pipeline.stop()
        return
      }
      record.pipeline = pipeline
      let waitingForFreshOutput = true
      const readiness = Promise.resolve(
        this.files.waitForFreshSegment?.(
          outputDirectory,
          outputReadyAfter,
          () => waitingForFreshOutput && generation === record.generation,
          2
        )
      ).then(() => ({ kind: 'ready' as const }))
      const earlyExit = pipeline.completed.then((exit) => ({
        kind: 'exit' as const,
        exit,
      }))
      const startup = await Promise.race([readiness, earlyExit])
      waitingForFreshOutput = false
      if (startup.kind === 'exit') {
        if (record.pipeline === pipeline) record.pipeline = undefined
        if (generation !== record.generation) return
        throw new Error(
          startup.exit.error ??
            `Channel encoder exited before producing a segment (code ${startup.exit.code ?? 'unknown'})`
        )
      }
      if (generation !== record.generation) {
        await pipeline.stop()
        if (record.pipeline === pipeline) record.pipeline = undefined
        return
      }
      record.state = {
        ...record.state,
        status:
          record.state.viewerCount > 0 || record.sessionLeases.size > 0
            ? 'live'
            : 'idle',
        currentScheduleItemId: activePosition.scheduleItemId,
        nextScheduleItemId: sequence[1]?.scheduleItemId ?? activePosition.nextScheduleItemId,
        sourceOffsetSeconds: activePosition.sourceOffsetSeconds,
        timelineRevision: activePosition.timelineRevision,
        transcoding: true,
        usingFallback,
      }
      void pipeline.completed.then((exit) => this.onPipelineExit(record, generation, exit))
    } catch (error) {
      const failedPipeline = record.pipeline
      record.pipeline = undefined
      if (failedPipeline) {
        try {
          await failedPipeline.stop()
        } catch {
          // Preserve the original startup/readiness error below.
        }
      }
      // stop/restart deliberately invalidates an in-flight startup. Its late
      // completion must not overwrite the replacement generation with an
      // error state.
      if (generation !== record.generation) return
      record.state = {
        ...record.state,
        status: 'error',
        transcoding: false,
        lastError: error instanceof Error ? error.message : String(error),
      }
      if (this.hasDemand(record)) this.scheduleRestart(record)
    }
  }

  private async onPipelineExit(record: WorkerRecord, generation: number, exit: ChannelPipelineExit): Promise<void> {
    if (generation !== record.generation) return
    record.pipeline = undefined
    record.state = {
      ...record.state,
      status: exit.code === 0 ? 'transitioning' : 'error',
      transcoding: false,
      lastError: exit.code === 0 ? undefined : exit.error ?? `FFmpeg exited with code ${exit.code}`,
    }
    record.appendNextStart = exit.code === 0
    await this.files.cleanupOutput(this.outputDirectory(record.state.channelId))
    if (this.hasDemand(record)) {
      if (exit.code === 0) await this.ensureStarted(record)
      else this.scheduleRestart(record)
    }
  }

  private scheduleRestart(record: WorkerRecord): void {
    if (record.restartTimer !== undefined) return
    record.restartTimer = this.clock.setTimeout(() => {
      record.restartTimer = undefined
      if (this.hasDemand(record) && !record.pipeline) void this.ensureStarted(record)
    }, this.restartDelayMs)
  }

  private async stopRecord(
    record: WorkerRecord,
    status: 'stopped',
    restartIfDemand = true
  ): Promise<void> {
    if (record.idleTimer !== undefined) this.clock.clearTimeout(record.idleTimer)
    if (record.restartTimer !== undefined) this.clock.clearTimeout(record.restartTimer)
    record.idleTimer = undefined
    record.restartTimer = undefined
    await this.stopPipeline(record)
    record.appendNextStart = false
    record.state = { ...record.state, status, transcoding: false, idleSince: undefined }
    await this.files.cleanupOutput(this.outputDirectory(record.state.channelId))
    if (restartIfDemand && this.hasDemand(record) && !record.pipeline) {
      await this.ensureStarted(record)
    }
  }

  private expireLease(record: WorkerRecord, clientId: string, expectedExpiry: number): void {
    const lease = record.leases.get(clientId)
    if (!lease || lease.expiresAt !== expectedExpiry) return
    record.leases.delete(clientId)
    record.state = { ...record.state, viewerCount: record.anonymousViewers + record.leases.size }
    this.enterIdleIfUnused(record)
  }

  private expireWarmLease(
    record: WorkerRecord,
    clientId: string,
    expectedExpiry: number
  ): void {
    const lease = record.warmLeases.get(clientId)
    if (!lease || lease.expiresAt !== expectedExpiry) return
    record.warmLeases.delete(clientId)
    if (
      record.warmLeases.size === 0 &&
      record.state.viewerCount === 0 &&
      record.sessionLeases.size === 0
    ) {
      void this.stopRecord(record, 'stopped')
    }
  }

  private async removeWarmLease(record: WorkerRecord, clientId: string): Promise<void> {
    const lease = record.warmLeases.get(clientId)
    if (!lease) return
    this.clock.clearTimeout(lease.timer)
    record.warmLeases.delete(clientId)
    if (
      record.warmLeases.size === 0 &&
      record.state.viewerCount === 0 &&
      record.sessionLeases.size === 0
    ) {
      await this.stopRecord(record, 'stopped')
    }
  }

  private async makeWarmCapacity(requested: WorkerRecord): Promise<void> {
    const warmOnly = [...this.records.values()]
      .filter(
        (record) =>
          record !== requested &&
          record.state.viewerCount === 0 &&
          record.warmLeases.size > 0 &&
          record.sessionLeases.size === 0
      )
      .sort((left, right) => (left.lastWarmedAt ?? 0) - (right.lastWarmedAt ?? 0))
    if (warmOnly.length < this.maximumWarmChannels) return
    const evicted = warmOnly[0]
    if (!evicted) return
    for (const lease of evicted.warmLeases.values()) {
      this.clock.clearTimeout(lease.timer)
    }
    evicted.warmLeases.clear()
    await this.stopRecord(evicted, 'stopped')
  }

  private hasDemand(record: WorkerRecord): boolean {
    return (
      record.state.viewerCount > 0 ||
      record.warmLeases.size > 0 ||
      record.sessionLeases.size > 0
    )
  }

  private enterIdleIfUnused(record: WorkerRecord): void {
    if (
      record.state.viewerCount !== 0 ||
      record.warmLeases.size > 0 ||
      record.sessionLeases.size > 0 ||
      !record.pipeline ||
      record.idleTimer !== undefined
    ) return
    const idleSince = this.clock.now().toISOString()
    record.state = { ...record.state, status: 'idle', idleSince }
    record.idleTimer = this.clock.setTimeout(() => {
      record.idleTimer = undefined
      // A deliberate idle release, not a crash: nothing here is an error.
      console.info(
        `Channel ${record.state.channelId} idle for ${Math.round(this.idleTimeoutMs / 1000)}s — releasing encoder`
      )
      void this.stopRecord(record, 'stopped')
    }, this.idleTimeoutMs)
  }

  private async stopPipeline(record: WorkerRecord): Promise<void> {
    if (record.stopping) return record.stopping
    const stopping = this.performStopPipeline(record)
    const wrapped = stopping.finally(() => {
      if (record.stopping === wrapped) record.stopping = undefined
    })
    record.stopping = wrapped
    return wrapped
  }

  private async performStopPipeline(record: WorkerRecord): Promise<void> {
    record.generation += 1
    const startup = record.startup
    const pipeline = record.pipeline
    // Keep the handle visible until FFmpeg has actually exited. A concurrent
    // tune must never start a second writer in the same HLS directory.
    if (pipeline) {
      await pipeline.stop()
      if (record.pipeline === pipeline) record.pipeline = undefined
    }
    if (startup) await startup.catch(() => undefined)
  }

  private outputDirectory(channelId: string): string {
    return `${this.options.outputRoot.replace(/[\\/]+$/, '')}/${channelId}/live`
  }

  private snapshot(record: WorkerRecord): ContinuousChannelWorkerState {
    const { sessionHeld: _stale, ...state } = record.state
    return { ...state, sessionHeld: record.sessionLeases.size > 0 }
  }
}
