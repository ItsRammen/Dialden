import type {
  MetadataConfigField,
  PublicMetadataConfig,
} from '../config/metadata'
import type { MetadataJobState } from '../types'
import { renderLayout } from './layout'
import { escapeHtml } from './utils'

export interface MetadataSettingsDraft {
  readonly removeTmdbApiKey?: boolean
  readonly language?: string
  readonly preferredRatingRegion?: string
  readonly fallbackRatingRegions?: string
  readonly requestTimeoutMs?: string
}

export interface MetadataSettingsRenderOptions {
  readonly saved?: boolean
  readonly testResult?: 'success' | 'failed'
  readonly reevaluationStarted?: boolean
  readonly reevaluationUnavailable?: boolean
  readonly errors?: Partial<Record<MetadataConfigField, string>>
  /** Non-secret values may be redisplayed after validation. */
  readonly draft?: MetadataSettingsDraft
}

export function renderMetadataSettings(
  config: PublicMetadataConfig,
  state: MetadataJobState,
  options: MetadataSettingsRenderOptions = {}
): string {
  const errors = options.errors ?? {}
  const language = options.draft?.language ?? config.language
  const preferredRegion =
    options.draft?.preferredRatingRegion ?? config.preferredRatingRegion
  const fallbackRegions =
    options.draft?.fallbackRatingRegions ??
    config.fallbackRatingRegions.join(', ')
  const requestTimeout =
    options.draft?.requestTimeoutMs ?? String(config.requestTimeoutMs)
  const health = metadataHealth(config, state)

  return renderLayout(
    'Metadata settings',
    `<div class="settings metadata-settings">
      <a class="settings-back-link" href="/settings">← Settings</a>

      <header class="metadata-settings-header">
        <div>
          <p class="metadata-eyebrow">Library enrichment</p>
          <h1>Metadata provider</h1>
          <p class="metadata-lede">Connect TMDB once, then ToastTV can match shows and movies and resolve regional content ratings in the background.</p>
        </div>
        <div class="metadata-provider-mark" aria-label="The Movie Database">
          <img src="/tmdb-logo.svg" width="92" height="66" alt="TMDB">
        </div>
      </header>

      ${renderPageAlert(options)}

      <section class="metadata-status-panel" aria-label="Metadata provider status">
        <div>
          <span class="metadata-status-dot metadata-status-${health.tone}" aria-hidden="true"></span>
          <div>
            <strong>${escapeHtml(health.label)}</strong>
            <span>${escapeHtml(health.detail)}</span>
          </div>
        </div>
        <dl>
          <div><dt>Background job</dt><dd>${escapeHtml(formatJobStatus(state.status))}</dd></div>
          <div><dt>Processed</dt><dd>${state.processed.toLocaleString('en-US')}</dd></div>
          <div><dt>Needs review</dt><dd>${state.needsReview.toLocaleString('en-US')}</dd></div>
        </dl>
      </section>

      <form id="metadata-settings-form" method="post" action="/settings/metadata" class="metadata-settings-form">
        <section class="settings-card metadata-settings-card">
          <div class="card-header metadata-card-heading">
            <div>
              <p class="metadata-step">Connection</p>
              <h2>TMDB credentials</h2>
            </div>
            <span class="metadata-key-state ${config.configured ? 'configured' : 'missing'}">${config.configured ? 'Key configured' : 'Key required'}</span>
          </div>

          <div class="form-group ${errors.tmdbApiKey ? 'has-error' : ''}">
            <label for="tmdbApiKey">TMDB v3 API key</label>
            <input type="password"
                   id="tmdbApiKey"
                   name="tmdbApiKey"
                   value=""
                   minlength="16"
                   maxlength="256"
                   autocomplete="new-password"
                   spellcheck="false"
                   placeholder="${config.configured ? 'Leave blank to keep the current key' : 'Paste your TMDB v3 API key'}"
                   ${errors.tmdbApiKey ? 'aria-invalid="true" aria-describedby="tmdbApiKey-error"' : ''}>
            <span class="hint">The key is stored server-side in ToastTV appdata. It is never sent back to this page or to TV clients.</span>
            ${renderFieldError('tmdbApiKey', errors.tmdbApiKey)}
          </div>

          ${
            config.configured
              ? `<label class="metadata-remove-key">
                  <input type="checkbox" name="removeTmdbApiKey" value="true" ${options.draft?.removeTmdbApiKey ? 'checked' : ''}>
                  <span>Remove the current API key</span>
                </label>`
              : ''
          }
        </section>

        <section class="settings-card metadata-settings-card">
          <div class="card-header metadata-card-heading">
            <div>
              <p class="metadata-step">Matching</p>
              <h2>Locale and ratings</h2>
            </div>
          </div>

          <div class="metadata-form-grid">
            <div class="form-group ${errors.language ? 'has-error' : ''}">
              <label for="metadataLanguage">Metadata language</label>
              <input type="text"
                     id="metadataLanguage"
                     name="language"
                     value="${escapeHtml(language)}"
                     maxlength="64"
                     required
                     placeholder="en-US"
                     ${errors.language ? 'aria-invalid="true" aria-describedby="language-error"' : ''}>
              <span class="hint">A language tag such as <code>en-US</code> or <code>zh-TW</code>.</span>
              ${renderFieldError('language', errors.language)}
            </div>

            <div class="form-group ${errors.preferredRatingRegion ? 'has-error' : ''}">
              <label for="preferredRatingRegion">Primary rating region</label>
              <input type="text"
                     id="preferredRatingRegion"
                     name="preferredRatingRegion"
                     value="${escapeHtml(preferredRegion)}"
                     minlength="2"
                     maxlength="2"
                     pattern="[A-Za-z]{2}"
                     required
                     autocapitalize="characters"
                     placeholder="US"
                     ${errors.preferredRatingRegion ? 'aria-invalid="true" aria-describedby="preferredRatingRegion-error"' : ''}>
              <span class="hint">ToastTV tries this two-letter country code first.</span>
              ${renderFieldError(
                'preferredRatingRegion',
                errors.preferredRatingRegion
              )}
            </div>
          </div>

          <div class="form-group ${errors.fallbackRatingRegions ? 'has-error' : ''}">
            <label for="fallbackRatingRegions">Fallback rating regions</label>
            <input type="text"
                   id="fallbackRatingRegions"
                   name="fallbackRatingRegions"
                   value="${escapeHtml(fallbackRegions)}"
                   placeholder="US, GB"
                   ${errors.fallbackRatingRegions ? 'aria-invalid="true" aria-describedby="fallbackRatingRegions-error"' : ''}>
            <span class="hint">Optional comma-separated country codes, checked from left to right when the primary region has no rating.</span>
            ${renderFieldError(
              'fallbackRatingRegions',
              errors.fallbackRatingRegions
            )}
          </div>

          <details class="metadata-advanced" ${errors.requestTimeoutMs ? 'open' : ''}>
            <summary>Advanced connection settings</summary>
            <div class="form-group ${errors.requestTimeoutMs ? 'has-error' : ''}">
              <label for="requestTimeoutMs">Request timeout (milliseconds)</label>
              <input type="number"
                     id="requestTimeoutMs"
                     name="requestTimeoutMs"
                     value="${escapeHtml(requestTimeout)}"
                     min="100"
                     max="60000"
                     step="100"
                     required
                     ${errors.requestTimeoutMs ? 'aria-invalid="true" aria-describedby="requestTimeoutMs-error"' : ''}>
              <span class="hint">Default: 10000. Increase this only for a slow provider connection.</span>
              ${renderFieldError('requestTimeoutMs', errors.requestTimeoutMs)}
            </div>
          </details>
        </section>

        <div id="metadata-test-result" class="metadata-test-result" aria-live="polite"></div>

        <div class="metadata-form-actions">
          <button class="btn btn-primary" type="submit">Save settings</button>
          <button class="btn btn-secondary"
                  type="submit"
                  formaction="/settings/metadata/test"
                  hx-post="/settings/metadata/test"
                  hx-include="#metadata-settings-form"
                  hx-target="#metadata-test-result"
                  hx-swap="innerHTML"
                  hx-disabled-elt="this">
            Test connection
          </button>
        </div>
      </form>

      <section class="settings-card metadata-settings-card metadata-maintenance">
        <div class="card-header metadata-card-heading">
          <div>
            <p class="metadata-step">Library maintenance</p>
            <h2>Re-evaluate matches and policy</h2>
          </div>
        </div>
        <p>Search automatic TMDB matches again, refresh genres, networks, studios, episode details, and ratings, then recalculate the Kids 7 policy and channel categories.</p>
        <p class="hint"><strong>Parent approve and Parent block choices are preserved.</strong> Manually confirmed TMDB identities stay locked and are refreshed without choosing a different title.</p>
        <form method="post" action="/settings/metadata/reevaluate" onsubmit="return confirm('Re-evaluate metadata and automatic policy decisions for the whole library? This may make many TMDB requests.');">
          <button class="btn btn-secondary" type="submit" ${config.configured ? '' : 'disabled'}>Re-evaluate entire library</button>
        </form>
      </section>

      <aside class="metadata-settings-note">
        <strong>About existing environment values</strong>
        <p><code>TMDB_API_KEY</code>, language, region, and timeout environment values are used only as bootstrap defaults until this page is saved. Saved appdata settings take precedence on later starts.</p>
      </aside>

      <p class="metadata-attribution">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
    </div>`
  )
}

export function renderMetadataTestResult(
  result: 'success' | 'failed' | 'invalid',
  message?: string
): string {
  const tone = result === 'success' ? 'success' : 'warning'
  const fallback =
    result === 'success'
      ? 'TMDB connection succeeded. Save settings to keep any changes.'
      : result === 'invalid'
        ? 'Correct the highlighted settings before testing.'
        : 'TMDB connection failed. Check the key and server network access.'
  return `<div class="metadata-inline-alert ${tone}" role="status">${escapeHtml(message ?? fallback)}</div>`
}

function renderPageAlert(options: MetadataSettingsRenderOptions): string {
  const messages: string[] = []
  if (options.saved) messages.push('Metadata settings saved in appdata.')
  if (options.reevaluationStarted) {
    messages.push('Library re-evaluation started. Progress appears on the dashboard and library pages.')
  }
  if (options.reevaluationUnavailable) {
    messages.push('Configure a TMDB API key before re-evaluating the library.')
  }
  if (options.testResult === 'success') messages.push('TMDB connection succeeded.')
  if (options.testResult === 'failed') {
    messages.push('TMDB connection failed. Check the key and server network access.')
  }
  if (Object.keys(options.errors ?? {}).length > 0) {
    messages.push('Some settings need attention. The API key was not redisplayed.')
  }
  if (messages.length === 0) return ''
  const tone =
    options.testResult === 'failed' ||
    options.reevaluationUnavailable ||
    Object.keys(options.errors ?? {}).length > 0
      ? 'warning'
      : 'success'
  return `<div class="metadata-page-alert ${tone}" role="status">${messages.map(escapeHtml).join(' ')}</div>`
}

function renderFieldError(
  field: MetadataConfigField,
  message: string | undefined
): string {
  return message
    ? `<span class="field-error" id="${field}-error">${escapeHtml(message)}</span>`
    : ''
}

function metadataHealth(
  config: PublicMetadataConfig,
  state: MetadataJobState
): { tone: 'good' | 'warning' | 'idle'; label: string; detail: string } {
  if (!config.configured) {
    return {
      tone: 'warning',
      label: 'Not configured',
      detail: 'Add a TMDB API key to enable automatic matching.',
    }
  }
  if (state.providerHealth === 'connected') {
    return {
      tone: 'good',
      label: 'Connected',
      detail: 'The latest TMDB provider check succeeded.',
    }
  }
  if (state.providerHealth === 'degraded' || state.status === 'failed') {
    return {
      tone: 'warning',
      label: 'Connection needs attention',
      detail:
        state.providerMessage ??
        'The latest metadata request failed. Test the connection below.',
    }
  }
  return {
    tone: 'idle',
    label: 'Configured, not yet verified',
    detail: 'Test the connection to verify the saved key and network access.',
  }
}

function formatJobStatus(status: MetadataJobState['status']): string {
  return status.replaceAll('_', ' ')
}
