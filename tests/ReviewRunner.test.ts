import { describe, expect, test } from 'bun:test'
import { ReviewRunner } from '../src/services/review/ReviewRunner'
import type { AutoDecisionPolicy } from '../src/services/review/autoDecision'
import type {
  ReviewDecisionDraft,
  ReviewDecisionRecord,
} from '../src/services/review/auditTypes'
import type { ReviewAssistant } from '../src/services/review/types'
import type { MediaCollection, OverrideDecision } from '../src/types'

function collection(overrides: Partial<MediaCollection> = {}): MediaCollection {
  return {
    id: 1,
    rootId: 'root',
    libraryKind: 'movie',
    identityKey: 'key',
    sourceTitle: 'Some Film (2011)',
    parsedTitle: 'Some Film',
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
    policyReason: 'metadata_ambiguous',
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

function candidate(externalId: string, title: string, year?: number) {
  return {
    provider: 'tmdb',
    externalId,
    mediaType: 'movie' as const,
    title,
    ...(year === undefined ? {} : { year }),
    confidence: 0.5,
  }
}

class FakeAudit {
  readonly drafts: ReviewDecisionDraft[] = []
  async recordReviewDecision(draft: ReviewDecisionDraft): Promise<number> {
    this.drafts.push(draft)
    return this.drafts.length
  }
  async listReviewDecisions(): Promise<ReviewDecisionRecord[]> {
    return []
  }
  async listReviewRuns(): Promise<
    { runId: string; startedAt: string; decisions: number; reverted: number }[]
  > {
    return []
  }
  async markReviewDecisionsReverted(): Promise<number> {
    return 0
  }
}

interface Harness {
  runner: ReviewRunner
  audit: FakeAudit
  overrides: { id: number; decision: OverrideDecision }[]
  matches: { id: number; externalId: string }[]
  calls: number
}

function harness(
  queue: MediaCollection[],
  assistant?: Partial<ReviewAssistant> & { configured?: boolean }
): Harness {
  const audit = new FakeAudit()
  const overrides: { id: number; decision: OverrideDecision }[] = []
  const matches: { id: number; externalId: string }[] = []
  const state = { calls: 0 }

  const full: ReviewAssistant | undefined = assistant
    ? ({
        id: 'fake',
        configured: assistant.configured ?? true,
        testConnection: async () => {},
        disambiguate: async (request) => {
          state.calls++
          return assistant.disambiguate
            ? assistant.disambiguate(request)
            : { status: 'rejected' as const, reason: 'no stub' }
        },
        assessSuitability: async () => ({
          status: 'rejected' as const,
          reason: 'not used',
        }),
      } as ReviewAssistant)
    : undefined

  const runner = new ReviewRunner({
    library: {
      getReviewQueue: async () => queue,
      getCollection: async (id) => queue.find((c) => c.id === id) ?? null,
      setOverride: async (id, decision) => {
        overrides.push({ id, decision })
        return true
      },
    },
    metadata: {
      confirmMatch: async (id, externalId) => {
        matches.push({ id, externalId })
        return collection({ id })
      },
    },
    audit,
    ...(full ? { assistant: full } : {}),
    assistantModel: 'test/model',
    promptVersion: 'v1',
    newRunId: () => 'run-1',
  })

  return {
    runner,
    audit,
    overrides,
    matches,
    get calls() {
      return state.calls
    },
  }
}

const blockMissing: AutoDecisionPolicy = {
  reviewBand: 'manual',
  missingRating: 'block',
  unrecognizedRating: 'block',
  ambiguousMetadata: 'assist',
  unmatchedMetadata: 'assist',
}

describe('automated review runner', () => {
  test('never revisits a collection a person already ruled on', async () => {
    const h = harness([
      collection({
        id: 7,
        policyReason: 'rating_missing',
        parentOverride: 'allow',
      }),
    ])

    const report = await h.runner.run(
      { dryRun: false, limit: 100, callBudget: 10, maxConcurrency: 1 },
      blockMissing
    )

    expect(report.skippedParentDecided).toBe(1)
    expect(h.overrides).toHaveLength(0)
    expect(h.audit.drafts).toHaveLength(0)
  })

  test('applies the policy table and records what it replaced', async () => {
    const h = harness([
      collection({
        id: 9,
        policyReason: 'rating_missing',
        metadataExternalId: '550',
        metadataStatus: 'matched',
      }),
    ])

    const report = await h.runner.run(
      { dryRun: false, limit: 100, callBudget: 10, maxConcurrency: 1 },
      blockMissing
    )

    expect(report.blocked).toBe(1)
    expect(h.overrides).toEqual([{ id: 9, decision: 'block' }])

    const [draft] = h.audit.drafts
    expect(draft?.action).toBe('block')
    expect(draft?.source).toBe('policy')
    // Without the previous state the run cannot be undone.
    expect(draft?.previousOverride).toBeNull()
    expect(draft?.previousExternalId).toBe('550')
    expect(draft?.previousMetadataStatus).toBe('matched')
  })

  test('a dry run reports the same counts and writes nothing', async () => {
    const queue = [
      collection({ id: 1, policyReason: 'rating_missing' }),
      collection({ id: 2, policyReason: 'rating_missing' }),
    ]
    const wet = harness(queue)
    const dry = harness(queue)

    const applied = await wet.runner.run(
      { dryRun: false, limit: 100, callBudget: 10, maxConcurrency: 1 },
      blockMissing
    )
    const previewed = await dry.runner.run(
      { dryRun: true, limit: 100, callBudget: 10, maxConcurrency: 1 },
      blockMissing
    )

    expect(previewed.blocked).toBe(applied.blocked)
    expect(previewed.scanned).toBe(applied.scanned)
    expect(dry.overrides).toHaveLength(0)
    expect(dry.audit.drafts).toHaveLength(0)
    expect(wet.overrides).toHaveLength(2)
  })

  test('asks the assistant only where there is a genuine choice', async () => {
    const h = harness(
      [
        collection({ id: 1, metadataCandidates: [] }),
        collection({ id: 2, metadataCandidates: [candidate('1', 'Only One')] }),
        collection({
          id: 3,
          metadataCandidates: [
            candidate('10', 'Some Film', 2011),
            candidate('11', 'Some Film', 1979),
          ],
        }),
      ],
      {
        disambiguate: async () => ({
          status: 'accepted',
          value: { externalId: '10', confidence: 0.9, reason: 'Year matches' },
        }),
      }
    )

    const report = await h.runner.run(
      { dryRun: false, limit: 100, callBudget: 10, maxConcurrency: 1 },
      blockMissing
    )

    // One candidate is not a choice, and none is not either.
    expect(h.calls).toBe(1)
    expect(report.assistant.attempted).toBe(1)
    expect(report.matched).toBe(1)
    expect(h.matches).toEqual([{ id: 3, externalId: '10' }])
    expect(report.leftForYou).toBe(2)
  })

  test('an abstention leaves the collection queued', async () => {
    const h = harness(
      [
        collection({
          id: 4,
          metadataCandidates: [candidate('1', 'A'), candidate('2', 'B')],
        }),
      ],
      {
        disambiguate: async () => ({
          status: 'accepted',
          value: { externalId: null, confidence: 0.2, reason: 'Cannot tell' },
        }),
      }
    )

    const report = await h.runner.run(
      { dryRun: false, limit: 100, callBudget: 10, maxConcurrency: 1 },
      blockMissing
    )

    expect(report.assistant.declined).toBe(1)
    expect(report.matched).toBe(0)
    expect(h.matches).toHaveLength(0)
    expect(report.leftForYou).toBe(1)
  })

  test('a dry run never applies an assistant match', async () => {
    const h = harness(
      [
        collection({
          id: 5,
          metadataCandidates: [candidate('1', 'A'), candidate('2', 'B')],
        }),
      ],
      {
        disambiguate: async () => ({
          status: 'accepted',
          value: { externalId: '1', confidence: 0.95, reason: 'Clear' },
        }),
      }
    )

    const report = await h.runner.run(
      { dryRun: true, limit: 100, callBudget: 10, maxConcurrency: 1 },
      blockMissing
    )

    expect(report.matched).toBe(1)
    expect(h.matches).toHaveLength(0)
    expect(h.audit.drafts).toHaveLength(0)
  })

  test('the call budget is a hard ceiling', async () => {
    const queue = Array.from({ length: 10 }, (_, index) =>
      collection({
        id: index + 1,
        metadataCandidates: [candidate('1', 'A'), candidate('2', 'B')],
      })
    )
    const h = harness(queue, {
      disambiguate: async () => ({
        status: 'accepted',
        value: { externalId: '1', confidence: 0.9, reason: 'ok' },
      }),
    })

    const report = await h.runner.run(
      { dryRun: true, limit: 100, callBudget: 3, maxConcurrency: 2 },
      blockMissing
    )

    // The check and the increment share a tick, so the cap is exact.
    expect(h.calls).toBe(3)
    expect(report.assistant.budgetExhausted).toBe(true)
  })

  test('an assistant that is off is not an error', async () => {
    const h = harness(
      [
        collection({
          id: 6,
          metadataCandidates: [candidate('1', 'A'), candidate('2', 'B')],
        }),
      ],
      { configured: false }
    )

    const report = await h.runner.run(
      { dryRun: false, limit: 100, callBudget: 10, maxConcurrency: 1 },
      blockMissing
    )

    expect(report.assistant.available).toBe(false)
    expect(report.assistant.attempted).toBe(0)
    expect(report.leftForYou).toBe(1)
    expect(report.errors).toHaveLength(0)
  })

  test('one provider failure does not abandon the rest of the run', async () => {
    let call = 0
    const h = harness(
      [
        collection({
          id: 1,
          metadataCandidates: [candidate('1', 'A'), candidate('2', 'B')],
        }),
        collection({
          id: 2,
          metadataCandidates: [candidate('3', 'C'), candidate('4', 'D')],
        }),
      ],
      {
        disambiguate: async () => {
          call++
          if (call === 1) throw new Error('rate limited')
          return {
            status: 'accepted',
            value: { externalId: '3', confidence: 0.9, reason: 'ok' },
          }
        },
      }
    )

    const report = await h.runner.run(
      { dryRun: false, limit: 100, callBudget: 10, maxConcurrency: 1 },
      blockMissing
    )

    expect(report.assistant.failed).toBe(1)
    expect(report.matched).toBe(1)
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]?.message).toContain('rate limited')
  })

  test('an assistant decision is attributed to its model and prompt', async () => {
    const h = harness(
      [
        collection({
          id: 8,
          metadataCandidates: [candidate('1', 'A'), candidate('2', 'B')],
        }),
      ],
      {
        disambiguate: async () => ({
          status: 'accepted',
          value: { externalId: '2', confidence: 0.88, reason: 'Overview matches' },
        }),
      }
    )

    await h.runner.run(
      { dryRun: false, limit: 100, callBudget: 10, maxConcurrency: 1 },
      blockMissing
    )

    const [draft] = h.audit.drafts
    expect(draft?.source).toBe('assistant')
    expect(draft?.model).toBe('test/model')
    expect(draft?.promptVersion).toBe('v1')
    expect(draft?.confidence).toBeCloseTo(0.88)
    expect(draft?.detail).toBe('Overview matches')
  })

  test('a policy decision is never attributed to a model', async () => {
    const h = harness([collection({ id: 3, policyReason: 'rating_missing' })])

    await h.runner.run(
      { dryRun: false, limit: 100, callBudget: 10, maxConcurrency: 1 },
      blockMissing
    )

    const [draft] = h.audit.drafts
    expect(draft?.model).toBeNull()
    expect(draft?.promptVersion).toBeNull()
  })

  test('a manual treatment leaves the item alone', async () => {
    const h = harness([
      collection({ id: 2, policyReason: 'rating_requires_review' }),
    ])

    const report = await h.runner.run(
      { dryRun: false, limit: 100, callBudget: 10, maxConcurrency: 1 },
      blockMissing
    )

    expect(report.leftForYou).toBe(1)
    expect(h.overrides).toHaveLength(0)
  })

  test('a system fault is never turned into a verdict', async () => {
    // A missing profile or a provider outage is not a fact about the content.
    const h = harness([
      collection({ id: 1, policyReason: 'metadata_error' }),
      collection({ id: 2, policyReason: 'policy_missing' }),
    ])

    const report = await h.runner.run(
      { dryRun: false, limit: 100, callBudget: 10, maxConcurrency: 1 },
      { ...blockMissing, reviewBand: 'block', missingRating: 'block' }
    )

    expect(report.blocked).toBe(0)
    expect(report.leftForYou).toBe(2)
    expect(h.overrides).toHaveLength(0)
  })
})
