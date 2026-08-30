/**
 * Settings Template
 *
 * Configuration page for session, interlude, MPV, and logo settings.
 * Uses pure HTMX for form submission and logo upload - no extensions.
 */

import type { AppConfig } from '../repositories/ConfigRepository'
import type { FfmpegTranscodingStatus } from '../services/FfmpegTranscodingBackend'
import type { TierDecision } from '../services/ChannelQualityTierService'
import { renderLayout } from './layout'
import { escapeHtml } from './utils'

export interface SettingsProps {
  config: AppConfig
  mediaDirectory: string
  hardwareProfileName?: string
  updatesEnabled?: boolean
  updateAvailable?: boolean
  currentVersion?: string
  latestVersion?: string | null
  /** Whether this process owns the legacy local MPV player. */
  localPlaybackEnabled?: boolean
  /** Resolved once at startup from the container's transcoding environment. */
  transcodingStatus?: FfmpegTranscodingStatus
  /** The lineup-wide quality decision derived from the probe and channel count. */
  qualityTier?: TierDecision
  libraryMonitoring?: {
    watcherActive: boolean
    watcherStartedAt: string | null
    lastWatcherEventAt: string | null
    safetyScanIntervalMinutes: number
    lastSafetyScanAt: string | null
  }
}

export function renderSettings(props: SettingsProps): string {
  const { config, mediaDirectory } = props
  const hasLogo = config.logo.imagePath !== null

  return renderLayout(
    'Settings',
    `
    <div class="settings settings-page">
      <header class="settings-page-header">
        <div>
          <p class="settings-eyebrow">Administration</p>
          <h1>Server settings</h1>
          <p class="settings-lede">Configure broadcast policy, catalog services, compatibility, and deployment settings.</p>
        </div>
        <nav class="settings-section-nav" aria-label="Settings sections">
          <a href="#branding">Branding</a>
          <a href="#playback">Playback</a>
          <a href="#library-services">Library</a>
          <a href="#server-system">System</a>
        </nav>
      </header>
      
      <form id="settings-form"
            hx-post="/api/config"
            hx-target="#toast-container"
            hx-swap="innerHTML">
        <section class="settings-card settings-branding-card" id="branding">
          <div class="card-header">
            <div>
              <p class="settings-card-kicker">Channel identity</p>
              <h2>Default channel logo</h2>
              <p class="settings-card-description">Shown only in ToastTV app menus and programme information. Logos are never burned into the video.</p>
            </div>
            <label class="toggle" aria-label="Enable default channel logo">
              <input type="checkbox" id="logoEnabled" name="logoEnabled" value="true" ${config.logo.enabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          
          <div class="logo-settings-grid">
            <div class="logo-controls">
              ${renderLogoUpload(hasLogo)}
              <input type="hidden" name="logoPosition" value="${config.logo.position}">
              <input type="hidden" name="logoX" value="${config.logo.x}">
              <input type="hidden" name="logoY" value="${config.logo.y}">
              <input type="hidden" name="logoOpacity" value="${config.logo.opacity}">
            </div>
            
            ${renderLogoPreview(hasLogo, config.logo.opacity, config.logo.position, config.logo.x, config.logo.y)}
          </div>
          <p class="settings-restart-note">The video stream remains clean. The LG app shows this artwork only while its channel or programme menu is visible.</p>
        </section>

        <section class="settings-group" id="playback">
          <header class="settings-group-heading">
            <div>
              <p class="settings-eyebrow">Viewing experience</p>
              <h2>Playback and scheduling</h2>
            </div>
            <p>Control watch limits, interludes, and compatibility safeguards.</p>
          </header>
          <div class="settings-grid settings-grid-three">
          <section class="settings-card">
            <div class="card-header">
              <div><p class="settings-card-kicker">Household</p><h3>Session limits</h3></div>
            </div>
            
            <div class="form-group">
              <label for="sessionLimit">Daily limit (minutes)</label>
              <input type="number" 
                     id="sessionLimit" 
                     name="sessionLimit" 
                     value="${config.session.limitMinutes || ''}"
                     min="1"
                     placeholder="Unlimited">
              <span class="hint">Leave empty for unlimited daily watch time</span>
            </div>
            
            <div class="form-group">
              <label for="resetHour">New day starts at</label>
              <select id="resetHour" name="resetHour">
                ${renderHourOptions(config.session.resetHour)}
              </select>
              <span class="hint">Quota resets at this hour each day</span>
            </div>
            
            <p class="card-note">Intro, outro, and off-air screens are managed in the <a href="/library">Library</a>.</p>
          </section>

          <section class="settings-card">
            <div class="card-header">
              <div><p class="settings-card-kicker">Continuity</p><h3>Interludes</h3></div>
              <label class="toggle" aria-label="Enable interludes">
                <input type="checkbox" id="interludeEnabled" name="interludeEnabled" value="true" ${config.interlude.enabled ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>
            </div>
            
            <div class="form-group">
              <label for="interludeFreq">Frequency</label>
              <select id="interludeFreq" name="interludeFrequency">
                ${[1, 2, 3, 4, 5]
                  .map(
                    (n) =>
                      `<option value="${n}" ${config.interlude.frequency === n ? 'selected' : ''}>Every ${n} video${n > 1 ? 's' : ''}</option>`
                  )
                  .join('')}
              </select>
              <span class="hint">Insert interlude after every N videos</span>
            </div>
          </section>

          <section class="settings-card">
            <div class="card-header">
              <div><p class="settings-card-kicker">Compatibility</p><h3>Playback safety</h3></div>
            </div>

            <div class="setting-row settings-toggle-row">
              <div>
                <label for="safeMode">Safe mode</label>
                <span class="hint">Exclude incompatible files from the playback queue.</span>
              </div>
              <label class="toggle" aria-label="Enable safe mode">
                <input type="checkbox" id="safeMode" name="safeMode" value="true" ${config.playback.safeMode ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>
            </div>

            <div class="form-group" id="hardware-profile-section">
              <label>Hardware profile</label>
              <div class="hardware-profile-display">
                <span class="profile-badge">${escapeHtml(props.hardwareProfileName ?? 'Unknown')}</span>
                <span class="hint">Device capabilities are detected automatically.</span>
              </div>
            </div>

            ${renderTranscodingStatus(props.transcodingStatus)}
            ${
              props.qualityTier
                ? `<div class="form-group" id="quality-tier">
              <label>Channel quality tier</label>
              <div class="hardware-profile-display">
                <span class="profile-badge">${escapeHtml(props.qualityTier.tier.toUpperCase())} · ${escapeHtml(String(props.qualityTier.profile.maximumHeight))}p</span>
                <span class="hint">${escapeHtml(props.qualityTier.reason)} Up to ${escapeHtml(String(props.qualityTier.maximumConcurrentWorkers))} encoder${props.qualityTier.maximumConcurrentWorkers === 1 ? '' : 's'} run at once; extra channels start on demand. (${escapeHtml(props.qualityTier.source)})</span>
              </div>
            </div>`
                : ''
            }
          </section>
          </div>
        </section>

        <section class="settings-group" id="library-services">
          <header class="settings-group-heading">
            <div>
              <p class="settings-eyebrow">Catalog services</p>
              <h2>Library and metadata</h2>
            </div>
            <p>Rescan mounted media and manage title matching.</p>
          </header>
          <div class="settings-grid settings-grid-two">
          <section class="settings-card">
            <div class="card-header">
              <div><p class="settings-card-kicker">Mounted media</p><h3>Media library</h3></div>
            </div>
            
            <div class="form-group">
              <label>Media directory</label>
              <code class="path-display">${escapeHtml(mediaDirectory)}</code>
            </div>
            <div class="form-group">
              <label for="safetyScanIntervalMinutes">Safety scan interval</label>
              <select id="safetyScanIntervalMinutes" name="safetyScanIntervalMinutes">
                ${renderSafetyScanOptions(config.library.safetyScanIntervalMinutes)}
              </select>
              <span class="hint">Filesystem changes are watched immediately. This fallback catches events missed by Docker bind mounts.</span>
            </div>
            ${renderLibraryMonitoring(props.libraryMonitoring)}
            <div class="settings-card-actions">
              <button type="button" class="btn btn-secondary"
                    hx-post="/api/rescan"
                    hx-target="#toast-container"
                    hx-swap="innerHTML">
                Rescan library
              </button>
              <span class="hint">Find files added to the mounted directory.</span>
            </div>
          </section>

          <section class="settings-card">
            <div class="card-header">
              <div><p class="settings-card-kicker">Matching and approvals</p><h3>Metadata and review</h3></div>
            </div>
            <p class="settings-card-copy">TMDB matching and certification regions, the optional review assistant, and re-running either over the library.</p>
            <div class="settings-card-actions">
              <a class="btn btn-secondary" href="/settings/metadata">Open metadata and review</a>
            </div>
          </section>
          </div>
        </section>

        <section class="settings-group" id="server-system">
          <header class="settings-group-heading">
            <div>
              <p class="settings-eyebrow">Administration</p>
              <h2>Server and system</h2>
            </div>
            <p>Connection details, server identity, and software updates.</p>
          </header>
          <div class="settings-grid settings-grid-three">
          <section class="settings-card">
            <div class="card-header">
              <div><p class="settings-card-kicker">Network</p><h3>Web server</h3></div>
            </div>
            
            <div class="form-group">
              <label for="serverPort">Port</label>
              <input type="number" id="serverPort" name="serverPort" value="${config.server.port}" min="1" max="65535">
              <span class="hint">Default: 1993. Requires restart.</span>
            </div>
          </section>

          ${props.localPlaybackEnabled === false ? '' : `<section class="settings-card">
            <div class="card-header">
              <div><p class="settings-card-kicker">Local player</p><h3>MPV connection</h3></div>
            </div>

            <div class="form-group">
              <label for="mpvSocket">IPC socket path</label>
              <input type="text" id="mpvSocket" name="mpvSocket" value="${escapeHtml(config.mpv.ipcSocket)}">
              <span class="hint">Used when ToastTV controls a local MPV process.</span>
            </div>
          </section>`}

          <section class="settings-card" id="about">
            <div class="card-header">
              <div><p class="settings-card-kicker">ToastTV</p><h3>Version and updates</h3></div>
            </div>
            
            <div class="form-group">
              <label>Version</label>
              <span class="version-display">${escapeHtml(props.currentVersion ?? 'unknown')}</span>
            </div>

            <div class="form-group" aria-label="TMDB attribution">
              <a href="https://www.themoviedb.org" target="_blank" rel="noopener noreferrer">
                <img src="/tmdb-logo.svg" width="72" height="52" alt="The Movie Database (TMDB)">
              </a>
              <p class="hint">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
            </div>
            
            <div id="update-result">
              ${
                props.updatesEnabled === false
                  ? `<div class="update-result">
                      <span class="update-status">Container updates are managed by redeploying the Docker image.</span>
                    </div>`
                  : props.updateAvailable
                  ? `<div class="update-result update-available">
                      <span class="update-status">Update available: ${escapeHtml(props.latestVersion ?? '')}</span>
                      <button type="button" class="btn btn-primary" id="update-apply-btn"
                              onclick="startUpdate()">
                        Update to ${escapeHtml(props.latestVersion ?? '')}
                      </button>
                    </div>`
                  : ''
              }
            </div>
            
            ${
              props.updatesEnabled === false
                ? ''
                : `<button type="button" class="btn btn-secondary"
                    hx-get="/api/update/check"
                    hx-target="#update-result"
                    hx-swap="innerHTML">
              Check for updates
            </button>`
            }

          </section>
          </div>
        </section>
        
        <div class="form-actions-sticky">
          <button type="submit" class="btn btn-primary btn-large">
            Save settings
          </button>
        </div>
      </form>
    </div>

    <!-- Update Terminal Modal -->
    <div id="update-modal" class="update-modal" style="display: none;">
      <div class="update-modal-backdrop" onclick="closeUpdateModal()"></div>
      <div class="update-modal-content">
        <div class="terminal-header">
          <span class="terminal-title">⬤ ToastTV Update</span>
          <button class="terminal-close" id="terminal-close-btn" onclick="closeUpdateModal()">✕</button>
        </div>
        <div class="terminal-body" id="terminal-body">
          <div id="terminal-output"></div>
          <span class="terminal-cursor">█</span>
        </div>
      </div>
    </div>
    
    <link rel="stylesheet" href="/css/settings.css">
    <script>
      ${getUpdateScript()}
    </script>
  `,
    { updateAvailable: props.updateAvailable }
  )
}

function renderSafetyScanOptions(selected: number): string {
  const options = [
    [0, 'Disabled'],
    [5, 'Every 5 minutes'],
    [10, 'Every 10 minutes'],
    [15, 'Every 15 minutes'],
    [30, 'Every 30 minutes'],
    [60, 'Every hour'],
    [360, 'Every 6 hours'],
  ] as const
  return options
    .map(
      ([value, label]) =>
        `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`
    )
    .join('')
}

function renderLibraryMonitoring(
  status: SettingsProps['libraryMonitoring']
): string {
  if (!status) return ''
  return `<dl class="settings-status-list settings-library-monitoring">
    <div><dt>Change detection</dt><dd>${status.watcherActive ? 'Watching mounted libraries' : 'Starting after the current scan'}</dd></div>
    <div><dt>Last filesystem event</dt><dd>${formatMonitoringTime(status.lastWatcherEventAt)}</dd></div>
    <div><dt>Last safety scan</dt><dd>${formatMonitoringTime(status.lastSafetyScanAt)}</dd></div>
  </dl>`
}

function formatMonitoringTime(value: string | null): string {
  if (!value) return 'Not yet'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Not yet'
    : escapeHtml(date.toLocaleString())
}

function renderTranscodingStatus(
  status: FfmpegTranscodingStatus | undefined
): string {
  if (!status) return ''

  const requestedDevice = status.requestedDevice ?? status.device
  const candidates = status.deviceCandidates ?? []
  const attempts = status.probeAttempts ?? []

  const configuredLabel =
    status.configuredMode === 'intel-qsv'
      ? 'Intel Quick Sync (QSV)'
      : status.configuredMode === 'auto'
        ? 'Automatic (Intel QSV with CPU fallback)'
        : 'CPU software encoding'
  const activeLabel = status.hardwareAcceleration
    ? 'Intel Quick Sync (QSV)'
    : 'CPU software encoding'
  const stateLabel = status.hardwareAcceleration
    ? 'Enabled'
    : status.configuredMode === 'software'
      ? 'Disabled'
      : 'Unavailable'
  const summary = status.hardwareAcceleration
    ? 'Hardware transcoding is enabled and active.'
    : status.configuredMode === 'software'
      ? 'Hardware transcoding is disabled; CPU software encoding is active.'
      : 'Hardware transcoding is unavailable; CPU fallback is active.'

  return `
    <div class="form-group" id="transcoding-status">
      <label>Transcoding</label>
      <div class="hardware-profile-display">
        <span class="profile-badge">Hardware ${stateLabel}</span>
        <span class="hint">${summary}</span>
      </div>
      <dl class="settings-status-list">
        <div><dt>Configured</dt><dd>${configuredLabel}</dd></div>
        <div><dt>Active encoder</dt><dd>${activeLabel}</dd></div>
        ${
          requestedDevice && status.device && requestedDevice !== status.device
            ? `<div><dt>Requested path</dt><dd><code>${escapeHtml(requestedDevice)}</code></dd></div>
               <div><dt>Resolved render node</dt><dd><code>${escapeHtml(status.device)}</code></dd></div>`
            : status.device
              ? `<div><dt>Device</dt><dd><code>${escapeHtml(status.device)}</code></dd></div>`
              : requestedDevice
                ? `<div><dt>Requested path</dt><dd><code>${escapeHtml(requestedDevice)}</code></dd></div>`
                : ''
        }
      </dl>
      ${status.fallbackReason ? `<p class="settings-restart-note" role="status">Fallback reason: ${escapeHtml(status.fallbackReason)}</p>` : ''}
      ${renderTranscodingDiagnostics(status, candidates, attempts)}
      <p class="hint">Read-only container setting. Change <code>TOASTTV_TRANSCODING_MODE</code> in the deployment environment, then restart ToastTV.</p>
    </div>
  `
}

function renderTranscodingDiagnostics(
  status: FfmpegTranscodingStatus,
  candidates: readonly string[],
  attempts: NonNullable<FfmpegTranscodingStatus['probeAttempts']>
): string {
  if (status.configuredMode === 'software') return ''

  const guidance = status.hardwareAcceleration
    ? 'The render node is accessible and the one-frame Intel QSV encode test passed.'
    : candidates.length === 0
      ? 'No DRM render node was discovered inside the container. Map the host /dev/dri directory into the container at /dev/dri, then restart ToastTV.'
      : 'The container can see a render node, but QSV did not start. Check the node group permissions and Intel media-driver support shown in the server log.'

  return `<details class="settings-transcoding-diagnostics" ${status.hardwareAcceleration ? '' : 'open'}>
    <summary>
      <span><strong>Hardware diagnostics</strong><small>${attempts.length} ${attempts.length === 1 ? 'probe attempt' : 'probe attempts'}</small></span>
    </summary>
    <div class="settings-transcoding-diagnostics-body">
      <p>${escapeHtml(guidance)}</p>
      <dl class="settings-status-list">
        <div><dt>Render nodes found</dt><dd>${
          candidates.length > 0
            ? candidates.map((candidate) => `<code>${escapeHtml(candidate)}</code>`).join(', ')
            : 'None'
        }</dd></div>
      </dl>
      ${
        attempts.length > 0
          ? `<ul class="settings-probe-attempts">${attempts
              .map(
                (attempt) => `<li>
                  <div><code>${escapeHtml(attempt.device)}</code><strong>${
                    attempt.timedOut
                      ? 'Timed out'
                      : attempt.exitCode === 0
                        ? 'Passed'
                        : `Exit ${attempt.exitCode ?? 'unknown'}`
                  }</strong></div>
                  ${attempt.detail ? `<small>${escapeHtml(attempt.detail)}</small>` : ''}
                </li>`
              )
              .join('')}</ul>`
          : ''
      }
      <p class="hint"><strong>This check runs inside the server container at startup, so the browser developer console stays empty.</strong> In Unraid, open Docker → ToastTV → Logs. With Compose, run <code>docker compose logs toasttv</code>.</p>
    </div>
  </details>`
}

function renderHourOptions(selectedHour: number): string {
  return Array.from({ length: 24 }, (_, h) => {
    const label =
      h === 0
        ? '12:00 AM'
        : h < 12
          ? `${h}:00 AM`
          : h === 12
            ? '12:00 PM'
            : `${h - 12}:00 PM`
    return `<option value="${h}" ${selectedHour === h ? 'selected' : ''}>${label}</option>`
  }).join('')
}

function renderLogoUpload(hasLogo: boolean): string {
  return `
    <div class="form-group" id="logo-upload-section">
      <label>Logo Image</label>
      <div class="logo-picker">
        ${hasLogo ? `<img src="/logo" alt="Current logo" class="logo-preview">` : `<div class="logo-placeholder">No logo</div>`}
        <label class="btn btn-primary btn-small">
          Choose
          <input type="file" 
                 id="logoFile"
                 accept="image/*"
                 style="display: none"
                 hx-post="/api/upload-logo"
                 hx-trigger="change"
                 hx-target="#logo-upload-section"
                 hx-swap="outerHTML"
                 hx-encoding="multipart/form-data"
                 name="file">
        </label>
      </div>
    </div>
  `
}

function renderLogoPreview(
  hasLogo: boolean,
  _opacity: number,
  _position: number,
  _x: number,
  _y: number
): string {
  return `
    <div class="logo-preview-area">
      <div class="logo-screen-preview" id="logoScreenPreview">
        <div class="screen-content">App menu preview</div>
        ${
          hasLogo
            ? `<img src="/logo" alt="Logo preview" class="screen-logo" id="screenLogo" 
                    style="opacity: 1; right: 24px; top: 24px;">`
            : ''
        }
      </div>
    </div>
  `
}

function getUpdateScript(): string {
  // Inline JS for the update terminal — uses fetch + ReadableStream to process SSE
  return `
    function startUpdate() {
      var modal = document.getElementById('update-modal');
      var output = document.getElementById('terminal-output');
      var body = document.getElementById('terminal-body');
      var applyBtn = document.getElementById('update-apply-btn');
      var closeBtn = document.getElementById('terminal-close-btn');

      if (!modal || !output) return;

      modal.style.display = 'flex';
      if (applyBtn) applyBtn.disabled = true;
      if (closeBtn) closeBtn.style.display = 'none';
      output.innerHTML = '';

      function addLine(text) {
        var line = document.createElement('div');
        line.className = 'terminal-line';
        line.textContent = text;
        output.appendChild(line);
        body.scrollTop = body.scrollHeight;
      }

      fetch('/api/update/apply', { method: 'POST' })
        .then(function(response) {
          if (!response.ok) {
            addLine('> Error: ' + response.statusText);
            return;
          }

          var reader = response.body.getReader();
          var decoder = new TextDecoder();
          var buffer = '';

          function read() {
            reader.read().then(function(result) {
              if (result.done) {
                startPolling();
                return;
              }

              buffer += decoder.decode(result.value, { stream: true });
              var parts = buffer.split('\\n\\n');
              buffer = parts.pop() || '';

              for (var i = 0; i < parts.length; i++) {
                var part = parts[i].trim();
                if (!part.startsWith('data: ')) continue;
                try {
                  var data = JSON.parse(part.slice(6));
                  if (data.line === '__DONE__') {
                    startPolling();
                    return;
                  }
                  addLine(data.line);
                } catch(e) {}
              }

              read();
            }).catch(function() {
              startPolling();
            });
          }

          read();
        })
        .catch(function() {
          addLine('> Connection lost');
          startPolling();
        });

      function startPolling() {
        addLine('> Restarting... waiting for server');
        var cursor = document.querySelector('.terminal-cursor');
        if (cursor) cursor.classList.add('blink-fast');

        var pollInterval = setInterval(function() {
          fetch('/api/update/check')
            .then(function(r) {
              if (r.ok) {
                clearInterval(pollInterval);
                fetch('/api/update/log')
                  .then(function(r) { return r.ok ? r.text() : null; })
                  .then(function(logText) {
                    if (logText) {
                      output.innerHTML = '';
                      var lines = logText.split('\\n');
                      for (var i = 0; i < lines.length; i++) {
                        if (lines[i].trim()) addLine(lines[i]);
                      }
                    }
                    addLine('> Server is back online!');
                    addLine('> Refreshing in 3s...');
                    if (cursor) cursor.classList.remove('blink-fast');
                    setTimeout(function() { location.reload(); }, 3000);
                  });
              }
            })
            .catch(function() {});
        }, 2000);
      }
    }

    function closeUpdateModal() {
      var modal = document.getElementById('update-modal');
      if (modal) modal.style.display = 'none';
    }
  `
}
