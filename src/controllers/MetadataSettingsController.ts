import { Hono } from 'hono'
import {
  MetadataConfigValidationError,
  type MetadataConfigUpdateInput,
} from '../config/metadata'
import type { MetadataEnrichmentService } from '../services/metadata/MetadataEnrichmentService'
import {
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
>

export function createMetadataSettingsController(
  metadata: MetadataSettingsService,
  onLibraryReevaluated?: () => Promise<void> | void
) {
  const controller = new Hono()

  controller.get('/settings/metadata', (c) => {
    const result = c.req.query('test')
    return c.html(
      renderMetadataSettings(metadata.getPublicConfig(), metadata.getState(), {
        saved: c.req.query('saved') === '1',
        reevaluationStarted: c.req.query('reevaluate') === 'started',
        testResult:
          result === 'success' || result === 'failed' ? result : undefined,
      })
    )
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
    return c.redirect('/settings/metadata?reevaluate=started', 303)
  })

  return controller
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
