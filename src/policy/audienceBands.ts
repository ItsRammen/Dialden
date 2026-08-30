/**
 * The audience ladder.
 *
 * A certification answers "who may see this" in one country's vocabulary. A
 * band answers it once, in ours: the youngest audience a title suits. Storing
 * that per title means a viewer or a channel can carry a ceiling and every
 * eligibility question becomes one comparison, instead of re-deciding the
 * whole library whenever the household's needs change.
 *
 * Where a certification falls between two rungs the stricter one is taken.
 * A US PG-13 is nominally thirteen, which is above the 12 rung and below the
 * 15, and a system that guards what a child watches should round towards the
 * older audience rather than away from it. Every such choice is listed in
 * BAND_BY_CERTIFICATION and is a one-line change if you disagree.
 *
 * Pure and exhaustively tested, so the ladder can be argued about without a
 * database in the room.
 */

/** Ordered from the youngest audience to the oldest. Order is meaningful. */
export const AUDIENCE_BANDS = [
  'everyone',
  'young',
  'older',
  'teen',
  'adult',
] as const

export type AudienceBand = (typeof AUDIENCE_BANDS)[number]

export interface AudienceBandDescriptor {
  readonly band: AudienceBand
  readonly label: string
  /** The youngest viewer the band is meant for; for display and sorting. */
  readonly minimumAge: number
}

export const AUDIENCE_BAND_DESCRIPTORS: readonly AudienceBandDescriptor[] = [
  { band: 'everyone', label: 'Everyone', minimumAge: 0 },
  { band: 'young', label: 'Younger children', minimumAge: 7 },
  { band: 'older', label: 'Older children', minimumAge: 12 },
  { band: 'teen', label: 'Teenagers', minimumAge: 15 },
  { band: 'adult', label: 'Adults', minimumAge: 18 },
]

const RANK: Readonly<Record<AudienceBand, number>> = {
  everyone: 0,
  young: 1,
  older: 2,
  teen: 3,
  adult: 4,
}

/**
 * Certification to band, across the regions the metadata settings query.
 *
 * Keys are the normalised form: upper case, hyphens regularised, interior
 * spacing collapsed. A certification absent from this table has no band, and
 * an absent band is never treated as safe.
 */
const BAND_BY_CERTIFICATION: Readonly<Record<string, AudienceBand>> = {
  // Suitable for all — United States, United Kingdom, Ireland, Australia, Canada
  G: 'everyone',
  U: 'everyone',
  UC: 'everyone',
  'TV-Y': 'everyone',
  'TV-G': 'everyone',
  E: 'everyone',

  // Guidance, but aimed at children
  'TV-Y7': 'young',
  'TV-Y7-FV': 'young',
  PG: 'young',
  'TV-PG': 'young',

  // Twelve
  '12': 'older',
  '12A': 'older',
  '12+': 'older',

  /* Thirteen and fourteen. Between the 12 and 15 rungs, taken as the older
     of the two so a twelve-year-old's ceiling does not admit them. */
  'PG-13': 'teen',
  'TV-14': 'teen',
  '14A': 'teen',
  '13+': 'teen',

  // Fifteen and sixteen
  '15': 'teen',
  '15A': 'teen',
  '16': 'teen',
  '16+': 'teen',
  M: 'teen',
  MA: 'teen',
  'MA15+': 'teen',
  'MA 15+': 'teen',

  // Eighteen and over
  R: 'adult',
  'NC-17': 'adult',
  'TV-MA': 'adult',
  '18': 'adult',
  '18A': 'adult',
  '18+': 'adult',
  R18: 'adult',
  'R18+': 'adult',
  'R 18+': 'adult',
  'X18+': 'adult',
  'X 18+': 'adult',
  A: 'adult',
}

/** Matches the policy engine's own normalisation, so the tables agree. */
export function normalizeCertification(value: string): string {
  return value
    .trim()
    .toLocaleUpperCase('en-US')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
}

/**
 * The band a certification belongs to, or null when it is not one we know.
 * Null is not a band and must never be treated as one: an unfamiliar rating
 * is a question for a person, exactly as it is in the policy engine.
 */
export function audienceBandFor(
  certification: string | null | undefined
): AudienceBand | null {
  if (typeof certification !== 'string') return null
  const normalized = normalizeCertification(certification)
  if (!normalized) return null
  return BAND_BY_CERTIFICATION[normalized] ?? null
}

/**
 * Whether a viewer at `ceiling` may see something in `band`. An unknown band
 * is never permitted, whatever the ceiling.
 */
export function bandWithinCeiling(
  band: AudienceBand | null | undefined,
  ceiling: AudienceBand
): boolean {
  if (!band) return false
  return RANK[band] <= RANK[ceiling]
}

/** Ladder position, for sorting and for comparing two bands directly. */
export function bandRank(band: AudienceBand): number {
  return RANK[band]
}

export function isAudienceBand(value: unknown): value is AudienceBand {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(RANK, value)
  )
}

export function audienceBandLabel(band: AudienceBand): string {
  const found = AUDIENCE_BAND_DESCRIPTORS.find(
    (descriptor) => descriptor.band === band
  )
  return found ? found.label : band
}
