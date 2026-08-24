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
    async getAll() {
      return []
    },
    async getCollections() {
      return [...persistedErrors]
    },
  } as unknown as IMediaRepository
  const channels = {
    list: () => ({ channels: [] }),
    getNow: async () => null,
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
})
