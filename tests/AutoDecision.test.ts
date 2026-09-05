import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_AUTO_DECISION_POLICY,
  decideAutomatically,
  describeAutoOutcome,
  type AutoDecisionPolicy,
} from '../src/services/review/autoDecision'
import type { PolicyEvaluation, PolicyReason } from '../src/policy/PolicyEngine'

function evaluation(
  reason: PolicyReason,
  decision: PolicyEvaluation['decision'] = 'review',
  certification: string | null = null
): PolicyEvaluation {
  return { decision, reason, certification }
}

const approveReviewBand: AutoDecisionPolicy = {
  ...DEFAULT_AUTO_DECISION_POLICY,
  reviewBand: 'approve',
}

describe('decideAutomatically', () => {
  describe('what it must never touch', () => {
    test('never contradicts a decision a person already made', () => {
      // The single rule that matters most: automation may shrink the queue,
      // never overrule the parent it exists to serve.
      const outcome = decideAutomatically(
        { evaluation: evaluation('rating_requires_review'), hasParentOverride: true },
        approveReviewBand
      )

      expect(outcome.action).toBe('none')
    })

    test('leaves alone anything policy already settled', () => {
      for (const decision of ['allow', 'block'] as const) {
        const outcome = decideAutomatically({
          evaluation: evaluation('rating_allowed', decision, 'G'),
          hasParentOverride: false,
        })
        expect(outcome.action).toBe('none')
      }
    })

    test('treats a broken profile or broken metadata as a fault, not a verdict', () => {
      // These describe a system that is not working. Deciding on them would
      // freeze a transient fault into a permanent answer about the content.
      for (const reason of [
        'policy_missing',
        'policy_invalid',
        'metadata_missing',
        'metadata_invalid',
        'metadata_error',
        'metadata_pending',
      ] as PolicyReason[]) {
        const outcome = decideAutomatically({
          evaluation: evaluation(reason),
          hasParentOverride: false,
        })
        expect(outcome.action).toBe('manual')
      }
    })
  })

  describe('the default table', () => {
    test('blocks anything it cannot classify rather than leaving it in limbo', () => {
      for (const reason of ['rating_missing', 'rating_unrecognized'] as PolicyReason[]) {
        const outcome = decideAutomatically({
          evaluation: evaluation(reason),
          hasParentOverride: false,
        })
        expect(outcome.action).toBe('block')
      }
    })

    test('sends metadata problems to the assistant, since a match may resolve them', () => {
      for (const reason of ['metadata_ambiguous', 'metadata_unmatched'] as PolicyReason[]) {
        const outcome = decideAutomatically({
          evaluation: evaluation(reason),
          hasParentOverride: false,
        })
        expect(outcome.action).toBe('assist')
      }
    })

    test('leaves the review band to a person by default', () => {
      const outcome = decideAutomatically({
        evaluation: evaluation('rating_requires_review', 'review', 'PG'),
        hasParentOverride: false,
      })

      expect(outcome.action).toBe('manual')
    })
  })

  describe('the table is the operator’s to set', () => {
    test('approves the review band when configured to', () => {
      const outcome = decideAutomatically(
        {
          evaluation: evaluation('rating_requires_review', 'review', 'PG'),
          hasParentOverride: false,
        },
        approveReviewBand
      )

      expect(outcome.action).toBe('approve')
      expect(outcome.reason).toBe('rating_requires_review')
    })

    test('can be told to leave the unclassifiable queued instead of blocking', () => {
      const outcome = decideAutomatically(
        { evaluation: evaluation('rating_missing'), hasParentOverride: false },
        { ...DEFAULT_AUTO_DECISION_POLICY, missingRating: 'manual' }
      )

      expect(outcome.action).toBe('manual')
    })

    test('can decide metadata problems without an assistant', () => {
      const outcome = decideAutomatically(
        { evaluation: evaluation('metadata_ambiguous'), hasParentOverride: false },
        { ...DEFAULT_AUTO_DECISION_POLICY, ambiguousMetadata: 'block' }
      )

      expect(outcome.action).toBe('block')
    })
  })

  test('every automatic action carries a reason that can be shown', () => {
    for (const reason of [
      'rating_requires_review',
      'rating_missing',
      'rating_unrecognized',
      'metadata_ambiguous',
      'metadata_unmatched',
    ] as PolicyReason[]) {
      const outcome = decideAutomatically({
        evaluation: evaluation(reason),
        hasParentOverride: false,
      })
      const described = describeAutoOutcome(outcome)
      expect(described.length).toBeGreaterThan(10)
      expect(described).not.toContain('undefined')
    }
  })
})
