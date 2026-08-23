const DEFAULT_LANGUAGE = 'en-US'
const DEFAULT_RATING_REGION = 'US'
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

export interface MetadataRuntimeConfig {
  /** Server-side secret. Never include this object in an HTTP response. */
  readonly tmdbApiKey: string | null
  readonly language: string
  readonly preferredRatingRegion: string
  readonly fallbackRatingRegions: readonly string[]
  readonly requestTimeoutMs: number
}

export interface PublicMetadataConfig {
  readonly provider: 'tmdb'
  readonly configured: boolean
  readonly language: string
  readonly preferredRatingRegion: string
  readonly fallbackRatingRegions: readonly string[]
}

export function loadMetadataConfig(
  environment: Record<string, string | undefined> = process.env
): MetadataRuntimeConfig {
  const tmdbApiKey = environment.TMDB_API_KEY?.trim() || null
  const preferredRatingRegion =
    normalizeRegion(environment.RATING_REGION) ?? DEFAULT_RATING_REGION
  const language = normalizeLanguage(environment.TMDB_LANGUAGE)

  const seenRegions = new Set([preferredRatingRegion])
  const fallbackRatingRegions: string[] = []
  for (const rawRegion of (environment.RATING_FALLBACK_REGIONS ?? '').split(',')) {
    const region = normalizeRegion(rawRegion)
    if (!region || seenRegions.has(region)) continue
    seenRegions.add(region)
    fallbackRatingRegions.push(region)
  }

  const parsedTimeout = Number.parseInt(
    environment.TMDB_REQUEST_TIMEOUT_MS ?? '',
    10
  )
  const requestTimeoutMs =
    Number.isInteger(parsedTimeout) && parsedTimeout >= 100 && parsedTimeout <= 60_000
      ? parsedTimeout
      : DEFAULT_REQUEST_TIMEOUT_MS

  return {
    tmdbApiKey,
    language,
    preferredRatingRegion,
    fallbackRatingRegions,
    requestTimeoutMs,
  }
}

/** Explicitly construct the only metadata config shape safe for a response. */
export function toPublicMetadataConfig(
  config: MetadataRuntimeConfig
): PublicMetadataConfig {
  return {
    provider: 'tmdb',
    configured: config.tmdbApiKey !== null,
    language: config.language,
    preferredRatingRegion: config.preferredRatingRegion,
    fallbackRatingRegions: [...config.fallbackRatingRegions],
  }
}

function normalizeRegion(value: string | undefined): string | null {
  const candidate = value?.trim().toUpperCase() ?? ''
  return /^[A-Z]{2}$/.test(candidate) ? candidate : null
}

function normalizeLanguage(value: string | undefined): string {
  const candidate = value?.trim()
  if (!candidate) return DEFAULT_LANGUAGE

  try {
    return new Intl.Locale(candidate).toString()
  } catch {
    return DEFAULT_LANGUAGE
  }
}
