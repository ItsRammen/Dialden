import type {
  CertificationLookup,
  ProviderRating,
} from '../../metadata/types'

const RELEASE_TYPE_PRIORITY = new Map<number, number>([
  [3, 0], // theatrical
  [2, 1], // limited theatrical
  [4, 2], // digital
  [5, 3], // physical
  [6, 4], // TV
  [1, 5], // premiere
])

/**
 * Select the first configured region with data. Conflicting certifications in
 * that region are deliberately ambiguous; a fallback must not hide conflict.
 */
export function resolveCertification(
  ratings: readonly ProviderRating[],
  orderedRegions: readonly string[]
): CertificationLookup {
  const cleaned = ratings
    .map(cleanRating)
    .filter((rating): rating is ProviderRating => rating !== null)
  const regions = uniqueRegions(orderedRegions)

  for (const region of regions) {
    const regionalRatings = cleaned
      .filter((rating) => rating.region === region)
      .sort(compareRatings)
    if (regionalRatings.length === 0) continue

    const certifications = new Set(
      regionalRatings.map((rating) => normalizeCertification(rating.certification))
    )
    if (certifications.size > 1) {
      return { status: 'ambiguous', selected: null, all: cleaned }
    }

    return {
      status: 'resolved',
      selected: regionalRatings[0] ?? null,
      all: cleaned,
    }
  }

  return { status: 'missing', selected: null, all: cleaned }
}

function cleanRating(rating: ProviderRating): ProviderRating | null {
  const region = rating.region.trim().toUpperCase()
  const certification = rating.certification.trim()
  if (!/^[A-Z]{2}$/.test(region) || !certification) return null
  return {
    region,
    certification,
    ...(rating.releaseType === undefined
      ? {}
      : { releaseType: rating.releaseType }),
  }
}

function uniqueRegions(regions: readonly string[]): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  for (const rawRegion of regions) {
    const region = rawRegion.trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(region) || seen.has(region)) continue
    seen.add(region)
    output.push(region)
  }
  return output
}

function normalizeCertification(value: string): string {
  return value.trim().toLocaleUpperCase('en-US')
}

function compareRatings(left: ProviderRating, right: ProviderRating): number {
  const leftPriority =
    left.releaseType === undefined
      ? Number.MAX_SAFE_INTEGER
      : (RELEASE_TYPE_PRIORITY.get(left.releaseType) ?? Number.MAX_SAFE_INTEGER)
  const rightPriority =
    right.releaseType === undefined
      ? Number.MAX_SAFE_INTEGER
      : (RELEASE_TYPE_PRIORITY.get(right.releaseType) ?? Number.MAX_SAFE_INTEGER)
  return leftPriority - rightPriority
}
