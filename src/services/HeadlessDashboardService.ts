import type { PublicMetadataConfig } from '../config/metadata'
import type { IMediaRepository } from '../repositories/IMediaRepository'
import type {
  HeadlessChannelProgramViewModel,
  HeadlessChannelViewModel,
  HeadlessDashboardViewModel,
  HeadlessDashboardWarningViewModel,
} from '../templates/headlessDashboard'
import type { ChannelService, ScheduledProgram } from './ChannelService'
import type { MediaIndexer } from './MediaIndexer'
import type { MetadataEnrichmentService } from './metadata/MetadataEnrichmentService'
import type { ClientPresenceService } from './ClientPresenceService'
import type { ContinuousChannelWorkerManager } from './ContinuousChannelWorkerManager'

const DASHBOARD_CACHE_TTL_MS = 5_000

export class HeadlessDashboardService {
  private readonly cachedBuilds = new Map<
    string,
    { readonly expiresAt: number; readonly value: HeadlessDashboardViewModel }
  >()
  private readonly buildsInFlight = new Map<
    string,
    Promise<HeadlessDashboardViewModel>
  >()

  constructor(
    private readonly repository: IMediaRepository,
    private readonly channels: ChannelService,
    private readonly indexer: Pick<MediaIndexer, 'getScanState'>,
    private readonly metadata: Pick<MetadataEnrichmentService, 'getState'>,
    private readonly metadataConfig:
      | PublicMetadataConfig
      | (() => PublicMetadataConfig),
    private readonly presence?: Pick<ClientPresenceService, 'getSnapshot'>,
    private readonly workers?: Pick<ContinuousChannelWorkerManager, 'getState'>,
    private readonly now: () => number = () => Date.now()
  ) {}

  async build(updateAvailable?: boolean): Promise<HeadlessDashboardViewModel> {
    const cacheKey =
      updateAvailable === undefined
        ? 'unknown'
        : updateAvailable
          ? 'available'
          : 'current'
    const cached = this.cachedBuilds.get(cacheKey)
    if (cached && cached.expiresAt > this.now()) return cached.value
    if (cached) this.cachedBuilds.delete(cacheKey)

    const existing = this.buildsInFlight.get(cacheKey)
    if (existing) return existing

    const promise = this.buildFresh(updateAvailable)
    this.buildsInFlight.set(cacheKey, promise)
    try {
      const value = await promise
      this.cachedBuilds.set(cacheKey, {
        expiresAt: this.now() + DASHBOARD_CACHE_TTL_MS,
        value,
      })
      return value
    } finally {
      if (this.buildsInFlight.get(cacheKey) === promise) {
        this.buildsInFlight.delete(cacheKey)
      }
    }
  }

  private async buildFresh(
    updateAvailable?: boolean
  ): Promise<HeadlessDashboardViewModel> {
    const channelList = this.channels.list().channels
    const [summary, metadataErrors, lineup] = await Promise.all([
      this.repository.getLibrarySummary(),
      this.repository.getCollections({
        metadataStatus: 'error',
        presentOnly: false,
        limit: 1,
      }),
      channelList.length > 0
        ? this.channels.getLineupSchedule()
        : Promise.resolve({ schedules: [] }),
    ])
    const schedulesByChannel = new Map(
      lineup.schedules.map((schedule) => [schedule.channelId, schedule])
    )
    const channelStates = channelList.map((channel) => ({
      channel,
      now: schedulesByChannel.get(channel.id) ?? null,
    }))
    const scan = this.indexer.getScanState()
    const metadata = this.metadata.getState()
    const metadataConfig =
      typeof this.metadataConfig === 'function'
        ? this.metadataConfig()
        : this.metadataConfig
    const presence = this.presence?.getSnapshot()
    const warnings: HeadlessDashboardWarningViewModel[] = []
    const channelConfigurationError =
      this.channels.administrationSnapshot?.().configurationError ?? null
    const libraryRootMisconfigured =
      summary.totalFiles > 0 &&
      summary.tvCollections === 0 &&
      summary.movieCollections === 0
    const metadataDegraded =
      metadataConfig.configured &&
      (metadata.providerHealth === 'degraded' ||
        metadata.status === 'failed' ||
        metadata.failed > 0 ||
        metadataErrors.length > 0)
    const metadataVerified =
      metadataConfig.configured &&
      metadata.providerHealth === 'connected' &&
      !metadataDegraded
    const metadataStatusMessage = !metadataConfig.configured
      ? 'Add a TMDB API key in Metadata settings to enable automatic collection matching.'
      : metadataDegraded
        ? metadata.providerMessage ??
          'One or more metadata records failed and need attention.'
        : metadataVerified
          ? undefined
          : 'TMDB is configured, but no successful provider request has been observed yet.'

    if (summary.reviewCollections > 0) {
      warnings.push({
        severity: 'warning',
        message: `${summary.reviewCollections} collections need a parent decision`,
        href: '/library/review',
        actionLabel: 'Review approvals',
      })
    }
    if (libraryRootMisconfigured) {
      warnings.push({
        severity: 'critical',
        message: `${summary.totalFiles.toLocaleString('en-US')} files are indexed, but none belong to managed TV or movie collections. Configure TOASTTV_TV_MEDIA and TOASTTV_MOVIE_MEDIA, then rescan.`,
        href: '/library/files',
        actionLabel: 'Inspect indexed files',
      })
    }
    if (channelList.length === 0) {
      warnings.push({
        severity: 'critical',
        message: 'No enabled channels are configured.',
        href: '/channels',
        actionLabel: 'Manage channels',
      })
    }
    if (channelConfigurationError) {
      warnings.push({
        severity: 'critical',
        message: `Saved channel configuration was rejected: ${channelConfigurationError}`,
        href: '/channels',
        actionLabel: 'Repair channels',
      })
    }
    for (const { channel, now } of channelStates) {
      if (channel.onAir && !now?.program && !now?.next) {
        warnings.push({
          severity: 'warning',
          message: `${channel.name} has no eligible programming. Check its slots, programming groups, library approvals, and media availability.`,
          href: `/channels?edit=${encodeURIComponent(channel.id)}#editor`,
          actionLabel: 'Configure channel',
        })
      }
      const worker = this.workers?.getState(channel.id)
      if (worker?.status === 'error') {
        warnings.push({
          severity: 'critical',
          message: `${channel.name} channel worker failed: ${worker.lastError ?? 'FFmpeg is unavailable'}`,
          href: `/channels?edit=${encodeURIComponent(channel.id)}#editor`,
          actionLabel: 'Inspect channel',
        })
      }
    }
    if (summary.metadataReviewCollections > 0) {
      warnings.push({
        severity: 'warning',
        message: `${summary.metadataReviewCollections} metadata matches or ratings need review`,
        href: '/library/review/metadata',
        actionLabel: 'Review metadata',
      })
    }
    if (metadataDegraded) {
      warnings.push({
        severity: 'critical',
        message: metadataStatusMessage ?? 'Metadata provider needs attention.',
        href: '/library/review/metadata',
        actionLabel: 'Review metadata',
      })
    }
    if (summary.probeFailedFiles > 0) {
      warnings.push({
        severity: 'critical',
        message: `${summary.probeFailedFiles} files failed technical indexing`,
        href: '/library/files?filter=errors',
        actionLabel: 'Open file details',
      })
    }
    const eligibleSeconds = summary.eligibleDurationSeconds
    if (eligibleSeconds < 3 * 60 * 60) {
      warnings.push({
        severity: 'info',
        message: `Only ${formatHours(eligibleSeconds)} of technically valid, approved programming is eligible`,
        href: '/library/review',
        actionLabel: 'Review library',
      })
    }

    return {
      server: {
        status:
          scan.status === 'failed' ||
          libraryRootMisconfigured ||
          channelList.length === 0 ||
          channelConfigurationError !== null ||
          summary.probeFailedFiles > 0 ||
          metadataDegraded
            ? 'degraded'
            : 'online',
        statusMessage:
          scan.status === 'failed'
            ? 'The most recent library scan failed.'
            : libraryRootMisconfigured
              ? 'Indexed media is not attached to managed TV or movie roots.'
              : channelConfigurationError
                ? 'Saved channel configuration was rejected.'
                : channelList.length === 0
                  ? 'No enabled channels are configured.'
                  : metadataDegraded
                    ? 'Metadata enrichment needs attention.'
                    : undefined,
        uptimeLabel: formatUptime(process.uptime()),
      },
      channels: channelStates.map(({ channel, now }) =>
        channelModel(
          channel,
          now,
          presence?.viewersByChannel[channel.id],
          this.workers?.getState(channel.id)
        )
      ),
      library: {
        tvCollections: summary.tvCollections,
        episodes: summary.tvEpisodes,
        movieCollections: summary.movieCollections,
        interludes: summary.interludeFiles,
        approvedCollections: summary.approvedCollections,
        reviewCollections: summary.reviewCollections,
        blockedCollections: summary.blockedCollections,
      },
      scan: {
        status: scan.status,
        discoveredFiles: scan.discoveredFiles,
        processedFiles: scan.processedFiles,
        indexedFiles: scan.indexedFiles,
        failedFiles: scan.failedFiles,
        currentLocationLabel:
          scan.currentRoot && scan.currentFile
            ? `${scan.currentRoot}/${scan.currentFile}`
            : scan.currentRoot ?? undefined,
        lastScanLabel: scan.completedAt
          ? new Date(scan.completedAt).toLocaleString()
          : undefined,
        errorMessage: scan.error ?? undefined,
      },
      metadata: {
        providerName: 'TMDB',
        status: !metadataConfig.configured
          ? 'not_configured'
          : metadataDegraded
            ? 'degraded'
            : metadataVerified
              ? 'connected'
              : 'offline',
        preferredRegion: metadataConfig.preferredRatingRegion,
        matchedCollections: summary.metadataMatchedCollections,
        pendingCollections: summary.metadataPendingCollections,
        reviewCollections: summary.metadataReviewCollections,
        lastRefreshLabel: metadata.completedAt
          ? new Date(metadata.completedAt).toLocaleString()
          : undefined,
        statusMessage: metadataStatusMessage,
      },
      clients: presence?.clients.map((client) => ({
        clientId: client.clientId,
        name: client.name,
        connected: client.connected,
        channelName:
          channelList.find((channel) => channel.id === client.channelId)?.name ??
          client.channelId ??
          undefined,
        playbackMode: client.playbackMode,
        lastSeenLabel: `Last seen ${new Date(client.lastSeenAt).toLocaleString()}`,
      })),
      warnings,
      updateAvailable,
    }
  }
}

function channelModel(
  channel: ReturnType<ChannelService['list']>['channels'][number],
  now: Awaited<ReturnType<ChannelService['getNow']>>,
  viewerCount?: number,
  worker?: ReturnType<ContinuousChannelWorkerManager['getState']>
): HeadlessChannelViewModel {
  const program = now?.program ?? null
  const next = now?.next ?? null
  return {
    id: channel.id,
    name: channel.name,
    status: !channel.onAir
      ? 'off_air'
      : program
        ? 'on_air'
        : next
          ? 'scheduled'
          : 'no_program',
    timezone: channel.timezone,
    now: program ? programModel(program, channel.timezone) : null,
    next: next ? programModel(next, channel.timezone) : null,
    guideHref: `/api/v1/channels/${encodeURIComponent(channel.id)}/guide`,
    manageHref: `/channels?edit=${encodeURIComponent(channel.id)}#editor`,
    onAirAction: channel.manuallyOffAir
      ? `/channels/${encodeURIComponent(channel.id)}/on-air`
      : undefined,
    offAirAction:
      channel.onAir && (program || next)
        ? `/channels/${encodeURIComponent(channel.id)}/off-air`
        : undefined,
    viewerCount: Math.max(viewerCount ?? 0, worker?.viewerCount ?? 0),
    worker: worker
      ? {
          status: worker.status,
          transcoding: worker.transcoding,
          usingFallback: worker.usingFallback,
          sessionHeld: worker.sessionHeld === true,
          ...(worker.lastError ? { errorMessage: worker.lastError } : {}),
        }
      : {
          status: 'stopped',
          transcoding: false,
          usingFallback: false,
          sessionHeld: false,
        },
  }
}

function programModel(
  program: ScheduledProgram,
  timezone: string
): HeadlessChannelProgramViewModel {
  return {
    title: program.title,
    collectionTitle: program.collectionTitle,
    episodeLabel: program.episodeLabel,
    timeRange: `${formatTime(program.scheduledStart, timezone)}–${formatTime(
      program.scheduledEnd,
      timezone
    )}`,
  }
}

function formatTime(value: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(value))
  } catch {
    return new Date(value).toISOString().slice(11, 16)
  }
}

function formatHours(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}
