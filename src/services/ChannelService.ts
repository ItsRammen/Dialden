import type { IMediaRepository } from '../repositories/IMediaRepository'
import type { MediaItem } from '../types'
import type {
  ChannelScheduleSlot,
  LibraryChannelPolicy,
  LibraryPolicyDocument,
  ScheduleDay,
} from '../config/library'
import { validateLibraryChannels } from '../config/library'
import { cleanFilename } from '../utils/cleanFilename'
import type {
  ChannelConfigurationSnapshot,
  ChannelConfigurationStore,
  CollectionProgrammingGroups,
} from './ChannelConfigurationStore'
import {
  loadStationAutomationCatalog,
  selectStationCollections,
  stationAirtimeSlots,
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
  readonly playback: DirectPlaybackDescriptor
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
const MAX_PROGRAMS_PER_SLOT = 20_000
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

  async previewAutomatedStation(
    request: StationSelectionRequest
  ): Promise<StationBuildPreview> {
    const catalog = await this.stationAutomationCatalog()
    const collections = selectStationCollections(catalog, request)
    return {
      collections,
      collectionCount: collections.length,
      eligibleFiles: collections.reduce(
        (total, collection) => total + collection.eligibleFiles,
        0
      ),
    }
  }

  async previewAutomatedStationBuild(
    request: StationBuildRequest
  ): Promise<StationBuildPreview> {
    this.automatedStationChannel(request)
    return this.previewAutomatedStation(request)
  }

  async createAutomatedStation(
    request: StationBuildRequest
  ): Promise<StationBuildResult> {
    const channel = this.automatedStationChannel(request)
    const preview = await this.previewAutomatedStation(request)
    if (preview.collectionCount === 0 || preview.eligibleFiles === 0) {
      throw new Error(
        'No schedulable media matched. Approve a collection, finish metadata and media probing, then preview again.'
      )
    }
    const group = this.generatedGroup(request.id)

    const byKey = new Map(
      this.withoutConfiguredGroup(group).map((assignment) => [
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
        groups: [...new Set([...(current?.groups ?? []), group])],
      })
    }
    const channels = validateLibraryChannels([...this.channels, channel])
    this.persistAndApply(channels, this.manuallyOffAir, [...byKey.values()])
    return { channel, ...preview }
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
      const now = this.clock.now()
      return {
        channelId,
        serverTime: now.toISOString(),
        serverTimeMs: now.getTime(),
        timezone: channel.timezone,
        timelineRevision: this.timelineRevision(channel, []),
        program: null,
        next: null,
      }
    }

    const media = await this.repository.getAll()
    const around = this.clock.now()
    // A sparse channel (for example Friday movie night) may need several days
    // of look-ahead to produce a useful `next` value.
    const programs = this.buildWindow(channel, media, around, 7, 1)
    // Sample the authoritative response time after schedule generation so the
    // client does not inherit time spent reading/building the timeline.
    const now = this.clock.now()
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
      channelId,
      serverTime: now.toISOString(),
      serverTimeMs: nowMs,
      timezone: channel.timezone,
      timelineRevision: this.timelineRevision(channel, media),
      program: current
        ? {
            ...current,
            playback: this.directPlayback(current.mediaId),
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
    hours = 8
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
        programs: ScheduledProgram[]
      }
    | null
  > {
    const channel = this.getChannel(channelId)
    if (!channel) return null

    const boundedHours = Math.min(24, Math.max(1, Math.floor(hours)))
    if (this.manuallyOffAir.has(channelId)) {
      const now = this.clock.now()
      return {
        channelId,
        serverTime: now.toISOString(),
        serverTimeMs: now.getTime(),
        timezone: channel.timezone,
        timelineRevision: this.timelineRevision(channel, []),
        requestedEnd: new Date(
          now.getTime() + boundedHours * 60 * 60 * 1000
        ).toISOString(),
        coverageEnd: null,
        truncated: false,
        programs: [],
      }
    }

    const media = await this.repository.getAll()
    const around = this.clock.now()
    const programs = this.buildWindow(
      channel,
      media,
      around,
      1,
      boundedHours
    )
    const now = this.clock.now()
    const nowMs = now.getTime()
    const horizonMs = nowMs + boundedHours * 60 * 60 * 1000
    const visiblePrograms = programs.filter(
      (program) =>
        Date.parse(program.scheduledEnd) > nowMs &&
        Date.parse(program.scheduledStart) < horizonMs
    )
    const coverageEnd =
      visiblePrograms[visiblePrograms.length - 1]?.scheduledEnd ?? null
    const truncated =
      visiblePrograms.length >= MAX_PROGRAMS_PER_SLOT &&
      coverageEnd !== null &&
      Date.parse(coverageEnd) < horizonMs

    return {
      channelId,
      serverTime: now.toISOString(),
      serverTimeMs: nowMs,
      timezone: channel.timezone,
      timelineRevision: this.timelineRevision(channel, media),
      requestedEnd: new Date(horizonMs).toISOString(),
      coverageEnd,
      truncated,
      programs: visiblePrograms,
    }
  }

  private getChannel(channelId: string): LibraryChannelPolicy | null {
    return (
      this.channels.find(
        (channel) => channel.id === channelId && channel.enabled
      ) ?? null
    )
  }

  private automatedStationChannel(
    request: StationBuildRequest
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
        slots: stationAirtimeSlots(request.airtime ?? 'all-day', group),
      },
    ])[0] as LibraryChannelPolicy
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
  }

  private buildWindow(
    channel: LibraryChannelPolicy,
    media: MediaItem[],
    around: Date,
    futureDays: number,
    continuousHorizonHours = 24
  ): ScheduledProgram[] {
    const continuousSlot = channel.slots.find(
      (slot) =>
        slot.start === '00:00' &&
        slot.end === '24:00' &&
        DAY_NAMES.every((day) => slot.days.includes(day))
    )
    if (continuousSlot) {
      return this.buildContinuousAllDayWindow(
        channel,
        media,
        continuousSlot,
        around,
        continuousHorizonHours
      )
    }
    const local = this.localParts(around, channel.timezone)
    const programs: ScheduledProgram[] = []
    for (let offset = 0; offset <= futureDays; offset++) {
      const date = this.addCalendarDays(local, offset)
      programs.push(...this.buildDay(channel, media, date))
    }
    return programs.sort(
      (a, b) => Date.parse(a.scheduledStart) - Date.parse(b.scheduledStart)
    )
  }

  private buildContinuousAllDayWindow(
    channel: LibraryChannelPolicy,
    media: MediaItem[],
    slot: ChannelScheduleSlot,
    around: Date,
    horizonHours: number
  ): ScheduledProgram[] {
    const allowedGroups = new Set(slot.groups)
    const eligible = media.filter((item) => {
      if (
        item.rootAvailable !== true ||
        item.playbackEnabled !== true ||
        item.mediaType !== 'video' ||
        item.isInterlude ||
        item.durationSeconds <= 0
      ) {
        return false
      }
      return [...this.groupsFor(item)].some((group) => allowedGroups.has(group))
    })
    if (eligible.length === 0) return []

    const orderedPrograms = this.deterministicShuffle(
      eligible,
      `${channel.id}|continuous|${slot.groups.join(',')}`
    )
    const ordered = this.withInterludes(
      orderedPrograms,
      media,
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
    const horizonMs =
      aroundMs + Math.max(1, Math.min(24, horizonHours)) * 60 * 60 * 1000
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
    media: MediaItem[],
    date: LocalParts
  ): ScheduledProgram[] {
    const programs: ScheduledProgram[] = []
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
      const allowedGroups = new Set(slot.groups)
      const eligible = media.filter((item) => {
        if (
          item.rootAvailable !== true ||
          item.playbackEnabled !== true ||
          item.mediaType !== 'video' ||
          item.isInterlude ||
          item.durationSeconds <= 0
        ) {
          return false
        }
        const groups = this.groupsFor(item)
        return [...groups].some((group) => allowedGroups.has(group))
      })
      if (eligible.length === 0) continue

      const dateKey = `${date.year}-${this.pad(date.month)}-${this.pad(date.day)}`
      const ordered = this.deterministicShuffle(
        eligible,
        `${channel.id}|${dateKey}|${slot.start}|${slot.groups.join(',')}`
      )
      let cursorMs = start.getTime()
      let sequence = 0
      let orderIndex = 0
      let programsSinceInterlude = 0
      let interludeIndex = 0
      const interludes = this.orderedInterludes(
        media,
        channel,
        slot,
        start,
        `${channel.id}|${dateKey}|${slot.start}|${slot.groups.join(',')}`
      )

      while (cursorMs < end.getTime() && sequence < MAX_PROGRAMS_PER_SLOT) {
        const remainingSeconds = Math.floor((end.getTime() - cursorMs) / 1000)
        let selected: MediaItem | undefined
        for (let attempt = 0; attempt < ordered.length; attempt++) {
          const candidate = ordered[(orderIndex + attempt) % ordered.length]
          if (candidate && candidate.durationSeconds <= remainingSeconds) {
            selected = candidate
            orderIndex = (orderIndex + attempt + 1) % ordered.length
            break
          }
        }
        if (!selected) break

        const scheduledStart = new Date(cursorMs)
        const scheduledEnd = new Date(
          cursorMs + selected.durationSeconds * 1000
        )
        programs.push(
          this.scheduledProgram(channel, selected, scheduledStart, scheduledEnd)
        )
        cursorMs = scheduledEnd.getTime()
        sequence++
        programsSinceInterlude++

        if (
          programsSinceInterlude >= this.interludeFrequency() &&
          interludes.length > 0 &&
          sequence < MAX_PROGRAMS_PER_SLOT
        ) {
          const interlude = interludes[interludeIndex % interludes.length]
          const interludeEndMs =
            cursorMs + (interlude?.durationSeconds ?? 0) * 1000
          if (interlude && interludeEndMs <= end.getTime()) {
            programs.push(
              this.scheduledProgram(
                channel,
                interlude,
                new Date(cursorMs),
                new Date(interludeEndMs)
              )
            )
            cursorMs = interludeEndMs
            sequence++
            interludeIndex++
            programsSinceInterlude = 0
          } else if (interlude) {
            // Never skip a due break merely to squeeze another program into a
            // bounded slot. The next slot starts a fresh cadence.
            break
          }
        }
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
      const groups = new Set([...policyGroups, ...configuredGroups])
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
    const providerTitle = item.episodeMetadataTitle?.trim()
    if (providerTitle) return providerTitle
    const parsedTitle = item.episodeTitle
      ?.replace(/[._]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
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
      durationSeconds: item.durationSeconds,
      durationMs: item.durationSeconds * 1000,
      type: isInterlude
        ? 'interlude'
        : item.libraryKind === 'movie'
          ? 'movie'
          : 'program',
      sourceStartSeconds: 0,
      sourceDurationSeconds: item.durationSeconds,
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
    media: MediaItem[],
    channel: LibraryChannelPolicy,
    slot: ChannelScheduleSlot,
    at: Date,
    seed: string
  ): MediaItem[] {
    const interludes = this.orderedInterludes(
      media,
      channel,
      slot,
      at,
      seed
    )
    if (interludes.length === 0) return programs

    const frequency = this.interludeFrequency()
    const output: MediaItem[] = []
    let programCount = 0
    let interludeIndex = 0
    for (let repetition = 0; repetition < frequency; repetition++) {
      for (const program of programs) {
        output.push(program)
        programCount++
        if (programCount % frequency === 0) {
          output.push(interludes[interludeIndex % interludes.length] as MediaItem)
          interludeIndex++
        }
      }
    }
    return output
  }

  private orderedInterludes(
    media: MediaItem[],
    channel: LibraryChannelPolicy,
    slot: ChannelScheduleSlot,
    at: Date,
    seed: string
  ): MediaItem[] {
    if (!this.interludePolicy.enabled) return []
    return this.deterministicShuffle(
      media.filter(
        (item) =>
          item.rootAvailable === true &&
          item.playbackEnabled === true &&
          (item.mediaType === 'interlude' || item.isInterlude) &&
          item.durationSeconds > 0 &&
          this.interludeActiveOn(item, at, channel.timezone)
      ),
      `${seed}|interludes|${slot.start}|${slot.end}`
    )
  }

  private interludeFrequency(): number {
    const value = Math.floor(this.interludePolicy.frequency)
    return Number.isFinite(value) && value > 0 ? value : 1
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
      episodeLabel: `S${String(item.seasonNumber).padStart(2, '0')}E${String(item.episodeNumber).padStart(2, '0')}`,
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
    const catalog = media
      .filter(
        (item) => item.rootAvailable === true && item.playbackEnabled === true
      )
      .map((item) => [
        item.rootId,
        item.relativePath,
        item.durationSeconds,
        item.playbackOverride,
        [...this.groupsFor(item)].sort((left, right) =>
          this.compareText(left, right)
        ),
      ])
      .sort((a, b) => this.compareText(JSON.stringify(a), JSON.stringify(b)))
    const interlude = this.interludePolicy.enabled
      ? { enabled: true, frequency: this.interludeFrequency() }
      : undefined
    return this.hash(JSON.stringify({ channel, catalog, interlude }))
      .toString(16)
      .padStart(8, '0')
  }

  private deterministicShuffle(items: MediaItem[], seed: string): MediaItem[] {
    const output = [...items].sort((a, b) =>
      this.compareText(
        `${a.rootId}:${a.relativePath ?? a.path}`,
        `${b.rootId}:${b.relativePath ?? b.path}`
      )
    )
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

  private withoutConfiguredGroup(
    group: string
  ): CollectionProgrammingGroups[] {
    return this.configuredCollectionGroups()
      .map((assignment) => ({
        ...assignment,
        groups: assignment.groups.filter((item) => item !== group),
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
          (group) =>
            !/^toasttv-auto-[0-9a-f]{8}$/.test(group) || referenced.has(group)
        ),
      }))
      .filter((assignment) => assignment.groups.length > 0)
  }

  private generatedGroup(channelId: string): string {
    return `toasttv-auto-${this.hash(channelId).toString(16).padStart(8, '0')}`
  }

  private timeToMinutes(value: string): number {
    const [hour = '0', minute = '0'] = value.split(':')
    return Number(hour) * 60 + Number(minute)
  }

  private pad(value: number): string {
    return value.toString().padStart(2, '0')
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
