import type { PolicyDecision } from './PolicyEngine'
/** Approved Dialden Kids 7 decisions, not equivalence between legal systems.
 * Unknown labels remain review-only. See docs/REGIONAL_RATINGS.md. */
export const AUTOMATIC_RATING_REGIONS = ['US', 'CA', 'AU', 'GB', 'IE', 'JP', 'KR', 'HK', 'TW', 'DE', 'FR', 'BR', 'SG'] as const
const bands: Readonly<Record<string, Readonly<Record<string, PolicyDecision>>>> = {
  BR: { L: 'allow', LIVRE: 'allow', '10': 'block', '12': 'block', '14': 'block', '16': 'block', '18': 'block' },
  SG: { G: 'allow', PG: 'review', PG13: 'block', NC16: 'block', M18: 'block', R21: 'block' },
  CA: { C: 'allow', G: 'allow', PG: 'review', C8: 'block', 'C8+': 'block',
    '14+': 'block', '18+': 'block', '14A': 'block', '18A': 'block', R: 'block', A: 'block',
    '8+': 'block', '13+': 'block', '16+': 'block' },
  JP: { G: 'allow', PG12: 'review', 'R15+': 'block', 'R18+': 'block' },
  KR: { ALL: 'allow', '12': 'block', '15': 'block', '18': 'block', '19': 'block' },
  HK: { I: 'allow', II: 'block', IIA: 'block', IIB: 'block', III: 'block' },
  TW: { '0+': 'allow', '6+': 'review', '12+': 'block', '15+': 'block', '18+': 'block' },
  DE: { '0': 'allow', '6': 'allow', '12': 'block', '16': 'block', '18': 'block' },
  FR: { TP: 'allow', U: 'allow', 'TOUS PUBLICS': 'allow', '12': 'block', '16': 'block', '18': 'block' },
}
export function regionalRatingDecision(region: string, rating: string): PolicyDecision | undefined {
  return bands[region]?.[rating]
}
export function hasRegionalRatingRules(region: string): boolean {
  return Object.hasOwn(bands, region)
}
