import { describe, expect, test } from 'bun:test'
import {
  TmdbClient,
  TmdbClientError,
  type TmdbFetch,
} from '../src/clients/TmdbClient'

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

describe('TMDB v3 HTTP client', () => {
  test('builds movie and TV searches with adult results disabled', async () => {
    const urls: URL[] = []
    const fetchImpl: TmdbFetch = async (input) => {
      urls.push(new URL(String(input)))
      return jsonResponse({ page: 1, results: [] })
    }
    const client = new TmdbClient({ apiKey: 'top-secret', fetch: fetchImpl })

    await client.searchMovie('Soul & Friends', {
      year: 2020,
      language: 'en-US',
      region: 'US',
    })
    await client.searchTV('Bluey', { year: 2018, language: 'en-US' })

    const movie = urls[0]
    expect(movie?.pathname).toBe('/3/search/movie')
    expect(movie?.searchParams.get('query')).toBe('Soul & Friends')
    expect(movie?.searchParams.get('primary_release_year')).toBe('2020')
    expect(movie?.searchParams.get('region')).toBe('US')
    expect(movie?.searchParams.get('include_adult')).toBe('false')
    expect(movie?.searchParams.get('api_key')).toBe('top-secret')

    const tv = urls[1]
    expect(tv?.pathname).toBe('/3/search/tv')
    expect(tv?.searchParams.get('first_air_date_year')).toBe('2018')
    expect(tv?.searchParams.get('include_adult')).toBe('false')
  })

  test('uses the v3 detail and certification endpoints', async () => {
    const paths: string[] = []
    const fetchImpl: TmdbFetch = async (input) => {
      paths.push(new URL(String(input)).pathname)
      return jsonResponse({ id: 42, results: [] })
    }
    const client = new TmdbClient({ apiKey: 'secret', fetch: fetchImpl })

    await client.getMovie(42, 'en-US')
    await client.getTV(43, 'en-US')
    await client.getMovieReleaseDates(42)
    await client.getTVContentRatings(43)

    expect(paths).toEqual([
      '/3/movie/42',
      '/3/tv/43',
      '/3/movie/42/release_dates',
      '/3/tv/43/content_ratings',
    ])
  })

  test('provides typed retry metadata for rate limiting without exposing key', async () => {
    const fetchImpl: TmdbFetch = async () =>
      new Response('', {
        status: 429,
        headers: { 'Retry-After': '3' },
      })
    const client = new TmdbClient({ apiKey: 'never-leak-me', fetch: fetchImpl })

    let failure: unknown
    try {
      await client.getConfiguration()
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(TmdbClientError)
    const typed = failure as TmdbClientError
    expect(typed.status).toBe(429)
    expect(typed.retryable).toBe(true)
    expect(typed.retryAfterMs).toBe(3000)
    expect(String(typed)).not.toContain('never-leak-me')
  })

  test('marks upstream 5xx failures retryable', async () => {
    const client = new TmdbClient({
      apiKey: 'secret',
      fetch: async () => new Response('', { status: 503 }),
    })

    await expect(client.getConfiguration()).rejects.toMatchObject({
      code: 'http',
      status: 503,
      retryable: true,
    })
  })

  test('aborts a request at the configured timeout', async () => {
    const fetchImpl: TmdbFetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        const rejectAbort = () => reject(signal?.reason ?? new Error('aborted'))
        if (signal?.aborted) rejectAbort()
        else signal?.addEventListener('abort', rejectAbort, { once: true })
      })
    const client = new TmdbClient({
      apiKey: 'secret',
      fetch: fetchImpl,
      requestTimeoutMs: 5,
    })

    await expect(client.getConfiguration()).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
    })
  })

  test('rejects malformed JSON as a non-retryable invalid response', async () => {
    const client = new TmdbClient({
      apiKey: 'secret',
      fetch: async () =>
        new Response('{not-json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    })

    await expect(client.getConfiguration()).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    })
  })
})
