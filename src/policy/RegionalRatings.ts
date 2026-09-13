import type { PolicyDecision } from './PolicyEngine'
/** Approved Dialden Kids 7 decisions, not equivalence between legal systems.
 * Unknown labels remain review-only. See docs/REGIONAL_RATINGS.md. */
export const AUTOMATIC_RATING_REGIONS = ['US', 'CA', 'AU', 'GB', 'IE', 'JP', 'KR', 'HK', 'TW', 'DE', 'FR'] as const
const bands: Readonly<Record<string, Readonly<Record<string, PolicyDecision>>>> = {
  JP: { G: 'allow', PG12: 'review', 'R15+': 'block', 'R18+': 'block' },
  KR: { ALL: 'allow', '12': 'block', '15': 'block', '18': 'block', '19': 'block' },
  HK: { I: 'allow', II: 'block', IIA: 'block', IIB: 'block', III: 'block' },
  TW: { '0+': 'allow', '6+': 'review', '12+': 'block', '15+': 'block', '18+': 'block' },
  DE: { '0': 'allow', '6': 'allow', '12': 'block', '16': 'block', '18': 'block' },
  FR: { U: 'allow', 'TOUS PUBLICS': 'allow', '12': 'block', '16': 'block', '18': 'block' },
}
export function regionalRatingDecision(region: string, rating: string): PolicyDecision | undefined {
  return bands[region]?.[rating]
}
export function hasRegionalRatingRules(region: string): boolean {
  return Object.hasOwn(bands, region)
}
