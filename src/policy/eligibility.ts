import type { PolicyDecision } from './PolicyEngine'

export interface SchedulingEligibilityFacts {
  readonly rootAvailable?: boolean | null
  readonly mediaType?: string | null
  readonly isInterlude?: boolean | null
  readonly durationSeconds?: number | null
  readonly effectiveDecision?: PolicyDecision | null
}

export type SchedulingIneligibilityReason =
  | 'root_unavailable'
  | 'not_video'
  | 'interlude'
  | 'invalid_duration'
  | 'decision_not_allow'

export type SchedulingEligibility =
  | { readonly eligible: true; readonly reason: null }
  | {
      readonly eligible: false
      readonly reason: SchedulingIneligibilityReason
    }

/** Strict automatic-scheduling gate. Missing facts always fail closed. */
export function evaluateSchedulingEligibility(
  facts: SchedulingEligibilityFacts
): SchedulingEligibility {
  if (facts.rootAvailable !== true) {
    return { eligible: false, reason: 'root_unavailable' }
  }
  if (facts.mediaType !== 'video') {
    return { eligible: false, reason: 'not_video' }
  }
  if (facts.isInterlude !== false) {
    return { eligible: false, reason: 'interlude' }
  }
  if (
    typeof facts.durationSeconds !== 'number' ||
    !Number.isFinite(facts.durationSeconds) ||
    facts.durationSeconds <= 0
  ) {
    return { eligible: false, reason: 'invalid_duration' }
  }
  if (facts.effectiveDecision !== 'allow') {
    return { eligible: false, reason: 'decision_not_allow' }
  }
  return { eligible: true, reason: null }
}

export function isSchedulingEligible(
  facts: SchedulingEligibilityFacts
): boolean {
  return evaluateSchedulingEligibility(facts).eligible
}
