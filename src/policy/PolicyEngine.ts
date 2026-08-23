/** Pure, fail-closed content-rating policy evaluation. */

export type PolicyDecision = 'allow' | 'review' | 'block'
export type OverrideDecision = 'allow' | 'block' | null

export type MetadataMatchStatus =
  | 'pending'
  | 'matched'
  | 'manual'
  | 'ambiguous'
  | 'unmatched'
  | 'error'

export interface RatingPolicyRules {
  readonly allow: readonly string[]
  readonly review: readonly string[]
  readonly block: readonly string[]
}

export interface RatingPolicyProfile {
  readonly id: string
  readonly name: string
  readonly age?: number
  readonly rules: RatingPolicyRules
}

export interface PolicyMetadata {
  readonly matchStatus: MetadataMatchStatus
  readonly certification?: string | null
}

export type PolicyReason =
  | 'rating_allowed'
  | 'rating_requires_review'
  | 'rating_blocked'
  | 'rating_missing'
  | 'rating_unrecognized'
  | 'policy_missing'
  | 'policy_invalid'
  | 'metadata_missing'
  | 'metadata_invalid'
  | 'metadata_pending'
  | 'metadata_ambiguous'
  | 'metadata_unmatched'
  | 'metadata_error'

export interface PolicyEvaluation {
  readonly decision: PolicyDecision
  readonly reason: PolicyReason
  readonly certification: string | null
}

export type EffectiveDecisionSource =
  | 'parent_override'
  | 'policy'
  | 'fail_closed'

export interface EffectiveDecision {
  readonly decision: PolicyDecision
  readonly source: EffectiveDecisionSource
}

export const DEFAULT_KIDS_7_POLICY = {
  id: 'kids-7',
  name: 'Kids 7',
  age: 7,
  rules: {
    allow: ['G', 'TV-Y', 'TV-Y7', 'TV-G'],
    review: ['PG', 'TV-PG'],
    block: ['PG-13', 'TV-14', 'R', 'TV-MA', 'NC-17'],
  },
} as const satisfies RatingPolicyProfile

const MATCH_STATUSES = new Set<MetadataMatchStatus>([
  'pending',
  'matched',
  'manual',
  'ambiguous',
  'unmatched',
  'error',
])

const MISSING_RATINGS = new Set([
  '',
  'UNKNOWN',
  'UNRATED',
  'NOT RATED',
  'NR',
  'N/R',
  'N/A',
])

export function evaluatePolicy(
  profile: RatingPolicyProfile | null | undefined,
  metadata: PolicyMetadata | null | undefined
): PolicyEvaluation {
  if (profile === null || profile === undefined) {
    return review('policy_missing')
  }

  const rules = normalizeAndValidatePolicy(profile)
  if (!rules) return review('policy_invalid')
  if (metadata === null || metadata === undefined) {
    return review('metadata_missing')
  }
  if (!MATCH_STATUSES.has(metadata.matchStatus)) {
    return review('metadata_invalid')
  }

  switch (metadata.matchStatus) {
    case 'pending':
      return review('metadata_pending')
    case 'ambiguous':
      return review('metadata_ambiguous')
    case 'unmatched':
      return review('metadata_unmatched')
    case 'error':
      return review('metadata_error')
    case 'matched':
    case 'manual':
      break
  }

  if (
    metadata.certification !== null &&
    metadata.certification !== undefined &&
    typeof metadata.certification !== 'string'
  ) {
    return review('metadata_invalid')
  }

  const certification = normalizeRating(metadata.certification ?? '')
  if (MISSING_RATINGS.has(certification)) {
    return review('rating_missing', certification || null)
  }
  if (rules.allow.has(certification)) {
    return {
      decision: 'allow',
      reason: 'rating_allowed',
      certification,
    }
  }
  if (rules.block.has(certification)) {
    return {
      decision: 'block',
      reason: 'rating_blocked',
      certification,
    }
  }
  if (rules.review.has(certification)) {
    return review('rating_requires_review', certification)
  }
  return review('rating_unrecognized', certification)
}

/**
 * Parent override wins when valid. Missing or malformed state never resolves
 * to allow.
 */
export function resolveEffectiveDecision(
  policyDecision: PolicyDecision | null | undefined,
  parentOverride: OverrideDecision | undefined
): EffectiveDecision {
  if (parentOverride === 'allow' || parentOverride === 'block') {
    return { decision: parentOverride, source: 'parent_override' }
  }
  if (parentOverride !== null && parentOverride !== undefined) {
    return { decision: 'review', source: 'fail_closed' }
  }
  if (
    policyDecision === 'allow' ||
    policyDecision === 'review' ||
    policyDecision === 'block'
  ) {
    return { decision: policyDecision, source: 'policy' }
  }
  return { decision: 'review', source: 'fail_closed' }
}

function review(
  reason: PolicyReason,
  certification: string | null = null
): PolicyEvaluation {
  return { decision: 'review', reason, certification }
}

function normalizeRating(value: string): string {
  return value
    .trim()
    .toLocaleUpperCase('en-US')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
}

function normalizeAndValidatePolicy(
  profile: RatingPolicyProfile
): {
  allow: ReadonlySet<string>
  review: ReadonlySet<string>
  block: ReadonlySet<string>
} | null {
  if (
    !profile ||
    typeof profile !== 'object' ||
    typeof profile.id !== 'string' ||
    !profile.id.trim() ||
    typeof profile.name !== 'string' ||
    !profile.name.trim() ||
    !profile.rules ||
    typeof profile.rules !== 'object'
  ) {
    return null
  }
  if (
    profile.age !== undefined &&
    (!Number.isSafeInteger(profile.age) || profile.age < 0)
  ) {
    return null
  }

  const allow = normalizeBucket(profile.rules.allow)
  const requiresReview = normalizeBucket(profile.rules.review)
  const block = normalizeBucket(profile.rules.block)
  if (!allow || !requiresReview || !block) return null

  const all = [...allow, ...requiresReview, ...block]
  if (new Set(all).size !== all.length) return null
  return {
    allow: new Set(allow),
    review: new Set(requiresReview),
    block: new Set(block),
  }
}

function normalizeBucket(value: readonly string[]): string[] | null {
  if (!Array.isArray(value)) return null
  const normalized: string[] = []
  for (const rating of value) {
    if (typeof rating !== 'string') return null
    const item = normalizeRating(rating)
    if (!item || normalized.includes(item)) return null
    normalized.push(item)
  }
  return normalized
}
