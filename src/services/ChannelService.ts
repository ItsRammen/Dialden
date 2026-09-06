import type { IMediaRepository } from '../repositories/IMediaRepository'
import type { MediaItem } from '../types'
import {
  parseStationAssetFilename,
  selectStationFillerAsset,
  selectStationTransitionAsset,
  STATION_ASSET_HISTORY,
  stationShowKey,
} from './StationAssetService'
import type { StationAssetRole } from './StationAssetService'
import type {
  ChannelAutomationCollectionRef,
  ChannelAutomationHandoffPolicy,
  ChannelAutomationPolicy,
  ChannelMarathonPolicy,
  ChannelScheduleSlot,
  LibraryChannelPolicy,
  LibraryPolicyDocument,
  ScheduleDay,
} from '../config/library'
import {
  automationLockedHandoffGroup,
  channelAutomationGroup,
  isChannelLockedHandoffGroup,
  validateLibraryChannels,
} from '../config/library'
import {
  parseEpisodeDisplayTitle,
  parseEpisodeRange,
} from '../domain/CollectionIdentity'
import { cleanFilename, cleanMediaTitle } from '../utils/cleanFilename'
import type {
  ChannelConfigurationSnapshot,
  ChannelConfigurationStore,
  CollectionProgrammingGroups,
} from './ChannelConfigurationStore'
import {
  loadStationAutomationCatalog,
  selectStationCollections,
  isStationPresetId,
  STATION_AIRTIME_OPTIONS,
  stationCollectionProgrammingGroups,
  stationAirtimeSlots,
  stationScheduleSlots,
  type StationAutomationCatalog,
  type StationAirtimeId,
  type StationCollectionOption,
  type StationSelectionRequest,
} from './StationAutomationService'

export interface ChannelClock {
  now(): Date
}

export interface ChannelSummary {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly timezone: string
  readonly onAir: boolean
  readonly manuallyOffAir: boolean
}

export interface ChannelAdministrationSnapshot {
  readonly channels: readonly LibraryChannelPolicy[]
  readonly manuallyOffAir: readonly string[]
  readonly programmingGroups: readonly string[]
  readonly configurationError: string | null
}

export interface StationBuildRequest extends StationSelectionRequest {
  readonly id: string
  readonly name: string
  readonly timezone: string
  readonly airtime?: StationAirtimeId
  readonly marathon?: ChannelMarathonPolicy
  /** Optional CN sign-off window. This changes identity and goes off-air; it never selects adult media. */
  readonly handoff?: ChannelAutomationHandoffPolicy
  /**
   * Saved explicit selections that are temporarily absent from the playable
   * catalog. This is output-only draft context: update requests cannot use it
   * to add arbitrary collection references.
   */
  readonly unavailableCollectionRefs?: readonly ChannelAutomationCollectionRef[]
}

export interface StationBuildPreview {
  readonly collections: readonly StationCollectionOption[]
  readonly collectionCount: number
  readonly eligibleFiles: number
}

export interface StationBuildResult extends StationBuildPreview {
  readonly channel: LibraryChannelPolicy
}

export interface ScheduledProgram {
  readonly id: string
  readonly channelId: string
  readonly mediaId: number
  readonly generated?: 'schedule-card'
  readonly title: string
  readonly collectionTitle: string
  readonly episodeLabel?: string
  readonly scheduledStart: string
  readonly scheduledEnd: string
  readonly durationSeconds: number
  readonly durationMs: number
  readonly type: ChannelScheduleItemType
  readonly sourceStartSeconds: number
  readonly sourceDurationSeconds: number
  readonly transitionIn: ChannelTransition
  readonly transitionOut: ChannelTransition
}

export type ChannelScheduleItemType =
  | 'program'
  | 'movie'
  | 'bumper'
  | 'ident'
  | 'interlude'
  | 'short'
  | 'offair'

export type ChannelTransition = 'hard_cut' | 'fade' | 'resume'

export interface ChannelInterludePolicy {
  readonly enabled: boolean
  /** Insert one interlude after this many complete programs. */
  readonly frequency: number
}

export interface DirectPlaybackDescriptor {
  readonly mode: 'direct'
  readonly url: string
  readonly sourceOffsetAtPlaybackZeroMs: 0
}

export interface CurrentProgram extends ScheduledProgram {
  readonly playback: DirectPlaybackDescriptor | { readonly mode: 'hls'; readonly url: string; readonly sourceOffsetAtPlaybackZeroMs: 0 }
  readonly offsetMs: number
  readonly offsetSeconds: number
}

export interface ChannelNowResult {
  readonly channelId: string
  readonly serverTime: string
  readonly serverTimeMs: number
  readonly timezone: string
  readonly timelineRevision: string
  readonly program: CurrentProgram | null
  readonly next: ScheduledProgram | null
}

export interface ChannelScheduleSnapshot {
  readonly serverTime: string
  readonly serverTimeMs: number
  readonly schedules: readonly ChannelNowResult[]
}

interface ScheduleSourceSnapshot {
  readonly epoch: number
  readonly expiresAt: number
  readonly programMedia: MediaItem[]
  readonly interludeMedia: MediaItem[]
  readonly groupsByMediaId: ReadonlyMap<number, ReadonlySet<string>>
  readonly programsByGroupKey: Map<string, MediaItem[]>
  readonly catalogHash: string
}

interface PreparedLineupChannel {
  readonly channel: LibraryChannelPolicy
  readonly offAir: boolean
  readonly programs: ScheduledProgram[]
  readonly timelineRevision: string
}

interface PreparedLineup {
  readonly epoch: number
  readonly expiresAt: number
  readonly channels: readonly PreparedLineupChannel[]
}

interface PreparedGuide {
  readonly epoch: number
  readonly expiresAt: number
  readonly requestedEnd: string
  readonly coverageEnd: string | null
  readonly truncated: boolean
  readonly programs: ScheduledProgram[]
  readonly timelineRevision: string
  readonly dayStarts: readonly string[]
}

interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: ScheduleDay
}

const SYSTEM_CLOCK: ChannelClock = { now: () => new Date() }
/* How many just-played fillers a gap remembers. Enough to keep a long gap
   moving through the library rather than cycling a few clips, and the selector
   falls back to the whole band when everything is recent, so a station with a
   handful of usable assets can still fill a long gap. */
/* Long enough for the selector to space seasonal pieces; it slices a shorter
   window off the end for ordinary repeat avoidance. */
const FILLER_MEMORY = STATION_ASSET_HISTORY

/* Longest a single break may run. Real pods sit around two to four minutes. */
const MAX_BREAK_POD_SECONDS = 180

const MAX_PROGRAMS_PER_SLOT = 20_000
// Scans, approvals, metadata edits, and channel configuration changes all
// explicitly invalidate the schedule epoch. Keep the expensive catalog warm
// between those events; the TTL remains as a safety net for missed callers.
const SCHEDULE_SOURCE_TTL_MS = 5 * 60_000
const LINEUP_CACHE_TTL_MS = 2 * 60_000
const GUIDE_CACHE_TTL_MS = 5 * 60_000
const GUIDE_CACHE_MAX_ENTRIES = 24
const ROLLING_GUIDE_ANCHOR_MS = 5 * 60_000
const DISABLED_INTERLUDES: ChannelInterludePolicy = {
  enabled: false,
  frequency: 1,
}
const DAY_NAMES: ScheduleDay[] = [
  'sun',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
]

export class ChannelService {
  private channels: LibraryChannelPolicy[]
  private readonly groupsByCollection = new Map<string, ReadonlySet<string>>()
  private configuredGroupsByCollection = new Map<
    string,
    CollectionProgrammingGroups
  >()
  private manuallyOffAir = new Set<string>()
  private configurationError: string | null = null
  private automatedReconciliation: Promise<readonly string[]> | null = null
  private scheduleEpoch = 0
  private scheduleSource: ScheduleSourceSnapshot | null = null
  private scheduleSourceInFlight: {
    readonly epoch: number
    readonly promise: Promise<ScheduleSourceSnapshot>
  } | null = null
  private preparedLineup: PreparedLineup | null = null
  private preparedLineupInFlight: {
    readonly epoch: number
    readonly promise: Promise<PreparedLineup>
  } | null = null
  private readonly preparedGuides = new Map<string, PreparedGuide>()
  private readonly preparedGuidesInFlight = new Map<
    string,
    Promise<PreparedGuide>
  >()

  constructor(
    private readonly repository: IMediaRepository,
    policy: LibraryPolicyDocument | null,
    private readonly clock: ChannelClock = SYSTEM_CLOCK,
    private readonly configurationStore?: Pick<
      ChannelConfigurationStore,
      'load' | 'save'
    >,
    private interludePolicy: ChannelInterludePolicy =
      DISABLED_INTERLUDES
  ) {
    this.channels = validateLibraryChannels(policy?.channels ?? [])
    for (const [rootId, root] of Object.entries(policy?.roots ?? {})) {
      for (const collection of root.collections) {
        this.groupsByCollection.set(
          this.collectionKey(rootId, collection.name),
          new Set(collection.groups ?? [])
        )
      }
    }
    if (this.configurationStore) {
      try {
        const snapshot = this.configurationStore.load()
        this.channels = validateLibraryChannels(snapshot.channels)
        this.manuallyOffAir = new Set(snapshot.manuallyOffAir)
        this.applyConfiguredGroups(snapshot.collectionGroups ?? [])
      } catch (error) {
        // A malformed persisted schedule must never broaden playback. Keep no
        // configured channels and expose the error through the admin surface.
        this.channels = []
        this.manuallyOffAir.clear()
        this.configuredGroupsByCollection.clear()
        this.configurationError = safeMessage(error)
        console.error(`Channel configuration rejected: ${this.configurationError}`)
      }
    }
  }

  setInterludePolicy(policy: ChannelInterludePolicy): void {
    this.interludePolicy = {
      enabled: policy.enabled,
      frequency: Math.max(1, Math.floor(policy.frequency)),
    }
    this.invalidateScheduleCatalog()
  }

  /** Invalidate derived schedules after a scan, approval, or metadata change. */
  invalidateScheduleCatalog(): void {
    this.scheduleEpoch += 1
    this.scheduleSource = null
    this.preparedLineup = null
    this.preparedGuides.clear()
  }

  list(): { serverTime: string; serverTimeMs: number; channels: ChannelSummary[] } {
    const now = this.clock.now()
    return {
      serverTime: now.toISOString(),
      serverTimeMs: now.getTime(),
      channels: this.channels
        .filter((channel) => channel.enabled)
        .map(({ id, name, enabled, timezone }) => ({
          id,
          name,
          enabled,
          timezone,
          onAir: !this.manuallyOffAir.has(id),
          manuallyOffAir: this.manuallyOffAir.has(id),
        })),
    }
  }

  administrationSnapshot(): ChannelAdministrationSnapshot {
    const programmingGroups = new Set<string>()
    for (const groups of this.groupsByCollection.values()) {
      for (const group of groups) programmingGroups.add(group)
    }
    for (const assignment of this.configuredGroupsByCollection.values()) {
      for (const group of assignment.groups) programmingGroups.add(group)
    }
    return {
      channels: this.channels.map((channel) => ({
        ...channel,
        slots: channel.slots.map((slot) => ({
          ...slot,
          days: [...slot.days],
          groups: [...slot.groups],
        })),
      })),
      manuallyOffAir: [...this.manuallyOffAir].sort(),
      programmingGroups: [...programmingGroups].sort((left, right) =>
        left === right ? 0 : left < right ? -1 : 1
      ),
      configurationError: this.configurationError,
    }
  }

  stationAutomationCatalog(): Promise<StationAutomationCatalog> {
    return loadStationAutomationCatalog(this.repository)
  }

  /** Reconstruct the exact generated lineup so the existing-channel builder
   * opens with today's content selected instead of silently defaulting to the
   * all-shows preset. */
  async stationAutomationDraft(
    channelId: string
  ): Promise<StationBuildRequest | undefined> {
    const channel = this.channels.find((item) => item.id === channelId)
    if (!channel) return undefined
    const group = this.generatedGroup(channelId)
    const assignments = this.configuredCollectionGroups().filter((assignment) =>
      assignment.groups.includes(group)
    )
    if (
      assignments.length === 0 &&
      channel.automation?.preset !== 'network-copy'
    ) {
      return undefined
    }

    const catalog = await this.stationAutomationCatalog()
    const collectionRefs = channel.automation?.collectionRefs
    const eligibleNetworkCollections =
      channel.automation?.preset === 'network-copy'
        ? selectStationCollections(catalog, {
            preset: 'network-copy',
            networkId: channel.automation.networkId,
            eraStartYear: channel.automation.eraStartYear,
            eraEndYear: channel.automation.eraEndYear,
            selectionMode: 'automatic',
          })
        : catalog.collections
    const collectionIds = eligibleNetworkCollections
      .filter((collection) =>
        collectionRefs
          ? collectionRefs.some(
              (reference) =>
                reference.rootId === collection.rootId &&
                reference.libraryKind === collection.libraryKind &&
                reference.identityKey === collection.identityKey
            )
          : assignments.some(
              (assignment) =>
                assignment.collectionId === collection.id ||
                (assignment.rootId === collection.rootId &&
                  assignment.libraryKind === collection.libraryKind &&
                  assignment.collectionIdentityKey === collection.identityKey)
            )
      )
      .map((collection) => collection.id)
    const availableReferenceKeys = new Set(
      catalog.collections.map((collection) =>
        this.automationReferenceKey(collection)
      )
    )
    const unavailableCollectionRefs = (collectionRefs ?? []).filter(
      (reference) =>
        !availableReferenceKeys.has(this.automationReferenceKey(reference))
    )
    const airtime = STATION_AIRTIME_OPTIONS.map((option) => option.id).find(
      (candidate) =>
        JSON.stringify(channel.slots) ===
        JSON.stringify(stationAirtimeSlots(candidate, group))
    )
    return {
      id: channel.id,
      name: channel.name,
      timezone: channel.timezone,
      preset:
        channel.automation && isStationPresetId(channel.automation.preset)
          ? channel.automation.preset
          : 'custom',
      ...(channel.automation?.preset === 'network-copy'
        ? {
            networkId: channel.automation.networkId,
            eraStartYear: channel.automation.eraStartYear,
            eraEndYear: channel.automation.eraEndYear,
            selectionMode: channel.automation.selectionMode,
            ...(channel.automation.selectionMode === 'explicit'
              ? {
                  collectionIds,
                  ...(unavailableCollectionRefs.length > 0
                    ? { unavailableCollectionRefs }
                    : {}),
                }
              : {}),
          }
        : { collectionIds }),
      ...(channel.automation
        ? { airtime: channel.automation.airtime }
        : airtime
          ? { airtime }
          : {}),
      ...(channel.marathon ? { marathon: channel.marathon } : {}),
      ...(channel.automation?.handoff
        ? { handoff: channel.automation.handoff }
        : {}),
    }
  }

  async previewAutomatedStation(
    request: StationSelectionRequest
  ): Promise<StationBuildPreview> {
    return (await this.automationSelection(request)).preview
  }

  async previewAutomatedStationBuild(
    request: StationBuildRequest
  ): Promise<StationBuildPreview> {
    const preview = await this.previewAutomatedStation(request)
    this.automatedStationChannel(request, preview.collections)
    return preview
  }

  async createAutomatedStation(
    request: StationBuildRequest
  ): Promise<StationBuildResult> {
    const preview = await this.previewAutomatedStation(request)
    if (preview.collectionCount === 0 || preview.eligibleFiles === 0) {
      throw new Error(
        'No schedulable media matched. Approve a collection, finish metadata and media probing, then preview again.'
      )
    }
    const channel = this.automatedStationChannel(request, preview.collections)
    const channels = validateLibraryChannels([...this.channels, channel])
    this.persistAndApply(
      channels,
      this.manuallyOffAir,
      this.automatedCollectionGroups(request.id, preview, request)
    )
    return { channel, ...preview }
  }

  async previewAutomatedStationUpdate(
    channelId: string,
    request: StationBuildRequest
  ): Promise<StationBuildPreview> {
    const preview = await this.previewAutomatedStation(request)
    this.automatedStationUpdateChannel(channelId, request, preview.collections)
    return preview
  }

  async updateAutomatedStation(
    channelId: string,
    request: StationBuildRequest
  ): Promise<StationBuildResult | null> {
    const index = this.channels.findIndex((channel) => channel.id === channelId)
    if (index < 0) return null
    const { catalog, preview } = await this.automationSelection(request)
    if (preview.collectionCount === 0 || preview.eligibleFiles === 0) {
      throw new Error(
        'No schedulable media matched. Approve a collection, finish metadata and media probing, then preview again.'
      )
    }
    const preservedCollectionRefs = this.preservedUnavailableCollectionRefs(
      this.channels[index] as LibraryChannelPolicy,
      request,
      catalog
    )
    const channel = this.automatedStationUpdateChannel(
      channelId,
      request,
      preview.collections,
      preservedCollectionRefs
    )
    const next = [...this.channels]
    next[index] = channel
    const validated = validateLibraryChannels(next)
    const generatedGroups = this.automatedCollectionGroups(
      channelId,
      preview,
      request
    )
    this.persistAndApply(
      validated,
      this.manuallyOffAir,
      preservedCollectionRefs.length > 0
        ? this.withUnavailableGeneratedAssignments(
            this.generatedGroup(channelId),
            catalog,
            generatedGroups
          )
        : generatedGroups
    )
    return { channel: validated[index] as LibraryChannelPolicy, ...preview }
  }

  /**
   * Re-materialize generated collection groups after an authoritative library
   * scan. Automatic copied networks pick up every newly eligible title;
   * explicit copies resolve only their durable saved references. Missing
   * collections are retained so a temporarily offline root cannot erase a
   * user's lineup. Concurrent scan callbacks share one reconciliation pass.
   */
  async reconcileAutomatedStations(): Promise<readonly string[]> {
    if (this.automatedReconciliation) return this.automatedReconciliation
    const active = this.reconcileAutomatedStationsOnce()
    this.automatedReconciliation = active
    try {
      return await active
    } finally {
      if (this.automatedReconciliation === active) {
        this.automatedReconciliation = null
      }
    }
  }

  create(channel: LibraryChannelPolicy): LibraryChannelPolicy {
    if (this.channels.some((existing) => existing.id === channel.id)) {
      throw new Error(`Channel ${channel.id} already exists`)
    }
    const next = validateLibraryChannels([...this.channels, channel])
    this.persistAndApply(next, this.manuallyOffAir)
    return next.find((item) => item.id === channel.id) as LibraryChannelPolicy
  }

  update(
    channelId: string,
    channel: LibraryChannelPolicy
  ): LibraryChannelPolicy | null {
    const index = this.channels.findIndex((existing) => existing.id === channelId)
    if (index < 0) return null
    if (channel.id !== channelId) {
      throw new Error('A channel ID cannot be changed after creation')
    }
    const next = [...this.channels]
    next[index] = channel
    const validated = validateLibraryChannels(next)
    this.persistAndApply(validated, this.manuallyOffAir)
    return validated[index] ?? null
  }

  delete(channelId: string): boolean {
    if (!this.channels.some((channel) => channel.id === channelId)) return false
    const next = this.channels.filter((channel) => channel.id !== channelId)
    const offAir = new Set(this.manuallyOffAir)
    offAir.delete(channelId)
    this.persistAndApply(
      next,
      offAir,
      this.withoutUnreferencedGeneratedGroups(next)
    )
    return true
  }

  setEnabled(channelId: string, enabled: boolean): boolean {
    const channel = this.channels.find((item) => item.id === channelId)
    if (!channel) return false
    this.update(channelId, { ...channel, enabled })
    return true
  }

  setOnAir(channelId: string, onAir: boolean): boolean {
    if (!this.getChannel(channelId)) return false
    const offAir = new Set(this.manuallyOffAir)
    if (onAir) offAir.delete(channelId)
    else offAir.add(channelId)
    this.persistAndApply(this.channels, offAir)
    return true
  }

  isOnAir(channelId: string): boolean {
    return this.getChannel(channelId) !== null && !this.manuallyOffAir.has(channelId)
  }

  async getNow(channelId: string): Promise<ChannelNowResult | null> {
    const channel = this.getChannel(channelId)
    if (!channel) return null
    if (this.manuallyOffAir.has(channelId)) {
      return this.channelNowResult(channel, [], this.clock.now(), [])
    }
    const source = await this.getScheduleSource()
    const around = this.clock.now()
    const programs = await this.buildNowWindow(channel, source, around)
    // Sample the authoritative response time after schedule generation so the
    // client does not inherit time spent reading/building the timeline.
    const now = this.clock.now()
    return this.channelNowResult(
      channel,
      programs,
      now,
      this.timelineRevisionForSource(channel, source)
    )
  }

  /**
   * Builds the channel browser's complete now/next catalog from one media
   * snapshot. It is deliberately independent of FFmpeg worker readiness.
   */
  async getLineupSchedule(): Promise<ChannelScheduleSnapshot> {
    const prepared = await this.getPreparedLineup()
    const now = this.clock.now()
    return {
      serverTime: now.toISOString(),
      serverTimeMs: now.getTime(),
      schedules: prepared.channels.map(
        ({ channel, programs, timelineRevision }) =>
        this.channelNowResult(
          channel,
          programs,
          now,
          timelineRevision
        )
      ),
    }
  }

  private channelNowResult(
    channel: LibraryChannelPolicy,
    programs: ScheduledProgram[],
    now: Date,
    catalogOrRevision: unknown[] | string
  ): ChannelNowResult {
    const nowMs = now.getTime()
    const current = programs.find(
      (program) =>
        Date.parse(program.scheduledStart) <= nowMs &&
        nowMs < Date.parse(program.scheduledEnd)
    )
    const next = programs.find(
      (program) => Date.parse(program.scheduledStart) > nowMs
    )

    return {
      channelId: channel.id,
      serverTime: now.toISOString(),
      serverTimeMs: nowMs,
      timezone: channel.timezone,
      timelineRevision:
        typeof catalogOrRevision === 'string'
          ? catalogOrRevision
          : this.timelineRevisionForCatalog(channel, catalogOrRevision),
      program: current
        ? {
            ...current,
            playback: current.generated ? { mode: 'hls', url: `/api/v1/channels/${encodeURIComponent(channel.id)}/live/index.m3u8`, sourceOffsetAtPlaybackZeroMs: 0 } : this.directPlayback(current.mediaId),
            offsetMs: Math.max(
              0,
              nowMs - Date.parse(current.scheduledStart)
            ),
            offsetSeconds: Math.max(
              0,
              (nowMs - Date.parse(current.scheduledStart)) / 1000
            ),
          }
        : null,
      next: next ?? null,
    }
  }

  async getGuide(
    channelId: string,
    hours = 8,
    options?: { from?: Date; calendarDays?: boolean }
  ): Promise<
    | {
        channelId: string
        serverTime: string
        serverTimeMs: number
        timezone: string
        timelineRevision: string
        requestedEnd: string
        coverageEnd: string | null
        truncated: boolean
        dayStarts?: readonly string[]
        programs: ScheduledProgram[]
      }
    | null
  > {
    const channel = this.getChannel(channelId)
    if (!channel) return null

    // A weekly TV guide can use the station's own calendar-day boundaries;
    // ordinary callers retain their explicit anchor while serverTime stays live.
    const boundedHours = Math.min(168, Math.max(1, Math.floor(hours)))
    const from = options?.from
    const liveAnchor = this.clock.now()
    const requestedAnchor =
      from instanceof Date && Number.isFinite(from.getTime())
        ? from
        : new Date(
            Math.floor(liveAnchor.getTime() / ROLLING_GUIDE_ANCHOR_MS) *
              ROLLING_GUIDE_ANCHOR_MS
          )
    const calendarParts = options?.calendarDays
      ? this.localParts(this.clock.now(), channel.timezone)
      : null
    const anchor = calendarParts
      ? this.zonedDateTime(calendarParts, 0, channel.timezone)
      : requestedAnchor
    const dayStarts = calendarParts
      ? Array.from({ length: 8 }, (_, offset) =>
          this.zonedDateTime(
            this.addCalendarDays(calendarParts, offset),
            0,
            channel.timezone
          ).toISOString()
        )
      : []
    if (this.manuallyOffAir.has(channelId)) {
      const now = this.clock.now()
      return {
        channelId,
        serverTime: now.toISOString(),
        serverTimeMs: now.getTime(),
        timezone: channel.timezone,
        timelineRevision: this.timelineRevision(channel, []),
        requestedEnd:
          dayStarts[dayStarts.length - 1] ??
          new Date(
            anchor.getTime() + boundedHours * 60 * 60 * 1000
          ).toISOString(),
        coverageEnd: null,
        truncated: false,
        dayStarts,
        programs: [],
      }
    }

    const source = await this.getScheduleSource()
    const prepared = await this.getPreparedGuide(
      channel,
      source,
      anchor,
      boundedHours,
      dayStarts
    )
    const now = this.clock.now()

    return {
      channelId,
      serverTime: now.toISOString(),
      serverTimeMs: now.getTime(),
      timezone: channel.timezone,
      timelineRevision: prepared.timelineRevision,
      requestedEnd: prepared.requestedEnd,
      coverageEnd: prepared.coverageEnd,
      truncated: prepared.truncated,
      dayStarts: prepared.dayStarts,
      programs: prepared.programs,
    }
  }

  private async getScheduleSource(): Promise<ScheduleSourceSnapshot> {
    const epoch = this.scheduleEpoch
    const now = Date.now()
    if (
      this.scheduleSource?.epoch === epoch &&
      this.scheduleSource.expiresAt > now
    ) {
      return this.scheduleSource
    }
    if (this.scheduleSourceInFlight?.epoch === epoch) {
      return this.scheduleSourceInFlight.promise
    }

    const promise = (async (): Promise<ScheduleSourceSnapshot> => {
      const media = await this.repository.getAll()
      // Give manifests and segments a chance to run after the synchronous
      // SQLite hydration before compiling the in-memory schedule indexes.
      await this.yieldToEventLoop()
      return this.compileScheduleSource(epoch, media)
    })()
    const inFlight = { epoch, promise }
    this.scheduleSourceInFlight = inFlight
    try {
      const snapshot = await promise
      if (epoch !== this.scheduleEpoch) return this.getScheduleSource()
      this.scheduleSource = snapshot
      return snapshot
    } finally {
      if (this.scheduleSourceInFlight === inFlight) {
        this.scheduleSourceInFlight = null
      }
    }
  }

  private async getPreparedLineup(): Promise<PreparedLineup> {
    const epoch = this.scheduleEpoch
    const now = Date.now()
    if (
      this.preparedLineup?.epoch === epoch &&
      this.preparedLineup.expiresAt > now
    ) {
      return this.preparedLineup
    }
    if (this.preparedLineupInFlight?.epoch === epoch) {
      return this.preparedLineupInFlight.promise
    }

    const promise = (async (): Promise<PreparedLineup> => {
      const source = await this.getScheduleSource()
      if (source.epoch !== this.scheduleEpoch) return this.getPreparedLineup()
      const around = this.clock.now()
      const channels: PreparedLineupChannel[] = []
      for (const channel of this.channels.filter((item) => item.enabled)) {
        // Large lineups must never monopolize the event loop that serves HLS.
        if (channels.length > 0) await this.yieldToEventLoop()
        const offAir = this.manuallyOffAir.has(channel.id)
        channels.push({
          channel,
          offAir,
          programs: offAir
            ? []
            : await this.buildNowWindow(channel, source, around),
          timelineRevision: offAir
            ? this.timelineRevision(channel, [])
            : this.timelineRevisionForSource(channel, source),
        })
      }
      return {
        epoch,
        expiresAt: Date.now() + LINEUP_CACHE_TTL_MS,
        channels,
      }
    })()
    const inFlight = { epoch, promise }
    this.preparedLineupInFlight = inFlight
    try {
      const prepared = await promise
      if (epoch !== this.scheduleEpoch) return this.getPreparedLineup()
      this.preparedLineup = prepared
      return prepared
    } finally {
      if (this.preparedLineupInFlight === inFlight) {
        this.preparedLineupInFlight = null
      }
    }
  }

  private async getPreparedGuide(
    channel: LibraryChannelPolicy,
    source: ScheduleSourceSnapshot,
    anchor: Date,
    boundedHours: number,
    dayStarts: readonly string[]
  ): Promise<PreparedGuide> {
    if (source.epoch !== this.scheduleEpoch) {
      return this.getPreparedGuide(
        channel,
        await this.getScheduleSource(),
        anchor,
        boundedHours,
        dayStarts
      )
    }
    const cacheKey = [
      source.epoch,
      channel.id,
      anchor.getTime(),
      boundedHours,
      dayStarts[dayStarts.length - 1] ?? '',
    ].join(':')
    const cached = this.preparedGuides.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      this.preparedGuides.delete(cacheKey)
      this.preparedGuides.set(cacheKey, cached)
      return cached
    }
    if (cached) this.preparedGuides.delete(cacheKey)
    const existing = this.preparedGuidesInFlight.get(cacheKey)
    if (existing) return existing

    const promise = (async (): Promise<PreparedGuide> => {
      const requestedEndMs = dayStarts.length > 1
        ? Date.parse(dayStarts[dayStarts.length - 1] as string)
        : anchor.getTime() + boundedHours * 60 * 60 * 1000
      const horizonHours = Math.max(
        boundedHours,
        Math.ceil((requestedEndMs - anchor.getTime()) / (60 * 60 * 1000))
      )
      // buildWindow includes offset zero, so N elapsed days require N + 1
      // calendar dates, not the previous N + 2 over-build.
      const futureDays = Math.min(8, Math.ceil(horizonHours / 24))
      const programs = await this.buildWindowCooperatively(
        channel,
        source,
        anchor,
        futureDays,
        horizonHours
      )
      const anchorMs = anchor.getTime()
      const horizonMs = requestedEndMs
      const visiblePrograms = programs.filter(
        (program) =>
          Date.parse(program.scheduledEnd) > anchorMs &&
          Date.parse(program.scheduledStart) < horizonMs
      )
      const coverageEnd =
        visiblePrograms[visiblePrograms.length - 1]?.scheduledEnd ?? null
      return {
        epoch: source.epoch,
        expiresAt: Date.now() + GUIDE_CACHE_TTL_MS,
        requestedEnd: new Date(horizonMs).toISOString(),
        coverageEnd,
        truncated:
          visiblePrograms.length >= MAX_PROGRAMS_PER_SLOT &&
          coverageEnd !== null &&
          Date.parse(coverageEnd) < horizonMs,
        programs: visiblePrograms,
        timelineRevision: this.timelineRevisionForSource(channel, source),
        dayStarts,
      }
    })()
    this.preparedGuidesInFlight.set(cacheKey, promise)
    try {
      const prepared = await promise
      if (source.epoch !== this.scheduleEpoch) {
        return this.getPreparedGuide(
          channel,
          await this.getScheduleSource(),
          anchor,
          boundedHours,
          dayStarts
        )
      }
      this.preparedGuides.set(cacheKey, prepared)
      while (this.preparedGuides.size > GUIDE_CACHE_MAX_ENTRIES) {
        const oldest = this.preparedGuides.keys().next().value
        if (typeof oldest !== 'string') break
        this.preparedGuides.delete(oldest)
      }
      return prepared
    } finally {
      if (this.preparedGuidesInFlight.get(cacheKey) === promise) {
        this.preparedGuidesInFlight.delete(cacheKey)
      }
    }
  }

  private getChannel(channelId: string): LibraryChannelPolicy | null {
    return (
      this.channels.find(
        (channel) => channel.id === channelId && channel.enabled
      ) ?? null
    )
  }

  private async automationSelection(
    request: StationSelectionRequest
  ): Promise<{
    catalog: StationAutomationCatalog
    preview: StationBuildPreview
  }> {
    const catalog = await this.stationAutomationCatalog()
    const collections = selectStationCollections(catalog, request)
    return {
      catalog,
      preview: {
        collections,
        collectionCount: collections.length,
        eligibleFiles: collections.reduce(
          (total, collection) => total + collection.eligibleFiles,
          0
        ),
      },
    }
  }

  private preservedUnavailableCollectionRefs(
    channel: LibraryChannelPolicy,
    request: StationBuildRequest,
    catalog: StationAutomationCatalog
  ): readonly ChannelAutomationCollectionRef[] {
    const current = channel.automation
    const requestedMode =
      request.selectionMode ??
      (request.collectionIds === undefined ? 'automatic' : 'explicit')
    if (
      !current ||
      current.preset !== request.preset ||
      current.selectionMode !== 'explicit' ||
      requestedMode !== 'explicit' ||
      (current.preset === 'network-copy' &&
        (current.networkId !== request.networkId ||
          current.eraStartYear !== request.eraStartYear ||
          current.eraEndYear !== request.eraEndYear))
    ) {
      return []
    }
    const available = new Set(
      catalog.collections.map((collection) =>
        this.automationReferenceKey(collection)
      )
    )
    return (current.collectionRefs ?? []).filter(
      (reference) => !available.has(this.automationReferenceKey(reference))
    )
  }

  private async reconcileAutomatedStationsOnce(): Promise<readonly string[]> {
    const catalog = await this.stationAutomationCatalog()
    if (catalog.truncated) {
      console.warn(
        'Skipped automated channel reconciliation because the playable catalog exceeds 5,000 collections'
      )
      return []
    }
    const changed: string[] = []
    for (const channel of this.channels) {
      const automation = channel.automation
      if (!automation || !isStationPresetId(automation.preset)) continue
      try {
        const selectionMode =
          automation.selectionMode ??
          (automation.preset === 'custom' ? undefined : 'automatic')
        if (!selectionMode) continue
        if (
          automation.preset === 'network-copy' &&
          (!automation.networkId ||
            automation.eraStartYear === undefined ||
            automation.eraEndYear === undefined)
        ) {
          continue
        }
        const automaticRequest: StationBuildRequest = {
          id: channel.id,
          name: channel.name,
          timezone: channel.timezone,
          preset: automation.preset,
          ...(automation.preset === 'network-copy'
            ? {
                networkId: automation.networkId,
                eraStartYear: automation.eraStartYear,
                eraEndYear: automation.eraEndYear,
              }
            : {}),
          selectionMode,
          airtime: automation.airtime,
          ...(automation.handoff ? { handoff: automation.handoff } : {}),
          ...(channel.marathon ? { marathon: channel.marathon } : {}),
        }
        const eligible =
          selectionMode === 'automatic'
            ? selectStationCollections(catalog, automaticRequest)
            : catalog.collections
        const selected =
          selectionMode === 'automatic'
            ? eligible
            : eligible.filter((collection) =>
                (automation.collectionRefs ?? []).some(
                  (reference) =>
                    this.automationReferenceKey(reference) ===
                    this.automationReferenceKey(collection)
                )
              )
        const preview: StationBuildPreview = {
          collections: selected,
          collectionCount: selected.length,
          eligibleFiles: selected.reduce(
            (total, collection) => total + collection.eligibleFiles,
            0
          ),
        }
        const group = this.generatedGroup(channel.id)
        const generated = this.automatedCollectionGroups(
          channel.id,
          preview,
          automaticRequest
        )
        const nextGroups = this.canonicalCollectionGroups(
          this.withUnavailableGeneratedAssignments(group, catalog, generated)
        )
        const currentGroups = this.canonicalCollectionGroups(
          this.configuredCollectionGroups()
        )
        if (JSON.stringify(nextGroups) === JSON.stringify(currentGroups)) {
          continue
        }
        this.persistAndApply(this.channels, this.manuallyOffAir, nextGroups)
        changed.push(channel.id)
      } catch (error) {
        console.error(
          `Automated channel ${channel.id} was not reconciled: ${safeMessage(error)}`
        )
      }
    }
    return changed
  }

  private withUnavailableGeneratedAssignments(
    group: string,
    catalog: StationAutomationCatalog,
    generated: readonly CollectionProgrammingGroups[]
  ): CollectionProgrammingGroups[] {
    const byKey = new Map(
      generated.map((assignment) => [
        this.configuredCollectionKey(assignment),
        assignment,
      ])
    )
    const isGeneratedGroup = (value: string) =>
      value === group || value.startsWith(`${group}-`)
    for (const assignment of this.configuredCollectionGroups()) {
      const generatedGroups = assignment.groups.filter(isGeneratedGroup)
      if (generatedGroups.length === 0) continue
      const stillAvailable = catalog.collections.some(
        (collection) =>
          assignment.collectionId === collection.id ||
          (assignment.collectionIdentityKey !== undefined &&
            assignment.libraryKind === collection.libraryKind &&
            assignment.rootId === collection.rootId &&
            assignment.collectionIdentityKey === collection.identityKey) ||
          (assignment.collectionIdentityKey === undefined &&
            assignment.rootId === collection.rootId &&
            assignment.collectionTitle === collection.collectionTitle)
      )
      if (stillAvailable) continue
      const key = this.configuredCollectionKey(assignment)
      const current = byKey.get(key)
      byKey.set(key, {
        ...assignment,
        groups: [
          ...new Set([...(current?.groups ?? []), ...generatedGroups]),
        ],
      })
    }
    return [...byKey.values()]
  }

  private canonicalCollectionGroups(
    assignments: readonly CollectionProgrammingGroups[]
  ): CollectionProgrammingGroups[] {
    return assignments
      .map((assignment) => ({
        ...assignment,
        groups: [...new Set(assignment.groups)].sort((left, right) =>
          this.compareText(left, right)
        ),
      }))
      .sort((left, right) =>
        this.compareText(
          this.configuredCollectionKey(left),
          this.configuredCollectionKey(right)
        )
      )
  }

  private automationReferenceKey(
    value:
      | Pick<StationCollectionOption, 'rootId' | 'libraryKind' | 'identityKey'>
      | ChannelAutomationCollectionRef
  ): string {
    return `${value.rootId.toLocaleLowerCase('en-US')}\u0000${value.libraryKind}\u0000${value.identityKey.toLocaleLowerCase('en-US')}`
  }

  private automatedStationChannel(
    request: StationBuildRequest,
    selectedCollections: readonly StationCollectionOption[]
  ): LibraryChannelPolicy {
    if (this.channels.some((channel) => channel.id === request.id)) {
      throw new Error(`Channel ${request.id} already exists`)
    }
    const group = this.generatedGroup(request.id)
    const policyCollision = [...this.groupsByCollection.values()].some(
      (groups) => groups.has(group)
    )
    const scheduleCollision = this.channels.some((channel) =>
      channel.slots.some((slot) => slot.groups.includes(group))
    )
    if (policyCollision || scheduleCollision) {
      throw new Error('Generated station group conflicts with existing configuration')
    }
    return validateLibraryChannels([
      {
        id: request.id,
        name: request.name,
        enabled: true,
        timezone: request.timezone,
        slots: this.automatedScheduleSlots(request, group),
        automation: this.stationAutomationPolicy(request, selectedCollections),
        ...(request.marathon ? { marathon: request.marathon } : {}),
      },
    ])[0] as LibraryChannelPolicy
  }

  private automatedStationUpdateChannel(
    channelId: string,
    request: StationBuildRequest,
    selectedCollections: readonly StationCollectionOption[],
    preservedCollectionRefs: readonly ChannelAutomationCollectionRef[] = []
  ): LibraryChannelPolicy {
    const current = this.channels.find((channel) => channel.id === channelId)
    if (!current) throw new Error('Channel not found')
    if (request.id !== channelId) {
      throw new Error('A channel ID cannot be changed after creation')
    }
    const group = this.generatedGroup(channelId)
    const scheduleCollision = this.channels.some(
      (channel) =>
        channel.id !== channelId &&
        channel.slots.some((slot) => slot.groups.includes(group))
    )
    if (scheduleCollision) {
      throw new Error('Generated station group conflicts with existing configuration')
    }
    return validateLibraryChannels([
      {
        ...current,
        name: request.name,
        timezone: request.timezone,
        slots: this.automatedScheduleSlots(request, group),
        automation: this.stationAutomationPolicy(
          request,
          selectedCollections,
          preservedCollectionRefs
        ),
        ...(request.marathon ? { marathon: request.marathon } : {}),
      },
    ])[0] as LibraryChannelPolicy
  }

  private stationAutomationPolicy(
    request: StationBuildRequest,
    selectedCollections: readonly StationCollectionOption[],
    preservedCollectionRefs: readonly ChannelAutomationCollectionRef[] = []
  ): ChannelAutomationPolicy {
    const airtime = request.airtime ?? 'all-day'
    if (request.preset !== 'network-copy') {
      if (request.handoff) {
        throw new Error('After-hours handoff requires a Cartoon Network copy')
      }
      const selectionMode =
        request.preset === 'custom' || request.collectionIds !== undefined
          ? 'explicit'
          : 'automatic'
      const collectionRefs = new Map<string, ChannelAutomationCollectionRef>()
      for (const collection of selectedCollections) {
        if (collection.libraryKind !== 'tv' && collection.libraryKind !== 'movie') {
          throw new Error('An explicit channel can store only TV and movie selections')
        }
        const reference: ChannelAutomationCollectionRef = {
          rootId: collection.rootId,
          libraryKind: collection.libraryKind,
          identityKey: collection.identityKey,
        }
        collectionRefs.set(this.automationReferenceKey(reference), reference)
      }
      for (const reference of preservedCollectionRefs) {
        collectionRefs.set(this.automationReferenceKey(reference), reference)
      }
      return {
        preset: request.preset,
        airtime,
        selectionMode,
        ...(selectionMode === 'explicit'
          ? { collectionRefs: [...collectionRefs.values()] }
          : {}),
      }
    }
    if (
      !request.networkId ||
      request.eraStartYear === undefined ||
      request.eraEndYear === undefined
    ) {
      throw new Error('A copied network requires a network and year range')
    }
    const selectionMode =
      request.selectionMode ??
      (request.collectionIds === undefined ? 'automatic' : 'explicit')
    const collectionRefs = new Map<string, ChannelAutomationCollectionRef>()
    for (const collection of selectedCollections) {
      if (
        collection.libraryKind !== 'tv' &&
        collection.libraryKind !== 'movie'
      ) {
        throw new Error(
          'A copied network can store only TV show and explicitly affiliated movie selections'
        )
      }
      const reference: ChannelAutomationCollectionRef = {
        rootId: collection.rootId,
        libraryKind: collection.libraryKind,
        identityKey: collection.identityKey,
      }
      collectionRefs.set(this.automationReferenceKey(reference), reference)
    }
    for (const reference of preservedCollectionRefs) {
      collectionRefs.set(this.automationReferenceKey(reference), reference)
    }
    return {
      preset: request.preset,
      airtime,
      networkId: request.networkId,
      eraStartYear: request.eraStartYear,
      eraEndYear: request.eraEndYear,
      selectionMode,
      ...(request.handoff ? { handoff: request.handoff } : {}),
      ...(selectionMode === 'explicit'
        ? { collectionRefs: [...collectionRefs.values()] }
        : {}),
    }
  }

  private automatedCollectionGroups(
    channelId: string,
    preview: StationBuildPreview,
    request: StationBuildRequest
  ): CollectionProgrammingGroups[] {
    const group = this.generatedGroup(channelId)
    const plannedGroups = new Map(
      preview.collections.map((collection) => [
        collection.id,
        stationCollectionProgrammingGroups(
          request.preset,
          collection,
          group,
          request
        ),
      ])
    )
    const lockedHandoffGroup = this.lockedHandoffGroup(group)
    const scheduledGroups = new Set(
      this.automatedScheduleSlots(request, group)
        .flatMap((slot) => slot.groups)
        .filter((scheduledGroup) => scheduledGroup !== lockedHandoffGroup)
    )
    const assignedGroups = new Set([...plannedGroups.values()].flat())
    const missingGroups = [...scheduledGroups].filter(
      (scheduledGroup) => !assignedGroups.has(scheduledGroup)
    )
    const fallback = [...preview.collections].sort(
      (left, right) =>
        Number(right.libraryKind === 'tv') - Number(left.libraryKind === 'tv') ||
        right.eligibleFiles - left.eligibleFiles ||
        this.compareText(left.displayTitle, right.displayTitle)
    )[0]
    if (fallback && missingGroups.length > 0) {
      plannedGroups.set(fallback.id, [
        ...new Set([...(plannedGroups.get(fallback.id) ?? []), ...missingGroups]),
      ])
    }
    const byKey = new Map(
      this.withoutConfiguredGroupTree(group).map((assignment) => [
        this.configuredCollectionKey(assignment),
        assignment,
      ])
    )
    for (const collection of preview.collections) {
      const key = this.collectionIdentityKey(
        collection.rootId,
        collection.libraryKind,
        collection.identityKey
      )
      const idKey = this.collectionIdKey(collection.id)
      const legacyKey = this.legacyConfiguredCollectionKey(
        collection.rootId,
        collection.collectionTitle
      )
      const current =
        byKey.get(key) ?? byKey.get(idKey) ?? byKey.get(legacyKey)
      byKey.delete(idKey)
      byKey.delete(legacyKey)
      byKey.set(key, {
        collectionId: collection.id,
        collectionIdentityKey: collection.identityKey,
        libraryKind: collection.libraryKind,
        rootId: collection.rootId,
        collectionTitle: collection.collectionTitle,
        groups: [
          ...new Set([
            ...(current?.groups ?? []),
            ...(plannedGroups.get(collection.id) ?? [group]),
          ]),
        ],
      })
    }
    return [...byKey.values()]
  }

  private automatedScheduleSlots(
    request: StationBuildRequest,
    group: string
  ): ChannelScheduleSlot[] {
    const slots = stationScheduleSlots(
      request.airtime ?? 'all-day',
      group,
      request.preset,
      request
    )
    return request.handoff
      ? applyLockedAfterHoursHandoff(
          slots,
          this.lockedHandoffGroup(group),
          request.handoff
        )
      : slots
  }

  private lockedHandoffGroup(group: string): string {
    return automationLockedHandoffGroup(group)
  }

  private persistAndApply(
    channels: readonly LibraryChannelPolicy[],
    manuallyOffAir: ReadonlySet<string>,
    collectionGroups: readonly CollectionProgrammingGroups[] =
      this.configuredCollectionGroups()
  ): void {
    const snapshot: ChannelConfigurationSnapshot = {
      channels,
      manuallyOffAir: [...manuallyOffAir],
      collectionGroups,
    }
    this.configurationStore?.save(snapshot)
    this.channels = validateLibraryChannels(channels)
    this.manuallyOffAir = new Set(snapshot.manuallyOffAir)
    this.applyConfiguredGroups(snapshot.collectionGroups ?? [])
    this.configurationError = null
    this.invalidateScheduleCatalog()
  }

  private async compileScheduleSource(
    epoch: number,
    media: MediaItem[]
  ): Promise<ScheduleSourceSnapshot> {
    const canonicalMedia = [...media].sort((left, right) =>
      this.compareText(
        this.canonicalMediaKey(left),
        this.canonicalMediaKey(right)
      )
    )
    const groupsByMediaId = new Map<number, ReadonlySet<string>>()
    const programMedia: MediaItem[] = []
    const interludeMedia: MediaItem[] = []

    for (let index = 0; index < canonicalMedia.length; index++) {
      if (index > 0 && index % 500 === 0) await this.yieldToEventLoop()
      const item = canonicalMedia[index] as MediaItem
      groupsByMediaId.set(item.id, this.groupsFor(item))
      if (
        item.rootAvailable !== true ||
        item.playbackEnabled !== true ||
        item.durationSeconds <= 0
      ) {
        continue
      }
      if (item.mediaType === 'interlude' || item.isInterlude) {
        interludeMedia.push(item)
      } else if (item.mediaType === 'video') {
        programMedia.push(item)
      }
    }

    const catalog = this.timelineCatalog(canonicalMedia, groupsByMediaId)
    return {
      epoch,
      expiresAt: Date.now() + SCHEDULE_SOURCE_TTL_MS,
      programMedia,
      interludeMedia,
      groupsByMediaId,
      programsByGroupKey: new Map<string, MediaItem[]>(),
      catalogHash: this.hash(JSON.stringify(catalog))
        .toString(16)
        .padStart(8, '0'),
    }
  }

  private programsForGroups(
    source: ScheduleSourceSnapshot,
    groups: readonly string[]
  ): MediaItem[] {
    const normalizedGroups = [...new Set(groups)].sort((left, right) =>
      this.compareText(left, right)
    )
    const cacheKey = JSON.stringify(normalizedGroups)
    const cached = source.programsByGroupKey.get(cacheKey)
    if (cached) return cached
    const allowedGroups = new Set(normalizedGroups)
    const eligible = source.programMedia.filter((item) => {
      const itemGroups = source.groupsByMediaId.get(item.id) ?? new Set<string>()
      return [...itemGroups].some((group) => allowedGroups.has(group))
    })
    source.programsByGroupKey.set(cacheKey, eligible)
    return eligible
  }

  private async buildNowWindow(
    channel: LibraryChannelPolicy,
    source: ScheduleSourceSnapshot,
    around: Date
  ): Promise<ScheduledProgram[]> {
    const continuousSlot = this.continuousSlot(channel)
    if (continuousSlot) {
      return this.buildContinuousAllDayWindow(
        channel,
        source,
        continuousSlot,
        around,
        1
      )
    }

    const local = this.localParts(around, channel.timezone)
    const programs: ScheduledProgram[] = []
    const aroundMs = around.getTime()
    for (let offset = 0; offset <= 7; offset++) {
      if (offset > 0) await this.yieldToEventLoop()
      const date = this.addCalendarDays(local, offset)
      programs.push(...this.buildDay(channel, source, date))
      if (
        programs.some(
          (program) => Date.parse(program.scheduledStart) > aroundMs
        )
      ) {
        break
      }
    }
    return programs.sort(
      (a, b) => Date.parse(a.scheduledStart) - Date.parse(b.scheduledStart)
    )
  }

  private async buildWindowCooperatively(
    channel: LibraryChannelPolicy,
    source: ScheduleSourceSnapshot,
    around: Date,
    futureDays: number,
    continuousHorizonHours = 24
  ): Promise<ScheduledProgram[]> {
    const continuousSlot = this.continuousSlot(channel)
    if (continuousSlot) {
      await this.yieldToEventLoop()
      return this.buildContinuousAllDayWindow(
        channel,
        source,
        continuousSlot,
        around,
        continuousHorizonHours
      )
    }
    const local = this.localParts(around, channel.timezone)
    const programs: ScheduledProgram[] = []
    for (let offset = 0; offset <= futureDays; offset++) {
      if (offset > 0) await this.yieldToEventLoop()
      const date = this.addCalendarDays(local, offset)
      programs.push(...this.buildDay(channel, source, date))
    }
    return programs.sort(
      (a, b) => Date.parse(a.scheduledStart) - Date.parse(b.scheduledStart)
    )
  }

  private continuousSlot(
    channel: LibraryChannelPolicy
  ): ChannelScheduleSlot | undefined {
    return channel.slots.find(
      (slot) =>
        slot.start === '00:00' &&
        slot.end === '24:00' &&
        DAY_NAMES.every((day) => slot.days.includes(day))
    )
  }

  private buildContinuousAllDayWindow(
    channel: LibraryChannelPolicy,
    source: ScheduleSourceSnapshot,
    slot: ChannelScheduleSlot,
    around: Date,
    horizonHours: number
  ): ScheduledProgram[] {
    const eligible = this.programsForGroups(source, slot.groups)
    if (eligible.length === 0) return []

    const orderedPrograms = this.withMarathons(
      this.deterministicShuffle(
        eligible,
        `${channel.id}|continuous|${slot.groups.join(',')}`
      ),
      channel
    )
    const ordered = this.withInterludes(
      orderedPrograms,
      source,
      channel,
      slot,
      around,
      `${channel.id}|continuous|${slot.groups.join(',')}`
    )
    const durationsMs = ordered.map((item) => item.durationSeconds * 1000)
    const cycleMs = durationsMs.reduce((total, duration) => total + duration, 0)
    if (!Number.isFinite(cycleMs) || cycleMs <= 0) return []

    // A fixed epoch and cycle offset let whole programs cross midnight without
    // gaps or truncation. The same instant always resolves to the same item,
    // including after restarts and across local daylight-saving boundaries.
    const anchorMs = Date.UTC(2020, 0, 1)
    const aroundMs = around.getTime()
    const cycleOffset = ((aroundMs - anchorMs) % cycleMs + cycleMs) % cycleMs
    let elapsed = 0
    let orderIndex = 0
    while (
      orderIndex < ordered.length - 1 &&
      cycleOffset >= elapsed + (durationsMs[orderIndex] ?? 0)
    ) {
      elapsed += durationsMs[orderIndex] ?? 0
      orderIndex++
    }
    let cursorMs = aroundMs - (cycleOffset - elapsed)
    // Seven station-calendar days can span 169 elapsed hours when daylight
    // saving time falls back. Public requests remain capped at 168 nominal
    // hours, but the calendar guide may ask for that exact extra hour.
    const horizonMs =
      aroundMs + Math.max(1, Math.min(169, horizonHours)) * 60 * 60 * 1000
    const programs: ScheduledProgram[] = []

    while (
      (cursorMs < horizonMs || programs.length < 2) &&
      programs.length < MAX_PROGRAMS_PER_SLOT
    ) {
      const selected = ordered[orderIndex]
      const durationMs = durationsMs[orderIndex]
      if (!selected || !durationMs) break
      const scheduledStart = new Date(cursorMs)
      const scheduledEnd = new Date(cursorMs + durationMs)
      programs.push(
        this.scheduledProgram(channel, selected, scheduledStart, scheduledEnd)
      )
      cursorMs = scheduledEnd.getTime()
      orderIndex = (orderIndex + 1) % ordered.length
    }
    return programs
  }

  private buildDay(
    channel: LibraryChannelPolicy,
    source: ScheduleSourceSnapshot,
    date: LocalParts
  ): ScheduledProgram[] {
    const programs: ScheduledProgram[] = []
    const recentBreakAssets: string[] = []
    const slots = channel.slots
      .filter((slot) => slot.days.includes(date.weekday))
      .sort((a, b) => this.timeToMinutes(a.start) - this.timeToMinutes(b.start))

    for (const slot of slots) {
      const start = this.zonedDateTime(
        date,
        this.timeToMinutes(slot.start),
        channel.timezone
      )
      const end = this.zonedDateTime(
        date,
        this.timeToMinutes(slot.end),
        channel.timezone
      )
      const eligible = this.programsForGroups(source, slot.groups)
      if (eligible.length === 0) continue

      const dateKey = `${date.year}-${this.pad(date.month)}-${this.pad(date.day)}`
      const ordered = this.withMarathons(
        this.deterministicShuffle(
          eligible,
          `${channel.id}|${dateKey}|${slot.start}|${slot.groups.join(',')}`
        ),
        channel
      )
      const interludes = this.orderedInterludes(
        source,
        channel,
        slot,
        start,
        `${channel.id}|${dateKey}|${slot.start}|${slot.groups.join(',')}`
      )
      const slotSeconds = Math.floor((end.getTime() - start.getTime()) / 1000)

      /* Plan the programmes first, reserving no break time at all, so the slot
         carries as many as it can hold. What is left over becomes the break
         budget. A broadcast format clock works this way round: the pods are
         sized to land the block on its boundary, rather than the leftover
         piling up as dead air at the end. */
      const frequency = this.interludeFrequency()
      /* Every break still has to fit its shortest asset. Sizing pods purely
         from leftover time would drop breaks altogether in a slot whose
         programmes happen to tile it exactly. */
      const minBreakSeconds =
        interludes.length === 0
          ? 0
          : Math.min(...interludes.map((item) => item.durationSeconds))
      const planned: MediaItem[] = []
      let plannedSeconds = 0
      let planIndex = 0
      while (planned.length < MAX_PROGRAMS_PER_SLOT) {
        let picked: MediaItem | undefined
        for (let attempt = 0; attempt < ordered.length; attempt++) {
          const candidate = ordered[(planIndex + attempt) % ordered.length]
          if (!candidate) continue
          const breaksAfter = Math.floor((planned.length + 1) / frequency)
          const committed =
            plannedSeconds +
            candidate.durationSeconds +
            minBreakSeconds * breaksAfter
          if (committed <= slotSeconds) {
            picked = candidate
            planIndex = (planIndex + attempt + 1) % ordered.length
            break
          }
        }
        if (!picked) break
        planned.push(picked)
        plannedSeconds += picked.durationSeconds
      }

      const breakSlots =
        !this.interludePolicy.enabled ? 0 : Math.floor(planned.length / frequency)
      const budgets = this.elasticBreakBudgets(
        slotSeconds - plannedSeconds - minBreakSeconds * breakSlots,
        breakSlots,
        minBreakSeconds
      )

      let cursorMs = start.getTime()
      let sequence = 0
      let breakIndex = 0
      /* Carried across every pod in the slot, not reset per break: the point is
         that the viewer does not see the same sting twice in quick succession,
         and pods sit only a programme apart. */
      for (let index = 0; index < planned.length; index++) {
        const selected = planned[index]
        if (!selected) break
        const scheduledEnd = new Date(
          cursorMs + selected.durationSeconds * 1000
        )
        programs.push(
          this.scheduledProgram(
            channel,
            selected,
            new Date(cursorMs),
            scheduledEnd
          )
        )
        cursorMs = scheduledEnd.getTime()
        sequence++

        if (!this.interludePolicy.enabled || (index + 1) % frequency !== 0) continue
        const budget = budgets[breakIndex] ?? 0
        breakIndex++
        if (budget <= 0) continue

        cursorMs = this.emitBreakPod(programs, channel, interludes, {
          startMs: cursorMs,
          limitMs: end.getTime(),
          budgetSeconds: budget,
          current: selected,
          ...(planned[index + 1] ? { next: planned[index + 1] } : {}),
          ...(planned[index + 2] ? { following: planned[index + 2] } : {}),
          recent: recentBreakAssets,
          seed: `${channel.id}|${cursorMs}|transition`,
        })
        sequence = programs.length
      }

      /* Anything the capped pods could not absorb. Reaching here means the slot
         has more empty time than a believable break load can cover, so it is
         genuinely unfilled rather than merely unbroken. */
      const recentFillers = recentBreakAssets
      while (this.interludePolicy.enabled && cursorMs < end.getTime() && sequence < MAX_PROGRAMS_PER_SLOT) {
        const remainingSeconds = (end.getTime() - cursorMs) / 1000
        if (remainingSeconds < 15 && this.absorbBreakRemainder(programs, channel, start.getTime(), remainingSeconds * 1000)) {
          cursorMs = end.getTime()
          break
        }
        const filler = selectStationFillerAsset(
          interludes.filter((item) => !recentFillers.includes(item.filename)),
          this.stationAssetKey(channel),
          remainingSeconds,
          `${channel.id}|${cursorMs}|filler`,
          recentFillers
        )
        if (!filler || sequence % 2 === 0) {
          const cardEnd = Math.min(end.getTime(), cursorMs + (remainingSeconds < 45 ? remainingSeconds * 1000 : 30_000))
          programs.push(this.scheduleCard(channel, cursorMs, cardEnd))
          cursorMs = cardEnd
          sequence++
          continue
        }
        recentFillers.push(filler.filename)
        if (recentFillers.length > FILLER_MEMORY) recentFillers.shift()
        const playSeconds = Math.min(filler.durationSeconds, remainingSeconds)
        const scheduledEnd = new Date(
          Math.min(end.getTime(), cursorMs + playSeconds * 1000)
        )
        programs.push(
          this.scheduledProgram(channel, filler, new Date(cursorMs), scheduledEnd)
        )
        cursorMs = scheduledEnd.getTime()
        sequence++
      }
    }

    return programs
  }

  private groupsFor(item: MediaItem): ReadonlySet<string> {
    const rootId = item.rootId ?? 'legacy'
    const collectionTitle = item.collectionTitle ?? ''
    const key = this.collectionKey(rootId, collectionTitle)
    const policyGroups = [...(this.groupsByCollection.get(key) ?? [])]
    const legacyAssignment = this.configuredGroupsByCollection.get(
      this.legacyConfiguredCollectionKey(rootId, collectionTitle)
    )
    const identityAssignment =
      item.collectionIdentityKey && item.libraryKind
        ? this.configuredGroupsByCollection.get(
            this.collectionIdentityKey(
              rootId,
              item.libraryKind,
              item.collectionIdentityKey
            )
          )
        : undefined
    const numericAssignment =
      item.collectionId == null
        ? undefined
        : this.configuredGroupsByCollection.get(
            this.collectionIdKey(item.collectionId)
          )
    const safeNumericAssignment =
      numericAssignment &&
      this.collectionKey(
        numericAssignment.rootId,
        numericAssignment.collectionTitle
      ) === key
        ? numericAssignment
        : undefined
    const configuredGroups = [
      ...(identityAssignment?.groups ?? []),
      ...(safeNumericAssignment?.groups ?? []),
      ...(legacyAssignment?.groups ?? []),
    ]
    if (policyGroups.length > 0 || configuredGroups.length > 0) {
      const groups = new Set(
        [...policyGroups, ...configuredGroups].filter(
          (group) => !isChannelLockedHandoffGroup(group)
        )
      )
      const metadataGenres = new Set(
        (item.collectionGenres ?? []).map((genre) =>
          genre.trim().toLocaleLowerCase('en-US')
        )
      )
      // A legacy title rule once put animated animal shows on the Nature
      // station. Once TMDB has identified a title, reserve that group for
      // documentaries and keep animation in its own programming category.
      if (
        groups.has('nature') &&
        metadataGenres.size > 0 &&
        !metadataGenres.has('documentary')
      ) {
        groups.delete('nature')
        if (metadataGenres.has('animation')) groups.add('cartoons')
      }
      return groups
    }
    // Approval and programming-group membership are independent. A parent
    // override may make a collection eligible, but it must not silently assign
    // that collection to an adventure or family-movie schedule.
    return new Set()
  }

  private programTitle(item: MediaItem): string {
    const range = parseEpisodeRange(item.relativePath || item.filename)
    const storedTitle = item.episodeTitle
      ? cleanMediaTitle(item.episodeTitle)
          .replace(/[._]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      : null
    const parsedTitle =
      parseEpisodeDisplayTitle(item.relativePath || item.filename) ||
      storedTitle
    const providerTitle = item.episodeMetadataTitle?.trim()
    // Older indexed rows may contain provider metadata for only the first
    // segment. Until metadata is refreshed, use the cleaned combined title.
    if (range?.endEpisodeNumber) {
      if (providerTitle?.includes(' + ')) return providerTitle
      if (parsedTitle) return parsedTitle
    }
    if (providerTitle) return providerTitle
    if (parsedTitle) return parsedTitle
    return cleanFilename(item.filename).replace(/[._]+/g, ' ').trim()
  }

  private scheduledProgram(
    channel: LibraryChannelPolicy,
    item: MediaItem,
    scheduledStart: Date,
    scheduledEnd: Date
  ): ScheduledProgram {
    const isInterlude = item.mediaType === 'interlude' || item.isInterlude
    const scheduledDurationSeconds = Math.max(
      0.001,
      (scheduledEnd.getTime() - scheduledStart.getTime()) / 1000
    )
    return {
      id: `${channel.id}:${scheduledStart.getTime()}:${item.id}`,
      channelId: channel.id,
      mediaId: item.id,
      title: this.programTitle(item),
      collectionTitle: isInterlude
        ? 'Interlude'
        : this.programCollectionTitle(item),
      ...(isInterlude ? {} : this.programEpisodeLabel(item)),
      scheduledStart: scheduledStart.toISOString(),
      scheduledEnd: scheduledEnd.toISOString(),
      durationSeconds: scheduledDurationSeconds,
      durationMs: scheduledDurationSeconds * 1000,
      type: isInterlude
        ? 'interlude'
        : item.libraryKind === 'movie'
          ? 'movie'
          : 'program',
      sourceStartSeconds: 0,
      sourceDurationSeconds: Math.min(item.durationSeconds, scheduledDurationSeconds),
      transitionIn: 'hard_cut',
      transitionOut: 'hard_cut',
    }
  }

  /**
   * Expand one deterministic program cycle so the fixed-epoch all-day
   * timeline accounts for every interlude byte-for-byte. Repeating the base
   * program order `frequency` times makes the cycle boundary preserve the
   * "every N programs" cadence even when the library contains fewer than N
   * programs.
   */
  private withInterludes(
    programs: MediaItem[],
    source: ScheduleSourceSnapshot,
    channel: LibraryChannelPolicy,
    slot: ChannelScheduleSlot,
    at: Date,
    seed: string
  ): MediaItem[] {
    const interludes = this.orderedInterludes(
      source,
      channel,
      slot,
      at,
      seed
    )
    if (interludes.length === 0) return programs

    const frequency = this.interludeFrequency()
    const output: MediaItem[] = []
    const recent: string[] = []
    let programCount = 0
    for (let repetition = 0; repetition < frequency; repetition++) {
      for (let index = 0; index < programs.length; index++) {
        const program = programs[index] as MediaItem
        output.push(program)
        programCount++
        if (programCount % frequency === 0) {
          const next = programs[(index + 1) % programs.length] as MediaItem
          const following = programs[(index + 2) % programs.length]
          const interlude = selectStationTransitionAsset(interludes, {
            station: this.stationAssetKey(channel),
            currentShow: this.stationProgramKey(program),
            nextShow: this.stationProgramKey(next),
            ...(following
              ? { followingShow: this.stationProgramKey(following) }
              : {}),
            seed: `${seed}|${repetition}|${index}|transition`,
            recentlyPlayed: recent,
          })
          if (interlude) { output.push(interlude); recent.push(interlude.filename); if (recent.length > FILLER_MEMORY) recent.shift() }
        }
      }
    }
    return output
  }

  private orderedInterludes(
    source: ScheduleSourceSnapshot,
    channel: LibraryChannelPolicy,
    slot: ChannelScheduleSlot,
    at: Date,
    seed: string
  ): MediaItem[] {
    if (!this.interludePolicy.enabled) return []
    return this.deterministicShuffle(
      source.interludeMedia.filter(
        (item) =>
          this.interludeActiveOn(item, at, channel.timezone)
      ),
      `${seed}|interludes|${slot.start}|${slot.end}`
    )
  }

  private interludeFrequency(): number {
    const value = Math.floor(this.interludePolicy.frequency)
    return Number.isFinite(value) && value > 0 ? value : 1
  }

  /* Spread a slot's unused time evenly over its breaks. Pods are capped so a
     slot that is mostly empty -- one short show against a long slot -- does not
     turn a single break into twenty minutes of station idents; past the cap the
     time is left for the filler tail, where it reads as unfilled rather than
     pretending to be a commercial load. */
  private elasticBreakBudgets(
    spareSeconds: number,
    breakSlots: number,
    floorSeconds: number
  ): number[] {
    if (breakSlots <= 0) return []
    const spare = Math.max(0, spareSeconds)
    const share = Math.floor(spare / breakSlots)
    let extra = spare - share * breakSlots
    const budgets: number[] = []
    for (let index = 0; index < breakSlots; index++) {
      const bonus = extra > 0 ? 1 : 0
      extra -= bonus
      budgets.push(
        Math.min(floorSeconds + share + bonus, MAX_BREAK_POD_SECONDS)
      )
    }
    return budgets
  }

  /* Reserve the closing handover before adding opening assets and cards.
     Imported clips always play in full. Returns the new cursor. */
  private emitBreakPod(
    programs: ScheduledProgram[],
    channel: LibraryChannelPolicy,
    interludes: readonly MediaItem[],
    options: {
      startMs: number
      limitMs: number
      budgetSeconds: number
      current: MediaItem
      next?: MediaItem
      following?: MediaItem
      recent: string[]
      seed: string
    }
  ): number {
    const station = this.stationAssetKey(channel)
    const podEndMs = Math.min(
      options.limitMs,
      options.startMs + options.budgetSeconds * 1000
    )
    let cursorMs = options.startMs
    const firstRow = programs.length
    const previousHistory = [...options.recent]

    const remember = (item: MediaItem): void => {
      options.recent.push(item.filename)
      if (options.recent.length > FILLER_MEMORY) options.recent.shift()
    }
    const emit = (item: MediaItem, limitMs = podEndMs): void => {
      if (item.durationSeconds * 1000 > limitMs - cursorMs) return
      const scheduledEnd = new Date(cursorMs + item.durationSeconds * 1000)
      programs.push(this.scheduledProgram(channel, item, new Date(cursorMs), scheduledEnd))
      cursorMs = scheduledEnd.getTime()
      remember(item)
    }

    /* The show-aware bumper closes the pod, immediately before the programme it
       names. Leading with it would put "Dora is coming up next" two minutes
       early, and a rightNow piece -- "starts right now" -- would simply be
       wrong. Its time is reserved up front so the fill cannot eat it. */
    const bumperContext = options.next
      ? {
          station,
          currentShow: this.stationProgramKey(options.current),
          nextShow: this.stationProgramKey(options.next),
          ...(options.following
            ? { followingShow: this.stationProgramKey(options.following) }
            : {}),
        }
      : undefined
    const budgetSeconds = Math.floor((podEndMs - cursorMs) / 1000)
    const transition = bumperContext
      ? selectStationTransitionAsset(interludes, {
          ...bumperContext,
          seed: options.seed,
          recentlyPlayed: options.recent,
          maximumDurationSeconds: budgetSeconds,
          position: 'break-in',
        })
      : undefined
    const afterTransitionMs = podEndMs - (transition?.durationSeconds ?? 0) * 1000

    const pick = (
      position: StationAssetRole,
      limitMs: number
    ): MediaItem | undefined => {
      if (cursorMs >= limitMs) return undefined
      const chosen = selectStationFillerAsset(
        interludes,
        station,
        Math.floor((limitMs - cursorMs) / 1000),
        `${options.seed}|${position}`,
        options.recent,
        position
      )
      return chosen && chosen.durationSeconds * 1000 <= limitMs - cursorMs
        ? chosen
        : undefined
    }

    /* Reserved before the middle is filled, for the same reason as the
       transition: fill first and there is never any budget left for a piece
       whose whole point is to arrive last. */
    const breakIn = pick('break-in', afterTransitionMs)
    const fillEndMs = afterTransitionMs - (breakIn?.durationSeconds ?? 0) * 1000

    /* Leaving the show: the spoken "we'll be right back" first if the station
       has one for it, then a generic break-out sting. */
    const leaving = bumperContext
      ? selectStationTransitionAsset(interludes, {
          ...bumperContext,
          seed: `${options.seed}|leaving`,
          recentlyPlayed: options.recent,
          maximumDurationSeconds: Math.floor((fillEndMs - cursorMs) / 1000),
          position: 'break-out',
        })
      : undefined
    if (leaving) emit(leaving, fillEndMs)
    const breakOut = pick('break-out', fillEndMs)
    if (breakOut) emit(breakOut, fillEndMs)

    // Decide from the selected clips, not an arbitrary total break length.
    // If there is no readable card time, use just the handover and start the
    // programme early. Roll back provisional opening clips and their history.
    if (fillEndMs - cursorMs < 15_000 && options.next) {
      programs.splice(firstRow)
      options.recent.splice(0, options.recent.length, ...previousHistory)
      cursorMs = options.startMs
      if (transition) emit(transition)
      return cursorMs
    }

    // A short station logo may precede the card; never pad a pod with a loop
    // of imported clips. Only generated cards may be sized to the remainder.
    const logo = interludes.find((item) => {
      const descriptor = parseStationAssetFilename(item.filename)
      return descriptor?.station === station && descriptor.kind === 'ident-general' && !descriptor.sequence && !descriptor.role &&
        item.durationSeconds <= 15 && !options.recent.includes(item.filename) &&
        item.durationSeconds * 1000 + 15_000 <= fillEndMs - cursorMs
    })
    if (logo) emit(logo, fillEndMs)
    else {
      const middle = selectStationFillerAsset(
        interludes.filter((item) => !options.recent.includes(item.filename) && item.id !== transition?.id && item.id !== breakIn?.id),
        station, Math.max(0, (fillEndMs - cursorMs) / 1000 - 15), `${options.seed}|middle`, options.recent
      )
      if (middle) emit(middle, fillEndMs)
    }
    while (fillEndMs - cursorMs >= 15_000) {
      // Keep a final page readable instead of leaving a sub-fifteen-second flash.
      const remainingMs = fillEndMs - cursorMs
      const cardEnd = cursorMs + (remainingMs < 45_000 ? remainingMs : 30_000)
      programs.push(this.scheduleCard(channel, cursorMs, cardEnd))
      cursorMs = cardEnd
    }

    // Closing the break, before the show-aware bumper hands over.
    if (breakIn) emit(breakIn)
    if (transition) emit(transition)
    return cursorMs
  }

  /** Extend an earlier readable card, shifting whole subsequent clips together. */
  private absorbBreakRemainder(programs: ScheduledProgram[], channel: LibraryChannelPolicy, slotStartMs: number, remainderMs: number): boolean {
    const index = programs.findLastIndex((item) => item.generated === 'schedule-card' &&
      Date.parse(item.scheduledStart) >= slotStartMs && item.durationMs + remainderMs <= 60_000)
    if (index < 0) return false
    const card = programs[index]!
    programs[index] = this.scheduleCard(channel, Date.parse(card.scheduledStart), Date.parse(card.scheduledEnd) + remainderMs)
    for (let i = index + 1; i < programs.length; i++) {
      const item = programs[i]!
      const start = Date.parse(item.scheduledStart) + remainderMs
      programs[i] = { ...item, id: `${channel.id}:${start}:${item.generated ? 'schedule-card' : item.mediaId}`,
        scheduledStart: new Date(start).toISOString(), scheduledEnd: new Date(Date.parse(item.scheduledEnd) + remainderMs).toISOString() }
    }
    return true
  }

  private scheduleCard(channel: LibraryChannelPolicy, startMs: number, endMs: number): ScheduledProgram {
    return {
      id: `${channel.id}:${startMs}:schedule-card`, channelId: channel.id,
      mediaId: 0, generated: 'schedule-card', title: 'Coming up · ' + channel.name,
      collectionTitle: 'Station schedule', scheduledStart: new Date(startMs).toISOString(),
      scheduledEnd: new Date(endMs).toISOString(), durationSeconds: (endMs - startMs) / 1000,
      durationMs: endMs - startMs, type: 'bumper', sourceStartSeconds: 0,
      sourceDurationSeconds: (endMs - startMs) / 1000, transitionIn: 'hard_cut', transitionOut: 'hard_cut',
    }
  }

  private stationAssetKey(channel: LibraryChannelPolicy): string {
    /* Nick Jr is its own on-air brand and the exporter now ships it as its own
       station, so it must not be folded into Nickelodeon's pool -- doing that
       leaves every nick-jr asset unreachable, including the Play With Us
       sequences, and dresses a preschool block in its sibling's bumpers. The
       nick-jr test has to come first: 'nick-jr' also starts with 'nick'. */
    const networkId = channel.automation?.networkId
    if (networkId === 'nick-jr') return 'nick-jr'
    if (networkId === 'nickelodeon') return 'nick'
    const key = stationShowKey(channel.id)
    if (key === 'nick-jr' || key.startsWith('nick-jr-')) return 'nick-jr'
    return key.startsWith('nick') ? 'nick' : key
  }

  private stationProgramKey(item: MediaItem): string {
    return stationShowKey(
      item.collectionTitle || item.collectionMetadataTitle || item.filename
    )
  }

  private interludeActiveOn(
    item: MediaItem,
    at: Date,
    timezone: string
  ): boolean {
    if (item.dateStart === null && item.dateEnd === null) return true
    if (!item.dateStart || !item.dateEnd) return false
    const local = this.localParts(at, timezone)
    const current = `${this.pad(local.month)}-${this.pad(local.day)}`
    const start = item.dateStart.slice(-5)
    const end = item.dateEnd.slice(-5)
    return start <= end
      ? current >= start && current <= end
      : current >= start || current <= end
  }

  private programCollectionTitle(item: MediaItem): string {
    return (
      item.collectionMetadataTitle?.trim() ||
      item.collectionTitle?.trim() ||
      cleanFilename(item.filename)
    )
  }

  private programEpisodeLabel(
    item: MediaItem
  ): { episodeLabel: string } | Record<string, never> {
    if (
      item.seasonNumber === null ||
      item.seasonNumber === undefined ||
      item.episodeNumber === null ||
      item.episodeNumber === undefined
    ) {
      return {}
    }
    return {
      episodeLabel: (() => {
        const range = parseEpisodeRange(item.relativePath || item.filename)
        const first = `S${String(item.seasonNumber).padStart(2, '0')}E${String(item.episodeNumber).padStart(2, '0')}`
        return range?.endEpisodeNumber
          ? `${first}–E${String(range.endEpisodeNumber).padStart(2, '0')}`
          : first
      })(),
    }
  }

  private directPlayback(mediaId: number): DirectPlaybackDescriptor {
    return {
      mode: 'direct',
      url: `/api/v1/media/${mediaId}/stream`,
      sourceOffsetAtPlaybackZeroMs: 0,
    }
  }

  private timelineRevision(
    channel: LibraryChannelPolicy,
    media: MediaItem[]
  ): string {
    return this.timelineRevisionForCatalog(
      channel,
      this.timelineCatalog(media)
    )
  }

  private timelineCatalog(
    media: MediaItem[],
    groupsByMediaId?: ReadonlyMap<number, ReadonlySet<string>>
  ): unknown[] {
    const ordered = groupsByMediaId
      ? media
      : [...media].sort((left, right) =>
          this.compareText(
            this.canonicalMediaKey(left),
            this.canonicalMediaKey(right)
          )
        )
    return ordered
      .filter(
        (item) => item.rootAvailable === true && item.playbackEnabled === true
      )
      .map((item) => [
        item.rootId,
        item.relativePath,
        item.durationSeconds,
        item.playbackOverride,
        item.collectionTitle,
        item.collectionMetadataTitle,
        item.seasonNumber,
        item.episodeNumber,
        item.episodeTitle,
        item.episodeMetadataTitle,
        [...(groupsByMediaId?.get(item.id) ?? this.groupsFor(item))].sort(
          (left, right) => this.compareText(left, right)
        ),
      ])
  }

  private timelineRevisionForSource(
    channel: LibraryChannelPolicy,
    source: ScheduleSourceSnapshot
  ): string {
    const interlude = this.interludePolicy.enabled
      ? { enabled: true, frequency: this.interludeFrequency() }
      : undefined
    return this.hash(
      JSON.stringify({ scheduleVersion: 'whole-clips-and-cards-v3', channel, catalogHash: source.catalogHash, interlude })
    )
      .toString(16)
      .padStart(8, '0')
  }

  private timelineRevisionForCatalog(
    channel: LibraryChannelPolicy,
    catalog: unknown[]
  ): string {
    const interlude = this.interludePolicy.enabled
      ? { enabled: true, frequency: this.interludeFrequency() }
      : undefined
    return this.hash(JSON.stringify({ scheduleVersion: 'whole-clips-and-cards-v3', channel, catalog, interlude }))
      .toString(16)
      .padStart(8, '0')
  }

  private deterministicShuffle(items: MediaItem[], seed: string): MediaItem[] {
    // Schedule-source lists are canonicalized once. Re-sorting the same large
    // group for every slot and day was the guide's dominant CPU cost.
    const output = [...items]
    let state = this.hash(seed) || 0x9e3779b9
    const random = () => {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return (state >>> 0) / 0x1_0000_0000
    }
    for (let index = output.length - 1; index > 0; index--) {
      const swapIndex = Math.floor(random() * (index + 1))
      const value = output[index]
      output[index] = output[swapIndex] as MediaItem
      output[swapIndex] = value as MediaItem
    }
    return output
  }

  /**
   * Reorder one already-deterministic programme cycle into bounded runs from a
   * TV collection. Every input appears exactly once, so enabling marathons
   * cannot introduce an immediate replay or expand the schedule indefinitely.
   */
  private withMarathons(
    programs: MediaItem[],
    channel: LibraryChannelPolicy
  ): MediaItem[] {
    const policy = channel.marathon
    if (!policy?.enabled || programs.length < 2) return programs

    const remaining = new Set(programs)
    const collectionPrograms = new Map<string, Set<MediaItem>>()
    for (const program of programs) {
      const key = this.marathonCollectionKey(program)
      if (!key) continue
      const collection = collectionPrograms.get(key) ?? new Set<MediaItem>()
      collection.add(program)
      collectionPrograms.set(key, collection)
    }

    const output: MediaItem[] = []
    let cursor = 0
    let ordinaryPrograms = 0
    while (output.length < programs.length) {
      while (cursor < programs.length && !remaining.has(programs[cursor] as MediaItem)) {
        cursor++
      }
      const candidate = programs[cursor]
      if (!candidate) break
      const key = this.marathonCollectionKey(candidate)
      const collection = key ? collectionPrograms.get(key) : undefined

      if (ordinaryPrograms >= policy.frequency && collection && collection.size >= 2) {
        const episodes = [...collection].sort((left, right) =>
          this.compareMarathonEpisodes(left, right)
        )
        const blockSize = Math.min(policy.episodeCount, episodes.length)
        const candidateIndex = episodes.indexOf(candidate)
        const blockStart = Math.min(
          Math.max(0, candidateIndex),
          episodes.length - blockSize
        )
        for (const episode of episodes.slice(blockStart, blockStart + blockSize)) {
          output.push(episode)
          remaining.delete(episode)
          collection.delete(episode)
        }
        ordinaryPrograms = 0
        continue
      }

      output.push(candidate)
      remaining.delete(candidate)
      if (collection) collection.delete(candidate)
      ordinaryPrograms++
    }
    return output
  }

  private marathonCollectionKey(item: MediaItem): string | null {
    if (item.libraryKind !== 'tv') return null
    if (!this.marathonEpisodeOrder(item)) return null
    const title = item.collectionTitle?.trim()
    if (!title) return null
    return this.collectionKey(item.rootId ?? 'legacy', title)
  }

  private compareMarathonEpisodes(left: MediaItem, right: MediaItem): number {
    const leftOrder = this.marathonEpisodeOrder(left)
    const rightOrder = this.marathonEpisodeOrder(right)
    const seasonDifference =
      (leftOrder?.season ?? Number.MAX_SAFE_INTEGER) -
      (rightOrder?.season ?? Number.MAX_SAFE_INTEGER)
    if (seasonDifference !== 0) return seasonDifference
    const episodeDifference =
      (leftOrder?.episode ?? Number.MAX_SAFE_INTEGER) -
      (rightOrder?.episode ?? Number.MAX_SAFE_INTEGER)
    if (episodeDifference !== 0) return episodeDifference
    return this.compareText(
      `${left.relativePath ?? left.path}\u0000${left.id}`,
      `${right.relativePath ?? right.path}\u0000${right.id}`
    )
  }

  private marathonEpisodeOrder(
    item: MediaItem
  ): { season: number; episode: number } | null {
    const parsed = parseEpisodeRange(item.relativePath || item.filename)
    const season = item.seasonNumber ?? parsed?.seasonNumber
    const episode = item.episodeNumber ?? parsed?.episodeNumber
    return Number.isInteger(season) && Number.isInteger(episode)
      ? { season: season as number, episode: episode as number }
      : null
  }

  private hash(value: string): number {
    let hash = 0x811c9dc5
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
    return hash >>> 0
  }

  private compareText(left: string, right: string): number {
    return left === right ? 0 : left < right ? -1 : 1
  }

  private canonicalMediaKey(item: MediaItem): string {
    return `${item.rootId ?? 'legacy'}:${item.relativePath ?? item.path}:${item.id}`
  }

  private yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }

  private localParts(date: Date, timezone: string): LocalParts {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    })
    const values = Object.fromEntries(
      formatter
        .formatToParts(date)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value])
    )
    const weekday = values.weekday?.slice(0, 3).toLowerCase() as ScheduleDay
    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day),
      hour: Number(values.hour),
      minute: Number(values.minute),
      second: Number(values.second),
      weekday,
    }
  }

  private zonedDateTime(
    date: LocalParts,
    minuteOfDay: number,
    timezone: string
  ): Date {
    const hour = Math.floor(minuteOfDay / 60)
    const minute = minuteOfDay % 60
    const desiredAsUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute)
    let candidateMs = desiredAsUtc
    for (let attempt = 0; attempt < 3; attempt++) {
      const actual = this.localParts(new Date(candidateMs), timezone)
      const actualAsUtc = Date.UTC(
        actual.year,
        actual.month - 1,
        actual.day,
        actual.hour,
        actual.minute,
        actual.second
      )
      const correction = desiredAsUtc - actualAsUtc
      candidateMs += correction
      if (correction === 0) break
    }
    return new Date(candidateMs)
  }

  private addCalendarDays(date: LocalParts, days: number): LocalParts {
    const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
    return {
      year: value.getUTCFullYear(),
      month: value.getUTCMonth() + 1,
      day: value.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
      weekday: DAY_NAMES[value.getUTCDay()] as ScheduleDay,
    }
  }

  private collectionKey(rootId: string, collectionTitle: string): string {
    return `${rootId.toLocaleLowerCase('en-US')}\u0000${collectionTitle.toLocaleLowerCase('en-US')}`
  }

  private collectionIdKey(collectionId: number): string {
    return `id\u0000${collectionId}`
  }

  private collectionIdentityKey(
    rootId: string,
    libraryKind: string,
    identityKey: string
  ): string {
    return `identity\u0000${rootId.toLocaleLowerCase('en-US')}\u0000${libraryKind}\u0000${identityKey.toLocaleLowerCase('en-US')}`
  }

  private legacyConfiguredCollectionKey(
    rootId: string,
    collectionTitle: string
  ): string {
    return `title\u0000${this.collectionKey(rootId, collectionTitle)}`
  }

  private configuredCollectionKey(
    assignment: CollectionProgrammingGroups
  ): string {
    if (
      assignment.collectionIdentityKey !== undefined &&
      assignment.libraryKind !== undefined
    ) {
      return this.collectionIdentityKey(
        assignment.rootId,
        assignment.libraryKind,
        assignment.collectionIdentityKey
      )
    }
    return assignment.collectionId === undefined
      ? this.legacyConfiguredCollectionKey(
          assignment.rootId,
          assignment.collectionTitle
        )
      : this.collectionIdKey(assignment.collectionId)
  }

  private applyConfiguredGroups(
    assignments: readonly CollectionProgrammingGroups[]
  ): void {
    const entries: Array<[string, CollectionProgrammingGroups]> = []
    for (const assignment of assignments) {
      const copy: CollectionProgrammingGroups = {
        ...(assignment.collectionId === undefined
          ? {}
          : { collectionId: assignment.collectionId }),
        ...(assignment.collectionIdentityKey === undefined ||
        assignment.libraryKind === undefined
          ? {}
          : {
              collectionIdentityKey: assignment.collectionIdentityKey,
              libraryKind: assignment.libraryKind,
            }),
        rootId: assignment.rootId,
        collectionTitle: assignment.collectionTitle,
        groups: [...assignment.groups],
      }
      entries.push([this.configuredCollectionKey(copy), copy])
    }
    this.configuredGroupsByCollection = new Map(entries)
  }

  private configuredCollectionGroups(): CollectionProgrammingGroups[] {
    const unique = new Map<string, CollectionProgrammingGroups>()
    for (const assignment of this.configuredGroupsByCollection.values()) {
      unique.set(this.configuredCollectionKey(assignment), assignment)
    }
    return [...unique.values()]
      .map((assignment) => ({
        ...assignment,
        groups: [...assignment.groups].sort((left, right) =>
          this.compareText(left, right)
        ),
      }))
      .sort((left, right) =>
        this.compareText(
          this.configuredCollectionKey(left),
          this.configuredCollectionKey(right)
        )
      )
  }

  private withoutConfiguredGroupTree(
    group: string
  ): CollectionProgrammingGroups[] {
    return this.configuredCollectionGroups()
      .map((assignment) => ({
        ...assignment,
        groups: assignment.groups.filter(
          (item) => item !== group && !item.startsWith(`${group}-`)
        ),
      }))
      .filter((assignment) => assignment.groups.length > 0)
  }

  private withoutUnreferencedGeneratedGroups(
    channels: readonly LibraryChannelPolicy[]
  ): CollectionProgrammingGroups[] {
    const referenced = new Set(
      channels.flatMap((channel) =>
        channel.slots.flatMap((slot) => slot.groups)
      )
    )
    return this.configuredCollectionGroups()
      .map((assignment) => ({
        ...assignment,
        groups: assignment.groups.filter(
          (group) => {
            if (!/^toasttv-auto-[0-9a-f]{8}(?:-[a-z0-9-]+)?$/.test(group)) {
              return true
            }
            if (referenced.has(group)) return true
            return (
              /^toasttv-auto-[0-9a-f]{8}$/.test(group) &&
              [...referenced].some((value) => value.startsWith(`${group}-`))
            )
          }
        ),
      }))
      .filter((assignment) => assignment.groups.length > 0)
  }

  private generatedGroup(channelId: string): string {
    return channelAutomationGroup(channelId)
  }

  private timeToMinutes(value: string): number {
    const [hour = '0', minute = '0'] = value.split(':')
    return Number(hour) * 60 + Number(minute)
  }

  private pad(value: number): string {
    return value.toString().padStart(2, '0')
  }
}

function applyLockedAfterHoursHandoff(
  slots: readonly ChannelScheduleSlot[],
  lockedGroup: string,
  handoff: ChannelAutomationHandoffPolicy
): ChannelScheduleSlot[] {
  const signOff = handoffTimeMinutes(handoff.start)
  const signOn = handoffTimeMinutes(handoff.end)
  if (signOff <= signOn) {
    throw new Error(
      'After-hours handoff must start in the evening and return the next morning'
    )
  }
  const daytime = slots.flatMap((slot) => {
    const start = Math.max(handoffTimeMinutes(slot.start, true), signOn)
    const end = Math.min(handoffTimeMinutes(slot.end, true), signOff)
    return end <= start
      ? []
      : [
          {
            ...slot,
            start: handoffTime(start),
            end: handoffTime(end),
          },
        ]
  })
  const everyDay: readonly ScheduleDay[] = [
    'sun',
    'mon',
    'tue',
    'wed',
    'thu',
    'fri',
    'sat',
  ]
  const branding = {
    mode: 'custom' as const,
    logoId: handoff.identity,
  }
  const locked: ChannelScheduleSlot[] = [
    ...(signOn > 0
      ? [
          {
            days: everyDay,
            start: '00:00',
            end: handoffTime(signOn),
            groups: [lockedGroup],
            branding,
          },
        ]
      : []),
    {
      days: everyDay,
      start: handoffTime(signOff),
      end: '24:00',
      groups: [lockedGroup],
      branding,
    },
  ]
  return [...daytime, ...locked].sort(
    (left, right) =>
      handoffTimeMinutes(left.start, true) -
      handoffTimeMinutes(right.start, true)
  )
}

function handoffTimeMinutes(value: string, allowEndOfDay = false): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) throw new Error(`Invalid schedule time: ${value}`)
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (
    minute > 59 ||
    hour > 24 ||
    (hour === 24 && (!allowEndOfDay || minute !== 0))
  ) {
    throw new Error(`Invalid schedule time: ${value}`)
  }
  return hour * 60 + minute
}

function handoffTime(minutes: number): string {
  if (minutes === 24 * 60) return '24:00'
  return `${Math.floor(minutes / 60).toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}`
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
