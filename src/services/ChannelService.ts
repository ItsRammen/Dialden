import type { IMediaRepository } from '../repositories/IMediaRepository'
import type { MediaItem } from '../types'
import type {
  LibraryChannelPolicy,
  LibraryPolicyDocument,
  ScheduleDay,
} from '../config/library'
import { cleanFilename } from '../utils/cleanFilename'

export interface ChannelClock {
  now(): Date
}

export interface ChannelSummary {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly timezone: string
  readonly onAir: boolean
}

export interface ScheduledProgram {
  readonly id: string
  readonly channelId: string
  readonly mediaId: number
  readonly title: string
  readonly collectionTitle: string
  readonly scheduledStart: string
  readonly scheduledEnd: string
  readonly durationSeconds: number
  readonly durationMs: number
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
  private readonly channels: readonly LibraryChannelPolicy[]
  private readonly groupsByCollection = new Map<string, ReadonlySet<string>>()
  private readonly manuallyOffAir = new Set<string>()

  constructor(
    private readonly repository: IMediaRepository,
    policy: LibraryPolicyDocument | null,
    private readonly clock: ChannelClock = SYSTEM_CLOCK
  ) {
    this.channels = policy?.channels ?? []
    for (const [rootId, root] of Object.entries(policy?.roots ?? {})) {
      for (const collection of root.collections) {
        this.groupsByCollection.set(
          this.collectionKey(rootId, collection.name),
          new Set(collection.groups ?? [])
        )
      }
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
        })),
    }
  }

  setOnAir(channelId: string, onAir: boolean): boolean {
    if (!this.getChannel(channelId)) return false
    if (onAir) this.manuallyOffAir.delete(channelId)
    else this.manuallyOffAir.add(channelId)
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
    const programs = this.buildWindow(channel, media, around, 7)
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
        programs: ScheduledProgram[]
      }
    | null
  > {
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
        programs: [],
      }
    }

    const boundedHours = Math.min(24, Math.max(1, Math.floor(hours)))
    const media = await this.repository.getAll()
    const around = this.clock.now()
    const programs = this.buildWindow(channel, media, around, 1)
    const now = this.clock.now()
    const nowMs = now.getTime()
    const horizonMs = nowMs + boundedHours * 60 * 60 * 1000
    const visiblePrograms = programs.filter(
      (program) =>
        Date.parse(program.scheduledEnd) > nowMs &&
        Date.parse(program.scheduledStart) < horizonMs
    )

    return {
      channelId,
      serverTime: now.toISOString(),
      serverTimeMs: nowMs,
      timezone: channel.timezone,
      timelineRevision: this.timelineRevision(channel, media),
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

  private buildWindow(
    channel: LibraryChannelPolicy,
    media: MediaItem[],
    around: Date,
    futureDays: number
  ): ScheduledProgram[] {
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
      const maximumPrograms = Math.max(ordered.length * 100, 1000)

      while (cursorMs < end.getTime() && sequence < maximumPrograms) {
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
        programs.push({
          id: `${channel.id}:${scheduledStart.getTime()}:${selected.id}`,
          channelId: channel.id,
          mediaId: selected.id,
          title: this.programTitle(selected),
          collectionTitle: selected.collectionTitle ?? selected.filename,
          scheduledStart: scheduledStart.toISOString(),
          scheduledEnd: scheduledEnd.toISOString(),
          durationSeconds: selected.durationSeconds,
          durationMs: selected.durationSeconds * 1000,
        })
        cursorMs = scheduledEnd.getTime()
        sequence++
      }
    }

    return programs
  }

  private groupsFor(item: MediaItem): ReadonlySet<string> {
    const configured = this.groupsByCollection.get(
      this.collectionKey(item.rootId ?? 'legacy', item.collectionTitle ?? '')
    )
    if (configured) return configured
    // Approval and programming-group membership are independent. A parent
    // override may make a collection eligible, but it must not silently assign
    // that collection to an adventure or family-movie schedule.
    return new Set()
  }

  private programTitle(item: MediaItem): string {
    const filename = cleanFilename(item.filename)
    const collection = item.collectionTitle ?? ''
    return collection && !filename.toLowerCase().includes(collection.toLowerCase())
      ? `${collection} — ${filename}`
      : filename
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
      ])
      .sort((a, b) => this.compareText(JSON.stringify(a), JSON.stringify(b)))
    return this.hash(JSON.stringify({ channel, catalog })).toString(16).padStart(8, '0')
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

  private timeToMinutes(value: string): number {
    const [hour = '0', minute = '0'] = value.split(':')
    return Number(hour) * 60 + Number(minute)
  }

  private pad(value: number): string {
    return value.toString().padStart(2, '0')
  }
}
