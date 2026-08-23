import { describe, expect, test } from 'bun:test'
import {
  TmdbClientError,
  type ITmdbClient,
} from '../src/clients/TmdbClient'
import { MetadataProviderError } from '../src/metadata/types'
import { TmdbMetadataProvider } from '../src/services/metadata/TmdbMetadataProvider'

function stubClient(overrides: Partial<ITmdbClient> = {}): ITmdbClient {
  return {
    getConfiguration: async () => ({}),
    searchMovie: async () => ({ page: 1, results: [] }),
    searchTV: async () => ({ page: 1, results: [] }),
    getMovie: async (id) => ({ id, title: 'Movie' }),
    getTV: async (id) => ({ id, name: 'TV Show' }),
    getMovieReleaseDates: async (id) => ({ id, results: [] }),
    getTVContentRatings: async (id) => ({ id, results: [] }),
    ...overrides,
  }
}

const searchInput = {
  title: 'Bluey',
  year: 2018,
  language: 'en-US',
  region: 'US',
}

describe('TMDB metadata provider adapter', () => {
  test('remains constructible but fail-closed when no key/client exists', async () => {
    const provider = new TmdbMetadataProvider()

    expect(provider.configured).toBe(false)
    await expect(provider.searchTV(searchInput)).rejects.toMatchObject({
      code: 'not_configured',
      provider: 'tmdb',
      retryable: false,
    })
  })

  test('maps movie search results and discards adult or malformed entries', async () => {
    const provider = new TmdbMetadataProvider({
      client: stubClient({
        searchMovie: async () => ({
          page: 1,
          results: [
            {
              id: 10,
              title: 'Soul',
              original_title: 'Soul',
              release_date: '2020-12-25',
              overview: 'A story',
              poster_path: '/poster.jpg',
              popularity: 42,
              adult: false,
            },
            { id: 11, title: 'Unsafe', adult: true },
            { id: 'invalid', title: 'Broken' },
          ],
        }),
      }),
    })

    const result = await provider.searchMovie({
      ...searchInput,
      title: 'Soul',
      year: 2020,
    })

    expect(result).toEqual([
      {
        provider: 'tmdb',
        externalId: '10',
        mediaType: 'movie',
        title: 'Soul',
        originalTitle: 'Soul',
        year: 2020,
        overview: 'A story',
        posterPath: '/poster.jpg',
        popularity: 42,
      },
    ])
  })

  test('maps TV details into provider-neutral metadata', async () => {
    const provider = new TmdbMetadataProvider({
      client: stubClient({
        getTV: async () => ({
          id: 82728,
          name: 'Bluey',
          original_name: 'Bluey',
          first_air_date: '2018-10-01',
          overview: 'Family animation',
          poster_path: '/bluey.jpg',
          backdrop_path: '/bluey-bg.jpg',
          genres: [{ id: 16, name: 'Animation' }, { id: 10751, name: 'Family' }],
        }),
      }),
    })

    expect(await provider.getTV('82728', { language: 'en-US' })).toEqual({
      provider: 'tmdb',
      externalId: '82728',
      mediaType: 'tv',
      title: 'Bluey',
      originalTitle: 'Bluey',
      year: 2018,
      overview: 'Family animation',
      posterPath: '/bluey.jpg',
      backdropPath: '/bluey-bg.jpg',
      genres: ['Animation', 'Family'],
    })
  })

  test('maps all movie release dates then applies configured region fallback', async () => {
    const provider = new TmdbMetadataProvider({
      client: stubClient({
        getMovieReleaseDates: async () => ({
          id: 10,
          results: [
            {
              iso_3166_1: 'US',
              release_dates: [{ certification: '', type: 3 }],
            },
            {
              iso_3166_1: 'GB',
              release_dates: [
                { certification: 'U', type: 4 },
                { certification: 'U', type: 3 },
              ],
            },
          ],
        }),
      }),
    })

    const result = await provider.getMovieCertification('10', ['US', 'GB'])

    expect(result.status).toBe('resolved')
    expect(result.selected).toEqual({
      region: 'GB',
      certification: 'U',
      releaseType: 3,
    })
    expect(result.all).toHaveLength(2)
  })

  test('fails closed when a TV region reports conflicting ratings', async () => {
    const provider = new TmdbMetadataProvider({
      client: stubClient({
        getTVContentRatings: async () => ({
          id: 1,
          results: [
            { iso_3166_1: 'US', rating: 'TV-Y7' },
            { iso_3166_1: 'US', rating: 'TV-PG' },
          ],
        }),
      }),
    })

    const result = await provider.getTVContentRating('1', ['US'])

    expect(result.status).toBe('ambiguous')
    expect(result.selected).toBeNull()
  })

  test('rejects invalid external IDs before provider calls can succeed', async () => {
    const provider = new TmdbMetadataProvider({ client: stubClient() })

    await expect(provider.getMovie('42junk', { language: 'en-US' })).rejects.toBeInstanceOf(
      MetadataProviderError
    )
    await expect(provider.getMovie('42junk', { language: 'en-US' })).rejects.toMatchObject({
      code: 'invalid_external_id',
    })
  })

  test('translates client rate-limit metadata without exposing credentials', async () => {
    const provider = new TmdbMetadataProvider({
      client: stubClient({
        getConfiguration: async () => {
          throw new TmdbClientError('HTTP 429', {
            code: 'http',
            status: 429,
            retryable: true,
            retryAfterMs: 5000,
          })
        },
      }),
    })

    await expect(provider.testConnection()).rejects.toMatchObject({
      code: 'rate_limited',
      provider: 'tmdb',
      retryable: true,
      retryAfterMs: 5000,
    })
  })
})
