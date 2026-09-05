import { Hono } from 'hono'
import {
  MetadataConfigValidationError,
  type MetadataConfigUpdateInput,
} from '../config/metadata'
import type { MetadataEnrichmentService } from '../services/metadata/MetadataEnrichmentService'
import {
  loadPersistedReviewAssistantConfig,
  persistReviewAssistantConfig,
  toPublicReviewAssistantConfig,
  type PublicReviewAssistantConfig,
  type ReviewAssistantSettingStore,
} from '../config/reviewAssistant'
import { OpenAiCompatibleReviewAssistant } from '../services/review/OpenAiCompatibleReviewAssistant'
import type { AutoDecisionPolicy } from '../services/review/autoDecision'
import { MetadataProviderError } from '../metadata/types'
import {
  renderAssistantTestResult,
  renderMetadataSettings,
  renderMetadataTestResult,
  type MetadataSettingsDraft,
} from '../templates/metadataSettings'

type MetadataSettingsService = Pick<
  MetadataEnrichmentService,
  | 'getState'
  | 'getPublicConfig'
  | 'updateConfiguration'
  | 'testConfiguration'
  | 'runPending'
  | 'reevaluateLibrary'
  | 'retryReviewLibrary'
  | 'reapplyCachedPolicies'
>

export function createMetadataSettingsController(
  metadata: MetadataSettingsService,
  onLibraryReevaluated?: () => Promise<void> | void,
  /** Absent in tests and any deployment without the assistant module. */
  assistantStore?: ReviewAssistantSettingStore
) {
  const controller = new Hono()

  const assistantConfig = async (): Promise<
    PublicReviewAssistantConfig | undefined
  > => {
    if (!assistantStore) return undefined
    return toPublicReviewAssistantConfig(
      await loadPersistedReviewAssistantConfig(assistantStore)
    )
  }

  controller.get('/settings/metadata', async (c) => {
    const result = c.req.query('test')
    const assistantTest = c.req.query('assistantTest')
    return c.html(
      renderMetadataSettings(metadata.getPublicConfig(), metadata.getState(), {
        saved: c.req.query('saved') === '1',
        maintenanceStarted: maintenanceQuery(c.req.query('maintenance')),
        testResult:
          result === 'success' || result === 'failed' ? result : undefined,
        assistant: await assistantConfig(),
        assistantSaved: c.req.query('assistantSaved') === '1',
        ...(assistantTest === 'success' || assistantTest === 'failed'
          ? { assistantTestResult: assistantTest }
          : {}),
        ...(c.req.query('assistantMessage')
          ? { assistantTestMessage: c.req.query('assistantMessage') as string }
          : {}),
      })
    )
  })

  /* An empty key field keeps whatever is stored, matching how the TMDB key
     above behaves, so saving the decision table never disturbs credentials. */
  controller.post('/settings/metadata/assistant', async (c) => {
    if (!assistantStore) return c.redirect('/settings/metadata', 303)
    const body = await c.req.parseBody()
    const current = await loadPersistedReviewAssistantConfig(assistantStore)

    const submittedKey = readText(body['apiKey'])
    const removeKey = body['removeApiKey'] === 'true'
    const apiKey = removeKey ? null : submittedKey || current.apiKey

    const baseUrl = normalizeBaseUrl(readText(body['baseUrl']) || current.baseUrl)
    if (baseUrl === null) {
      return c.redirect(
        '/settings/metadata?assistantTest=failed&assistantMessage=' +
          encodeURIComponent('The provider endpoint must be a valid http or https URL.'),
        303
      )
    }

    const model = readText(body['model']) || current.model
    const decisionPolicy = readPolicy(body, current.decisionPolicy)

    await persistReviewAssistantConfig(assistantStore, {
      ...current,
      apiKey,
      baseUrl,
      model,
      decisionPolicy,
      enabled: body['enabled'] === 'true' && Boolean(apiKey && baseUrl),
    })
    return c.redirect('/settings/metadata?assistantSaved=1', 303)
  })

  /* Answers with a fragment rather than a redirect: a connection check whose
     only output is a page reload tells you nothing. */
  controller.post('/settings/metadata/assistant/test', async (c) => {
    if (!assistantStore) {
      return c.html(renderAssistantTestResult('failed', 'The assistant is not available.'))
    }
    const config = await loadPersistedReviewAssistantConfig(assistantStore)
    const assistant = new OpenAiCompatibleReviewAssistant({
      ...config,
      // Test what is stored even when it has not been switched on yet.
      enabled: Boolean(config.apiKey && config.baseUrl),
    })
    if (!assistant.configured) {
      return c.html(
        renderAssistantTestResult(
          'failed',
          'Add an endpoint and API key, save, then test.'
        )
      )
    }
    try {
      await assistant.testConnection()
      return c.html(
        renderAssistantTestResult('success', `${config.model} answered.`)
      )
    } catch (error) {
      return c.html(
        renderAssistantTestResult(
          'failed',
          error instanceof MetadataProviderError
            ? `${error.message} (${error.code})`
            : 'The provider could not be reached.'
        )
      )
    }
  })

  controller.post('/settings/metadata', async (c) => {
    const body = await c.req.parseBody()
    const input = metadataInput(body)
    try {
      await metadata.updateConfiguration(input)
      // Previously-unconfigured and recoverable-error rows are already part of
      // the pending queue. Start it after applying the live provider without
      // making the settings request wait on the whole library.
      void metadata.runPending().catch(() => {})
      return c.redirect('/settings/metadata?saved=1', 303)
    } catch (error) {
      if (error instanceof MetadataConfigValidationError) {
        return c.html(
          renderMetadataSettings(metadata.getPublicConfig(), metadata.getState(), {
            errors: error.fieldErrors,
            draft: metadataDraft(body),
          }),
          400
        )
      }
      return c.html(
        renderMetadataSettings(metadata.getPublicConfig(), metadata.getState(), {
          errors: {
            tmdbApiKey:
              'Settings could not be saved. The existing configuration is still active.',
          },
          draft: metadataDraft(body),
        }),
        500
      )
    }
  })

  controller.post('/settings/metadata/test', async (c) => {
    const body = await c.req.parseBody()
    const input = metadataInput(body)
    const isHtmx = c.req.header('HX-Request')?.toLowerCase() === 'true'

    try {
      // Test a supplied replacement key without persisting or swapping the
      // active provider. A blank field intentionally exercises the current key.
      await metadata.testConfiguration(input)
      if (isHtmx) return c.html(renderMetadataTestResult('success'))
      return c.html(
        renderMetadataSettings(metadata.getPublicConfig(), metadata.getState(), {
          testResult: 'success',
          draft: metadataDraft(body),
        })
      )
    } catch (error) {
      if (error instanceof MetadataConfigValidationError) {
        if (isHtmx) {
          return c.html(
            renderMetadataTestResult(
              'invalid',
              Object.values(error.fieldErrors).filter(Boolean).join(' ')
            )
          )
        }
        return c.html(
          renderMetadataSettings(metadata.getPublicConfig(), metadata.getState(), {
            errors: error.fieldErrors,
            draft: metadataDraft(body),
          }),
          400
        )
      }

      // Provider/client errors are intentionally collapsed to a credential-free
      // message. Typed provider health details never contain request URLs either.
      if (isHtmx) return c.html(renderMetadataTestResult('failed'))
      return c.html(
        renderMetadataSettings(metadata.getPublicConfig(), metadata.getState(), {
          testResult: 'failed',
          draft: metadataDraft(body),
        }),
        502
      )
    }
  })

  controller.post('/settings/metadata/reevaluate', (c) => {
    if (!metadata.getPublicConfig().configured) {
      return c.html(
        renderMetadataSettings(metadata.getPublicConfig(), metadata.getState(), {
          reevaluationUnavailable: true,
        }),
        409
      )
    }
    void metadata
      .reevaluateLibrary()
      .then(() => onLibraryReevaluated?.())
      .catch(() => {})
    return c.redirect('/settings/metadata?maintenance=full', 303)
  })

  controller.post('/settings/metadata/retry-review', (c) => {
    if (!metadata.getPublicConfig().configured) {
      return c.html(
        renderMetadataSettings(metadata.getPublicConfig(), metadata.getState(), {
          reevaluationUnavailable: true,
        }),
        409
      )
    }
    void metadata
      .retryReviewLibrary()
      .then(() => onLibraryReevaluated?.())
      .catch(() => {})
    return c.redirect('/settings/metadata?maintenance=review', 303)
  })

  controller.post('/settings/metadata/reapply-policy', (c) => {
    void metadata
      .reapplyCachedPolicies()
      .then(() => onLibraryReevaluated?.())
      .catch(() => {})
    return c.redirect('/settings/metadata?maintenance=policy', 303)
  })

  return controller
}

function maintenanceQuery(
  value: string | undefined
): 'policy' | 'review' | 'full' | undefined {
  return value === 'policy' || value === 'review' || value === 'full'
    ? value
    : undefined
}

function metadataInput(
  body: Record<string, string | File | (string | File)[]>
): MetadataConfigUpdateInput {
  return {
    tmdbApiKey: textField(body, 'tmdbApiKey'),
    removeTmdbApiKey: textField(body, 'removeTmdbApiKey') === 'true',
    language: textField(body, 'language'),
    preferredRatingRegion: textField(body, 'preferredRatingRegion'),
    fallbackRatingRegions: textField(body, 'fallbackRatingRegions'),
    requestTimeoutMs: textField(body, 'requestTimeoutMs'),
  }
}

/** Deliberately excludes the API key so it can never be reflected into HTML. */
function metadataDraft(
  body: Record<string, string | File | (string | File)[]>
): MetadataSettingsDraft {
  return {
    removeTmdbApiKey: textField(body, 'removeTmdbApiKey') === 'true',
    language: textField(body, 'language'),
    preferredRatingRegion: textField(body, 'preferredRatingRegion'),
    fallbackRatingRegions: textField(body, 'fallbackRatingRegions'),
    requestTimeoutMs: textField(body, 'requestTimeoutMs'),
  }
}

function textField(
  body: Record<string, string | File | (string | File)[]>,
  field: string
): string | undefined {
  const value = body[field]
  return typeof value === 'string' ? value : undefined
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeBaseUrl(value: string): string | null {
  const candidate = value.trim().replace(/\/+$/u, '').replace(/\/chat\/completions$/iu, '')
  if (!candidate) return ''
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  } catch {
    return null
  }
  return candidate
}

/** Unknown values keep the stored treatment rather than silently loosening it. */
function readPolicy(
  body: Record<string, unknown>,
  current: AutoDecisionPolicy
): AutoDecisionPolicy {
  const plain = ['approve', 'block', 'manual']
  const withAssist = [...plain, 'assist']
  const pick = <T extends string>(key: string, allowed: string[], fallback: T): T => {
    const raw = readText(body[key])
    return allowed.includes(raw) ? (raw as T) : fallback
  }
  return {
    reviewBand: pick('reviewBand', plain, current.reviewBand),
    missingRating: pick('missingRating', plain, current.missingRating),
    unrecognizedRating: pick('unrecognizedRating', plain, current.unrecognizedRating),
    ambiguousMetadata: pick('ambiguousMetadata', withAssist, current.ambiguousMetadata),
    unmatchedMetadata: pick('unmatchedMetadata', withAssist, current.unmatchedMetadata),
  }
}
