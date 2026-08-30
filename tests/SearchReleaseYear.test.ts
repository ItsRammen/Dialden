import { describe, expect, test } from 'bun:test'
import type { ITmdbClient } from '../src/clients/TmdbClient'
import { TmdbMetadataProvider } from '../src/services/metadata/TmdbMetadataProvider'
import { matchMetadata, parseCollectionTitle } from '../src/services/metadata/TitleMatcher'

/**
 * TMDB localises the release_date it returns to the region asked for. Asking
 * for US dates reported a Japanese film of 2007 as 2019, which then failed to
 * match a file named for 2007. These pin the parameter and the consequence.
 */
function clientCapturing(
  calls: Record<string, unknown>[],
  results: never[] = []
): ITmdbClient {
  return {
    getConfiguration: async () => ({}),
    searchMovie: async (query, options) => {
      calls.push({ query, ...options })
      return { page: 1, results }
    },
    searchTV: async (query, options) => {
      calls.push({ query, ...options })
      return { page: 1, results: [] }
    },
    getMovie: async (id) => ({ id, title: 'Movie' }),
    getTV: async (id) => ({ id, name: 'TV Show' }),
    getTVSeason: async () => ({ episodes: [] }),
    getMovieReleaseDates: async (id) => ({ id, results: [] }),
    getTVContentRatings: async (id) => ({ id, results: [] }),
  }
}

describe('the year a search reports', () => {
  test('no region is sent, so the date is the original release', async () => {
    const calls: Record<string, unknown>[] = []
    const provider = new TmdbMetadataProvider({ client: clientCapturing(calls) })

    await provider.searchMovie({
      title: 'A Tale of Mari and Three Puppies',
      year: 2007,
      language: 'en-US',
    })

    expect(calls[0]).not.toHaveProperty('region')
    expect(calls[0]?.['year']).toBe(2007)
  })

  test('the rating region never leaks into a search', async () => {
    /* The two settings mean different things: one picks a certification
       board, the other rewrites which release date is reported. */
    const calls: Record<string, unknown>[] = []
    const provider = new TmdbMetadataProvider({ client: clientCapturing(calls) })

    await provider.searchMovie({
      title: 'A Real Young Girl',
      year: 1976,
      language: 'en-US',
    })

    // The language is legitimately en-US; it is the region key that must
    // not exist, so assert on the key rather than on the substring.
    expect(Object.keys(calls[0] ?? {})).not.toContain('region')
    expect(calls[0]?.['language']).toBe('en-US')
  })

  test('the original year matches the file; a localised one would not', () => {
    const parsed = parseCollectionTitle('A Tale of Mari & 3 Puppies (2007)')
    const candidate = {
      provider: 'tmdb',
      externalId: '125239',
      mediaType: 'movie' as const,
      title: 'A Tale of Mari and Three Puppies',
    }

    // What TMDB reports without a region: the Japanese original.
    const original = matchMetadata(parsed, [{ ...candidate, year: 2007 }])
    expect(original.status).toBe('matched')
    expect(original.confidence).toBe(1)

    // What region=US reported before: the American release, twelve years on.
    const localised = matchMetadata(parsed, [{ ...candidate, year: 2019 }])
    expect(localised.status).toBe('ambiguous')
  })

  test('the same holds for A Real Young Girl', () => {
    const parsed = parseCollectionTitle('A Real Young Girl (1976)')
    const candidate = {
      provider: 'tmdb',
      externalId: '1631',
      mediaType: 'movie' as const,
      title: 'A Real Young Girl',
      originalTitle: 'Une vraie jeune fille',
    }

    expect(matchMetadata(parsed, [{ ...candidate, year: 1976 }]).status).toBe(
      'matched'
    )
    expect(matchMetadata(parsed, [{ ...candidate, year: 2001 }]).status).toBe(
      'ambiguous'
    )
  })
})
