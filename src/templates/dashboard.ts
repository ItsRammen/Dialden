/**
 * Dashboard Template
 *
 * Broadcast monitor with three-zone layout:
 * - Fixed top: session status bar
 * - Scrollable middle: now playing + queue
 * - Fixed bottom: playback controls
 *
 * Uses SSE for real-time updates — client owns the progress timer.
 */

import { renderLayout } from './layout'

export function renderDashboard(updateAvailable?: boolean): string {
  return renderLayout(
    'Dashboard',
    `
    <div class="dashboard">
      <!-- Zone 1: Fixed Status Bar -->
      <div class="status-bar" id="status-bar">
        <div class="status-bar-left">
          <span class="status-badge" id="status-badge">
            <span class="status-dot" id="status-dot"></span>
            <span id="status-text">CONNECTING</span>
          </span>
        </div>
        <div class="status-bar-right">
          <span class="session-remaining" id="session-remaining">--:--</span>
        </div>
        <div class="session-progress" id="session-progress">
          <div class="session-progress-fill" id="session-progress-fill" style="width: 0%"></div>
        </div>
      </div>

      <!-- Zone 2: Scrollable Content -->
      <div class="dashboard-content" id="dashboard-content">
        <!-- Loading State -->
        <div class="state-card" id="loading-state">
          <div class="state-icon">📺</div>
          <div class="state-message">Connecting to TV...</div>
        </div>

        <!-- TV Off State -->
        <div class="state-card" id="tv-off-state" style="display: none;">
          <div class="smpte-bars">
            <div class="smpte-row smpte-main">
              <div style="background: #c0c0c0; flex: 1;"></div>
              <div style="background: #c0c000; flex: 1;"></div>
              <div style="background: #00c0c0; flex: 1;"></div>
              <div style="background: #00c000; flex: 1;"></div>
              <div style="background: #c000c0; flex: 1;"></div>
              <div style="background: #c00000; flex: 1;"></div>
              <div style="background: #0000c0; flex: 1;"></div>
            </div>
            <div class="smpte-row smpte-mid">
              <div style="background: #0000c0; flex: 1;"></div>
              <div style="background: #131313; flex: 1;"></div>
              <div style="background: #c000c0; flex: 1;"></div>
              <div style="background: #131313; flex: 1;"></div>
              <div style="background: #00c0c0; flex: 1;"></div>
              <div style="background: #131313; flex: 1;"></div>
              <div style="background: #c0c0c0; flex: 1;"></div>
            </div>
            <div class="smpte-row smpte-bottom">
              <div style="background: #00214c; flex: 1.5;"></div>
              <div style="background: #fff; flex: 1.5;"></div>
              <div style="background: #32006a; flex: 1.5;"></div>
              <div style="background: #131313; flex: 4;"></div>
              <div style="background: #090909; flex: 0.5;"></div>
              <div style="background: #1d1d1d; flex: 0.5;"></div>
            </div>
            <div class="smpte-overlay"></div>
          </div>
          <div class="state-actions">
            <button class="btn btn-primary btn-large"
                    hx-post="/api/session/start"
                    hx-swap="none">
              ⏻ POWER ON
            </button>
          </div>
        </div>

        <!-- Off-Air State -->
        <div class="state-card" id="off-air-state" style="display: none;">
          <div class="off-air-card">
            <div class="off-air-icon">🌙</div>
            <h2 class="off-air-title">OFF AIR</h2>
            <p class="off-air-message">Daily limit reached</p>
            <p class="off-air-loop">🔁 Playing on loop</p>
            <button class="btn btn-primary off-air-btn"
                    hx-post="/api/skip-quota"
                    hx-swap="none">
              Skip Limit Today
            </button>
            <p class="off-air-reset">Limit resumes at <span id="reset-hour">6:00</span></p>
          </div>
        </div>

        <!-- TV On State: Now Playing + Queue -->
        <div id="tv-on-state" style="display: none;">
          <!-- Now Playing Card -->
          <div class="now-playing-card">
            <div class="now-playing-thumb" id="now-playing-thumb">
              <img id="now-playing-img" alt="" loading="lazy">
            </div>
            <div class="now-playing-info">
              <h2 class="now-playing-title" id="track-title">Loading...</h2>
              <div class="now-playing-progress">
                <div class="progress-bar">
                  <div class="progress-fill" id="progress-fill" style="width: 0%"></div>
                </div>
                <div class="progress-time" id="time-display">0:00 / 0:00</div>
              </div>
            </div>
          </div>

          <!-- Coming Up Section -->
          <div class="queue-section" id="queue-section" style="display: none;">
            <div class="queue-header">
              <span class="queue-label">COMING UP</span>
              <span class="queue-total" id="queue-total"></span>
            </div>
            <div class="queue-list" id="queue-list"></div>
          </div>
        </div>
      </div>

      <!-- Zone 3: Fixed Controls Bar -->
      <div class="controls-bar" id="controls-bar" style="display: none;">
        <button class="ctrl-btn" id="play-pause-btn" hx-post="/api/pause" hx-swap="none" title="Pause">
          <svg viewBox="0 0 24 24" fill="currentColor" id="play-pause-icon">
            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
          </svg>
        </button>

        <button class="ctrl-btn" hx-post="/api/skip" hx-swap="none" title="Skip">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
        </button>

        <div class="ctrl-divider"></div>

        <button class="ctrl-btn ctrl-secondary" hx-post="/api/session/shuffle" hx-swap="none" title="Shuffle Queue">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>
        </button>

        <button class="ctrl-btn ctrl-danger" hx-post="/api/session/stop" hx-confirm="End broadcast?" hx-swap="none" title="Power Off">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17C4.23 6.82 3 9.26 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83z"/></svg>
        </button>
      </div>
    </div>
    
    <!-- Toast Container for Notifications -->
    <div id="toast-container"></div>
    
    <!-- SSE Client Script -->
    <script>
    ${getDashboardScript()}
    </script>
  `,
    { updateAvailable }
  )
}

function getDashboardScript(): string {
  return `
    (function() {
      'use strict';
      
      // --- State ---
      var position = 0;
      var duration = 0;
      var isPlaying = false;
      var trackId = null;
      var sessionRemainingMs = 0;
      var sessionLimitMs = 0;
      var sessionStartedAt = null;
      var timer = null;
      var sessionTimer = null;
      
      // --- DOM Elements ---
      var loadingState = document.getElementById('loading-state');
      var tvOffState = document.getElementById('tv-off-state');
      var tvOnState = document.getElementById('tv-on-state');
      var offAirState = document.getElementById('off-air-state');
      var statusBar = document.getElementById('status-bar');
      var statusBadge = document.getElementById('status-badge');
      var statusDot = document.getElementById('status-dot');
      var statusText = document.getElementById('status-text');
      var sessionRemaining = document.getElementById('session-remaining');
      var sessionProgressFill = document.getElementById('session-progress-fill');
      var sessionProgress = document.getElementById('session-progress');
      var trackTitle = document.getElementById('track-title');
      var progressFill = document.getElementById('progress-fill');
      var timeDisplay = document.getElementById('time-display');
      var nowPlayingThumb = document.getElementById('now-playing-thumb');
      var nowPlayingImg = document.getElementById('now-playing-img');
      var playPauseIcon = document.getElementById('play-pause-icon');
      var queueSection = document.getElementById('queue-section');
      var queueList = document.getElementById('queue-list');
      var queueTotal = document.getElementById('queue-total');
      var controlsBar = document.getElementById('controls-bar');
      var resetHourEl = document.getElementById('reset-hour');
      
      // --- Helpers ---
      function ts() {
        return new Date().toISOString().slice(11, 23);
      }
      function log(category, msg) {
        console.log('[' + ts() + '] ' + category + ': ' + msg);
      }
      
      function cleanFilename(filename) {
        if (!filename) return '';
        return filename
          .replace(/\\.[^.]+$/, '')
          .replace(/_/g, ' ');
      }
      
      function formatTime(secs) {
        var m = Math.floor(secs / 60);
        var s = Math.floor(secs % 60);
        return m + ':' + (s < 10 ? '0' : '') + s;
      }
      
      function formatDuration(secs) {
        var m = Math.floor(secs / 60);
        var s = Math.floor(secs % 60);
        if (m === 0) return s + 's';
        if (s === 0) return m + 'm';
        return m + ':' + (s < 10 ? '0' : '') + s;
      }
      
      // --- SSE Connection ---
      var eventSource = null;
      var reconnectAttempts = 0;
      
      function connect() {
        eventSource = new EventSource('/events/dashboard');
        
        eventSource.onopen = function() {
          reconnectAttempts = 0;
          log('SSE', 'connected');
        };
        
        eventSource.onmessage = function(e) {
          try {
            var event = JSON.parse(e.data);
            handleEvent(event);
          } catch (err) {
            console.error('SSE parse error:', err);
          }
        };
        
        eventSource.onerror = function() {
          eventSource.close();
          reconnectAttempts++;
          var delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
          log('SSE', 'reconnecting in ' + delay + 'ms');
          setTimeout(connect, delay);
        };
      }
      
      // --- Event Router ---
      function handleEvent(event) {
        log('SSE', 'received: ' + event.type + ' ' + (event.filename || event.trackId || ''));
        switch (event.type) {
          case 'sync':
            handleSync(event);
            break;
          case 'trackStart':
            handleTrackStart(event);
            break;
          case 'paused':
            handlePaused();
            break;
          case 'playing':
          case 'resume':
            handlePlaying();
            break;
          case 'sessionStart':
            handleSessionStart(event);
            break;
          case 'sessionEnd':
            handleSessionEnd();
            break;
          case 'queueUpdate':
            handleQueueUpdate(event);
            break;
        }
      }
      
      // --- Event Handlers ---
      function handleSync(event) {
        log('SSE', 'sync: pos=' + event.position + ' dur=' + event.duration + ' playing=' + event.isPlaying + ' offAir=' + event.isOffAir);
        loadingState.style.display = 'none';
        
        if (event.isOffAir) {
          showOffAir(event.resetHour);
          return;
        }
        
        if (!event.sessionActive) {
          showTvOff();
          return;
        }
        
        showTvOn();
        
        trackId = event.trackId;
        position = event.position;
        duration = event.duration;
        isPlaying = event.isPlaying;
        sessionRemainingMs = event.sessionRemainingMs;
        sessionLimitMs = event.sessionLimitMs || 0;
        sessionStartedAt = event.sessionStartedAt;
        
        trackTitle.textContent = cleanFilename(event.filename) || 'No video';
        updateThumbnail(event.trackId);
        updateProgressBar();
        updateStatusBadge();
        updateSessionDisplay();
        handleQueueUpdate(event);
        
        if (isPlaying) {
          startTimer();
          startSessionTimer();
        } else {
          stopTimer();
          stopSessionTimer();
        }
      }
      
      function handleTrackStart(event) {
        log('SSE', 'trackStart: ' + event.filename + ' dur=' + event.duration);
        trackId = event.trackId;
        position = 0;
        duration = event.duration;
        isPlaying = true;
        
        trackTitle.textContent = cleanFilename(event.filename);
        updateThumbnail(event.trackId);
        updateProgressBar();
        updateStatusBadge();
        startTimer();
        if (event.queue) {
          handleQueueUpdate(event);
        }
      }
      
      function handlePaused() {
        isPlaying = false;
        stopTimer();
        stopSessionTimer();
        updateStatusBadge();
      }
      
      function handlePlaying() {
        isPlaying = true;
        startTimer();
        startSessionTimer();
        updateStatusBadge();
      }
      
      function handleSessionStart(event) {
        sessionRemainingMs = event.sessionRemainingMs;
        showTvOn();
        startSessionTimer();
        if (event.queue) {
          handleQueueUpdate(event);
        }
      }
      
      function handleSessionEnd() {
        stopTimer();
        stopSessionTimer();
        showTvOff();
      }
      
      function handleQueueUpdate(event) {
        if (!event.queue || event.queue.length === 0) {
          queueSection.style.display = 'none';
          return;
        }
        
        queueSection.style.display = 'block';
        
        var totalSeconds = 0;
        var html = '';
        for (var i = 0; i < event.queue.length; i++) {
          var item = event.queue[i];
          totalSeconds += item.durationSeconds || 0;
          html += '<div class="queue-item' + (item.isInterlude ? ' queue-interlude' : '') + '">' +
            '<div class="queue-thumb" style="background-image: url(\\'/thumbnails/' + item.id + '.jpg\\')"></div>' +
            '<div class="queue-item-info">' +
              '<span class="queue-item-title">' + cleanFilename(item.filename) + '</span>' +
              '<span class="queue-item-duration">' + formatDuration(item.durationSeconds || 0) + '</span>' +
            '</div>' +
          '</div>';
        }
        
        queueList.innerHTML = html;
        queueTotal.textContent = event.queue.length + ' video' + (event.queue.length !== 1 ? 's' : '') + ' · ' + formatDuration(totalSeconds);
      }
      
      // --- UI State Transitions ---
      function showTvOff() {
        loadingState.style.display = 'none';
        tvOffState.style.display = 'block';
        tvOnState.style.display = 'none';
        offAirState.style.display = 'none';
        controlsBar.style.display = 'none';
        statusBar.className = 'status-bar off';
        statusDot.className = 'status-dot off';
        statusText.textContent = 'OFF';
        sessionRemaining.textContent = '';
        sessionProgressFill.style.width = '0%';
      }
      
      function showTvOn() {
        loadingState.style.display = 'none';
        tvOffState.style.display = 'none';
        tvOnState.style.display = 'block';
        offAirState.style.display = 'none';
        controlsBar.style.display = 'flex';
      }
      
      function showOffAir(resetHour) {
        loadingState.style.display = 'none';
        tvOffState.style.display = 'none';
        tvOnState.style.display = 'none';
        offAirState.style.display = 'block';
        controlsBar.style.display = 'none';
        statusBar.className = 'status-bar off-air';
        statusDot.className = 'status-dot off-air';
        statusText.textContent = 'OFF AIR';
        sessionRemaining.textContent = '';
        sessionProgressFill.style.width = '100%';
        if (resetHourEl) resetHourEl.textContent = resetHour + ':00';
      }
      
      // --- UI Updates ---
      function updateThumbnail(id) {
        if (id && nowPlayingImg) {
          nowPlayingImg.src = '/thumbnails/' + id + '.jpg';
          nowPlayingImg.alt = 'Now playing';
        }
      }
      
      function updateStatusBadge() {
        if (isPlaying) {
          statusBar.className = 'status-bar live';
          statusDot.className = 'status-dot live';
          statusText.textContent = 'ON AIR';
          playPauseIcon.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
        } else {
          statusBar.className = 'status-bar paused';
          statusDot.className = 'status-dot paused';
          statusText.textContent = 'PAUSED';
          playPauseIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
        }
      }
      
      function updateProgressBar() {
        var pct = duration > 0 ? (position / duration) * 100 : 0;
        progressFill.style.width = Math.min(100, pct) + '%';
        timeDisplay.textContent = formatTime(position) + ' / ' + formatTime(duration);
      }
      
      function updateSessionDisplay() {
        if (sessionRemainingMs <= 0 && sessionLimitMs > 0) {
          sessionRemaining.textContent = 'Ending Soon';
          sessionProgressFill.style.width = '100%';
          sessionProgress.className = 'session-progress critical';
          return;
        }
        
        if (sessionLimitMs <= 0) {
          // Unlimited session
          sessionRemaining.textContent = '∞';
          sessionProgressFill.style.width = '0%';
          sessionProgress.className = 'session-progress';
          return;
        }
        
        var mins = Math.floor(sessionRemainingMs / 60000);
        var secs = Math.floor((sessionRemainingMs % 60000) / 1000);
        sessionRemaining.textContent = mins + ':' + (secs < 10 ? '0' : '') + secs + ' left';
        
        var elapsed = sessionLimitMs - sessionRemainingMs;
        var pct = Math.min(100, (elapsed / sessionLimitMs) * 100);
        sessionProgressFill.style.width = pct + '%';
        
        if (mins < 5) {
          sessionProgress.className = 'session-progress critical';
        } else if (mins < 10) {
          sessionProgress.className = 'session-progress warning';
        } else {
          sessionProgress.className = 'session-progress';
        }
      }
      
      // --- Timers ---
      function startTimer() {
        stopTimer();
        timer = setInterval(function() {
          if (isPlaying && position < duration) {
            position++;
            updateProgressBar();
          }
        }, 1000);
      }
      
      function stopTimer() {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      }
      
      function startSessionTimer() {
        stopSessionTimer();
        sessionTimer = setInterval(function() {
          if (sessionRemainingMs > 0) {
            sessionRemainingMs -= 1000;
            updateSessionDisplay();
          }
        }, 1000);
      }
      
      function stopSessionTimer() {
        if (sessionTimer) {
          clearInterval(sessionTimer);
          sessionTimer = null;
        }
      }
      
      // --- Start ---
      connect();
    })();
  `
}
