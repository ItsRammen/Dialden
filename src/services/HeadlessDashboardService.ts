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

export class HeadlessDashboardService {
  constructor(
    private readonly repository: IMediaRepository,
    private readonly channels: ChannelService,
    private readonly indexer: Pick<MediaIndexer, 'getScanState'>,
    private readonly metadata: Pick<MetadataEnrichmentService, 'getState'>,
    private readonly metadataConfig: PublicMetadataConfig,
    private readonly presence?: Pick<ClientPresenceService, 'getSnapshot'>
  ) {}

  async build(updateAvailable?: boolean): Promise<HeadlessDashboardViewModel> {
    const channelList = this.channels.list().channels
    const [summary, media, metadataErrors, channelStates] = await Promise.all([
      this.repository.getLibrarySummary(),
      this.repository.getAll(),
      this.repository.getCollections({
        metadataStatus: 'error',
        presentOnly: false,
        limit: 1,
      }),
      Promise.all(
        channelList.map(async (channel) => ({
          channel,
          now: await this.channels.getNow(channel.id),
        }))
      ),
    ])
    const scan = this.indexer.getScanState()
    const metadata = this.metadata.getState()
    const presence = this.presence?.getSnapshot()
    const warnings: HeadlessDashboardWarningViewModel[] = []
    const metadataDegraded =
      this.metadataConfig.configured &&
      (metadata.providerHealth === 'degraded' ||
        metadata.status === 'failed' ||
        metadata.failed > 0 ||
        metadataErrors.length > 0)
    const metadataVerified =
      this.metadataConfig.configured &&
      metadata.providerHealth === 'connected' &&
      !metadataDegraded
    const metadataStatusMessage = !this.metadataConfig.configured
      ? 'Set TMDB_API_KEY to enable automatic collection matching.'
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
        href: '/library/files?filter=all',
        actionLabel: 'Open file details',
      })
    }
    const eligibleSeconds = media
      .filter(
        (item) =>
          item.rootAvailable === true &&
          item.playbackEnabled === true &&
          item.mediaType === 'video' &&
          !item.isInterlude &&
          item.durationSeconds > 0
      )
      .reduce((total, item) => total + item.durationSeconds, 0)
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
          summary.probeFailedFiles > 0 ||
          metadataDegraded
            ? 'degraded'
            : 'online',
        statusMessage:
          scan.status === 'failed'
            ? 'The most recent library scan failed.'
            : metadataDegraded
              ? 'Metadata enrichment needs attention.'
              : undefined,
        uptimeLabel: formatUptime(process.uptime()),
      },
      channels: channelStates.map(({ channel, now }) =>
        channelModel(channel, now, presence?.viewersByChannel[channel.id])
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
        status: !this.metadataConfig.configured
          ? 'not_configured'
          : metadataDegraded
            ? 'degraded'
            : metadataVerified
              ? 'connected'
              : 'offline',
        preferredRegion: this.metadataConfig.preferredRatingRegion,
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
  viewerCount?: number
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
          : 'off_air',
    timezone: channel.timezone,
    now: program ? programModel(program, channel.timezone) : null,
    next: next ? programModel(next, channel.timezone) : null,
    guideHref: `/api/v1/channels/${encodeURIComponent(channel.id)}/guide`,
    onAirAction: `/channels/${encodeURIComponent(channel.id)}/on-air`,
    offAirAction: `/channels/${encodeURIComponent(channel.id)}/off-air`,
    viewerCount: viewerCount ?? 0,
  }
}

function programModel(
  program: ScheduledProgram,
  timezone: string
): HeadlessChannelProgramViewModel {
  return {
    title: program.title,
    collectionTitle: program.collectionTitle,
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
