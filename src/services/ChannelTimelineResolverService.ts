import { existsSync } from 'node:fs'
import type { AppConfig } from '../repositories/ConfigRepository'
import type {
  ChannelBrandingPolicy,
  ChannelScheduleSlot,
  LibraryChannelPolicy,
} from '../config/library'
import type { ChannelLogoStore } from './ChannelLogoStore'
import type { IMediaRepository } from '../repositories/IMediaRepository'
import type {
  ChannelTimelinePosition,
  ChannelTimelineResolver,
  ChannelVideoOverlay,
} from './ContinuousChannelWorkerManager'
import type { ChannelService, ScheduledProgram } from './ChannelService'
import type { MediaDeliveryService } from './MediaDeliveryService'

type ChannelRuntimeConfig = Pick<AppConfig, 'session'> &
  Partial<Pick<AppConfig, 'logo'>>

export interface ChannelBrandingPresentation {
  readonly enabled: boolean
  readonly logoUrl?: string
}

interface ResolvedChannelBranding {
  readonly policy: ChannelBrandingPolicy
  readonly logoId?: string
}

/** Adapts the deterministic public guide to safe, absolute worker inputs. */
export class ChannelTimelineResolverService implements ChannelTimelineResolver {
  constructor(
    private readonly channels: Pick<ChannelService, 'getGuide'> &
      Partial<Pick<ChannelService, 'getNow' | 'administrationSnapshot'>>,
    private readonly media: Pick<
      MediaDeliveryService,
      'resolveForChannelWorker'
    >,
    private readonly repository: Pick<IMediaRepository, 'getById'>,
    private readonly config?: () => Promise<ChannelRuntimeConfig>,
    private readonly logos?: Pick<ChannelLogoStore, 'path'> &
      Partial<Pick<ChannelLogoStore, 'has'>>,
    private readonly sourceExists: (path: string) => boolean = existsSync
  ) {}

  /** Effective logo metadata for the client UI at the authoritative response time. */
  async presentation(
    channelId: string,
    at = new Date()
  ): Promise<ChannelBrandingPresentation> {
    const channel = this.channel(channelId)
    if (!channel) return { enabled: false }
    const selected = this.resolveBranding(channel, at)
    if (selected.policy.mode === 'off') return { enabled: false }

    if (selected.policy.mode === 'custom') {
      if (!this.logos) return { enabled: false }
      const available = this.logos.has
        ? this.logos.has(channel.id, selected.logoId)
        : this.sourceExists(this.logos.path(channel.id, selected.logoId))
      if (!available) {
        return { enabled: false }
      }
      const base = `/channels/${encodeURIComponent(channel.id)}/logo`
      return {
        enabled: true,
        logoUrl: selected.logoId
          ? `${base}?variant=${encodeURIComponent(selected.logoId)}`
          : base,
      }
    }

    const runtime = await this.config?.()
    const global = runtime?.logo
    if (
      !global?.enabled ||
      !global.imagePath ||
      !this.sourceExists(global.imagePath)
    ) {
      return { enabled: false }
    }
    return { enabled: true, logoUrl: '/logo' }
  }

  async overlay(channelId: string, at = new Date()): Promise<ChannelVideoOverlay | null> {
    const channel = this.channel(channelId)
    if (!channel) return null
    return this.resolveOverlay(channel, at, await this.config?.())
  }

  private resolveOverlay(
    channel: LibraryChannelPolicy,
    at: Date,
    runtime?: ChannelRuntimeConfig
  ): ChannelVideoOverlay | null {
    const selected = this.resolveBranding(channel, at)
    const branding = selected.policy
    if (branding.mode === 'off' || branding.burnIn !== true) return null
    if (branding.mode === 'custom') {
      if (!this.logos) return null
      if (this.logos.has && !this.logos.has(channel.id, selected.logoId)) {
        return null
      }
      return {
        sourcePath: this.logos.path(channel.id, selected.logoId),
        ...brandingValues(branding),
      }
    }
    const global = runtime?.logo
    if (
      !global?.enabled ||
      !global.imagePath ||
      !this.sourceExists(global.imagePath)
    ) {
      return null
    }
    return {
      sourcePath: global.imagePath,
      opacity: clamp(global.opacity / 255, 0, 1),
      position: normalizePosition(global.position),
      x: boundedInteger(global.x, 8, 0, 500),
      y: boundedInteger(global.y, 8, 0, 500),
      sizePercent: 12,
    }
  }

  private resolveBranding(
    channel: LibraryChannelPolicy,
    at: Date
  ): ResolvedChannelBranding {
    const channelBranding = channel.branding ?? defaultBranding('inherit')
    const slotBranding = activeSlot(channel, at)?.branding
    if (slotBranding?.mode === 'inherit') {
      return {
        policy: {
          ...defaultBranding('inherit'),
          ...(channelBranding.burnIn === true ? { burnIn: true } : {}),
        },
      }
    }
    if (slotBranding?.mode === 'off') {
      return { policy: defaultBranding('off') }
    }
    if (slotBranding?.mode === 'custom') {
      return {
        policy: { ...channelBranding, mode: 'custom' },
        logoId: slotBranding.logoId,
      }
    }
    return { policy: channelBranding }
  }

  async resolve(
    channelId: string,
    _at: Date
  ): Promise<ChannelTimelinePosition | null> {
    return (await this.resolveWindow(channelId, _at, 1))[0] ?? null
  }

  async resolveWindow(
    channelId: string,
    _at: Date,
    minimumItems: number
  ): Promise<readonly ChannelTimelinePosition[]> {
    const hours = Math.min(24, Math.max(1, Math.ceil(minimumItems * 2)))
    // One guide response owns the catalog, timeline revision, and clock sample.
    // Combining an independently generated /now response with a guide can
    // straddle a schedule boundary and briefly start the previous programme.
    const guide = await this.channels.getGuide(channelId, hours)
    if (!guide) return []

    const ordered = guide.programs.filter(
      (program) => Date.parse(program.scheduledEnd) > guide.serverTimeMs
    )
    const currentIndex = ordered.findIndex(
      (program) =>
        Date.parse(program.scheduledStart) <= guide.serverTimeMs &&
        guide.serverTimeMs < Date.parse(program.scheduledEnd)
    )
    if (currentIndex < 0) return []
    const current = ordered[currentIndex]!
    const window = ordered
      .slice(currentIndex)
      .slice(0, Math.max(1, minimumItems))
    const result: ChannelTimelinePosition[] = []
    const channel = this.channel(channelId)
    const [runtime, resolvedWindow] = await Promise.all([
      this.config?.(),
      Promise.all(
        window.map((program) =>
          this.media.resolveForChannelWorker(program.mediaId)
        )
      ),
    ])

    for (let index = 0; index < window.length; index++) {
      const program = window[index]
      if (!program) continue
      const resolved = resolvedWindow[index]
      if (!resolved) break
      const isCurrent = program.id === current.id
      const elapsed = isCurrent
        ? Math.max(
            0,
            (guide.serverTimeMs - Date.parse(program.scheduledStart)) / 1000
          )
        : 0
      const startAt = new Date(
        Date.parse(program.scheduledStart) + elapsed * 1_000
      )
      const remaining = Math.max(0.001, program.sourceDurationSeconds - elapsed)
      const parts = channel?.branding?.burnIn === true
        ? brandingSlices(channel, startAt, remaining)
        : [{ at: startAt, offsetSeconds: 0, durationSeconds: remaining }]
      for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        const part = parts[partIndex]
        if (!part) continue
        result.push(
          this.position(
            program,
            resolved.path,
            guide.timelineRevision,
            elapsed + part.offsetSeconds,
            part.durationSeconds,
            window[index + 1]?.id,
            channel ? this.resolveOverlay(channel, part.at, runtime) : null,
            partIndex
          )
        )
        if (result.length >= Math.max(1, minimumItems)) break
      }
      if (result.length >= Math.max(1, minimumItems)) break
    }
    return result
  }

  async fallback(
    channelId: string,
    missing: ChannelTimelinePosition | null,
    _at: Date
  ): Promise<ChannelTimelinePosition | null> {
    const id = (await this.config?.())?.session.offAirAssetId
    if (!id) return null
    const [item, resolved] = await Promise.all([
      this.repository.getById(id),
      this.media.resolveForChannelWorker(id),
    ])
    if (!item || !resolved || item.durationSeconds <= 0) return null
    return {
      scheduleItemId: `${channelId}:fallback:${id}`,
      sourcePath: resolved.path,
      sourceOffsetSeconds: 0,
      sourceDurationSeconds:
        missing?.sourceDurationSeconds ?? item.durationSeconds,
      loopSource: missing !== null,
      timelineRevision: missing?.timelineRevision ?? 'fallback',
      type: 'offair',
    }
  }

  private position(
    program: ScheduledProgram,
    sourcePath: string,
    timelineRevision: string,
    elapsedSeconds: number,
    durationSeconds: number,
    nextScheduleItemId?: string,
    overlay?: ChannelVideoOverlay | null,
    partIndex = 0
  ): ChannelTimelinePosition {
    const boundedElapsed = Math.max(
      0,
      Math.min(program.sourceDurationSeconds, elapsedSeconds)
    )
    return {
      scheduleItemId: partIndex > 0 ? `${program.id}:brand-${partIndex}` : program.id,
      ...(nextScheduleItemId ? { nextScheduleItemId } : {}),
      sourcePath,
      sourceOffsetSeconds: program.sourceStartSeconds + boundedElapsed,
      sourceDurationSeconds: Math.max(0.001, durationSeconds),
      overlay,
      timelineRevision,
      type: program.type,
    }
  }


  private channel(channelId: string): LibraryChannelPolicy | undefined {
    return this.channels
      .administrationSnapshot?.()
      .channels.find((candidate) => candidate.id === channelId)
  }
}

function activeSlot(
  channel: LibraryChannelPolicy,
  at: Date
): ChannelScheduleSlot | undefined {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: channel.timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const weekday = (parts.find((part) => part.type === 'weekday')?.value ?? '').toLowerCase()
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0')
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0')
  const localMinutes = hour * 60 + minute
  return channel.slots.find((slot) => {
    if (!slot.days.includes(weekday as ChannelScheduleSlot['days'][number])) return false
    return scheduleMinutes(slot.start) <= localMinutes && localMinutes < scheduleMinutes(slot.end)
  })
}

function brandingSlices(
  channel: LibraryChannelPolicy,
  startAt: Date,
  durationSeconds: number
): Array<{ at: Date; offsetSeconds: number; durationSeconds: number }> {
  const endMs = startAt.getTime() + durationSeconds * 1_000
  const boundaries = [startAt.getTime()]
  let prior = slotBrandingKey(activeSlot(channel, startAt))
  let cursor = Math.floor(startAt.getTime() / 60_000) * 60_000 + 60_000
  while (cursor < endMs) {
    const current = slotBrandingKey(activeSlot(channel, new Date(cursor)))
    if (current !== prior) boundaries.push(cursor)
    prior = current
    cursor += 60_000
  }
  boundaries.push(endMs)
  return boundaries.slice(0, -1).map((boundary, index) => ({
    at: new Date(boundary),
    offsetSeconds: (boundary - startAt.getTime()) / 1_000,
    durationSeconds: ((boundaries[index + 1] ?? endMs) - boundary) / 1_000,
  }))
}

function slotBrandingKey(slot: ChannelScheduleSlot | undefined): string {
  return slot?.branding?.mode === 'custom'
    ? `custom:${slot.branding.logoId}`
    : slot?.branding?.mode ?? 'channel'
}

function scheduleMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number)
  return (hour ?? 0) * 60 + (minute ?? 0)
}

function defaultBranding(mode: ChannelBrandingPolicy['mode']): ChannelBrandingPolicy {
  return { mode, opacity: 210, position: 2, x: 24, y: 24, sizePercent: 12 }
}

function brandingValues(
  branding: ChannelBrandingPolicy
): Omit<ChannelVideoOverlay, 'sourcePath'> {
  return {
    opacity: clamp(branding.opacity / 255, 0, 1),
    position: branding.position,
    x: branding.x,
    y: branding.y,
    sizePercent: branding.sizePercent,
  }
}

function normalizePosition(value: number): 0 | 2 | 6 | 8 {
  return value === 0 || value === 6 || value === 8 ? value : 2
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  return Number.isInteger(value)
    ? Math.max(minimum, Math.min(maximum, value as number))
    : fallback
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}
