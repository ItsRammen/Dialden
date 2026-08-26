import type { ContinuousHlsProfile } from './ContinuousChannelWorkerManager'

export type QualityTier = 'full' | 'standard' | 'economy'

export interface TierDecision {
  readonly tier: QualityTier
  readonly profile: ContinuousHlsProfile
  /**
   * How many encoders may be pre-started concurrently. Channels beyond this
   * still play, they simply start on demand when a viewer tunes to them.
   */
  readonly maximumConcurrentWorkers: number
  readonly source: 'probe' | 'override'
  readonly reason: string
}

export interface TierInput {
  readonly hardwareAcceleration: boolean
  readonly enabledChannelCount: number
}

interface ChannelQualityTierServiceOptions {
  /** Operator pin from Settings. Overrides every probe-derived decision. */
  readonly override?: QualityTier
}

const BASE_PROFILE: ContinuousHlsProfile = {
  videoCodec: 'h264',
  audioCodec: 'aac',
  audioChannels: 2,
  segmentSeconds: 1,
  // Keep enough live history to absorb a brief NAS/SQLite control-plane stall.
  // EXT-X-START still directs new viewers to the two-second live edge.
  playlistWindowSegments: 8,
  maximumWidth: 1920,
  maximumHeight: 1080,
}

const ECONOMY_CONCURRENCY = 2

function profileAtHeight(height: 720 | 1080): ContinuousHlsProfile {
  return { ...BASE_PROFILE, maximumHeight: height, maximumWidth: Math.round((height * 16) / 9) }
}

/**
 * One resolution for the entire lineup: mixing warm 720p neighbours with a
 * tuned 1080p channel changes decoder format mid-stream, which is exactly the
 * reset risk this service exists to prevent. Tier globally, never per-channel.
 */
export class ChannelQualityTierService {
  private readonly override?: QualityTier

  constructor(options: ChannelQualityTierServiceOptions = {}) {
    if (
      options.override !== undefined &&
      !['full', 'standard', 'economy'].includes(options.override)
    ) {
      throw new Error('Quality tier override must be full, standard, or economy')
    }
    this.override = options.override
  }

  resolve(input: TierInput): TierDecision {
    const channels = Math.max(0, Math.floor(input.enabledChannelCount))
    if (this.override) {
      return {
        ...this.decisionFor(this.override, channels),
        source: 'override',
        reason: `${label(this.override)} quality selected by operator override.`,
      }
    }
    const tier: QualityTier = input.hardwareAcceleration
      ? 'full'
      : channels <= 3
        ? 'standard'
        : 'economy'
    return this.decisionFor(tier, channels)
  }

  private decisionFor(tier: QualityTier, channels: number): TierDecision {
    switch (tier) {
      case 'full':
        return {
          tier,
          profile: profileAtHeight(1080),
          maximumConcurrentWorkers: Math.max(1, channels),
          source: this.override ? 'override' : 'probe',
          reason: this.override
            ? `${label(tier)} quality selected by operator override.`
            : `Intel QSV encode sustains ${Math.max(1, channels)} simultaneous 1080p channel${channels === 1 ? '' : 's'}.`,
        }
      case 'standard':
        return {
          tier,
          profile: profileAtHeight(720),
          maximumConcurrentWorkers: Math.max(1, channels),
          source: this.override ? 'override' : 'probe',
          reason: this.override
            ? `${label(tier)} quality selected by operator override.`
            : `Software encoding keeps ${channels} channel${channels === 1 ? '' : 's'} at 720p without starving playback.`,
        }
      case 'economy':
        return {
          tier,
          profile: profileAtHeight(720),
          maximumConcurrentWorkers: ECONOMY_CONCURRENCY,
          source: this.override ? 'override' : 'probe',
          reason: this.override
            ? `${label(tier)} quality selected by operator override.`
            : `Large software lineup is capped at ${ECONOMY_CONCURRENCY} pre-built encoders; remaining channels start on demand.`,
        }
    }
  }
}

function label(tier: QualityTier): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1)
}
