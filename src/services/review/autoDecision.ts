/**
 * The deterministic layer of library review.
 *
 * `evaluatePolicy` already says precisely why a collection is waiting — a
 * certification in the review band, no certification at all, an ambiguous
 * title. This turns those reasons into automatic decisions from a table the
 * operator controls, so the rules are legible and adjustable rather than
 * buried in branches.
 *
 * It runs before any assistant and settles everything it can, so a model is
 * only ever asked about what genuine policy could not resolve. Pure, so the
 * table is testable without a database.
 */
import type { PolicyEvaluation, PolicyReason } from '../../policy/PolicyEngine'

/** What the deterministic layer may do. `manual` leaves the item queued. */
export type AutoTreatment = 'approve' | 'block' | 'manual'

/** `assist` hands the case to the review assistant when one is configured. */
export type MetadataTreatment = AutoTreatment | 'assist'

export interface AutoDecisionPolicy {
  /** Certifications the profile nominates for a parent to judge. */
  readonly reviewBand: AutoTreatment
  /** Matched, but no certification in any configured region. */
  readonly missingRating: AutoTreatment
  /** A certification the profile does not recognise. */
  readonly unrecognizedRating: AutoTreatment
  /** More than one plausible title. */
  readonly ambiguousMetadata: MetadataTreatment
  /** No reliable title match at all. */
  readonly unmatchedMetadata: MetadataTreatment
}

/**
 * Unknown content is treated as unsafe rather than left in limbo, and the
 * ambiguous cases are offered to an assistant because resolving the match can
 * turn them into an ordinary certification decision.
 */
export const DEFAULT_AUTO_DECISION_POLICY: AutoDecisionPolicy = {
  reviewBand: 'manual',
  missingRating: 'block',
  unrecognizedRating: 'block',
  ambiguousMetadata: 'assist',
  unmatchedMetadata: 'assist',
}

export type AutoOutcome =
  | { readonly action: 'approve' | 'block'; readonly reason: PolicyReason }
  | { readonly action: 'manual'; readonly reason: PolicyReason }
  | { readonly action: 'assist'; readonly reason: PolicyReason }
  | { readonly action: 'none'; readonly reason: PolicyReason }

export interface AutoDecisionInput {
  readonly evaluation: PolicyEvaluation
  /** A decision a person already made. Automation never overrides one. */
  readonly hasParentOverride: boolean
}

/**
 * Reasons that describe a broken system rather than a content judgement.
 * Deciding on these would encode a transient fault as a permanent verdict.
 */
const SYSTEM_FAULTS: ReadonlySet<PolicyReason> = new Set<PolicyReason>([
  'policy_missing',
  'policy_invalid',
  'metadata_missing',
  'metadata_invalid',
  'metadata_error',
  'metadata_pending',
])

export function decideAutomatically(
  input: AutoDecisionInput,
  policy: AutoDecisionPolicy = DEFAULT_AUTO_DECISION_POLICY
): AutoOutcome {
  const { reason, decision } = input.evaluation

  // A person has already answered. Nothing here may contradict them.
  if (input.hasParentOverride) return { action: 'none', reason }

  // Policy already settled it; there is nothing outstanding to decide.
  if (decision !== 'review') return { action: 'none', reason }

  // A fault in metadata or the profile is not a fact about the content.
  if (SYSTEM_FAULTS.has(reason)) return { action: 'manual', reason }

  switch (reason) {
    case 'rating_requires_review':
      return { action: treatmentToAction(policy.reviewBand), reason }
    case 'rating_missing':
      return { action: treatmentToAction(policy.missingRating), reason }
    case 'rating_unrecognized':
      return { action: treatmentToAction(policy.unrecognizedRating), reason }
    case 'metadata_ambiguous':
      return { action: treatmentToAction(policy.ambiguousMetadata), reason }
    case 'metadata_unmatched':
      return { action: treatmentToAction(policy.unmatchedMetadata), reason }
    default:
      return { action: 'manual', reason }
  }
}

function treatmentToAction(
  treatment: MetadataTreatment
): 'approve' | 'block' | 'manual' | 'assist' {
  return treatment
}

/** Human-readable justification stored alongside an automatic decision. */
export function describeAutoOutcome(outcome: AutoOutcome): string {
  switch (outcome.reason) {
    case 'rating_requires_review':
      return 'Certification falls in the profile’s review band'
    case 'rating_missing':
      return 'No certification was available in any configured region'
    case 'rating_unrecognized':
      return 'Certification is not one the profile recognises'
    case 'metadata_ambiguous':
      return 'More than one plausible title matched'
    case 'metadata_unmatched':
      return 'No reliable title match was found'
    default:
      return `Policy reason: ${outcome.reason}`
  }
}
