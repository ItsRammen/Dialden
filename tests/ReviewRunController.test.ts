import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createReviewRunController } from '../src/controllers/ReviewRunController'
import type {
  ReviewDecisionDraft,
  ReviewDecisionRecord,
} from '../src/services/review/auditTypes'
import type { MediaCollection, OverrideDecision } from '../src/types'

function collection(overrides: Partial<MediaCollection> = {}): MediaCollection {
  return {
    id: 1,
    rootId: 'root',
    libraryKind: 'movie',
    identityKey: 'key',
    sourceTitle: 'Title',
    parsedTitle: 'Title',
    year: 2011,
    present: true,
    metadataProvider: 'tmdb',
    metadataExternalId: null,
    metadataStatus: 'ambiguous',
    metadataLocked: false,
    metadataTitle: null,
    metadataOriginalTitle: null,
    metadataYear: null,
    overview: null,
    posterPath: null,
    backdropPath: null,
    genres: [],
    certification: null,
    certificationRegion: null,
    ratingStatus: 'missing',
    matchConfidence: null,
    metadataCandidates: [],
    metadataError: null,
    policyDecision: 'review',
    policyReason: 'rating_missing',
    policyProfileId: 'kids-7',
    parentOverride: null,
    effectiveDecision: 'review',
    decisionSource: 'policy',
    fileCount: 1,
    seasonCount: 0,
    episodeCount: 0,
    readyFileCount: 1,
    failedFileCount: 0,
    legacyOverrideCount: 0,
    scheduleEligibleCount: 0,
    rootAvailable: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as MediaCollection
}

function record(
  overrides: Partial<ReviewDecisionRecord> = {}
): ReviewDecisionRecord {
  return {
    id: 1,
    runId: 'run-1',
    collectionId: 10,
    action: 'block',
    source: 'policy',
    reason: 'rating_missing',
    detail: 'No certification',
    model: null,
    promptVersion: null,
    confidence: null,
    previousOverride: null,
    previousExternalId: null,
    previousMetadataStatus: 'matched',
    createdAt: '2026-01-01T00:00:00Z',
    revertedAt: null,
    ...overrides,
  }
}

function build(options: {
  queue?: MediaCollection[]
  decisions?: ReviewDecisionRecord[]
  assistantConfig?: Record<string, unknown>
  /** Awaited inside getReviewQueue, so a test can hold a run open. */
  gate?: Promise<void>
} = {}) {
  const overrides: { id: number; decision: OverrideDecision }[] = []
  const retried: number[] = []
  const drafts: ReviewDecisionDraft[] = []
  const revertedIds: number[] = []

  const settings = new Map<string, string>([
    [
      'review_assistant_configuration_v1',
      JSON.stringify({
        version: 1,
        enabled: false,
        apiKey: null,
        baseUrl: '',
        model: 'test/model',
        requestTimeoutMs: 30_000,
        maxConcurrency: 2,
        callBudget: 100,
        decisionPolicy: {
          reviewBand: 'manual',
          missingRating: 'block',
          unrecognizedRating: 'block',
          ambiguousMetadata: 'assist',
          unmatchedMetadata: 'assist',
        },
        ...options.assistantConfig,
      }),
    ],
  ])

  const app = new Hono()
  app.route(
    '/',
    createReviewRunController({
      library: {
        getReviewQueue: async () => {
          if (options.gate) await options.gate
          return options.queue ?? []
        },
        getDetail: async (id) => ({ collection: collection({ id }) }),
        setOverride: async (id, decision) => {
          overrides.push({ id, decision })
          return true
        },
      },
      metadata: {
        confirmMatch: async (id) => collection({ id }),
        retryCollection: async (id) => {
          retried.push(id)
          return collection({ id })
        },
      },
      audit: {
        recordReviewDecision: async (draft) => {
          drafts.push(draft)
          return drafts.length
        },
        listReviewDecisions: async () => options.decisions ?? [],
        listReviewRuns: async () => [],
        markReviewDecisionsReverted: async (ids) => {
          revertedIds.push(...ids)
          return ids.length
        },
      },
      assistantStore: {
        getSetting: async (key) => settings.get(key) ?? null,
        setSetting: async (key, value) => {
          settings.set(key, value)
        },
      },
    })
  )

  return { app, overrides, retried, drafts, revertedIds }
}

describe('review run endpoints', () => {
  test('a request that says nothing gets a dry run', async () => {
    // Defaulting the other way would mean an empty POST rewrites the library.
    const h = build({ queue: [collection({ id: 3 })] })

    const response = await h.app.request(
      '/api/admin/v1/library/review-assistant/run',
      { method: 'POST' }
    )
    const body = (await response.json()) as { report: Record<string, unknown> }

    expect(response.status).toBe(200)
    expect(body.report['dryRun']).toBe(true)
    expect(body.report['blocked']).toBe(1)
    expect(h.overrides).toHaveLength(0)
  })

  test('applying writes and audits', async () => {
    const h = build({ queue: [collection({ id: 4 })] })

    const response = await h.app.request(
      '/api/admin/v1/library/review-assistant/run',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun: false }),
      }
    )

    expect(response.status).toBe(200)
    expect(h.overrides).toEqual([{ id: 4, decision: 'block' }])
    expect(h.drafts).toHaveLength(1)
  })

  test('a second run is refused while one is in flight', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = build({ queue: [collection({ id: 5 })], gate })

    const post = async (): Promise<Response> =>
      h.app.request('/api/admin/v1/library/review-assistant/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun: true }),
      })

    const first = post()
    /* The guard used to sit before the body parse, so both requests got
       through while the first was still reading its own JSON. */
    const second = post()
    release?.()

    const statuses = [(await first).status, (await second).status].sort()
    expect(statuses).toEqual([200, 409])
  })

  test('the slot is released after a run finishes', async () => {
    const h = build({ queue: [collection({ id: 8 })] })

    const first = await h.app.request(
      '/api/admin/v1/library/review-assistant/run',
      { method: 'POST' }
    )
    const second = await h.app.request(
      '/api/admin/v1/library/review-assistant/run',
      { method: 'POST' }
    )

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
  })

  test('the settings page gets a fragment, not JSON', async () => {
    const h = build({ queue: [collection({ id: 6 })] })

    const response = await h.app.request(
      '/settings/metadata/assistant/run?dryRun=true',
      { method: 'POST' }
    )
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('Preview only')
    expect(body).toContain('review-run-summary')
    expect(body).not.toContain('<html')
  })

  test('reverting an override restores what was there before', async () => {
    const h = build({
      decisions: [
        record({ id: 1, collectionId: 20, action: 'block', previousOverride: 'allow' }),
        record({ id: 2, collectionId: 21, action: 'approve', previousOverride: null }),
      ],
    })

    const response = await h.app.request(
      '/api/admin/v1/library/review-assistant/revert',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: 'run-1' }),
      }
    )

    expect(response.status).toBe(200)
    expect(h.overrides).toEqual([
      { id: 20, decision: 'allow' },
      { id: 21, decision: null },
    ])
    expect(h.revertedIds).toEqual([1, 2])
  })

  test('reverting a match returns the collection to automatic matching', async () => {
    const h = build({
      decisions: [record({ id: 3, collectionId: 30, action: 'match', source: 'assistant' })],
    })

    await h.app.request('/api/admin/v1/library/review-assistant/revert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'run-1' }),
    })

    // Not left holding the answer being undone.
    expect(h.retried).toEqual([30])
    expect(h.overrides).toHaveLength(0)
  })

  test('a revert naming nothing is refused', async () => {
    const h = build()

    const response = await h.app.request(
      '/api/admin/v1/library/review-assistant/revert',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }
    )

    expect(response.status).toBe(400)
  })

  test('a malformed id list fails rather than running over everything', async () => {
    const h = build({ queue: [collection({ id: 7 })] })

    const response = await h.app.request(
      '/api/admin/v1/library/review-assistant/run',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun: false, collectionIds: [1, 'two'] }),
      }
    )

    expect(response.status).toBe(400)
    expect(h.overrides).toHaveLength(0)
  })
})
