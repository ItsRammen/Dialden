import { renderLayout } from './layout'
import { escapeHtml } from './utils'

export type ServerOperationalStatus = 'online' | 'degraded' | 'offline'

export interface HeadlessServerViewModel {
  readonly status: ServerOperationalStatus
  readonly statusMessage?: string
  readonly version?: string
  readonly uptimeLabel?: string
}

export type ChannelOperationalStatus =
  | 'on_air'
  | 'off_air'
  | 'no_program'
  | 'scheduled'
  | 'unavailable'

export interface HeadlessChannelProgramViewModel {
  readonly title: string
  readonly collectionTitle?: string
  readonly episodeLabel?: string
  /** Preformatted in the channel's configured timezone. */
  readonly timeRange: string
}

export interface HeadlessChannelViewModel {
  readonly id: string
  readonly name: string
  readonly status: ChannelOperationalStatus
  readonly timezone?: string
  readonly now: HeadlessChannelProgramViewModel | null
  readonly next: HeadlessChannelProgramViewModel | null
  readonly guideHref: string
  readonly manageHref?: string
  readonly onAirAction?: string
  readonly offAirAction?: string
  readonly viewerCount?: number
}

export interface HeadlessClientViewModel {
  readonly clientId: string
  readonly name: string
  readonly connected: boolean
  readonly channelName?: string
  readonly playbackMode: string
  readonly lastSeenLabel: string
}

export interface HeadlessLibrarySummaryViewModel {
  readonly tvCollections: number
  readonly episodes: number
  readonly movieCollections: number
  readonly interludes: number
  readonly approvedCollections: number
  readonly reviewCollections: number
  readonly blockedCollections: number
}

export type HeadlessScanStatus =
  | 'idle'
  | 'discovering'
  | 'scanning'
  | 'completed'
  | 'failed'

export interface HeadlessScanViewModel {
  readonly status: HeadlessScanStatus
  readonly discoveredFiles: number
  readonly processedFiles: number
  readonly indexedFiles: number
  readonly failedFiles: number
  /** A safe, root-relative display value rather than an absolute host path. */
  readonly currentLocationLabel?: string
  readonly lastScanLabel?: string
  readonly errorMessage?: string
}

export type HeadlessMetadataStatus =
  | 'connected'
  | 'not_configured'
  | 'degraded'
  | 'offline'

export interface HeadlessMetadataViewModel {
  readonly providerName: string
  readonly status: HeadlessMetadataStatus
  readonly preferredRegion?: string
  readonly matchedCollections: number
  readonly pendingCollections: number
  readonly reviewCollections: number
  readonly lastRefreshLabel?: string
  readonly statusMessage?: string
}

export type DashboardWarningSeverity = 'warning' | 'critical' | 'info'

export interface HeadlessDashboardWarningViewModel {
  readonly severity: DashboardWarningSeverity
  readonly message: string
  readonly href?: string
  readonly actionLabel?: string
}

export interface HeadlessDashboardViewModel {
  readonly server: HeadlessServerViewModel
  readonly channels: readonly HeadlessChannelViewModel[]
  readonly library: HeadlessLibrarySummaryViewModel
  readonly scan: HeadlessScanViewModel
  readonly metadata: HeadlessMetadataViewModel
  readonly clients?: readonly HeadlessClientViewModel[]
  readonly warnings?: readonly HeadlessDashboardWarningViewModel[]
  readonly updateAvailable?: boolean
}

const SERVER_STATUS: Record<
  ServerOperationalStatus,
  { label: string; icon: string }
> = {
  online: { label: 'Server online', icon: '●' },
  degraded: { label: 'Server needs attention', icon: '▲' },
  offline: { label: 'Server unavailable', icon: '●' },
}

const CHANNEL_STATUS: Record<
  ChannelOperationalStatus,
  { label: string; icon: string }
> = {
  on_air: { label: 'On air', icon: '●' },
  off_air: { label: 'Manually off air', icon: '○' },
  no_program: { label: 'No programming', icon: '!' },
  scheduled: { label: 'Scheduled', icon: '◷' },
  unavailable: { label: 'Unavailable', icon: '!' },
}

const SCAN_STATUS: Record<HeadlessScanStatus, string> = {
  idle: 'Idle',
  discovering: 'Discovering files',
  scanning: 'Scanning library',
  completed: 'Scan completed',
  failed: 'Scan failed',
}

const METADATA_STATUS: Record<HeadlessMetadataStatus, string> = {
  connected: 'Connected',
  not_configured: 'Not configured',
  degraded: 'Needs attention',
  offline: 'Unavailable',
}

function count(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Math.max(0, Math.floor(value)).toLocaleString('en-US')
}

function safeInternalHref(value: string | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (
    !trimmed.startsWith('/') ||
    trimmed.startsWith('//') ||
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    return null
  }
  return escapeHtml(trimmed)
}

function renderProgram(
  label: 'Now' | 'Next',
  program: HeadlessChannelProgramViewModel | null
): string {
  if (!program) {
    return `
      <div class="headless-program headless-program-empty">
        <dt>${label}</dt>
        <dd>No ${label.toLowerCase()} program in the current guide window</dd>
      </div>
    `
  }

  const secondary = [program.collectionTitle, program.episodeLabel]
    .filter((value): value is string => Boolean(value))
    .map(escapeHtml)
    .join(' · ')

  return `
    <div class="headless-program">
      <dt>${label}</dt>
      <dd>
        <strong>${escapeHtml(program.title)}</strong>
        ${secondary ? `<span>${secondary}</span>` : ''}
        <time>${escapeHtml(program.timeRange)}</time>
      </dd>
    </div>
  `
}

function renderChannel(channel: HeadlessChannelViewModel): string {
  const status = CHANNEL_STATUS[channel.status]
  const guideHref = safeInternalHref(channel.guideHref)
  const manageHref = safeInternalHref(channel.manageHref)
  const onAirAction = safeInternalHref(channel.onAirAction)
  const offAirAction = safeInternalHref(channel.offAirAction)

  return `
    <article class="headless-channel-card">
      <header>
        <div>
          <h3>${escapeHtml(channel.name)}</h3>
          ${channel.timezone ? `<p>${escapeHtml(channel.timezone)}</p>` : ''}
        </div>
        <span class="headless-status headless-status-${channel.status}">
          <span aria-hidden="true">${status.icon}</span>
          ${status.label}
        </span>
      </header>
      <dl class="headless-programs">
        ${renderProgram('Now', channel.now)}
        ${renderProgram('Next', channel.next)}
      </dl>
      ${
        channel.viewerCount === undefined
          ? ''
          : `<p class="headless-viewers">${count(channel.viewerCount)} active viewer${channel.viewerCount === 1 ? '' : 's'}</p>`
      }
      <div class="headless-channel-actions">
        ${
          guideHref
            ? `<a class="headless-card-link" href="${guideHref}" aria-label="Open the ${escapeHtml(channel.name)} guide">Guide</a>`
            : ''
        }
        ${manageHref ? `<a class="headless-card-link" href="${manageHref}">Configure</a>` : ''}
        ${
          channel.status === 'off_air' && onAirAction
            ? `<form method="post" action="${onAirAction}"><button type="submit">Resume schedule</button></form>`
            : (channel.status === 'on_air' || channel.status === 'scheduled') && offAirAction
              ? `<form method="post" action="${offAirAction}"><button type="submit">Go off air</button></form>`
              : ''
        }
      </div>
    </article>
  `
}

function renderWarnings(
  warnings: readonly HeadlessDashboardWarningViewModel[]
): string {
  if (warnings.length === 0) return ''

  return `
    <section class="headless-warnings" aria-labelledby="headless-warnings-title">
      <h2 id="headless-warnings-title">Needs attention</h2>
      <ul>
        ${warnings
          .map((warning) => {
            const href = safeInternalHref(warning.href)
            return `
              <li class="headless-warning headless-warning-${warning.severity}">
                <span aria-hidden="true">${warning.severity === 'critical' ? '!' : '▲'}</span>
                <span>${escapeHtml(warning.message)}</span>
                ${
                  href
                    ? `<a href="${href}">${escapeHtml(warning.actionLabel ?? 'Review')}</a>`
                    : ''
                }
              </li>
            `
          })
          .join('')}
      </ul>
    </section>
  `
}

function renderScan(scan: HeadlessScanViewModel): string {
  const discovered = Math.max(0, Math.floor(scan.discoveredFiles || 0))
  const processed = Math.max(0, Math.floor(scan.processedFiles || 0))
  const hasKnownTotal = discovered > 0
  const active = scan.status === 'discovering' || scan.status === 'scanning'
  const progress = hasKnownTotal
    ? `<progress aria-label="Library scan progress" value="${Math.min(processed, discovered)}" max="${discovered}">${Math.round((Math.min(processed, discovered) / discovered) * 100)}%</progress>`
    : active
      ? '<progress aria-label="Library scan progress">Discovering files</progress>'
      : '<progress aria-label="Library scan progress" value="0" max="1">0%</progress>'

  return `
    <section id="headless-scan-card" class="headless-ops-card" aria-labelledby="headless-scan-title">
      <header>
        <h2 id="headless-scan-title">Library scan</h2>
        <span id="headless-scan-status" class="headless-state-label">${SCAN_STATUS[scan.status]}</span>
      </header>
      <div class="headless-progress" role="status" aria-live="polite" aria-atomic="true" aria-busy="${active}">
        ${progress.replace('<progress ', '<progress id="headless-scan-progress" ')}
        <p id="headless-scan-count">${count(processed)} of ${hasKnownTotal ? count(discovered) : 'an unknown number of'} files processed</p>
      </div>
      <dl class="headless-stat-list">
        <div><dt>Indexed</dt><dd id="headless-scan-indexed">${count(scan.indexedFiles)}</dd></div>
        <div><dt>Errors</dt><dd id="headless-scan-errors">${count(scan.failedFiles)}</dd></div>
      </dl>
      ${scan.currentLocationLabel ? `<p class="headless-current"><span>Current</span><code>${escapeHtml(scan.currentLocationLabel)}</code></p>` : ''}
      ${scan.lastScanLabel ? `<p class="headless-muted">Last scan: ${escapeHtml(scan.lastScanLabel)}</p>` : ''}
      ${scan.errorMessage ? `<p class="headless-error">${escapeHtml(scan.errorMessage)}</p>` : ''}
      <a class="headless-card-link" href="/library">Open library</a>
    </section>
  `
}

function renderMetadata(metadata: HeadlessMetadataViewModel): string {
  return `
    <section id="headless-metadata-card" class="headless-ops-card" aria-labelledby="headless-metadata-title">
      <header>
        <h2 id="headless-metadata-title">Metadata</h2>
        <span id="headless-metadata-status" class="headless-status headless-metadata-${metadata.status}">${METADATA_STATUS[metadata.status]}</span>
      </header>
      <p class="headless-provider">
        <strong>${escapeHtml(metadata.providerName)}</strong>
        ${metadata.preferredRegion ? `<span>Preferred region: ${escapeHtml(metadata.preferredRegion)}</span>` : ''}
      </p>
      <dl class="headless-stat-list">
        <div><dt>Matched</dt><dd id="headless-metadata-matched">${count(metadata.matchedCollections)}</dd></div>
        <div><dt>Pending</dt><dd id="headless-metadata-pending">${count(metadata.pendingCollections)}</dd></div>
        <div><dt>Needs review</dt><dd id="headless-metadata-review">${count(metadata.reviewCollections)}</dd></div>
      </dl>
      ${metadata.lastRefreshLabel ? `<p class="headless-muted">Last refresh: ${escapeHtml(metadata.lastRefreshLabel)}</p>` : ''}
      ${metadata.statusMessage ? `<p class="headless-message">${escapeHtml(metadata.statusMessage)}</p>` : ''}
      <a class="headless-card-link" href="/library/review/metadata">Review metadata</a>
    </section>
  `
}

export function renderHeadlessDashboardContent(
  view: HeadlessDashboardViewModel
): string {
  const serverStatus = SERVER_STATUS[view.server.status]
  const warnings = view.warnings ?? []
  const clients = view.clients ?? []

  return `
    <div class="headless-dashboard">
      <header class="headless-dashboard-header">
        <div>
          <p class="headless-eyebrow">Broadcast server</p>
          <h1>ToastTV</h1>
        </div>
        <div class="headless-server-state headless-server-${view.server.status}" role="status" aria-live="polite">
          <strong><span aria-hidden="true">${serverStatus.icon}</span> ${serverStatus.label}</strong>
          ${view.server.statusMessage ? `<span>${escapeHtml(view.server.statusMessage)}</span>` : ''}
          ${view.server.version ? `<span>Version ${escapeHtml(view.server.version)}</span>` : ''}
          ${view.server.uptimeLabel ? `<span>Uptime ${escapeHtml(view.server.uptimeLabel)}</span>` : ''}
        </div>
      </header>

      ${renderWarnings(warnings)}

      <section class="headless-channels" aria-labelledby="headless-channels-title">
        <div class="headless-section-heading">
          <div>
            <p class="headless-eyebrow">Channels</p>
            <h2 id="headless-channels-title">Now and next</h2>
          </div>
          <a class="headless-card-link" href="/channels">Manage channels</a>
        </div>
        <div class="headless-channel-grid">
          ${
            view.channels.length > 0
              ? view.channels.map(renderChannel).join('')
              : '<p class="headless-empty">No channels are configured.</p>'
          }
        </div>
      </section>

      <div class="headless-operations-grid">
        <section class="headless-ops-card" aria-labelledby="headless-library-title">
          <header>
            <h2 id="headless-library-title">Library</h2>
          </header>
          <dl class="headless-library-counts">
            <div><dt>TV shows</dt><dd>${count(view.library.tvCollections)}</dd><span>${count(view.library.episodes)} episodes</span></div>
            <div><dt>Movies</dt><dd>${count(view.library.movieCollections)}</dd></div>
            <div><dt>Interludes</dt><dd>${count(view.library.interludes)}</dd></div>
          </dl>
          <dl class="headless-stat-list headless-approval-counts">
            <div><dt>Approved</dt><dd>${count(view.library.approvedCollections)}</dd></div>
            <div><dt>Needs review</dt><dd>${count(view.library.reviewCollections)}</dd></div>
            <div><dt>Blocked</dt><dd>${count(view.library.blockedCollections)}</dd></div>
          </dl>
          <a class="headless-card-link" href="/library/review">Review library</a>
        </section>

        ${renderScan(view.scan)}
        ${renderMetadata(view.metadata)}
      </div>

      <section class="headless-clients" aria-labelledby="headless-clients-title">
        <div class="headless-section-heading">
          <div><p class="headless-eyebrow">Clients</p><h2 id="headless-clients-title">TV connections</h2></div>
        </div>
        ${
          clients.length === 0
            ? '<p class="headless-empty">No TV clients have checked in since this server started.</p>'
            : `<ul>${clients
                .map(
                  (client) => `<li>
                    <div><strong>${escapeHtml(client.name)}</strong><span>${escapeHtml(client.channelName ?? 'No channel')} · ${escapeHtml(client.playbackMode)}</span></div>
                    <div><span class="headless-status ${client.connected ? 'headless-client-connected' : 'headless-client-offline'}">${client.connected ? 'Connected' : 'Offline'}</span><small>${escapeHtml(client.lastSeenLabel)}</small></div>
                  </li>`
                )
                .join('')}</ul>`
        }
      </section>
    </div>
  `
}

export function renderHeadlessDashboard(
  view: HeadlessDashboardViewModel
): string {
  return renderLayout(
    'Dashboard',
    `<link rel="stylesheet" href="/css/headless-dashboard.css">
     ${renderHeadlessDashboardContent(view)}
     <script>
       (function () {
         if (!window.EventSource) return;
         var source = new EventSource('/events/dashboard');
         var reloadTimer = null;
         function text(id, value) { var element = document.getElementById(id); if (element) element.textContent = String(value); }
         function scan(state) {
           if (!state) return;
           var progress = document.getElementById('headless-scan-progress');
           var total = Math.max(1, Number(state.discoveredFiles) || 1);
           if (progress) { progress.max = total; progress.value = Math.min(total, Number(state.processedFiles) || 0); }
           text('headless-scan-status', state.status);
           text('headless-scan-count', String(state.processedFiles || 0) + ' of ' + String(state.discoveredFiles || 0) + ' files processed');
           text('headless-scan-indexed', state.indexedFiles || 0);
           text('headless-scan-errors', state.failedFiles || 0);
           if (state.status === 'completed' || state.status === 'failed') scheduleReload();
         }
         function metadata(state) {
           if (!state) return;
           text('headless-metadata-status', state.status);
           if (state.status === 'completed' || state.status === 'failed' || state.status === 'not_configured') scheduleReload();
         }
         function scheduleReload() {
           if (reloadTimer) return;
           reloadTimer = window.setTimeout(function () { window.location.reload(); }, 1000);
         }
         source.onmessage = function (message) {
           try {
             var event = JSON.parse(message.data);
             if (event.type === 'sync') {
               if (event.libraryScan && (event.libraryScan.status === 'discovering' || event.libraryScan.status === 'scanning')) scan(event.libraryScan);
               if (event.metadata && event.metadata.status === 'running') metadata(event.metadata);
             }
             else if (String(event.type).indexOf('library.scan.') === 0) scan(event.state);
             else if (String(event.type).indexOf('library.metadata.') === 0) metadata(event.state);
           } catch (_) {}
         };
       })();
     </script>`,
    { updateAvailable: view.updateAvailable }
  )
}
