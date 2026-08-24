const DEFAULT_BASE_URL = 'https://api.themoviedb.org/3'
const DEFAULT_TIMEOUT_MS = 10_000

export type TmdbFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>

export interface TmdbSearchResponse<T> {
  readonly page?: number
  readonly results?: readonly T[]
  readonly total_pages?: number
  readonly total_results?: number
}

export interface TmdbMovieSearchResult {
  readonly id?: unknown
  readonly title?: unknown
  readonly original_title?: unknown
  readonly release_date?: unknown
  readonly overview?: unknown
  readonly poster_path?: unknown
  readonly popularity?: unknown
  readonly adult?: unknown
}

export interface TmdbTVSearchResult {
  readonly id?: unknown
  readonly name?: unknown
  readonly original_name?: unknown
  readonly first_air_date?: unknown
  readonly overview?: unknown
  readonly poster_path?: unknown
  readonly popularity?: unknown
  readonly adult?: unknown
}

export interface TmdbGenre {
  readonly id?: unknown
  readonly name?: unknown
}

export interface TmdbNamedEntity {
  readonly id?: unknown
  readonly name?: unknown
}

export interface TmdbMovieDetails extends TmdbMovieSearchResult {
  readonly backdrop_path?: unknown
  readonly genres?: unknown
  readonly production_companies?: unknown
}

export interface TmdbTVDetails extends TmdbTVSearchResult {
  readonly backdrop_path?: unknown
  readonly genres?: unknown
  readonly networks?: unknown
  readonly production_companies?: unknown
}

export interface TmdbTVEpisode {
  readonly season_number?: unknown
  readonly episode_number?: unknown
  readonly name?: unknown
  readonly overview?: unknown
  readonly air_date?: unknown
  readonly still_path?: unknown
}

export interface TmdbTVSeasonDetails {
  readonly episodes?: unknown
}

export interface TmdbMovieReleaseDate {
  readonly certification?: unknown
  readonly type?: unknown
  readonly release_date?: unknown
}

export interface TmdbMovieReleaseDateRegion {
  readonly iso_3166_1?: unknown
  readonly release_dates?: unknown
}

export interface TmdbMovieReleaseDatesResponse {
  readonly id?: unknown
  readonly results?: unknown
}

export interface TmdbTVContentRating {
  readonly iso_3166_1?: unknown
  readonly rating?: unknown
}

export interface TmdbTVContentRatingsResponse {
  readonly id?: unknown
  readonly results?: unknown
}

export interface ITmdbClient {
  getConfiguration(signal?: AbortSignal): Promise<unknown>
  searchMovie(
    query: string,
    options: {
      readonly year?: number
      readonly language: string
      readonly region: string
      readonly signal?: AbortSignal
    }
  ): Promise<TmdbSearchResponse<TmdbMovieSearchResult>>
  searchTV(
    query: string,
    options: {
      readonly year?: number
      readonly language: string
      readonly signal?: AbortSignal
    }
  ): Promise<TmdbSearchResponse<TmdbTVSearchResult>>
  getMovie(
    id: number,
    language: string,
    signal?: AbortSignal
  ): Promise<TmdbMovieDetails>
  getTV(
    id: number,
    language: string,
    signal?: AbortSignal
  ): Promise<TmdbTVDetails>
  getTVSeason(
    id: number,
    seasonNumber: number,
    language: string,
    signal?: AbortSignal
  ): Promise<TmdbTVSeasonDetails>
  getMovieReleaseDates(
    id: number,
    signal?: AbortSignal
  ): Promise<TmdbMovieReleaseDatesResponse>
  getTVContentRatings(
    id: number,
    signal?: AbortSignal
  ): Promise<TmdbTVContentRatingsResponse>
}

export type TmdbClientErrorCode =
  | 'http'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'invalid_response'

export class TmdbClientError extends Error {
  readonly code: TmdbClientErrorCode
  readonly status: number | null
  readonly retryable: boolean
  readonly retryAfterMs: number | null

  constructor(
    message: string,
    options: {
      readonly code: TmdbClientErrorCode
      readonly status?: number | null
      readonly retryable?: boolean
      readonly retryAfterMs?: number | null
      readonly cause?: unknown
    }
  ) {
    super(message, { cause: options.cause })
    this.name = 'TmdbClientError'
    this.code = options.code
    this.status = options.status ?? null
    this.retryable = options.retryable ?? false
    this.retryAfterMs = options.retryAfterMs ?? null
  }
}

export interface TmdbClientOptions {
  readonly apiKey: string
  readonly requestTimeoutMs?: number
  readonly baseUrl?: string
  readonly fetch?: TmdbFetch
}

/** Thin TMDB v3 HTTP client. It never logs request URLs or credentials. */
export class TmdbClient implements ITmdbClient {
  private readonly apiKey: string
  private readonly requestTimeoutMs: number
  private readonly baseUrl: string
  private readonly fetchImpl: TmdbFetch

  constructor(options: TmdbClientOptions) {
    const apiKey = options.apiKey.trim()
    if (!apiKey) throw new Error('TMDB API key is required')

    this.apiKey = apiKey
    this.requestTimeoutMs = normalizeTimeout(options.requestTimeoutMs)
    this.baseUrl = (options.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.fetchImpl = options.fetch ?? fetch
  }

  getConfiguration(signal?: AbortSignal): Promise<unknown> {
    return this.request('/configuration', {}, signal)
  }

  searchMovie(
    query: string,
    options: {
      readonly year?: number
      readonly language: string
      readonly region: string
      readonly signal?: AbortSignal
    }
  ): Promise<TmdbSearchResponse<TmdbMovieSearchResult>> {
    return this.request(
      '/search/movie',
      {
        query,
        include_adult: 'false',
        language: options.language,
        region: options.region,
        page: '1',
        primary_release_year: options.year,
      },
      options.signal
    )
  }

  searchTV(
    query: string,
    options: {
      readonly year?: number
      readonly language: string
      readonly signal?: AbortSignal
    }
  ): Promise<TmdbSearchResponse<TmdbTVSearchResult>> {
    return this.request(
      '/search/tv',
      {
        query,
        include_adult: 'false',
        language: options.language,
        page: '1',
        first_air_date_year: options.year,
      },
      options.signal
    )
  }

  getMovie(
    id: number,
    language: string,
    signal?: AbortSignal
  ): Promise<TmdbMovieDetails> {
    return this.request(`/movie/${id}`, { language }, signal)
  }

  getTV(
    id: number,
    language: string,
    signal?: AbortSignal
  ): Promise<TmdbTVDetails> {
    return this.request(`/tv/${id}`, { language }, signal)
  }

  getTVSeason(
    id: number,
    seasonNumber: number,
    language: string,
    signal?: AbortSignal
  ): Promise<TmdbTVSeasonDetails> {
    return this.request(
      `/tv/${id}/season/${seasonNumber}`,
      { language },
      signal
    )
  }

  getMovieReleaseDates(
    id: number,
    signal?: AbortSignal
  ): Promise<TmdbMovieReleaseDatesResponse> {
    return this.request(`/movie/${id}/release_dates`, {}, signal)
  }

  getTVContentRatings(
    id: number,
    signal?: AbortSignal
  ): Promise<TmdbTVContentRatingsResponse> {
    return this.request(`/tv/${id}/content_ratings`, {}, signal)
  }

  private async request<T>(
    path: string,
    query: Readonly<Record<string, string | number | undefined>>,
    callerSignal?: AbortSignal
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && String(value).trim() !== '') {
        url.searchParams.set(key, String(value))
      }
    }
    // TMDB v3 API key authentication. Never include this URL in errors/logs.
    url.searchParams.set('api_key', this.apiKey)

    const controller = new AbortController()
    let timedOut = false
    const onCallerAbort = () => controller.abort(callerSignal?.reason)
    if (callerSignal?.aborted) onCallerAbort()
    else callerSignal?.addEventListener('abort', onCallerAbort, { once: true })

    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort(new DOMException('TMDB request timed out', 'TimeoutError'))
    }, this.requestTimeoutMs)

    try {
      const response = await this.fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })

      if (!response.ok) {
        const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'))
        throw new TmdbClientError(
          `TMDB request failed with HTTP ${response.status}`,
          {
            code: 'http',
            status: response.status,
            retryable: response.status === 429 || response.status >= 500,
            retryAfterMs,
          }
        )
      }

      try {
        return (await response.json()) as T
      } catch (error) {
        throw new TmdbClientError('TMDB returned an invalid JSON response', {
          code: 'invalid_response',
          cause: error,
        })
      }
    } catch (error) {
      if (error instanceof TmdbClientError) throw error
      if (timedOut) {
        throw new TmdbClientError('TMDB request timed out', {
          code: 'timeout',
          retryable: true,
          cause: error,
        })
      }
      if (callerSignal?.aborted) {
        throw new TmdbClientError('TMDB request was aborted', {
          code: 'aborted',
          cause: error,
        })
      }
      throw new TmdbClientError('TMDB network request failed', {
        code: 'network',
        retryable: true,
        cause: error,
      })
    } finally {
      clearTimeout(timeout)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    }
  }
}

function normalizeTimeout(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) >= 1
    ? Math.floor(value as number)
    : DEFAULT_TIMEOUT_MS
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000)
  }

  const instant = Date.parse(value)
  if (Number.isNaN(instant)) return null
  return Math.max(0, instant - Date.now())
}
