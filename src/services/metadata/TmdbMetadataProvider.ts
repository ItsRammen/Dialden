import {
  TmdbClient,
  TmdbClientError,
  type ITmdbClient,
  type TmdbFetch,
  type TmdbGenre,
  type TmdbMovieDetails,
  type TmdbMovieReleaseDate,
  type TmdbMovieReleaseDateRegion,
  type TmdbMovieSearchResult,
  type TmdbNamedEntity,
  type TmdbTVContentRating,
  type TmdbTVDetails,
  type TmdbTVEpisode,
  type TmdbTVSearchResult,
} from '../../clients/TmdbClient'
import {
  MetadataProviderError,
  type CertificationLookup,
  type MetadataCandidate,
  type MetadataProvider,
  type MetadataProviderErrorCode,
  type MetadataSearchInput,
  type ProviderRating,
  type ProviderTitleDetails,
  type ProviderEpisodeDetails,
} from '../../metadata/types'
import { resolveCertification } from './RatingResolver'

const PROVIDER_ID = 'tmdb'

export interface TmdbMetadataProviderOptions {
  readonly apiKey?: string | null
  readonly requestTimeoutMs?: number
  readonly fetch?: TmdbFetch
  /** Test/alternate-client injection. Explicit null means unconfigured. */
  readonly client?: ITmdbClient | null
}

export class TmdbMetadataProvider implements MetadataProvider {
  readonly id = PROVIDER_ID
  private readonly client: ITmdbClient | null

  constructor(options: TmdbMetadataProviderOptions = {}) {
    if (options.client !== undefined) {
      this.client = options.client
      return
    }

    const apiKey = options.apiKey?.trim()
    this.client = apiKey
      ? new TmdbClient({
          apiKey,
          requestTimeoutMs: options.requestTimeoutMs,
          fetch: options.fetch,
        })
      : null
  }

  get configured(): boolean {
    return this.client !== null
  }

  async testConnection(signal?: AbortSignal): Promise<void> {
    await this.execute(async (client) => {
      const result = await client.getConfiguration(signal)
      if (!result || typeof result !== 'object') throw invalidResponse()
    })
  }

  searchMovie(input: MetadataSearchInput): Promise<MetadataCandidate[]> {
    return this.execute(async (client) => {
      if (!input.title.trim()) return []
      const response = await client.searchMovie(input.title, {
        year: input.year,
        language: input.language,
        region: input.region,
        signal: input.signal,
      })
      if (!Array.isArray(response.results)) throw invalidResponse()
      return response.results
        .map((result) => mapMovieCandidate(result, true))
        .filter((candidate): candidate is MetadataCandidate => candidate !== null)
    })
  }

  searchTV(input: MetadataSearchInput): Promise<MetadataCandidate[]> {
    return this.execute(async (client) => {
      if (!input.title.trim()) return []
      const response = await client.searchTV(input.title, {
        year: input.year,
        language: input.language,
        signal: input.signal,
      })
      if (!Array.isArray(response.results)) throw invalidResponse()
      return response.results
        .map((result) => mapTVCandidate(result, true))
        .filter((candidate): candidate is MetadataCandidate => candidate !== null)
    })
  }

  getMovie(
    externalId: string,
    input: Pick<MetadataSearchInput, 'language' | 'signal'>
  ): Promise<ProviderTitleDetails> {
    return this.execute(async (client) => {
      const id = parseExternalId(externalId)
      return mapMovieDetails(await client.getMovie(id, input.language, input.signal))
    })
  }

  getTV(
    externalId: string,
    input: Pick<MetadataSearchInput, 'language' | 'signal'>
  ): Promise<ProviderTitleDetails> {
    return this.execute(async (client) => {
      const id = parseExternalId(externalId)
      return mapTVDetails(await client.getTV(id, input.language, input.signal))
    })
  }

  getTVSeason(
    externalId: string,
    seasonNumber: number,
    input: Pick<MetadataSearchInput, 'language' | 'signal'>
  ): Promise<readonly ProviderEpisodeDetails[]> {
    return this.execute(async (client) => {
      if (!Number.isSafeInteger(seasonNumber) || seasonNumber < 0) {
        throw new MetadataProviderError('Invalid TV season number', {
          provider: PROVIDER_ID,
          code: 'invalid_external_id',
        })
      }
      const response = await client.getTVSeason(
        parseExternalId(externalId),
        seasonNumber,
        input.language,
        input.signal
      )
      if (!Array.isArray(response.episodes)) throw invalidResponse()
      return response.episodes
        .map(mapTVEpisode)
        .filter((episode): episode is ProviderEpisodeDetails => episode !== null)
    })
  }

  getMovieCertification(
    externalId: string,
    regions: readonly string[],
    signal?: AbortSignal
  ): Promise<CertificationLookup> {
    return this.execute(async (client) => {
      const response = await client.getMovieReleaseDates(
        parseExternalId(externalId),
        signal
      )
      if (!Array.isArray(response.results)) throw invalidResponse()

      const ratings: ProviderRating[] = []
      for (const rawRegion of response.results) {
        if (!rawRegion || typeof rawRegion !== 'object') continue
        const region = rawRegion as TmdbMovieReleaseDateRegion
        if (typeof region.iso_3166_1 !== 'string') continue
        if (!Array.isArray(region.release_dates)) continue
        for (const rawRelease of region.release_dates) {
          if (!rawRelease || typeof rawRelease !== 'object') continue
          const release = rawRelease as TmdbMovieReleaseDate
          if (
            typeof release.certification !== 'string' ||
            !release.certification.trim()
          ) {
            continue
          }
          ratings.push({
            region: region.iso_3166_1,
            certification: release.certification,
            ...(typeof release.type === 'number' && Number.isInteger(release.type)
              ? { releaseType: release.type }
              : {}),
          })
        }
      }
      return resolveCertification(ratings, regions)
    })
  }

  getTVContentRating(
    externalId: string,
    regions: readonly string[],
    signal?: AbortSignal
  ): Promise<CertificationLookup> {
    return this.execute(async (client) => {
      const response = await client.getTVContentRatings(
        parseExternalId(externalId),
        signal
      )
      if (!Array.isArray(response.results)) throw invalidResponse()

      const ratings: ProviderRating[] = []
      for (const rawRating of response.results) {
        if (!rawRating || typeof rawRating !== 'object') continue
        const rating = rawRating as TmdbTVContentRating
        if (
          typeof rating.iso_3166_1 !== 'string' ||
          typeof rating.rating !== 'string' ||
          !rating.rating.trim()
        ) {
          continue
        }
        ratings.push({
          region: rating.iso_3166_1,
          certification: rating.rating,
        })
      }
      return resolveCertification(ratings, regions)
    })
  }

  private async execute<T>(
    operation: (client: ITmdbClient) => Promise<T>
  ): Promise<T> {
    if (!this.client) {
      throw new MetadataProviderError('TMDB metadata provider is not configured', {
        provider: PROVIDER_ID,
        code: 'not_configured',
      })
    }

    try {
      return await operation(this.client)
    } catch (error) {
      if (error instanceof MetadataProviderError) throw error
      if (error instanceof TmdbClientError) throw mapClientError(error)
      throw new MetadataProviderError('TMDB returned an invalid response', {
        provider: PROVIDER_ID,
        code: 'invalid_response',
        cause: error,
      })
    }
  }
}

function mapMovieCandidate(
  raw: TmdbMovieSearchResult,
  excludeAdult = false
): MetadataCandidate | null {
  if (excludeAdult && raw.adult === true) return null
  const id = positiveInteger(raw.id)
  const title = nonEmptyString(raw.title)
  if (id === null || title === null) return null

  return {
    provider: PROVIDER_ID,
    externalId: String(id),
    mediaType: 'movie',
    title,
    ...optionalString('originalTitle', raw.original_title),
    ...optionalYear(raw.release_date),
    ...optionalString('overview', raw.overview),
    ...optionalString('posterPath', raw.poster_path),
    ...optionalNumber('popularity', raw.popularity),
  }
}

function mapTVCandidate(
  raw: TmdbTVSearchResult,
  excludeAdult = false
): MetadataCandidate | null {
  if (excludeAdult && raw.adult === true) return null
  const id = positiveInteger(raw.id)
  const title = nonEmptyString(raw.name)
  if (id === null || title === null) return null

  return {
    provider: PROVIDER_ID,
    externalId: String(id),
    mediaType: 'tv',
    title,
    ...optionalString('originalTitle', raw.original_name),
    ...optionalYear(raw.first_air_date),
    ...optionalString('overview', raw.overview),
    ...optionalString('posterPath', raw.poster_path),
    ...optionalNumber('popularity', raw.popularity),
  }
}

function mapMovieDetails(raw: TmdbMovieDetails): ProviderTitleDetails {
  const candidate = mapMovieCandidate(raw)
  if (!candidate) throw invalidResponse()
  return {
    ...candidate,
    ...optionalString('backdropPath', raw.backdrop_path),
    ...runtimeMinutes(raw.runtime),
    genres: mapGenres(raw.genres),
    networks: [],
    studios: mapNames(raw.production_companies),
  }
}

/** TMDB reports 0 for unknown, which is not a runtime. */
function runtimeMinutes(value: unknown): { runtimeMinutes?: number } {
  const minutes = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(minutes) && minutes > 0
    ? { runtimeMinutes: Math.round(minutes) }
    : {}
}

function episodeRuntimeMinutes(value: unknown): { runtimeMinutes?: number } {
  if (!Array.isArray(value)) return {}
  for (const entry of value) {
    const mapped = runtimeMinutes(entry)
    if (mapped.runtimeMinutes !== undefined) return mapped
  }
  return {}
}

function mapTVDetails(raw: TmdbTVDetails): ProviderTitleDetails {
  const candidate = mapTVCandidate(raw)
  if (!candidate) throw invalidResponse()
  return {
    ...candidate,
    ...optionalString('backdropPath', raw.backdrop_path),
    ...episodeRuntimeMinutes(raw.episode_run_time),
    genres: mapGenres(raw.genres),
    networks: mapNames(raw.networks),
    studios: mapNames(raw.production_companies),
  }
}

function mapTVEpisode(raw: unknown): ProviderEpisodeDetails | null {
  if (!raw || typeof raw !== 'object') return null
  const episode = raw as TmdbTVEpisode
  const seasonNumber = nonNegativeInteger(episode.season_number)
  const episodeNumber = positiveInteger(episode.episode_number)
  const title = nonEmptyString(episode.name)
  if (seasonNumber === null || episodeNumber === null || title === null) {
    return null
  }
  return {
    seasonNumber,
    episodeNumber,
    title,
    ...optionalString('overview', episode.overview),
    ...optionalString('airDate', episode.air_date),
    ...optionalString('stillPath', episode.still_path),
  }
}

function mapGenres(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((genre) =>
      genre && typeof genre === 'object'
        ? nonEmptyString((genre as TmdbGenre).name)
        : null
    )
    .filter((name): name is string => name !== null)
}

function mapNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value
        .map((item) =>
          item && typeof item === 'object'
            ? nonEmptyString((item as TmdbNamedEntity).name)
            : null
        )
        .filter((name): name is string => name !== null)
    ),
  ]
}

function parseExternalId(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new MetadataProviderError('Invalid TMDB external ID', {
      provider: PROVIDER_ID,
      code: 'invalid_external_id',
    })
  }
  const id = Number(value)
  if (!Number.isSafeInteger(id)) {
    throw new MetadataProviderError('Invalid TMDB external ID', {
      provider: PROVIDER_ID,
      code: 'invalid_external_id',
    })
  }
  return id
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const output = value.trim()
  return output || null
}

function optionalString<K extends string>(
  key: K,
  value: unknown
): { [P in K]?: string } {
  const output = nonEmptyString(value)
  return output === null ? {} : ({ [key]: output } as { [P in K]: string })
}

function optionalNumber<K extends string>(
  key: K,
  value: unknown
): { [P in K]?: number } {
  return typeof value === 'number' && Number.isFinite(value)
    ? ({ [key]: value } as { [P in K]: number })
    : {}
}

function optionalYear(value: unknown): { year?: number } {
  if (typeof value !== 'string') return {}
  const match = /^(\d{4})-/.exec(value)
  if (!match) return {}
  const year = Number(match[1])
  return Number.isInteger(year) ? { year } : {}
}

function invalidResponse(): MetadataProviderError {
  return new MetadataProviderError('TMDB returned an invalid response', {
    provider: PROVIDER_ID,
    code: 'invalid_response',
  })
}

function mapClientError(error: TmdbClientError): MetadataProviderError {
  let code: MetadataProviderErrorCode
  if (error.code === 'timeout') code = 'timeout'
  else if (error.code === 'aborted') code = 'aborted'
  else if (error.code === 'network') code = 'network'
  else if (error.code === 'invalid_response') code = 'invalid_response'
  else if (error.status === 401 || error.status === 403) code = 'unauthorized'
  else if (error.status === 404) code = 'not_found'
  else if (error.status === 429) code = 'rate_limited'
  else code = 'upstream'

  return new MetadataProviderError(`TMDB provider request failed (${code})`, {
    provider: PROVIDER_ID,
    code,
    status: error.status,
    retryable: error.retryable,
    retryAfterMs: error.retryAfterMs,
    cause: error,
  })
}
