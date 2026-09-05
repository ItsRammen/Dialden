import type {
  MetadataConfigField,
  PublicMetadataConfig,
} from '../config/metadata'
import type { MetadataJobState } from '../types'
import type { PublicReviewAssistantConfig } from '../config/reviewAssistant'
import { renderLayout, renderSettingsNavigation } from './layout'
import { escapeHtml } from './utils'

export interface MetadataSettingsDraft {
  readonly removeTmdbApiKey?: boolean
  readonly language?: string
  readonly preferredRatingRegion?: string
  readonly fallbackRatingRegions?: string
  readonly requestTimeoutMs?: string
}

export interface MetadataSettingsRenderOptions {
  /** Omitted when the assistant module is unavailable; the card is then hidden. */
  readonly assistant?: PublicReviewAssistantConfig
  readonly assistantSaved?: boolean
  readonly assistantTestResult?: 'success' | 'failed'
  readonly assistantTestMessage?: string
  readonly saved?: boolean
  readonly testResult?: 'success' | 'failed'
  readonly maintenanceStarted?: 'policy' | 'review' | 'full'
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
  /* Saving the assistant redirects back here, so land on the tab the operator
     was actually working in rather than throwing them back to TMDB. */
  const assistantTab =
    options.assistant !== undefined &&
    (options.assistantSaved === true ||
      options.assistantTestResult !== undefined)
  const tabs: { id: string; label: string }[] = [
    { id: 'provider', label: 'The Movie Database' },
    ...(options.assistant ? [{ id: 'assistant', label: 'Review assistant' }] : []),
    { id: 'maintenance', label: 'Maintenance' },
  ]
  const activeTab = options.maintenanceStarted || options.reevaluationUnavailable ? 'maintenance' : assistantTab ? 'assistant' : 'provider'
  const panel = (id: string, body: string): string =>
    `<div class="settings-tabpanel${id === activeTab ? ' is-active' : ''}" id="tabpanel-${id}" role="tabpanel" aria-labelledby="tab-${id}">${body}</div>`

  return renderLayout(
    'Metadata and review',
    `<div class="settings metadata-settings">


      <header class="metadata-settings-header">
        <div>
          <p class="metadata-eyebrow">Library enrichment</p>
          <h1>Metadata and review</h1>
          <p class="metadata-lede">Connect your metadata provider, configure automatic reviews, and maintain your library.</p>
        </div>
      </header>

      ${renderSettingsNavigation('metadata')}
      ${renderPageAlert(options)}

      <section class="metadata-status-panel" aria-label="TMDB provider status">
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

      <div class="settings-tabs" role="tablist" aria-label="Metadata settings sections">
        ${tabs
          .map(
            (tab) =>
              `<button type="button" class="settings-tab${tab.id === activeTab ? ' is-active' : ''}" id="tab-${tab.id}" role="tab" aria-controls="tabpanel-${tab.id}" aria-selected="${tab.id === activeTab}" data-tab="${tab.id}">${escapeHtml(tab.label)}</button>`
          )
          .join('')}
      </div>

      ${panel(
        'provider',
        `<form id="metadata-settings-form" method="post" action="/settings/metadata" class="metadata-settings-form">
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

      <aside class="metadata-settings-note">
        <strong>About existing environment values</strong>
        <p><code>TMDB_API_KEY</code>, language, region, and timeout environment values are used only as bootstrap defaults until this page is saved. Saved appdata settings take precedence on later starts.</p>
      </aside>`
      )}

      ${options.assistant ? panel('assistant', renderAssistantCard(options)) : ''}

      ${panel(
        'maintenance',
        `<section class="settings-card metadata-settings-card metadata-maintenance">
        <div class="card-header metadata-card-heading">
          <div>
            <p class="metadata-step">Library maintenance</p>
            <h2>Re-evaluate library decisions</h2>
          </div>
        </div>
        <p>Choose the smallest operation that fits the change. Parent approvals and blocks are always preserved.</p>
        <div class="metadata-maintenance-actions">
          <form method="post" action="/settings/metadata/reapply-policy">
            <h3>Apply updated rules</h3>
            <p>Recalculate the Kids 7 policy and station eligibility from cached metadata. No TMDB requests.</p>
            <button class="btn btn-secondary" type="submit">Apply cached rules</button>
          </form>
          <form method="post" action="/settings/metadata/retry-review" onsubmit="return confirm('Retry automatic matching and ratings only for unresolved collections?');">
            <h3>Retry Needs Review</h3>
            <p>Retry ambiguous, unmatched, unrated, and failed collections without touching parent-decided titles.</p>
            <button class="btn btn-primary" type="submit" ${config.configured ? '' : 'disabled'}>Retry review queue</button>
          </form>
          <form method="post" action="/settings/metadata/reevaluate" onsubmit="return confirm('Rebuild automatic metadata for the whole library? This may make many TMDB requests.');">
            <h3>Rebuild all metadata</h3>
            <p>Refresh every automatic match, provider field, episode record, rating, and category.</p>
            <button class="btn btn-secondary" type="submit" ${config.configured ? '' : 'disabled'}>Rebuild entire library</button>
          </form>
        </div>
        <p class="hint"><strong>Manual TMDB identities remain locked.</strong> Explicit Parent approve and Parent block choices are never replaced.</p>
      </section>`
      )}

      ${TAB_SCRIPT}

      <div class="metadata-attribution">
        <div class="metadata-provider-mark" aria-label="The Movie Database">
          <img src="/tmdb-logo.svg" width="92" height="66" alt="TMDB">
        </div>
        <p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
      </div>
    </div>`
  )
}

/**
 * Inline summary of a run. A preview and an applied run render identically
 * apart from the heading, because they are the same walk over the same queue.
 */
export function renderReviewRunReport(report: {
  dryRun: boolean
  scanned: number
  skippedParentDecided: number
  approved: number
  blocked: number
  matched: number
  leftForYou: number
  assistant: {
    available: boolean
    attempted: number
    applied: number
    declined: number
    failed: number
    budgetExhausted: boolean
  }
  samples: readonly {
    collectionId: number
    title: string
    action: string
    source: string
    detail: string
    confidence?: number
  }[]
  errors: readonly { collectionId: number; message: string }[]
}): string {
  const rows: [string, number][] = [
    ['Looked at', report.scanned],
    ['Approved', report.approved],
    ['Blocked', report.blocked],
    ['Matched by the assistant', report.matched],
    ['Left for you', report.leftForYou],
    ['Already decided by you', report.skippedParentDecided],
  ]

  const notes: string[] = []
  if (!report.assistant.available) {
    notes.push(
      'The assistant is off, so titles with more than one plausible match were left alone.'
    )
  }
  if (report.assistant.declined > 0) {
    notes.push(
      `The assistant was not confident enough on ${report.assistant.declined} of ${report.assistant.attempted}.`
    )
  }
  if (report.assistant.failed > 0) {
    notes.push(`${report.assistant.failed} provider calls failed.`)
  }
  if (report.assistant.budgetExhausted) {
    notes.push('The call budget ran out before the queue did; run again to continue.')
  }

  return `
    <div class="metadata-inline-alert ${report.dryRun ? 'info' : 'success'}" role="status">
      <strong>${report.dryRun ? 'Preview only — nothing was changed.' : 'Applied.'}</strong>
    </div>
    <dl class="review-run-summary">
      ${rows
        .map(
          ([label, value]) =>
            `<div><dt>${escapeHtml(label)}</dt><dd>${value.toLocaleString('en-US')}</dd></div>`
        )
        .join('')}
    </dl>
    ${notes.length ? `<p class="hint">${notes.map(escapeHtml).join(' ')}</p>` : ''}
    ${
      report.samples.length
        ? `<ul class="review-run-samples">${report.samples
            .slice(0, 12)
            .map(
              (sample) =>
                `<li><span class="review-run-action review-run-action--${escapeHtml(sample.action)}">${escapeHtml(sample.action)}</span> <strong>${escapeHtml(sample.title)}</strong><span>${escapeHtml(sample.detail)}</span></li>`
            )
            .join('')}</ul>`
        : ''
    }
    ${
      report.errors.length
        ? `<p class="metadata-inline-alert warning" role="status">${escapeHtml(
            `${report.errors.length} collections could not be processed: ${report.errors[0]?.message ?? ''}`
          )}</p>`
        : ''
    }
  `
}

/** Inline result for the assistant connection check, mirroring TMDB's. */
export function renderAssistantTestResult(
  result: 'success' | 'failed',
  message?: string
): string {
  const tone = result === 'success' ? 'success' : 'warning'
  const fallback =
    result === 'success'
      ? 'The provider answered. Save settings to keep any changes.'
      : 'The provider could not be reached.'
  return `<div class="metadata-inline-alert ${tone}" role="status">${escapeHtml(message ?? fallback)}</div>`
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
  if (options.saved) messages.push('Provider settings saved in appdata.')
  if (options.maintenanceStarted === 'policy') {
    messages.push('Cached policy re-evaluation started. No TMDB requests are required.')
  }
  if (options.maintenanceStarted === 'review') {
    messages.push('Needs Review retry started. Progress appears on the dashboard and library pages.')
  }
  if (options.maintenanceStarted === 'full') {
    messages.push('Full metadata rebuild started. Progress appears on the dashboard and library pages.')
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

/**
 * Optional second opinion on what policy could not settle.
 *
 * The key is write-only: it is never rendered back, and an empty field keeps
 * whatever is stored, mirroring how the TMDB key above behaves.
 */
/**
 * Every panel is served visible and the script hides the inactive ones on load.
 * Done the other way round, a client whose scripting failed would be left with
 * two thirds of the settings page unreachable rather than merely unstyled.
 */
const TAB_SCRIPT = `<script>
(function () {
  var bar = document.querySelector('.settings-tabs')
  if (!bar) return
  var tabs = [].slice.call(bar.querySelectorAll('.settings-tab'))
  if (!tabs.length) return
  function select(id) {
    tabs.forEach(function (tab) {
      var on = tab.getAttribute('data-tab') === id
      tab.classList.toggle('is-active', on)
      tab.setAttribute('aria-selected', String(on))
      tab.tabIndex = on ? 0 : -1
      var body = document.getElementById('tabpanel-' + tab.getAttribute('data-tab'))
      if (!body) return
      body.classList.toggle('is-active', on)
      body.hidden = !on
    })
  }
  bar.addEventListener('click', function (event) {
    var tab = event.target.closest ? event.target.closest('.settings-tab') : null
    if (tab) select(tab.getAttribute('data-tab'))
  })
  bar.addEventListener('keydown', function (event) {
    var index = tabs.indexOf(event.target)
    if (index < 0) return
    var next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
    if (next < 0) return
    event.preventDefault()
    select(tabs[next].getAttribute('data-tab'))
    tabs[next].focus()
  })
  var opening = bar.querySelector('.settings-tab.is-active') || tabs[0]
  select(opening.getAttribute('data-tab'))
})()
</script>`

function renderAssistantCard(options: MetadataSettingsRenderOptions): string {
  const assistant = options.assistant
  if (!assistant) return ''
  const policy = assistant.decisionPolicy
  const treatment = (
    name: string,
    label: string,
    selected: string,
    hint: string,
    withAssist: boolean
  ): string => {
    const choices: [string, string][] = [
      ['manual', 'Leave for me'],
      ['approve', 'Approve automatically'],
      ['block', 'Block automatically'],
      ...(withAssist ? ([['assist', 'Ask the assistant']] as [string, string][]) : []),
    ]
    return `<div class="form-group">
      <label for="${name}">${label}</label>
      <select id="${name}" name="${name}">
        ${choices
          .map(
            ([value, text]) =>
              `<option value="${value}" ${selected === value ? 'selected' : ''}>${text}</option>`
          )
          .join('')}
      </select>
      <span class="hint">${hint}</span>
    </div>`
  }

  return `
    <form id="assistant-settings-form" method="post" action="/settings/metadata/assistant" class="metadata-settings-form">
      <section class="settings-card metadata-settings-card">
        <div class="card-header metadata-card-heading">
          <div>
            <p class="metadata-step">Optional</p>
            <h2>Review assistant</h2>
          </div>
          <span class="metadata-key-state ${assistant.configured ? 'configured' : 'missing'}">${
            assistant.enabled ? 'Active' : assistant.configured ? 'Configured, off' : 'Not configured'
          }</span>
        </div>
        <p class="metadata-lede">Policy decides everything it can on its own. An assistant is only asked about what it could not settle — usually a title with more than one plausible match. Titles, years, overviews and genres are sent to the provider; file paths never are.</p>

        ${
          options.assistantSaved
            ? '<p class="metadata-alert success">Review assistant settings saved.</p>'
            : ''
        }
        ${
          options.assistantTestResult === 'failed'
            ? `<p class="metadata-alert error">${escapeHtml(options.assistantTestMessage ?? 'The provider could not be reached.')}</p>`
            : ''
        }

        <label class="metadata-remove-key">
          <input type="checkbox" name="enabled" value="true" ${assistant.enabled ? 'checked' : ''}>
          <span>Use the assistant for cases policy cannot settle</span>
        </label>

        <div class="form-group">
          <label for="assistantBaseUrl">Provider endpoint</label>
          <input type="url" id="assistantBaseUrl" name="baseUrl" value="${escapeHtml(assistant.baseUrl)}" spellcheck="false" placeholder="https://openrouter.ai/api/v1">
          <span class="hint">Any OpenAI-compatible endpoint. A trailing <code>/chat/completions</code> is trimmed for you.</span>
        </div>

        <div class="form-group">
          <label for="assistantModel">Model</label>
          <input type="text" id="assistantModel" name="model" value="${escapeHtml(assistant.model)}" spellcheck="false">
        </div>

        <div class="form-group">
          <label for="assistantApiKey">API key</label>
          <input type="password" id="assistantApiKey" name="apiKey" value="" autocomplete="new-password" spellcheck="false" placeholder="${assistant.configured ? 'Leave blank to keep the current key' : 'Paste the provider API key'}">
          <span class="hint">Stored server-side in ToastTV appdata. It is never sent back to this page.</span>
        </div>

        ${
          assistant.configured
            ? `<label class="metadata-remove-key">
                <input type="checkbox" name="removeApiKey" value="true">
                <span>Remove the current API key</span>
              </label>`
            : ''
        }

        <h3>What to do with each outstanding case</h3>
        ${treatment('reviewBand', 'Certification in the review band', policy.reviewBand, 'Ratings your profile nominates for a parent to judge, such as PG.', false)}
        ${treatment('missingRating', 'No certification anywhere', policy.missingRating, 'Matched, but no rating in any configured region.', false)}
        ${treatment('unrecognizedRating', 'Unrecognised certification', policy.unrecognizedRating, 'A rating the profile has no rule for.', false)}
        ${treatment('ambiguousMetadata', 'More than one plausible title', policy.ambiguousMetadata, 'The case an assistant is best at: choosing between candidates already found.', true)}
        ${treatment('unmatchedMetadata', 'No reliable title match', policy.unmatchedMetadata, 'Nothing matched well enough to rate.', true)}

        <div id="assistant-test-result" class="metadata-test-result" aria-live="polite"></div>

        <div class="metadata-form-actions">
          <button class="btn btn-primary" type="submit">Save assistant settings</button>
          <button class="btn btn-secondary"
                  type="submit"
                  formaction="/settings/metadata/assistant/test"
                  formnovalidate
                  hx-post="/settings/metadata/assistant/test"
                  hx-target="#assistant-test-result"
                  hx-swap="innerHTML"
                  hx-disabled-elt="this">
            Test connection
          </button>
        </div>
      </section>
    </form>

    <section class="settings-card metadata-settings-card">
      <div class="card-header metadata-card-heading">
        <div>
          <p class="metadata-step">Run</p>
          <h2>Review the outstanding queue</h2>
        </div>
      </div>
      <p class="metadata-lede">A run never starts on its own. Preview first: it walks exactly the same path and writes nothing, so what it reports is what applying would do. Everything a run changes is recorded and can be undone together.</p>

      <div id="assistant-run-result" class="metadata-test-result" aria-live="polite"></div>

      <div class="metadata-form-actions">
        <button class="btn btn-primary"
                type="button"
                hx-post="/settings/metadata/assistant/run?dryRun=true"
                hx-target="#assistant-run-result"
                hx-swap="innerHTML"
                hx-disabled-elt="this">
          Preview a run
        </button>
        <button class="btn btn-secondary"
                type="button"
                hx-post="/settings/metadata/assistant/run?dryRun=false"
                hx-confirm="Apply automated decisions to the outstanding queue? Everything applied can be undone from this page."
                hx-target="#assistant-run-result"
                hx-swap="innerHTML"
                hx-disabled-elt="this">
          Apply decisions
        </button>
      </div>
      <p class="hint">Titles a parent has already approved or blocked are never revisited.</p>
    </section>
  `
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
