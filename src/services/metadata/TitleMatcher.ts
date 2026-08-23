import type { MetadataCandidate } from '../../metadata/types'

const TRAILING_YEAR = /^(.*?)\s*\((\d{4})\)\s*$/u
const MEDIA_EXTENSION = /\.(?:mp4|mkv|avi|mov|webm|m4v|mpg|mpeg|ts)$/iu
const MIN_PLAUSIBLE_SCORE = 0.45

export interface ParsedCollectionTitle {
  readonly title: string
  readonly normalizedTitle: string
  readonly year?: number
}

export interface RankedMetadataCandidate {
  readonly candidate: MetadataCandidate
  readonly score: number
  readonly exactTitle: boolean
  readonly yearMatches: boolean
  readonly titleSimilarity: number
}

export interface MetadataMatchResult {
  readonly status: 'matched' | 'ambiguous' | 'unmatched'
  readonly candidate: MetadataCandidate | null
  readonly confidence: number
  readonly candidates: readonly RankedMetadataCandidate[]
}

export function parseCollectionTitle(
  value: string,
  options: { readonly stripMediaExtension?: boolean } = {}
): ParsedCollectionTitle {
  const trimmed = value.trim()
  const titleWithNoExtension = options.stripMediaExtension
    ? trimmed.replace(MEDIA_EXTENSION, '')
    : trimmed
  const yearMatch = TRAILING_YEAR.exec(titleWithNoExtension)

  if (yearMatch) {
    const title = yearMatch[1]?.trim() ?? ''
    const year = Number(yearMatch[2])
    // TMDB's practical catalogue range. Out-of-range parenthesized numbers
    // remain part of the title rather than becoming misleading match input.
    if (title && year >= 1800 && year <= 2199) {
      return { title, normalizedTitle: normalizeTitle(title), year }
    }
  }

  return {
    title: titleWithNoExtension,
    normalizedTitle: normalizeTitle(titleWithNoExtension),
  }
}

export function normalizeTitle(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/&/g, ' and ')
    .replace(/[\u2018\u2019']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function rankMetadataCandidates(
  collection: ParsedCollectionTitle,
  candidates: readonly MetadataCandidate[]
): RankedMetadataCandidate[] {
  const deduplicated = new Map<string, MetadataCandidate>()
  for (const candidate of candidates) {
    deduplicated.set(`${candidate.provider}\u0000${candidate.externalId}`, candidate)
  }

  return [...deduplicated.values()]
    .map((candidate) => rankCandidate(collection, candidate))
    .sort(compareRankedCandidates)
}

/**
 * Strict automatic matcher. Similarity only ranks review candidates; it can
 * never independently produce `matched`.
 */
export function matchMetadata(
  collection: ParsedCollectionTitle,
  candidates: readonly MetadataCandidate[]
): MetadataMatchResult {
  const ranked = rankMetadataCandidates(collection, candidates)

  const automatic = ranked.filter((item) => {
    if (!item.exactTitle) return false
    return collection.year === undefined || item.yearMatches
  })

  if (automatic.length === 1) {
    const selected = automatic[0]
    if (selected) {
      return {
        status: 'matched',
        candidate: selected.candidate,
        confidence: collection.year === undefined ? 0.95 : 1,
        candidates: ranked,
      }
    }
  }

  if (
    automatic.length > 1 ||
    ranked.some((candidate) => candidate.score >= MIN_PLAUSIBLE_SCORE)
  ) {
    return {
      status: 'ambiguous',
      candidate: null,
      confidence: ranked[0]?.score ?? 0,
      candidates: ranked,
    }
  }

  return {
    status: 'unmatched',
    candidate: null,
    confidence: 0,
    candidates: ranked,
  }
}

function rankCandidate(
  collection: ParsedCollectionTitle,
  candidate: MetadataCandidate
): RankedMetadataCandidate {
  const candidateTitles = [candidate.title, candidate.originalTitle]
    .filter((title): title is string => typeof title === 'string' && title.length > 0)
    .map(normalizeTitle)
  const similarities = candidateTitles.map((title) =>
    titleSimilarity(collection.normalizedTitle, title)
  )
  const titleScore = Math.max(0, ...similarities)
  const exactTitle = candidateTitles.includes(collection.normalizedTitle)
  const yearMatches =
    collection.year !== undefined && candidate.year === collection.year

  let score = titleScore * 0.75
  if (collection.year !== undefined) {
    if (yearMatches) score += 0.25
    else if (candidate.year !== undefined) {
      const difference = Math.abs(candidate.year - collection.year)
      score -= difference === 1 ? 0.08 : 0.2
    }
  } else if (exactTitle) {
    score += 0.15
  }

  return {
    candidate,
    score: clampScore(score),
    exactTitle,
    yearMatches,
    titleSimilarity: titleScore,
  }
}

function compareRankedCandidates(
  left: RankedMetadataCandidate,
  right: RankedMetadataCandidate
): number {
  if (left.score !== right.score) return right.score - left.score
  if (left.exactTitle !== right.exactTitle) return left.exactTitle ? -1 : 1
  if (left.yearMatches !== right.yearMatches) return left.yearMatches ? -1 : 1

  const popularityDifference =
    (right.candidate.popularity ?? 0) - (left.candidate.popularity ?? 0)
  if (popularityDifference !== 0) return popularityDifference
  return left.candidate.externalId.localeCompare(right.candidate.externalId)
}

function titleSimilarity(left: string, right: string): number {
  if (!left || !right) return 0
  if (left === right) return 1
  if (left.length < 2 || right.length < 2) return 0

  const leftPairs = bigramCounts(left)
  const rightPairs = bigramCounts(right)
  let overlap = 0
  for (const [pair, count] of leftPairs) {
    overlap += Math.min(count, rightPairs.get(pair) ?? 0)
  }
  return (2 * overlap) / (left.length - 1 + right.length - 1)
}

function bigramCounts(value: string): Map<string, number> {
  const result = new Map<string, number>()
  for (let index = 0; index < value.length - 1; index++) {
    const pair = value.slice(index, index + 2)
    result.set(pair, (result.get(pair) ?? 0) + 1)
  }
  return result
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 10_000) / 10_000))
}
