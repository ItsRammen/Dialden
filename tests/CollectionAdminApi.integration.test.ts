import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import {
  loadMetadataConfig,
  toPublicMetadataConfig,
} from '../src/config/metadata'
import { createCollectionLibraryController } from '../src/controllers/CollectionLibraryController'
import { MediaRepository } from '../src/repositories/MediaRepository'
import { CollectionLibraryService } from '../src/services/CollectionLibraryService'
import type { MetadataJobState } from '../src/types'

const idleMetadataState: MetadataJobState = {
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
}

describe('collection administration API integration', () => {
  let repository: MediaRepository
  let app: Hono
  let collectionId: number
  let refreshCount: number

  beforeEach(async () => {
    repository = new MediaRepository(':memory:')
    await repository.initialize()
    const [collection] = await repository.upsertCollections([
      {
        rootId: 'tv',
        libraryKind: 'tv',
        identityKey: JSON.stringify(['bluey', 2018]),
        sourceTitle: 'Bluey (2018)',
        parsedTitle: 'Bluey',
        year: 2018,
      },
    ])
    collectionId = collection?.id ?? 0
    refreshCount = 0

    const secret = 'must-not-leave-the-server'
    const controller = createCollectionLibraryController({
      library: new CollectionLibraryService(repository),
      indexer: {
        getScanState: () => ({
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
        }),
        scanAll: async () => 0,
      },
      metadata: {
        getState: () => idleMetadataState,
        runPending: async () => idleMetadataState,
        confirmMatch: async () => null,
        retryCollection: async () => null,
        testConnection: async () => {},
      },
      metadataConfig: toPublicMetadataConfig(
        loadMetadataConfig({ TMDB_API_KEY: secret })
      ),
      refreshSchedules: async () => {
        refreshCount++
      },
    })
    app = new Hono()
    app.route('/', controller)
  })

  afterEach(async () => {
    await repository.close()
  })

  test('approve, block, and reset-policy mutate the collection override and refresh schedules', async () => {
    const approve = await app.request(
      `/api/admin/v1/library/collections/${collectionId}/approve`,
      { method: 'POST' }
    )
    expect(approve.status).toBe(200)
    expect(await approve.json()).toMatchObject({
      collection: {
        id: collectionId,
        parentOverride: 'allow',
        effectiveDecision: 'allow',
        decisionSource: 'parent',
      },
    })

    const block = await app.request(
      `/api/admin/v1/library/collections/${collectionId}/block`,
      { method: 'POST' }
    )
    expect(block.status).toBe(200)
    expect(await block.json()).toMatchObject({
      collection: {
        id: collectionId,
        parentOverride: 'block',
        effectiveDecision: 'block',
      },
    })

    const reset = await app.request(
      `/api/admin/v1/library/collections/${collectionId}/reset-policy`,
      { method: 'POST' }
    )
    expect(reset.status).toBe(200)
    expect(await reset.json()).toMatchObject({
      collection: {
        id: collectionId,
        parentOverride: null,
        policyDecision: 'review',
        effectiveDecision: 'review',
        decisionSource: 'policy',
      },
    })
    expect(refreshCount).toBe(3)
  })

  test('returns only redacted metadata configuration', async () => {
    const response = await app.request('/api/v1/library/metadata')
    const serialized = JSON.stringify(await response.json())

    expect(response.status).toBe(200)
    expect(serialized).not.toContain('must-not-leave-the-server')
    expect(JSON.parse(serialized)).toMatchObject({
      config: {
        provider: 'tmdb',
        configured: true,
        language: 'en-US',
        preferredRatingRegion: 'US',
      },
      state: { status: 'idle' },
    })
  })
})
