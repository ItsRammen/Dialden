/**
 * Review assistant configuration.
 *
 * Mirrors `src/config/metadata.ts`: environment supplies the defaults, one
 * versioned JSON value in the settings table overrides them, and a present but
 * invalid stored value fails closed rather than resurrecting an environment key
 * an administrator removed.
 *
 * The assistant is optional. Deterministic policy settles what it can on its
 * own, and nothing here changes whether the library works — only whether the
 * cases policy could not resolve get a second opinion.
 */
import type {
  AutoDecisionPolicy,
  AutoTreatment,
  MetadataTreatment,
} from '../services/review/autoDecision'
import { DEFAULT_AUTO_DECISION_POLICY } from '../services/review/autoDecision'

const DEFAULT_MODEL = 'gpt-4o-mini'
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MIN_REQUEST_TIMEOUT_MS = 1_000
const MAX_REQUEST_TIMEOUT_MS = 120_000
const DEFAULT_MAX_CONCURRENCY = 2
const MAX_CONCURRENCY_LIMIT = 8
/** A run cannot spend more than this many calls without being asked again. */
const DEFAULT_CALL_BUDGET = 250

export const REVIEW_ASSISTANT_CONFIG_SETTING_KEY = 'review_assistant_configuration_v1'

export interface ReviewAssistantSettingStore {
  getSetting(key: string): Promise<string | null>
  setSetting(key: string, value: string): Promise<void>
}

export type ReviewAssistantDiagnostic = (message: string) => void

export interface ReviewAssistantRuntimeConfig {
  readonly enabled: boolean
  /** Server-side secret. Never include this object in an HTTP response. */
  readonly apiKey: string | null
  /** OpenAI-compatible root, without the `/chat/completions` suffix. */
  readonly baseUrl: string
  readonly model: string
  readonly requestTimeoutMs: number
  readonly maxConcurrency: number
  readonly callBudget: number
  readonly decisionPolicy: AutoDecisionPolicy
}

export interface PublicReviewAssistantConfig {
  readonly enabled: boolean
  readonly configured: boolean
  readonly baseUrl: string
  readonly model: string
  readonly requestTimeoutMs: number
  readonly maxConcurrency: number
  readonly callBudget: number
  readonly decisionPolicy: AutoDecisionPolicy
}

const AUTO_TREATMENTS: readonly AutoTreatment[] = ['approve', 'block', 'manual']
const METADATA_TREATMENTS: readonly MetadataTreatment[] = [
  'approve',
  'block',
  'manual',
  'assist',
]

export function loadReviewAssistantConfig(
  environment: Record<string, string | undefined> = process.env
): ReviewAssistantRuntimeConfig {
  const apiKey = environment.REVIEW_ASSISTANT_API_KEY?.trim() || null
  const baseUrl = normalizeBaseUrl(environment.REVIEW_ASSISTANT_BASE_URL) ?? ''
  const model = environment.REVIEW_ASSISTANT_MODEL?.trim() || DEFAULT_MODEL

  return {
    // Absent credentials mean the assistant is simply off; the deterministic
    // layer continues to work exactly as it did.
    enabled: Boolean(apiKey && baseUrl),
    apiKey,
    baseUrl,
    model,
    requestTimeoutMs: clampInteger(
      environment.REVIEW_ASSISTANT_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      MIN_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS
    ),
    maxConcurrency: clampInteger(
      environment.REVIEW_ASSISTANT_CONCURRENCY,
      DEFAULT_MAX_CONCURRENCY,
      1,
      MAX_CONCURRENCY_LIMIT
    ),
    callBudget: clampInteger(
      environment.REVIEW_ASSISTANT_CALL_BUDGET,
      DEFAULT_CALL_BUDGET,
      1,
      100_000
    ),
    decisionPolicy: DEFAULT_AUTO_DECISION_POLICY,
  }
}

export function toPublicReviewAssistantConfig(
  config: ReviewAssistantRuntimeConfig
): PublicReviewAssistantConfig {
  return {
    enabled: config.enabled,
    configured: Boolean(config.apiKey && config.baseUrl),
    baseUrl: config.baseUrl,
    model: config.model,
    requestTimeoutMs: config.requestTimeoutMs,
    maxConcurrency: config.maxConcurrency,
    callBudget: config.callBudget,
    decisionPolicy: config.decisionPolicy,
  }
}

/** A disabled assistant that still carries the deterministic policy table. */
export function disabledReviewAssistantConfig(
  decisionPolicy: AutoDecisionPolicy = DEFAULT_AUTO_DECISION_POLICY
): ReviewAssistantRuntimeConfig {
  return {
    enabled: false,
    apiKey: null,
    baseUrl: '',
    model: DEFAULT_MODEL,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    callBudget: DEFAULT_CALL_BUDGET,
    decisionPolicy,
  }
}

export async function loadPersistedReviewAssistantConfig(
  repository: Pick<ReviewAssistantSettingStore, 'getSetting'>,
  environment: Record<string, string | undefined> = process.env,
  reportDiagnostic: ReviewAssistantDiagnostic = (message) => console.warn(message)
): Promise<ReviewAssistantRuntimeConfig> {
  const stored = await repository.getSetting(REVIEW_ASSISTANT_CONFIG_SETTING_KEY)
  if (stored === null) return loadReviewAssistantConfig(environment)

  try {
    const parsed: unknown = JSON.parse(stored)
    const config = parseStoredReviewAssistantConfig(parsed)
    if (config) return config
  } catch {
    // The stored JSON carries an API key, so it is never logged.
  }

  reportDiagnostic(
    'Saved review assistant settings are invalid or use an unsupported version; the assistant is disabled until they are saved again.'
  )
  return disabledReviewAssistantConfig()
}

export async function persistReviewAssistantConfig(
  repository: Pick<ReviewAssistantSettingStore, 'setSetting'>,
  config: ReviewAssistantRuntimeConfig
): Promise<void> {
  await repository.setSetting(
    REVIEW_ASSISTANT_CONFIG_SETTING_KEY,
    JSON.stringify({ version: 1, ...config })
  )
}

export function parseStoredReviewAssistantConfig(
  value: unknown
): ReviewAssistantRuntimeConfig | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record['version'] !== 1) return null

  const apiKey =
    typeof record['apiKey'] === 'string' && record['apiKey'].trim()
      ? record['apiKey'].trim()
      : null
  const baseUrl = normalizeBaseUrl(
    typeof record['baseUrl'] === 'string' ? record['baseUrl'] : undefined
  )
  if (baseUrl === null) return null

  const model =
    typeof record['model'] === 'string' && record['model'].trim()
      ? record['model'].trim()
      : DEFAULT_MODEL

  const decisionPolicy = parseDecisionPolicy(record['decisionPolicy'])
  if (!decisionPolicy) return null

  return {
    enabled: record['enabled'] === true && Boolean(apiKey && baseUrl),
    apiKey,
    baseUrl,
    model,
    requestTimeoutMs: clampInteger(
      record['requestTimeoutMs'],
      DEFAULT_REQUEST_TIMEOUT_MS,
      MIN_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS
    ),
    maxConcurrency: clampInteger(
      record['maxConcurrency'],
      DEFAULT_MAX_CONCURRENCY,
      1,
      MAX_CONCURRENCY_LIMIT
    ),
    callBudget: clampInteger(record['callBudget'], DEFAULT_CALL_BUDGET, 1, 100_000),
    decisionPolicy,
  }
}

function parseDecisionPolicy(value: unknown): AutoDecisionPolicy | null {
  if (value === undefined || value === null) return DEFAULT_AUTO_DECISION_POLICY
  if (typeof value !== 'object') return null
  const record = value as Record<string, unknown>

  const pick = <T extends string>(
    key: string,
    allowed: readonly T[],
    fallback: T
  ): T | null => {
    const raw = record[key]
    if (raw === undefined) return fallback
    return typeof raw === 'string' && (allowed as readonly string[]).includes(raw)
      ? (raw as T)
      : null
  }

  const reviewBand = pick('reviewBand', AUTO_TREATMENTS, DEFAULT_AUTO_DECISION_POLICY.reviewBand)
  const missingRating = pick('missingRating', AUTO_TREATMENTS, DEFAULT_AUTO_DECISION_POLICY.missingRating)
  const unrecognizedRating = pick('unrecognizedRating', AUTO_TREATMENTS, DEFAULT_AUTO_DECISION_POLICY.unrecognizedRating)
  const ambiguousMetadata = pick('ambiguousMetadata', METADATA_TREATMENTS, DEFAULT_AUTO_DECISION_POLICY.ambiguousMetadata)
  const unmatchedMetadata = pick('unmatchedMetadata', METADATA_TREATMENTS, DEFAULT_AUTO_DECISION_POLICY.unmatchedMetadata)

  if (
    reviewBand === null ||
    missingRating === null ||
    unrecognizedRating === null ||
    ambiguousMetadata === null ||
    unmatchedMetadata === null
  ) {
    return null
  }

  return {
    reviewBand,
    missingRating,
    unrecognizedRating,
    ambiguousMetadata,
    unmatchedMetadata,
  }
}

/** Trailing slashes and an appended `/chat/completions` are both tolerated. */
function normalizeBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) return ''
  let candidate = trimmed.replace(/\/+$/u, '')
  candidate = candidate.replace(/\/chat\/completions$/iu, '')
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  } catch {
    return null
  }
  return candidate
}

function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed =
    typeof value === 'number'
      ? value
      : Number.parseInt(typeof value === 'string' ? value : '', 10)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback
  return parsed
}
