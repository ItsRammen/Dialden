import type { MetadataCandidate } from '../../metadata/types'

const TRAILING_YEAR = /^(.*?)\s*\((\d{4})\)\s*$/u
const MEDIA_EXTENSION = /\.(?:mp4|mkv|avi|mov|webm|m4v|mpg|mpeg|ts)$/iu
const MIN_PLAUSIBLE_SCORE = 0.45

/** Square and curly groups only. Parentheses can carry a real subtitle. */
const BRACKETED_NOISE = /\[[^\]]*\]|\{[^}]*\}/gu

/** Encoding and release furniture that is never part of a title. */
const RELEASE_TOKENS =
  /\b(?:\d{3,4}p|4k|uhd|hdr10\+?|hdr|sdr|bluray|blu-ray|brrip|bdrip|webrip|web-dl|webdl|hdtv|dvdrip|remux|x26[45]|h\.?26[45]|hevc|xvid|divx|aac(?:\d(?:\.\d)?)?|ac3|eac3|dts(?:-hd)?|truehd|atmos|ddp?\d(?:\.\d)?|\d{1,2}bit|proper|repack|internal|limited|extended|unrated|remastered|directors?\s+cut|theatrical\s+cut|final\s+cut)\b/giu

/**
 * A part or volume marker is filename noise only when more title text follows
 * it: "28 Years Later Part 2 The Bone Temple" carries a subtitle, whereas
 * "Harry Potter and the Deathly Hallows Part 1" is a distinct film that must
 * never be collapsed onto its sibling. Anchoring on trailing text is what keeps
 * the two apart.
 */
const MID_TITLE_PART =
  /\s+(?:part|pt\.?|vol\.?|volume|chapter)\s+(?:\d{1,2}|[ivx]{1,4})\s+(?=\S)/giu

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

/**
 * Strips filename furniture from a title, or returns null when there was none.
 *
 * This only ever widens the search: the matcher still requires a unique exact
 * normalized title, so a cleaned variant cannot force a wrong match unless the
 * cleaned string is exactly some other title. Release furniture is removed
 * before part markers so that a trailing "Part 1 1080p BluRay" leaves the part
 * marker at the end, where it is meaningful and therefore kept.
 */
export function cleanCollectionTitle(value: string): string | null {
  const original = value.trim()
  /* Dots separate words only in a scene-style filename. In an ordinary title
     they belong to it — "Kill Bill Vol. 2", "Mr. Peabody" — so treat them as
     separators only when they outnumber the spaces. */
  const dots = (original.match(/[._]/gu) ?? []).length
  const spaces = (original.match(/\s/gu) ?? []).length
  const separated = dots > spaces ? original.replace(/[._]+/gu, ' ') : original
  const withoutFurniture = separated
    .replace(BRACKETED_NOISE, ' ')
    .replace(RELEASE_TOKENS, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim()
  const cleaned = withoutFurniture
    .replace(MID_TITLE_PART, ' ')
    .replace(/\s{2,}/gu, ' ')
    .replace(/[\s\-:]+$/u, '')
    .trim()
  if (!cleaned || cleaned === original) return null
  return cleaned
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

  const exactTitles = ranked.filter((item) => item.exactTitle)
  const exactYears = exactTitles.filter((item) => item.yearMatches)
  // Primary release years can differ by one across countries and festivals.
  // Only tolerate that drift for an exact normalized title, never for fuzzy
  // similarity, and prefer a true exact-year result whenever one exists.
  const adjacentYears = exactTitles.filter(
    (item) =>
      collection.year !== undefined &&
      item.candidate.year !== undefined &&
      Math.abs(item.candidate.year - collection.year) === 1
  )
  const automatic =
    collection.year === undefined
      ? exactTitles
      : exactYears.length > 0
        ? exactYears
        : adjacentYears

  if (automatic.length === 1) {
    const selected = automatic[0]
    if (selected) {
      return {
        status: 'matched',
        candidate: selected.candidate,
        confidence:
          collection.year === undefined ? 0.95 : selected.yearMatches ? 1 : 0.98,
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
