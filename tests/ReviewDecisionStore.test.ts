import { beforeEach, describe, expect, test } from 'bun:test'
import { MediaRepository } from '../src/repositories/MediaRepository'
import type { ReviewDecisionDraft } from '../src/services/review/auditTypes'

let repo: MediaRepository

function draft(overrides: Partial<ReviewDecisionDraft> = {}): ReviewDecisionDraft {
  return {
    runId: 'run-a',
    collectionId: 1,
    action: 'block',
    source: 'policy',
    reason: 'rating_missing',
    detail: 'No certification was available',
    model: null,
    promptVersion: null,
    confidence: null,
    previousOverride: null,
    previousExternalId: null,
    previousMetadataStatus: 'matched',
    ...overrides,
  }
}

beforeEach(async () => {
  repo = new MediaRepository(':memory:')
  await repo.initialize()
})

describe('review decision audit trail', () => {
  test('the table exists after a fresh initialize', async () => {
    // The migration runs on startup; without it every run would throw.
    await expect(repo.listReviewDecisions()).resolves.toEqual([])
    await expect(repo.listReviewRuns()).resolves.toEqual([])
  })

  test('round-trips a decision with the state it replaced', async () => {
    await repo.recordReviewDecision(
      draft({
        collectionId: 42,
        previousOverride: 'allow',
        previousExternalId: '550',
        previousMetadataStatus: 'manual',
      })
    )

    const [stored] = await repo.listReviewDecisions()
    expect(stored?.collectionId).toBe(42)
    expect(stored?.previousOverride).toBe('allow')
    expect(stored?.previousExternalId).toBe('550')
    expect(stored?.previousMetadataStatus).toBe('manual')
    expect(stored?.revertedAt).toBeNull()
  })

  test('keeps an assistant decision attributable', async () => {
    await repo.recordReviewDecision(
      draft({
        action: 'match',
        source: 'assistant',
        model: 'minimax/minimax-m3:free',
        promptVersion: 'review-2026-08-30',
        confidence: 0.82,
      })
    )

    const [stored] = await repo.listReviewDecisions()
    expect(stored?.source).toBe('assistant')
    expect(stored?.model).toBe('minimax/minimax-m3:free')
    expect(stored?.promptVersion).toBe('review-2026-08-30')
    expect(stored?.confidence).toBeCloseTo(0.82)
  })

  test('groups decisions into runs', async () => {
    await repo.recordReviewDecision(draft({ runId: 'run-a', collectionId: 1 }))
    await repo.recordReviewDecision(draft({ runId: 'run-a', collectionId: 2 }))
    await repo.recordReviewDecision(draft({ runId: 'run-b', collectionId: 3 }))

    const runs = await repo.listReviewRuns()
    expect(runs).toHaveLength(2)
    expect(runs.find((run) => run.runId === 'run-a')?.decisions).toBe(2)
    expect(runs.find((run) => run.runId === 'run-b')?.decisions).toBe(1)
  })

  test('filters to one run', async () => {
    await repo.recordReviewDecision(draft({ runId: 'run-a' }))
    await repo.recordReviewDecision(draft({ runId: 'run-b' }))

    const decisions = await repo.listReviewDecisions({ runId: 'run-b' })
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.runId).toBe('run-b')
  })

  test('a reverted decision drops out of the default listing but is kept', async () => {
    const id = await repo.recordReviewDecision(draft())

    expect(await repo.markReviewDecisionsReverted([id])).toBe(1)
    expect(await repo.listReviewDecisions()).toHaveLength(0)

    const [kept] = await repo.listReviewDecisions({ includeReverted: true })
    expect(kept?.id).toBe(id)
    expect(kept?.revertedAt).not.toBeNull()
  })

  test('reverting twice does not double count', async () => {
    const id = await repo.recordReviewDecision(draft())

    expect(await repo.markReviewDecisionsReverted([id])).toBe(1)
    expect(await repo.markReviewDecisionsReverted([id])).toBe(0)
  })

  test('ignores ids that are not real', async () => {
    expect(await repo.markReviewDecisionsReverted([])).toBe(0)
    expect(await repo.markReviewDecisionsReverted([-1, 0, 9999])).toBe(0)
  })
})
