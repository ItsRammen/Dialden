export type MetadataMediaType = 'movie' | 'tv'

export type MetadataMatchStatus =
  | 'pending'
  | 'matched'
  | 'ambiguous'
  | 'unmatched'
  | 'manual'
  | 'error'

export interface MetadataSearchInput {
  readonly title: string
  readonly year?: number
  readonly language: string
  readonly region: string
  readonly signal?: AbortSignal
}

export interface MetadataCandidate {
  readonly provider: string
  readonly externalId: string
  readonly mediaType: MetadataMediaType
  readonly title: string
  readonly originalTitle?: string
  readonly year?: number
  readonly overview?: string
  readonly posterPath?: string
  readonly popularity?: number
}

export interface ProviderTitleDetails extends MetadataCandidate {
  readonly backdropPath?: string
  /**
   * Minutes. For a film this is the whole feature; for a series it is one
   * episode. It is the strongest signal available for telling apart two
   * records that share a title and a year, because it can be checked against
   * the file on disk.
   */
  readonly runtimeMinutes?: number
  readonly genres: readonly string[]
  readonly networks?: readonly string[]
  readonly studios?: readonly string[]
}

export interface ProviderEpisodeDetails {
  readonly seasonNumber: number
  readonly episodeNumber: number
  readonly title: string
  readonly overview?: string
  readonly airDate?: string
  readonly stillPath?: string
}

/**
 * One raw certification reported by a metadata provider. `releaseType` is
 * provider-specific supporting information (TMDB uses values 1-6 for movies).
 */
export interface ProviderRating {
  readonly region: string
  readonly certification: string
  readonly releaseType?: number
}

export interface CertificationLookup {
  readonly status: 'resolved' | 'missing' | 'ambiguous'
  readonly selected: ProviderRating | null
  /** All non-empty ratings returned by the provider, not just the selection. */
  readonly all: readonly ProviderRating[]
}

export interface MetadataProvider {
  readonly id: string
  readonly configured: boolean

  testConnection(signal?: AbortSignal): Promise<void>

  searchMovie(input: MetadataSearchInput): Promise<MetadataCandidate[]>
  searchTV(input: MetadataSearchInput): Promise<MetadataCandidate[]>

  getMovie(
    externalId: string,
    input: Pick<MetadataSearchInput, 'language' | 'signal'>
  ): Promise<ProviderTitleDetails>

  getTV(
    externalId: string,
    input: Pick<MetadataSearchInput, 'language' | 'signal'>
  ): Promise<ProviderTitleDetails>

  /** Optional for providers that expose episode-level TV metadata. */
  getTVSeason?(
    externalId: string,
    seasonNumber: number,
    input: Pick<MetadataSearchInput, 'language' | 'signal'>
  ): Promise<readonly ProviderEpisodeDetails[]>

  /** Regions are ordered from preferred to least-preferred fallback. */
  getMovieCertification(
    externalId: string,
    regions: readonly string[],
    signal?: AbortSignal
  ): Promise<CertificationLookup>

  /** Regions are ordered from preferred to least-preferred fallback. */
  getTVContentRating(
    externalId: string,
    regions: readonly string[],
    signal?: AbortSignal
  ): Promise<CertificationLookup>
}

export type MetadataProviderErrorCode =
  | 'not_configured'
  | 'invalid_external_id'
  | 'unauthorized'
  | 'not_found'
  | 'rate_limited'
  | 'upstream'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'invalid_response'

export interface MetadataProviderErrorOptions {
  readonly code: MetadataProviderErrorCode
  readonly provider: string
  readonly retryable?: boolean
  readonly retryAfterMs?: number | null
  readonly status?: number | null
  readonly cause?: unknown
}

/** Provider-neutral failure consumed by the future metadata queue. */
export class MetadataProviderError extends Error {
  readonly code: MetadataProviderErrorCode
  readonly provider: string
  readonly retryable: boolean
  readonly retryAfterMs: number | null
  readonly status: number | null

  constructor(message: string, options: MetadataProviderErrorOptions) {
    super(message, { cause: options.cause })
    this.name = 'MetadataProviderError'
    this.code = options.code
    this.provider = options.provider
    this.retryable = options.retryable ?? false
    this.retryAfterMs = options.retryAfterMs ?? null
    this.status = options.status ?? null
  }
}
