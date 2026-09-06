import type { ScheduleCardService } from './ScheduleCardService'
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
} from './ContinuousChannelWorkerManager'
import type { ChannelService, ScheduledProgram } from './ChannelService'
import type { MediaDeliveryService } from './MediaDeliveryService'
import type { MediaItem } from '../types'

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
  private readonly unavailableReasons = new Map<string, string>()

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
    private readonly sourceExists: (path: string) => boolean = existsSync,
    private readonly hardwareDecodesH264: () => boolean = () => false,
    private readonly scheduleCards?: Pick<ScheduleCardService, 'resolve'>
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
    if (!guide) {
      this.unavailableReasons.set(
        channelId,
        `No schedule is available for channel ${channelId}`
      )
      return []
    }

    const ordered = guide.programs.filter(
      (program) => Date.parse(program.scheduledEnd) > guide.serverTimeMs
    )
    const currentIndex = ordered.findIndex(
      (program) =>
        Date.parse(program.scheduledStart) <= guide.serverTimeMs &&
        guide.serverTimeMs < Date.parse(program.scheduledEnd)
    )
    if (currentIndex < 0) {
      this.unavailableReasons.set(
        channelId,
        `No programme is scheduled for channel ${channelId} at ${new Date(
          guide.serverTimeMs
        ).toISOString()}`
      )
      return []
    }
    const current = ordered[currentIndex]!
    const window = ordered
      .slice(currentIndex)
      .slice(0, Math.max(1, minimumItems))
    const result: ChannelTimelinePosition[] = []
    const resolvedWindow = await Promise.all(
      window.map(async (program) => {
        if (program.generated === 'schedule-card') {
          if (!this.scheduleCards) return { resolved: null, item: null }
          const channel = this.channel(channelId)
          const selected = channel ? this.resolveBranding(channel, new Date(program.scheduledStart)) : undefined
          let logoPath: string | undefined
          if (selected?.policy.mode === 'custom' && this.logos) {
            const path = this.logos.path(channelId, selected.logoId)
            if (this.sourceExists(path)) logoPath = path
          }
          const path = await this.scheduleCards.resolve({
            channelName: channel?.name ?? channelId, timezone: guide.timezone,
            program, programs: guide.programs, logoPath,
          })
          return { resolved: { path }, item: { hasAudio: true, width: 1280, height: 720, codec: 'h264', compatibility: 'compatible', pixelFormat: 'yuv420p' } as MediaItem }
        }
        return {
          resolved: await this.media.resolveForChannelWorker(program.mediaId),
          item: await this.repository.getById(program.mediaId),
        }
      })
    )

    for (let index = 0; index < window.length; index++) {
      const program = window[index]
      if (!program) continue
      const entry = resolvedWindow[index]
      if (!entry?.resolved) {
        if (index === 0) {
          this.unavailableReasons.set(
            channelId,
            this.mediaUnavailableReason(channelId, program, entry?.item ?? null)
          )
        }
        break
      }
      const resolved = entry.resolved
      const mediaItem = entry.item
      const isCurrent = program.id === current.id
      const elapsed = isCurrent
        ? Math.max(
            0,
            (guide.serverTimeMs - Date.parse(program.scheduledStart)) / 1000
          )
        : 0
      const remaining = Math.max(0.001, program.sourceDurationSeconds - elapsed)
      result.push(
        this.position(
          program,
          resolved.path,
          guide.timelineRevision,
          elapsed,
          remaining,
          window[index + 1]?.id,
          typeof mediaItem?.hasAudio === 'boolean'
            ? mediaItem.hasAudio
            : undefined,
          this.hardwareDecodesH264() && hardwareDecodable(mediaItem)
            ? 'hw'
            : 'sw',
          mediaItem?.width ?? null,
          mediaItem?.height ?? null
        )
      )
      if (result.length >= Math.max(1, minimumItems)) break
    }
    if (result.length > 0) this.unavailableReasons.delete(channelId)
    return result
  }

  unavailableReason(channelId: string): string | null {
    return this.unavailableReasons.get(channelId) ?? null
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
    hasAudio?: boolean,
    decodeHint?: 'hw' | 'sw',
    sourceWidth?: number | null,
    sourceHeight?: number | null
  ): ChannelTimelinePosition {
    const boundedElapsed = Math.max(
      0,
      Math.min(program.sourceDurationSeconds, elapsedSeconds)
    )
    return {
      scheduleItemId: program.id,
      ...(nextScheduleItemId ? { nextScheduleItemId } : {}),
      sourcePath,
      sourceOffsetSeconds: program.sourceStartSeconds + boundedElapsed,
      sourceDurationSeconds: Math.max(0.001, durationSeconds),
      ...(hasAudio === undefined ? {} : { hasAudio }),
      ...(decodeHint === undefined ? {} : { decodeHint }),
      ...(typeof sourceWidth === 'number' && sourceWidth > 0
        ? { sourceWidth }
        : {}),
      ...(typeof sourceHeight === 'number' && sourceHeight > 0
        ? { sourceHeight }
        : {}),
      timelineRevision,
      type: program.type,
    }
  }

  private mediaUnavailableReason(
    channelId: string,
    program: ScheduledProgram,
    item: MediaItem | null
  ): string {
    const prefix = `Scheduled media ${program.mediaId} for channel ${channelId} is unavailable`
    if (!item) return `${prefix}: its library row no longer exists`
    if (item.rootAvailable !== true) {
      return `${prefix}: library root ${item.rootId || 'unknown'} is unavailable (a library scan may be in progress)`
    }
    if (item.playbackEnabled !== true) {
      return `${prefix}: playback is no longer approved`
    }
    if (!(item.durationSeconds > 0)) {
      return `${prefix}: technical indexing has no usable duration`
    }
    if (!item.relativePath) {
      return `${prefix}: its root-relative locator is missing`
    }
    return `${prefix}: the configured source file could not be resolved`
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

function scheduleMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number)
  return (hour ?? 0) * 60 + (minute ?? 0)
}

function defaultBranding(mode: ChannelBrandingPolicy['mode']): ChannelBrandingPolicy {
  return { mode, opacity: 210, position: 2, x: 24, y: 24, sizePercent: 12 }
}

/*
 * Codecs the media engine decodes, measured rather than assumed --
 * scripts/qsv-capability-probe.sh on the deployed box. H.264, HEVC at 8 and
 * 10 bit, AV1, VP9 and MPEG-2 all passed. VC-1 and MPEG-4 part 2 were not
 * probed and stay on software until they are; they are 212 files between them.
 */
const HARDWARE_DECODABLE_CODECS = new Set([
  'h264',
  'hevc',
  'av1',
  'vp9',
  'mpeg2video',
])

/**
 * Hardware decode eligibility.
 *
 * Conservative where it must be and no further. An unknown pixel format — a
 * legacy row awaiting the probe backfill — is software-only, because failing
 * closed here prevents a mid-tune spawn death. The deep-colour exclusion
 * applies to H.264 alone: Intel has no Hi10P decoder, but 10-bit HEVC decodes
 * fine provided the graph converts P010 to NV12, which the hardware pipeline
 * always asks for.
 */
function hardwareDecodable(
  item: Pick<MediaItem, 'codec' | 'compatibility' | 'pixelFormat'> | null
): boolean {
  if (!item) return false
  if (item.compatibility === 'incompatible') return false
  const codec = item.codec
  if (typeof codec !== 'string' || !HARDWARE_DECODABLE_CODECS.has(codec)) return false
  const pixelFormat = item.pixelFormat
  if (typeof pixelFormat !== 'string' || pixelFormat.length === 0) return false
  if (codec === 'h264' && /(?:10|12|16)/.test(pixelFormat)) return false
  return true
}
