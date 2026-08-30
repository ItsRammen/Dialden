import { Hono } from 'hono'
import {
  loadPersistedReviewAssistantConfig,
  persistReviewAssistantConfig,
  toPublicReviewAssistantConfig,
  type ReviewAssistantRuntimeConfig,
  type ReviewAssistantSettingStore,
} from '../config/reviewAssistant'
import { OpenAiCompatibleReviewAssistant } from '../services/review/OpenAiCompatibleReviewAssistant'
import type { AutoDecisionPolicy } from '../services/review/autoDecision'
import { MetadataProviderError } from '../metadata/types'

/**
 * Settings and connection checking for the review assistant.
 *
 * The API key is write-only over HTTP: it can be set and cleared, and it is
 * never read back, so an administration page can display the configuration
 * without ever putting the secret on the wire.
 */
export interface ReviewAssistantControllerDeps {
  readonly store: ReviewAssistantSettingStore
}

const TREATMENTS = new Set(['approve', 'block', 'manual'])
const METADATA_TREATMENTS = new Set(['approve', 'block', 'manual', 'assist'])

export function createReviewAssistantController(
  deps: ReviewAssistantControllerDeps
): Hono {
  const controller = new Hono()

  controller.get('/api/admin/v1/review-assistant', async (c) => {
    const config = await loadPersistedReviewAssistantConfig(deps.store)
    return c.json({ config: toPublicReviewAssistantConfig(config) })
  })

  controller.post('/api/admin/v1/review-assistant', async (c) => {
    const current = await loadPersistedReviewAssistantConfig(deps.store)
    const body = await readJson(c)
    if (!body) return c.json({ error: 'Body must be a JSON object' }, 400)

    const next = applyUpdate(current, body)
    if (typeof next === 'string') return c.json({ error: next }, 400)

    await persistReviewAssistantConfig(deps.store, next)
    return c.json({ config: toPublicReviewAssistantConfig(next) })
  })

  controller.post('/api/admin/v1/review-assistant/test', async (c) => {
    const config = await loadPersistedReviewAssistantConfig(deps.store)
    /* Test what is stored even when the assistant has not been switched on:
       checking credentials before enabling them is the normal order. */
    const assistant = new OpenAiCompatibleReviewAssistant({
      ...config,
      enabled: Boolean(config.apiKey && config.baseUrl),
    })
    if (!assistant.configured) {
      return c.json({ ok: false, error: 'Review assistant is not configured' }, 400)
    }
    try {
      await assistant.testConnection()
      return c.json({ ok: true, model: config.model })
    } catch (error) {
      const failure =
        error instanceof MetadataProviderError
          ? { code: error.code, retryable: error.retryable, message: error.message }
          : { code: 'network', retryable: true, message: 'Assistant request failed' }
      return c.json({ ok: false, ...failure }, 502)
    }
  })

  return controller
}

/**
 * Applies a partial update. An absent key leaves the stored one alone, which is
 * what lets the settings page save without ever holding the secret; an explicit
 * null clears it.
 */
function applyUpdate(
  current: ReviewAssistantRuntimeConfig,
  body: Record<string, unknown>
): ReviewAssistantRuntimeConfig | string {
  let apiKey = current.apiKey
  if ('apiKey' in body) {
    const raw = body['apiKey']
    if (raw === null) apiKey = null
    else if (typeof raw === 'string') apiKey = raw.trim() || null
    else return 'apiKey must be a string or null'
  }

  let baseUrl = current.baseUrl
  if ('baseUrl' in body) {
    const raw = body['baseUrl']
    if (typeof raw !== 'string') return 'baseUrl must be a string'
    const normalized = raw.trim().replace(/\/+$/u, '').replace(/\/chat\/completions$/iu, '')
    if (normalized) {
      try {
        const url = new URL(normalized)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          return 'baseUrl must be an http or https URL'
        }
      } catch {
        return 'baseUrl must be a valid URL'
      }
    }
    baseUrl = normalized
  }

  let model = current.model
  if ('model' in body) {
    const raw = body['model']
    if (typeof raw !== 'string' || !raw.trim()) return 'model must be a non-empty string'
    model = raw.trim()
  }

  let decisionPolicy = current.decisionPolicy
  if ('decisionPolicy' in body) {
    const parsed = parsePolicy(body['decisionPolicy'], current.decisionPolicy)
    if (typeof parsed === 'string') return parsed
    decisionPolicy = parsed
  }

  const enabled =
    'enabled' in body ? body['enabled'] === true : current.enabled

  return {
    ...current,
    apiKey,
    baseUrl,
    model,
    decisionPolicy,
    // Credentials are what make it usable; asking for it without them is a
    // configuration error waiting to happen, so it simply stays off.
    enabled: enabled && Boolean(apiKey && baseUrl),
  }
}

function parsePolicy(
  value: unknown,
  current: AutoDecisionPolicy
): AutoDecisionPolicy | string {
  if (typeof value !== 'object' || value === null) {
    return 'decisionPolicy must be an object'
  }
  const record = value as Record<string, unknown>
  const next = { ...current }

  for (const key of ['reviewBand', 'missingRating', 'unrecognizedRating'] as const) {
    if (!(key in record)) continue
    const raw = record[key]
    if (typeof raw !== 'string' || !TREATMENTS.has(raw)) {
      return `${key} must be approve, block or manual`
    }
    next[key] = raw as AutoDecisionPolicy['reviewBand']
  }

  for (const key of ['ambiguousMetadata', 'unmatchedMetadata'] as const) {
    if (!(key in record)) continue
    const raw = record[key]
    if (typeof raw !== 'string' || !METADATA_TREATMENTS.has(raw)) {
      return `${key} must be approve, block, manual or assist`
    }
    next[key] = raw as AutoDecisionPolicy['ambiguousMetadata']
  }

  return next
}

async function readJson(c: {
  req: { json(): Promise<unknown> }
}): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await c.req.json()
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
