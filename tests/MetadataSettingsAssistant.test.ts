import { describe, expect, test } from 'bun:test'
import { renderMetadataSettings } from '../src/templates/metadataSettings'
import { toPublicReviewAssistantConfig, loadReviewAssistantConfig } from '../src/config/reviewAssistant'
import type { MetadataJobState } from '../src/types'
import type { PublicMetadataConfig } from '../src/config/metadata'

const metadataConfig: PublicMetadataConfig = {
  provider: 'tmdb',
  configured: true,
  language: 'en-US',
  preferredRatingRegion: 'US',
  fallbackRatingRegions: ['GB'],
  requestTimeoutMs: 10_000,
}

const state: MetadataJobState = {
  status: 'completed',
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

const configured = toPublicReviewAssistantConfig(
  loadReviewAssistantConfig({
    REVIEW_ASSISTANT_API_KEY: 'super-secret-key',
    REVIEW_ASSISTANT_BASE_URL: 'https://openrouter.ai/api/v1',
    REVIEW_ASSISTANT_MODEL: 'openai/gpt-4o-mini',
  })
)

describe('review assistant card on the metadata settings page', () => {
  test('is absent entirely when the module is not wired', () => {
    // A deployment without the assistant should show no trace of it.
    const html = renderMetadataSettings(metadataConfig, state)

    expect(html).not.toContain('Review assistant')
    expect(html).not.toContain('/settings/metadata/assistant')
  })

  test('never renders the API key, even when one is configured', () => {
    // The key is write-only. This is the assertion that keeps it that way.
    const html = renderMetadataSettings(metadataConfig, state, { assistant: configured })

    expect(html).toContain('Review assistant')
    expect(html).not.toContain('super-secret-key')
  })

  test('offers to keep the stored key rather than demanding it again', () => {
    const html = renderMetadataSettings(metadataConfig, state, { assistant: configured })

    expect(html).toContain('Leave blank to keep the current key')
    expect(html).toContain('name="removeApiKey"')
  })

  test('shows the endpoint and model so the page is readable without the secret', () => {
    const html = renderMetadataSettings(metadataConfig, state, { assistant: configured })

    expect(html).toContain('https://openrouter.ai/api/v1')
    expect(html).toContain('openai/gpt-4o-mini')
  })

  test('reports configured-but-off distinctly from not configured', () => {
    const off = renderMetadataSettings(metadataConfig, state, {
      assistant: { ...configured, enabled: false },
    })
    const absent = renderMetadataSettings(metadataConfig, state, {
      assistant: { ...configured, enabled: false, configured: false },
    })

    expect(off).toContain('Configured, off')
    expect(absent).toContain('Not configured')
  })

  test('exposes every outstanding case as its own choice', () => {
    const html = renderMetadataSettings(metadataConfig, state, { assistant: configured })

    for (const field of [
      'reviewBand',
      'missingRating',
      'unrecognizedRating',
      'ambiguousMetadata',
      'unmatchedMetadata',
    ]) {
      expect(html).toContain(`name="${field}"`)
    }
  })

  test('offers the assistant only where it can actually help', () => {
    // Asking a model about a certification band is pointless; asking it to
    // choose between candidates is the whole reason it exists.
    const html = renderMetadataSettings(metadataConfig, state, { assistant: configured })
    const section = (name: string): string => {
      const start = html.indexOf(`name="${name}"`)
      return html.slice(start, html.indexOf('</select>', start))
    }

    expect(section('ambiguousMetadata')).toContain('assist')
    expect(section('unmatchedMetadata')).toContain('assist')
    expect(section('reviewBand')).not.toContain('"assist"')
    expect(section('missingRating')).not.toContain('"assist"')
  })

  test('says plainly what leaves the network', () => {
    const html = renderMetadataSettings(metadataConfig, state, { assistant: configured })

    expect(html).toContain('file paths never are')
  })

  test('surfaces a failed connection test with the provider’s reason', () => {
    const html = renderMetadataSettings(metadataConfig, state, {
      assistant: configured,
      assistantTestResult: 'failed',
      assistantTestMessage: 'Assistant rejected the API key (unauthorized)',
    })

    expect(html).toContain('unauthorized')
  })
})

describe('metadata settings tabs', () => {
  test('separates the provider from the assistant', () => {
    const html = renderMetadataSettings(metadataConfig, state, { assistant: configured })

    expect(html).toContain('data-tab="provider"')
    expect(html).toContain('data-tab="assistant"')
    expect(html).toContain('data-tab="maintenance"')
  })

  test('offers no assistant tab where there is no assistant', () => {
    const html = renderMetadataSettings(metadataConfig, state)

    expect(html).toContain('data-tab="provider"')
    expect(html).not.toContain('data-tab="assistant"')
  })

  test('each tab controls exactly one panel', () => {
    const html = renderMetadataSettings(metadataConfig, state, { assistant: configured })

    for (const id of ['provider', 'assistant', 'maintenance']) {
      expect(html).toContain(`aria-controls="tabpanel-${id}"`)
      expect(html).toContain(`id="tabpanel-${id}"`)
    }
  })

  test('opens on the provider tab', () => {
    const html = renderMetadataSettings(metadataConfig, state, { assistant: configured })

    expect(html).toContain('class="settings-tabpanel is-active" id="tabpanel-provider"')
    expect(html).toContain('class="settings-tabpanel" id="tabpanel-assistant"')
  })

  test('returns to the assistant tab after saving it', () => {
    // The save redirects; landing back on TMDB would lose the operator's place.
    const html = renderMetadataSettings(metadataConfig, state, {
      assistant: configured,
      assistantSaved: true,
    })

    expect(html).toContain('class="settings-tabpanel is-active" id="tabpanel-assistant"')
    expect(html).toContain('class="settings-tabpanel" id="tabpanel-provider"')
  })

  test('serves every panel visible so a scripting failure is not a dead page', () => {
    // The script hides the inactive panels on load. If the server hid them,
    // a client without working JS would lose two thirds of this page.
    const html = renderMetadataSettings(metadataConfig, state, { assistant: configured })

    expect(html).not.toContain('role="tabpanel" aria-labelledby="tab-assistant" hidden')
    expect(html).not.toContain('hidden>')
    expect(html).toContain('TMDB v3 API key')
    expect(html).toContain('Review assistant')
    expect(html).toContain('Re-evaluate library decisions')
  })
})

describe('assistant connection test', () => {
  test('reports inline rather than reloading the page', () => {
    const html = renderMetadataSettings(metadataConfig, state, { assistant: configured })

    expect(html).toContain('id="assistant-test-result"')
    expect(html).toContain('hx-post="/settings/metadata/assistant/test"')
    expect(html).toContain('hx-target="#assistant-test-result"')
  })

  test('uses the same buttons as the rest of the page', () => {
    // `button--primary` and `button-row` have no styles anywhere in the CSS.
    const html = renderMetadataSettings(metadataConfig, state, { assistant: configured })

    expect(html).not.toContain('button--primary')
    expect(html).not.toContain('button--quiet')
    expect(html).not.toContain('class="button-row"')
  })
})
