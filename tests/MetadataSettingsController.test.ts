import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { MetadataConfigValidationError } from '../src/config/metadata'
import { createMetadataSettingsController } from '../src/controllers/MetadataSettingsController'
import type { MetadataJobState } from '../src/types'

const state: MetadataJobState = {
  status: 'idle',
  providerHealth: 'unverified',
  providerMessage: null,
  total: 0,
  processed: 0,
  matched: 0,
  needsReview: 0,
  failed: 0,
  currentCollectionId: null,
  startedAt: null,
  completedAt: null,
  error: null,
}

function service(overrides: Record<string, unknown> = {}) {
  return {
    getState: () => state,
    getPublicConfig: () => ({
      provider: 'tmdb' as const,
      configured: true,
      language: 'en-US',
      preferredRatingRegion: 'US',
      fallbackRatingRegions: [],
      requestTimeoutMs: 10_000,
    }),
    updateConfiguration: async () => {},
    testConfiguration: async () => {},
    runPending: async () => state,
    reevaluateLibrary: async () => state,
    retryReviewLibrary: async () => state,
    reapplyCachedPolicies: async () => 0,
    ...overrides,
  }
}

function appFor(metadata: ReturnType<typeof service>): Hono {
  const app = new Hono()
  app.route('/', createMetadataSettingsController(metadata as never))
  return app
}

function validForm(secret = ''): FormData {
  const form = new FormData()
  form.set('tmdbApiKey', secret)
  form.set('language', 'zh-TW')
  form.set('preferredRatingRegion', 'TW')
  form.set('fallbackRatingRegions', 'US, GB')
  form.set('requestTimeoutMs', '5000')
  return form
}

describe('metadata settings controller', () => {
  test('GET renders editable redacted settings', async () => {
    const secret = 'server-secret-must-never-render'
    const response = await appFor(service()).request('/settings/metadata')
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('TMDB v3 API key')
    expect(html).toContain('Leave blank to keep the current key')
    expect(html).toContain('value="en-US"')
    expect(html).not.toContain(secret)
    expect(html).not.toContain('TMDB_API_KEY</code>, <code>RATING_REGION')
  })

  test('POST saves validated form values and starts pending enrichment', async () => {
    let submitted: unknown
    let runs = 0
    const metadata = service({
      async updateConfiguration(input: unknown) {
        submitted = input
      },
      async runPending() {
        runs++
        return state
      },
    })

    const response = await appFor(metadata).request('/settings/metadata', {
      method: 'POST',
      body: validForm(),
    })

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/settings/metadata?saved=1')
    expect(submitted).toEqual({
      tmdbApiKey: '',
      removeTmdbApiKey: false,
      language: 'zh-TW',
      preferredRatingRegion: 'TW',
      fallbackRatingRegions: 'US, GB',
      requestTimeoutMs: '5000',
    })
    await Promise.resolve()
    expect(runs).toBe(1)
  })

  test('validation response never reflects a submitted API key', async () => {
    const secret = 'submitted-secret-value-123456'
    const metadata = service({
      async updateConfiguration() {
        throw new MetadataConfigValidationError({
          language: 'Enter a valid language tag.',
        })
      },
    })

    const form = validForm(secret)
    form.set('removeTmdbApiKey', 'true')
    const response = await appFor(metadata).request('/settings/metadata', {
      method: 'POST',
      body: form,
    })
    const html = await response.text()

    expect(response.status).toBe(400)
    expect(html).toContain('Enter a valid language tag.')
    expect(html).not.toContain(secret)
    expect(html).toContain('name="tmdbApiKey"')
    expect(html).toContain('value=""')
    expect(html).toContain(
      'name="removeTmdbApiKey" value="true" checked'
    )
  })

  test('save failures report that the existing configuration remains active', async () => {
    const secret = 'submitted-secret-value-123456'
    let runs = 0
    const metadata = service({
      async updateConfiguration() {
        throw new Error(`repository failure containing ${secret}`)
      },
      async runPending() {
        runs++
        return state
      },
    })

    const response = await appFor(metadata).request('/settings/metadata', {
      method: 'POST',
      body: validForm(secret),
    })
    const html = await response.text()

    expect(response.status).toBe(500)
    expect(html).toContain(
      'Settings could not be saved. The existing configuration is still active.'
    )
    expect(html).not.toContain(secret)
    expect(html).not.toContain('repository failure')
    expect(runs).toBe(0)
  })

  test('HTMX connection test uses a supplied key without saving it', async () => {
    const secret = 'replacement-secret-value-123456'
    let tested: unknown
    let saves = 0
    const metadata = service({
      async testConfiguration(input: unknown) {
        tested = input
      },
      async updateConfiguration() {
        saves++
      },
    })

    const response = await appFor(metadata).request(
      '/settings/metadata/test',
      {
        method: 'POST',
        headers: { 'HX-Request': 'true' },
        body: validForm(secret),
      }
    )
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(tested).toMatchObject({ tmdbApiKey: secret })
    expect(saves).toBe(0)
    expect(html).toContain('TMDB connection succeeded')
    expect(html).not.toContain(secret)
  })

  test('connection errors return only a credential-free diagnostic', async () => {
    const secret = 'failed-secret-value-123456'
    const metadata = service({
      async testConfiguration() {
        throw new Error(`upstream URL contained ${secret}`)
      },
    })

    const response = await appFor(metadata).request(
      '/settings/metadata/test',
      {
        method: 'POST',
        headers: { 'HX-Request': 'true' },
        body: validForm(secret),
      }
    )
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('TMDB connection failed')
    expect(html).not.toContain(secret)
    expect(html).not.toContain('upstream URL')
  })

  test('starts a whole-library re-evaluation and refreshes schedules afterward', async () => {
    let reevaluations = 0
    let refreshes = 0
    const metadata = service({
      async reevaluateLibrary() {
        reevaluations++
        return state
      },
    })
    const app = new Hono()
    app.route(
      '/',
      createMetadataSettingsController(metadata as never, async () => {
        refreshes++
      })
    )

    const response = await app.request('/settings/metadata/reevaluate', {
      method: 'POST',
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(
      '/settings/metadata?maintenance=full'
    )
    expect(reevaluations).toBe(1)
    expect(refreshes).toBe(1)
  })

  test('explains that re-evaluation preserves explicit parent decisions', async () => {
    const response = await appFor(service()).request('/settings/metadata')
    const html = await response.text()

    expect(html).toContain('Apply updated rules')
    expect(html).toContain('Retry Needs Review')
    expect(html).toContain('Rebuild all metadata')
    expect(html).toContain('Explicit Parent approve and Parent block choices are never replaced')
    expect(html).toContain('Manual TMDB identities remain locked')
  })

  test('offers cached-policy and targeted review maintenance independently', async () => {
    const calls: string[] = []
    const metadata = service({
      async reapplyCachedPolicies() {
        calls.push('policy')
        return 2
      },
      async retryReviewLibrary() {
        calls.push('review')
        return state
      },
    })
    const app = appFor(metadata)

    const policy = await app.request('/settings/metadata/reapply-policy', {
      method: 'POST',
    })
    await Promise.resolve()
    const review = await app.request('/settings/metadata/retry-review', {
      method: 'POST',
    })
    await Promise.resolve()

    expect(policy.headers.get('location')).toBe(
      '/settings/metadata?maintenance=policy'
    )
    expect(review.headers.get('location')).toBe(
      '/settings/metadata?maintenance=review'
    )
    expect(calls).toEqual(['policy', 'review'])
  })
})
