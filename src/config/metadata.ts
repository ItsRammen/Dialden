const DEFAULT_LANGUAGE = 'en-US'
const DEFAULT_RATING_REGION = 'US'
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const MIN_REQUEST_TIMEOUT_MS = 100
const MAX_REQUEST_TIMEOUT_MS = 60_000

/**
 * The metadata configuration is deliberately stored as one versioned value so
 * a settings save cannot leave a half-updated region/key combination behind.
 * The value lives in the appdata SQLite settings table.
 */
export const METADATA_CONFIG_SETTING_KEY = 'metadata_configuration_v1'

export interface MetadataSettingStore {
  getSetting(key: string): Promise<string | null>
  setSetting(key: string, value: string): Promise<void>
}

export type MetadataConfigDiagnostic = (message: string) => void

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
  readonly requestTimeoutMs: number
}

export type MetadataConfigField =
  | 'tmdbApiKey'
  | 'language'
  | 'preferredRatingRegion'
  | 'fallbackRatingRegions'
  | 'requestTimeoutMs'

/** Values accepted from the admin settings form. */
export interface MetadataConfigUpdateInput {
  /** Blank or omitted preserves the current server-side secret. */
  readonly tmdbApiKey?: string
  readonly removeTmdbApiKey?: boolean
  readonly language?: string
  readonly preferredRatingRegion?: string
  readonly fallbackRatingRegions?: string | readonly string[]
  readonly requestTimeoutMs?: string | number
}

export class MetadataConfigValidationError extends Error {
  constructor(
    readonly fieldErrors: Partial<Record<MetadataConfigField, string>>
  ) {
    super('Metadata settings contain invalid values')
    this.name = 'MetadataConfigValidationError'
  }
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
    Number.isInteger(parsedTimeout) &&
    parsedTimeout >= MIN_REQUEST_TIMEOUT_MS &&
    parsedTimeout <= MAX_REQUEST_TIMEOUT_MS
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
    requestTimeoutMs: config.requestTimeoutMs,
  }
}

/**
 * Load the saved appdata value when present. Environment values are bootstrap
 * defaults only and are used when an installation has never saved this page.
 * A present but invalid value is authoritative: fail closed instead of
 * resurrecting an environment key that an administrator may have removed.
 */
export async function loadPersistedMetadataConfig(
  repository: Pick<MetadataSettingStore, 'getSetting'>,
  environment: Record<string, string | undefined> = process.env,
  reportDiagnostic: MetadataConfigDiagnostic = (message) =>
    console.warn(message)
): Promise<MetadataRuntimeConfig> {
  const stored = await repository.getSetting(METADATA_CONFIG_SETTING_KEY)
  if (stored === null) return loadMetadataConfig(environment)

  try {
    const parsed: unknown = JSON.parse(stored)
    const config = parseStoredMetadataConfig(parsed)
    if (config) return config
  } catch {
    // The stored JSON may contain an API key, so never include it in a log.
  }

  reportDiagnostic(
    'Saved metadata settings are invalid or use an unsupported version; metadata is disabled until the settings are saved again.'
  )
  return safeDisabledMetadataConfig()
}

/** Persist the complete validated runtime shape as one SQLite setting. */
export async function persistMetadataConfig(
  repository: Pick<MetadataSettingStore, 'setSetting'>,
  config: MetadataRuntimeConfig
): Promise<void> {
  await repository.setSetting(
    METADATA_CONFIG_SETTING_KEY,
    JSON.stringify({
      version: 1,
      tmdbApiKey: config.tmdbApiKey,
      language: config.language,
      preferredRatingRegion: config.preferredRatingRegion,
      fallbackRatingRegions: [...config.fallbackRatingRegions],
      requestTimeoutMs: config.requestTimeoutMs,
    })
  )
}

/**
 * Validate an admin form against the current secret-bearing configuration.
 * Empty API-key input intentionally keeps the existing value.
 */
export function resolveMetadataConfigUpdate(
  current: MetadataRuntimeConfig,
  input: MetadataConfigUpdateInput
): MetadataRuntimeConfig {
  const fieldErrors: Partial<Record<MetadataConfigField, string>> = {}

  let tmdbApiKey = current.tmdbApiKey
  const submittedKey = input.tmdbApiKey?.trim() ?? ''
  if (input.removeTmdbApiKey && submittedKey) {
    fieldErrors.tmdbApiKey =
      'Choose either a replacement API key or remove the current key.'
  } else if (input.removeTmdbApiKey) {
    tmdbApiKey = null
  } else if (submittedKey) {
    if (
      submittedKey.length < 16 ||
      submittedKey.length > 256 ||
      /\s|[\u0000-\u001f\u007f]/.test(submittedKey)
    ) {
      fieldErrors.tmdbApiKey =
        'Enter a valid TMDB v3 API key without spaces (16–256 characters).'
    } else {
      tmdbApiKey = submittedKey
    }
  }

  const languageInput = input.language ?? current.language
  const language = normalizeLanguageStrict(languageInput)
  if (!language) {
    fieldErrors.language = 'Enter a valid language tag, such as en-US or zh-TW.'
  }

  const preferredInput =
    input.preferredRatingRegion ?? current.preferredRatingRegion
  const preferredRatingRegion = normalizeRegion(preferredInput)
  if (!preferredRatingRegion) {
    fieldErrors.preferredRatingRegion =
      'Enter a two-letter country code, such as US or TW.'
  }

  const fallbackInput = input.fallbackRatingRegions
  const fallbackValues =
    fallbackInput === undefined
      ? [...current.fallbackRatingRegions]
      : typeof fallbackInput === 'string'
        ? fallbackInput.split(',')
        : [...fallbackInput]
  const fallbackRatingRegions: string[] = []
  const seenRegions = new Set(
    preferredRatingRegion ? [preferredRatingRegion] : []
  )
  for (const rawRegion of fallbackValues) {
    if (!rawRegion.trim()) continue
    const region = normalizeRegion(rawRegion)
    if (!region) {
      fieldErrors.fallbackRatingRegions =
        'Use comma-separated two-letter country codes, such as US, GB.'
      continue
    }
    if (seenRegions.has(region)) continue
    seenRegions.add(region)
    fallbackRatingRegions.push(region)
  }
  if (fallbackRatingRegions.length > 10) {
    fieldErrors.fallbackRatingRegions = 'Use no more than 10 fallback regions.'
  }

  const timeoutInput = input.requestTimeoutMs ?? current.requestTimeoutMs
  const timeoutText = String(timeoutInput).trim()
  const requestTimeoutMs = /^\d+$/.test(timeoutText)
    ? Number.parseInt(timeoutText, 10)
    : Number.NaN
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < MIN_REQUEST_TIMEOUT_MS ||
    requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS
  ) {
    fieldErrors.requestTimeoutMs = `Enter a timeout from ${MIN_REQUEST_TIMEOUT_MS} to ${MAX_REQUEST_TIMEOUT_MS} milliseconds.`
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new MetadataConfigValidationError(fieldErrors)
  }

  return {
    tmdbApiKey,
    language: language!,
    preferredRatingRegion: preferredRatingRegion!,
    fallbackRatingRegions,
    requestTimeoutMs,
  }
}

function parseStoredMetadataConfig(value: unknown): MetadataRuntimeConfig | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.version !== 1) return null
  if (
    record.tmdbApiKey !== null &&
    (typeof record.tmdbApiKey !== 'string' || !record.tmdbApiKey.trim())
  ) {
    return null
  }
  if (typeof record.language !== 'string') return null
  if (typeof record.preferredRatingRegion !== 'string') return null
  if (!Array.isArray(record.fallbackRatingRegions)) return null
  if (!record.fallbackRatingRegions.every((region) => typeof region === 'string')) {
    return null
  }
  if (typeof record.requestTimeoutMs !== 'number') return null

  try {
    return resolveMetadataConfigUpdate(
      {
        tmdbApiKey: null,
        language: DEFAULT_LANGUAGE,
        preferredRatingRegion: DEFAULT_RATING_REGION,
        fallbackRatingRegions: [],
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      },
      {
        tmdbApiKey: record.tmdbApiKey ?? undefined,
        removeTmdbApiKey: record.tmdbApiKey === null,
        language: record.language,
        preferredRatingRegion: record.preferredRatingRegion,
        fallbackRatingRegions: record.fallbackRatingRegions as string[],
        requestTimeoutMs: record.requestTimeoutMs,
      }
    )
  } catch {
    return null
  }
}

function safeDisabledMetadataConfig(): MetadataRuntimeConfig {
  return {
    tmdbApiKey: null,
    language: DEFAULT_LANGUAGE,
    preferredRatingRegion: DEFAULT_RATING_REGION,
    fallbackRatingRegions: [],
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
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

function normalizeLanguageStrict(value: string): string | null {
  const candidate = value.trim()
  if (!candidate || candidate.length > 64) return null
  try {
    return new Intl.Locale(candidate).toString()
  } catch {
    return null
  }
}
