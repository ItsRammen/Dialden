import { describe, expect, test } from 'bun:test'
import type { PublicMetadataConfig } from '../src/config/metadata'
import type { IMediaRepository } from '../src/repositories/IMediaRepository'
import type { ChannelService } from '../src/services/ChannelService'
import { HeadlessDashboardService } from '../src/services/HeadlessDashboardService'
import type {
  LibraryScanState,
  LibrarySummary,
  MediaCollection,
  MetadataJobState,
} from '../src/types'

const summary: LibrarySummary = {
  tvCollections: 0,
  tvEpisodes: 0,
  movieCollections: 0,
  interludeFiles: 0,
  totalFiles: 0,
  approvedCollections: 0,
  reviewCollections: 0,
  blockedCollections: 0,
  unmatchedCollections: 0,
  metadataPendingCollections: 0,
  metadataMatchedCollections: 0,
  metadataReviewCollections: 0,
  probeFailedFiles: 0,
  eligibleDurationSeconds: 0,
}

const scan: LibraryScanState = {
  status: 'idle',
  currentRoot: null,
  currentFile: null,
  discoveredFiles: 0,
  processedFiles: 0,
  indexedFiles: 0,
  failedFiles: 0,
  startedAt: null,
  completedAt: null,
  error: null,
}

const publicConfig: PublicMetadataConfig = {
  provider: 'tmdb',
  configured: true,
  language: 'en-US',
  preferredRatingRegion: 'US',
  fallbackRatingRegions: [],
  requestTimeoutMs: 10_000,
}

function metadataState(
  overrides: Partial<MetadataJobState> = {}
): MetadataJobState {
  return {
    status: 'idle',
    providerHealth: 'unverified',
    providerMessage: null,
    total: 0,
    processed: 0,
    matched: 0,
    needsReview: 0,
    failed: 0,
    currentCollectionId: null,
    startedAt: null,
    completedAt: null,
    error: null,
    ...overrides,
  }
}

function dashboard(
  state: MetadataJobState,
  persistedErrors: readonly MediaCollection[] = [],
  config: PublicMetadataConfig = publicConfig,
  summaryOverrides: Partial<LibrarySummary> = {}
): HeadlessDashboardService {
  const repository = {
    async getLibrarySummary() {
      return { ...summary, ...summaryOverrides }
    },
    async getCollections() {
      return [...persistedErrors]
    },
  } as unknown as IMediaRepository
  const channels = {
    list: () => ({ channels: [] }),
    getLineupSchedule: async () => ({ schedules: [] }),
  } as unknown as ChannelService

  return new HeadlessDashboardService(
    repository,
    channels,
    { getScanState: () => scan },
    { getState: () => state },
    config
  )
}

describe('headless dashboard metadata health', () => {
  test('links technical indexing failures directly to the filtered files', async () => {
    const view = await dashboard(metadataState(), [], publicConfig, {
      probeFailedFiles: 6,
    }).build()

    expect(view.warnings).toContainEqual({
      severity: 'critical',
      message: '6 files failed technical indexing',
      href: '/library/files?filter=errors',
      actionLabel: 'Open file details',
    })
  })

  test('shows configured-but-unverified metadata as unavailable, not connected', async () => {
    const view = await dashboard(metadataState()).build()

    expect(view.metadata.status).toBe('offline')
    expect(view.metadata.statusMessage).toContain(
      'no successful provider request has been observed'
    )
    expect(view.server.status).toBe('degraded')
    expect(view.warnings).toContainEqual({
      severity: 'critical',
      message: 'No enabled channels are configured.',
      href: '/channels',
      actionLabel: 'Manage channels',
    })
  })

  test('shows connected only after the service reports an observed success', async () => {
    const view = await dashboard(
      metadataState({ providerHealth: 'connected' })
    ).build()

    expect(view.metadata.status).toBe('connected')
    expect(view.metadata.statusMessage).toBeUndefined()
  })

  test('degrades the card and server and adds a warning after a failed run', async () => {
    const providerMessage =
      'The metadata provider rejected the configured credentials.'
    const view = await dashboard(
      metadataState({
        status: 'failed',
        providerHealth: 'degraded',
        providerMessage,
        failed: 1,
      })
    ).build()

    expect(view.metadata.status).toBe('degraded')
    expect(view.metadata.statusMessage).toBe(providerMessage)
    expect(view.server.status).toBe('degraded')
    expect(view.warnings).toContainEqual({
      severity: 'critical',
      message: providerMessage,
      href: '/library/review/metadata',
      actionLabel: 'Review metadata',
    })
  })

  test('keeps health degraded while a persisted metadata error row exists', async () => {
    const view = await dashboard(
      metadataState({ providerHealth: 'connected' }),
      [{} as MediaCollection]
    ).build()

    expect(view.metadata.status).toBe('degraded')
    expect(view.server.status).toBe('degraded')
    expect(view.warnings?.some((warning) => warning.severity === 'critical')).toBe(
      true
    )
  })

  test('warns when files were indexed through the legacy root instead of managed collections', async () => {
    const view = await dashboard(
      metadataState({ providerHealth: 'connected' }),
      [],
      publicConfig,
      { totalFiles: 20_976 }
    ).build()

    expect(view.server.status).toBe('degraded')
    expect(
      view.warnings?.some(
        (warning) =>
          warning.severity === 'critical' &&
          warning.message.includes('20,976 files are indexed') &&
          warning.message.includes('TOASTTV_TV_MEDIA')
      )
    ).toBe(true)
  })

  test('uses the aggregate eligible duration without loading every media row', async () => {
    const view = await dashboard(metadataState(), [], publicConfig, {
      eligibleDurationSeconds: 90 * 60,
    }).build()

    expect(view.warnings).toContainEqual({
      severity: 'info',
      message: 'Only 1h 30m of technically valid, approved programming is eligible',
      href: '/library/review',
      actionLabel: 'Review library',
    })
  })
})

describe('headless dashboard request coalescing', () => {
  test('reads one lineup snapshot instead of requesting every channel separately', async () => {
    let lineupCalls = 0
    let getNowCalls = 0
    const repository = {
      async getLibrarySummary() {
        return { ...summary, eligibleDurationSeconds: 3 * 60 * 60 }
      },
      async getCollections() {
        return []
      },
      async getAll() {
        throw new Error('dashboard must not materialize the media library')
      },
    } as unknown as IMediaRepository
    const channelList = [
      {
        id: 'kids',
        name: 'Kids',
        enabled: true,
        timezone: 'UTC',
        onAir: true,
        manuallyOffAir: false,
      },
      {
        id: 'nature',
        name: 'Nature',
        enabled: true,
        timezone: 'UTC',
        onAir: true,
        manuallyOffAir: false,
      },
    ]
    const channels = {
      list: () => ({ channels: channelList }),
      async getLineupSchedule() {
        lineupCalls += 1
        return { schedules: [] }
      },
      async getNow() {
        getNowCalls += 1
        return null
      },
    } as unknown as ChannelService
    const service = new HeadlessDashboardService(
      repository,
      channels,
      { getScanState: () => scan },
      { getState: () => metadataState() },
      publicConfig
    )

    const view = await service.build()

    expect(view.channels.map((channel) => channel.id)).toEqual([
      'kids',
      'nature',
    ])
    expect(lineupCalls).toBe(1)
    expect(getNowCalls).toBe(0)
  })

  test('coalesces concurrent builds and reuses the result for five seconds', async () => {
    let currentTime = 1_000
    let summaryCalls = 0
    let releaseSummary!: () => void
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve
    })
    const repository = {
      async getLibrarySummary() {
        summaryCalls += 1
        await summaryGate
        return summary
      },
      async getCollections() {
        return []
      },
    } as unknown as IMediaRepository
    const channels = {
      list: () => ({ channels: [] }),
      getLineupSchedule: async () => ({ schedules: [] }),
    } as unknown as ChannelService
    const service = new HeadlessDashboardService(
      repository,
      channels,
      { getScanState: () => scan },
      { getState: () => metadataState() },
      publicConfig,
      undefined,
      undefined,
      () => currentTime
    )

    const first = service.build()
    const second = service.build()
    expect(summaryCalls).toBe(1)
    releaseSummary()
    expect(await first).toBe(await second)

    await service.build()
    expect(summaryCalls).toBe(1)

    currentTime += 5_001
    await service.build()
    expect(summaryCalls).toBe(2)
  })
})
