/**
 * The audit trail for automated review.
 *
 * Every automatic change records what it did, why, and — critically — what the
 * collection looked like beforehand. Without the previous state a run of six
 * hundred decisions is irreversible, which is what would make automating them
 * unsafe rather than merely wrong sometimes.
 */
import type { OverrideDecision } from '../../types'

/** What produced the decision. */
export type ReviewDecisionSource = 'policy' | 'assistant'

export type ReviewDecisionAction = 'approve' | 'block' | 'match'

export interface ReviewDecisionRecord {
  readonly id: number
  /** Groups every decision made by one invocation, so a run reverts as a unit. */
  readonly runId: string
  readonly collectionId: number
  readonly action: ReviewDecisionAction
  readonly source: ReviewDecisionSource
  /** The `PolicyReason` that left this collection outstanding. */
  readonly reason: string
  /** Human-readable justification; the model's own words when it decided. */
  readonly detail: string
  readonly model: string | null
  readonly promptVersion: string | null
  readonly confidence: number | null
  /** State before the change, so a revert restores rather than guesses. */
  readonly previousOverride: OverrideDecision
  readonly previousExternalId: string | null
  readonly previousMetadataStatus: string | null
  readonly createdAt: string
  readonly revertedAt: string | null
}

export type ReviewDecisionDraft = Omit<
  ReviewDecisionRecord,
  'id' | 'createdAt' | 'revertedAt'
>

export interface ReviewDecisionStore {
  recordReviewDecision(draft: ReviewDecisionDraft): Promise<number>
  listReviewDecisions(options?: {
    readonly runId?: string
    readonly collectionId?: number
    readonly includeReverted?: boolean
    readonly limit?: number
  }): Promise<ReviewDecisionRecord[]>
  listReviewRuns(limit?: number): Promise<
    {
      readonly runId: string
      readonly startedAt: string
      readonly decisions: number
      readonly reverted: number
    }[]
  >
  markReviewDecisionsReverted(ids: readonly number[]): Promise<number>
}
