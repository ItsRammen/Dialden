/**
 * Pure collection and episode identity parsing.
 *
 * Filesystem discovery owns paths; this module only derives conservative
 * catalog hints from a root-relative path. It deliberately does not perform
 * fuzzy title matching or make policy decisions.
 */

import { cleanMediaTitle } from '../utils/cleanFilename'

export type CollectionLibraryKind = 'tv' | 'movie'

export interface CollectionTitleParts {
  readonly title: string
  readonly year: number | null
}

export interface CollectionIdentity {
  /** Folder name, or a cleaned filename for flat libraries. */
  readonly sourceTitle: string
  /** Title with only a terminal parenthesized year removed. */
  readonly title: string
  readonly year: number | null
  /** Stable, normalized key suitable for a root-scoped unique constraint. */
  readonly identityKey: string
  readonly seasonNumber: number | null
  readonly episodeNumber: number | null
  readonly episodeTitle: string | null
}

export interface CollectionIdentityInput {
  readonly libraryKind: CollectionLibraryKind
  readonly relativePath: string
}

export interface EpisodeRange {
  readonly seasonNumber: number
  readonly episodeNumber: number
  readonly endEpisodeNumber: number | null
}

const TERMINAL_YEAR = /^(.*?)\s*\(((?:18|19|20|21)\d{2})\)\s*$/
// Release managers do not agree on episode-token spacing. Treat S03E08,
// S03 E08, and S03 - E08 as the same identity so provider metadata can still
// be joined to the file instead of leaving the guide to display its basename.
const EPISODE_TOKEN =
  /\bS(\d{1,3})[\s._-]*E(\d{1,4})(?:(?:\s*[-+]\s*E?|E)(\d{1,4}))?\b/i
const SEASON_DIRECTORY = /^Season[\s._-]*(\d{1,3})$/i

/**
 * Parse only a terminal parenthesized year. A numeric title such as `1923`
 * remains a title and is never reinterpreted as a release year.
 */
export function parseCollectionTitle(value: string): CollectionTitleParts {
  const source = normalizeDisplayWhitespace(value)
  const match = TERMINAL_YEAR.exec(source)
  const candidateTitle = match?.[1]
  const candidateYear = match?.[2]

  if (candidateTitle && candidateYear) {
    const title = normalizeDisplayWhitespace(candidateTitle)
    if (title) return { title, year: Number(candidateYear) }
  }

  return { title: source, year: null }
}

/** Normalize identity without applying fuzzy search transformations. */
export function normalizeCollectionTitle(value: string): string {
  return normalizeDisplayWhitespace(value)
    .normalize('NFC')
    .toLocaleLowerCase('en-US')
}

export function deriveCollectionIdentity(
  input: CollectionIdentityInput
): CollectionIdentity | null {
  const segments = parseRelativeSegments(input.relativePath)
  if (!segments) return null

  const filename = segments[segments.length - 1]
  if (!filename) return null
  const fileStem = stripExtension(filename)
  const episodeMatch = EPISODE_TOKEN.exec(fileStem)

  let sourceTitle: string
  if (segments.length > 1) {
    sourceTitle = normalizeDisplayWhitespace(segments[0] ?? '')
  } else if (input.libraryKind === 'tv' && episodeMatch?.index !== undefined) {
    // A flat TV root can still be grouped when the conventional episode token
    // provides an unambiguous boundary. Otherwise retain the whole basename.
    const prefix = fileStem
      .slice(0, episodeMatch.index)
      .replace(/[\s._-]+$/g, '')
      .replace(/_/g, ' ')
    sourceTitle = normalizeDisplayWhitespace(prefix || fileStem.replace(/_/g, ' '))
  } else {
    sourceTitle = normalizeDisplayWhitespace(fileStem.replace(/_/g, ' '))
  }

  if (!sourceTitle) return null
  const { title, year } = parseCollectionTitle(sourceTitle)
  if (!title) return null

  const tokenSeason = parseInteger(episodeMatch?.[1])
  const episodeNumber = parseInteger(episodeMatch?.[2])
  const directorySeason = segments
    .slice(1, -1)
    .map((segment) => parseInteger(SEASON_DIRECTORY.exec(segment)?.[1]))
    .find((value): value is number => value !== null)
  const seasonNumber = tokenSeason ?? directorySeason ?? null
  const episodeTitle = episodeMatch
    ? parseEpisodeTitle(fileStem, episodeMatch.index, episodeMatch[0].length)
    : null
  const normalizedTitle = normalizeCollectionTitle(title)
  if (!normalizedTitle) return null

  return {
    sourceTitle,
    title,
    year,
    // JSON encoding avoids delimiter collisions and embedded NULs in SQLite
    // while retaining the distinction between a missing year and a real year.
    identityKey: JSON.stringify([normalizedTitle, year]),
    seasonNumber,
    episodeNumber,
    episodeTitle,
  }
}

/** Parse both ordinary and multi-episode Sonarr/Plex tokens. */
export function parseEpisodeRange(value: string): EpisodeRange | null {
  const match = EPISODE_TOKEN.exec(value)
  const seasonNumber = parseInteger(match?.[1])
  const episodeNumber = parseInteger(match?.[2])
  const endEpisodeNumber = parseInteger(match?.[3])
  if (seasonNumber === null || episodeNumber === null) return null
  return {
    seasonNumber,
    episodeNumber,
    endEpisodeNumber:
      endEpisodeNumber !== null && endEpisodeNumber > episodeNumber
        ? endEpisodeNumber
        : null,
  }
}

/** Re-derive the human episode title from the current filename. */
export function parseEpisodeDisplayTitle(value: string): string | null {
  const fileStem = stripExtension(value)
  const match = EPISODE_TOKEN.exec(fileStem)
  return match
    ? parseEpisodeTitle(fileStem, match.index, match[0].length)
    : null
}

function parseRelativeSegments(value: string): string[] | null {
  if (!value || value.includes('\0')) return null
  const normalized = value.replace(/\\/g, '/')
  if (normalized.startsWith('/') || normalized.endsWith('/')) return null
  const segments = normalized.split('/')
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => !segment || segment === '.' || segment === '..'
    )
  ) {
    return null
  }
  return segments
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, '')
}

function normalizeDisplayWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function parseInteger(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function parseEpisodeTitle(
  fileStem: string,
  tokenIndex: number,
  tokenLength: number
): string | null {
  const suffix = fileStem
    .slice(tokenIndex + tokenLength)
    .replace(/^[\s._-]+/, '')
  const title = normalizeDisplayWhitespace(cleanMediaTitle(suffix))
  return title || null
}
