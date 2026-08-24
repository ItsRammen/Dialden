import type { AppConfig } from '../repositories/ConfigRepository'
import type { IMediaRepository } from '../repositories/IMediaRepository'
import type {
  ChannelTimelinePosition,
  ChannelTimelineResolver,
} from './ContinuousChannelWorkerManager'
import type { ChannelService, ScheduledProgram } from './ChannelService'
import type { MediaDeliveryService } from './MediaDeliveryService'

type SessionFallbackConfig = Pick<AppConfig, 'session'>

/** Adapts the deterministic public guide to safe, absolute worker inputs. */
export class ChannelTimelineResolverService implements ChannelTimelineResolver {
  constructor(
    private readonly channels: Pick<ChannelService, 'getNow' | 'getGuide'>,
    private readonly media: Pick<
      MediaDeliveryService,
      'resolveForChannelWorker'
    >,
    private readonly repository: Pick<IMediaRepository, 'getById'>,
    private readonly config?: () => Promise<SessionFallbackConfig>
  ) {}

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
    const [now, guide] = await Promise.all([
      this.channels.getNow(channelId),
      this.channels.getGuide(channelId, hours),
    ])
    if (!now || !guide || !now.program) return []

    const ordered = guide.programs.filter(
      (program) => Date.parse(program.scheduledEnd) > now.serverTimeMs
    )
    const currentIndex = ordered.findIndex(
      (program) => program.id === now.program?.id
    )
    const window = (currentIndex >= 0 ? ordered.slice(currentIndex) : [now.program])
      .slice(0, Math.max(1, minimumItems))
    const result: ChannelTimelinePosition[] = []

    for (let index = 0; index < window.length; index++) {
      const program = window[index]
      if (!program) continue
      const resolved = await this.media.resolveForChannelWorker(program.mediaId)
      if (!resolved) break
      const isCurrent = program.id === now.program.id
      const elapsed = isCurrent ? now.program.offsetSeconds : 0
      result.push(
        this.position(
          program,
          resolved.path,
          guide.timelineRevision,
          elapsed,
          window[index + 1]?.id
        )
      )
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
    nextScheduleItemId?: string
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
      sourceDurationSeconds: Math.max(
        0.001,
        program.sourceDurationSeconds - boundedElapsed
      ),
      timelineRevision,
      type: program.type,
    }
  }
}
