import { evaluatePolicy, type RatingPolicyProfile, type PolicyEvaluation } from './PolicyEngine'
import { AUTOMATIC_RATING_REGIONS } from './RegionalRatings'
import type { ProviderRating } from '../metadata/types'

/** Conflicting labels can agree on policy without becoming one certification. */
export function evaluateRatingConsensus(profile: RatingPolicyProfile | null, ratings: readonly ProviderRating[], regions: readonly string[]): PolicyEvaluation | null {
  for (const region of [...new Set([...regions, ...AUTOMATIC_RATING_REGIONS].map(r => r.trim().toUpperCase()))]) {
    const labels = [...new Set(ratings.filter(r => r.region.trim().toUpperCase() === region)
      .map(r => r.certification.trim().toUpperCase())
      .filter(r => r && !/^(NR|N\/R|N\/A|UNRATED|NOT RATED|UNKNOWN)$/.test(r)))]
    if (!labels.length) continue
    if (labels.length < 2) return null
    const decisions = labels.map(certification => evaluatePolicy(profile, { matchStatus: 'matched', certification, certificationRegion: region }))
    const first = decisions[0]!
    if (first.decision === 'review' || decisions.some(d => d.decision !== first.decision)) return null
    return { decision: first.decision, reason: 'rating_consensus', certification: null }
  }
  return null
}
