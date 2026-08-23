import type { PublicMetadataConfig } from '../config/metadata'
import type { MetadataJobState } from '../types'
import { renderLayout } from './layout'
import { escapeHtml } from './utils'

export function renderMetadataSettings(
  config: PublicMetadataConfig,
  state: MetadataJobState,
  testResult?: 'success' | 'failed'
): string {
  const regions = [
    config.preferredRatingRegion,
    ...config.fallbackRatingRegions,
  ]
  return renderLayout(
    'Metadata settings',
    `<div class="settings">
      <p><a href="/settings">← Back to settings</a></p>
      <h1>Metadata</h1>
      ${
        testResult
          ? `<div class="toast ${testResult === 'success' ? 'success' : 'warning'}">${testResult === 'success' ? 'TMDB connection succeeded' : 'TMDB connection failed'}</div>`
          : ''
      }
      <section class="settings-card">
        <div class="card-header"><h2>TMDB</h2></div>
        <dl class="headless-stat-list">
          <div><dt>API key</dt><dd>${config.configured ? '••••••••••••••••' : 'Not configured'}</dd></div>
          <div><dt>Status</dt><dd>${config.configured ? 'Configured' : 'Provider not configured'}</dd></div>
          <div><dt>Language</dt><dd>${escapeHtml(config.language)}</dd></div>
          <div><dt>Rating regions</dt><dd>${regions.map(escapeHtml).join(' → ')}</dd></div>
          <div><dt>Background task</dt><dd>${escapeHtml(state.status)}</dd></div>
        </dl>
        <p class="card-note">Set <code>TMDB_API_KEY</code>, <code>RATING_REGION</code>, and optional <code>RATING_FALLBACK_REGIONS</code> in the server environment. The key is never returned to browsers or TV clients.</p>
        <form method="post" action="/settings/metadata/test">
          <button class="btn btn-primary" type="submit" ${config.configured ? '' : 'disabled'}>Test connection</button>
        </form>
      </section>
    </div>`
  )
}
