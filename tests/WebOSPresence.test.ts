import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function functionSource(script: string, name: string, nextName: string): string {
  const start = script.indexOf(`function ${name}(`)
  const end = script.indexOf(`function ${nextName}(`, start + 1)
  if (start < 0 || end <= start) {
    throw new Error(`Could not isolate ${name}() before ${nextName}()`)
  }
  // core.autocrlf checks the bundle out with CRLF on Windows, so assertions
  // that span a line break only match after normalising.
  return script.slice(start, end).replace(/\r\n/g, '\n')
}

describe('LG webOS presence telemetry', () => {
  test('uses a stable local identity and sends only the public heartbeat fields', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )

    expect(script).toContain("var STORAGE_CLIENT_ID = 'toasttv.clientId.v1'")
    expect(script).toContain("'/api/client/v1/heartbeat'")
    expect(script).toContain("xhr.open('POST'")
    expect(script).toContain('clientId: state.clientId')
    expect(script).toContain('name: state.clientName')
    expect(script).toContain('channelId: channel ? channel.id : null')
    expect(script).toContain('playbackMode: mode')
    expect(script).not.toMatch(/(?:apiKey|authorization|password):\s*state\./i)
  })

  test('reports state changes as well as periodic liveness', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )

    expect(script).toContain('window.setInterval(sendPresenceHeartbeat, PRESENCE_INTERVAL_MS)')
    expect(script).toContain("return 'direct-play'")
    expect(script).toContain("return 'transcode'")
    expect(script).toContain("return 'buffering'")
    expect(script).toContain("return 'paused'")
    expect(script).toContain("return 'error'")
  })

  test('bounds dense guide rendering and reports a truncated server window', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )

    expect(script).toContain('var GUIDE_RENDER_LIMIT = 250')
    expect(script).toContain('matches.slice(0, GUIDE_RENDER_LIMIT)')
    expect(script).toContain('data.truncated === true')
    expect(script).toContain("'/guide?hours=24&from=' + fromMs")
    expect(script).not.toContain('/guide?hours=168')
    expect(script).not.toContain('calendar=1&from=')
    expect(script).toContain('formatTime(coverageEnd)')
  })

  test('renders a weekly catalog with channel rail, day strip, and tune-on-select', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )
    const markup = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'index.html'),
      'utf8'
    )
    const styles = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'styles.css'),
      'utf8'
    )

    expect(markup).toContain('id="catalogRail"')
    expect(markup).toContain('id="catalogDays"')
    expect(styles).toContain('.catalog-rail')
    expect(styles).toContain('.catalog-days')
    expect(script).toContain('function renderCatalogRail()')
    expect(script).toContain('function setCatalogChannel(')
    expect(script).toContain('var fromMs = catalogDayStart(dayIndex).getTime()')
    expect(script).toContain('function localCatalogDayStart(')
    expect(script).toContain('state.catalog.dayStarts = entry.dayStarts')
    expect(script).toContain('var cacheKey = guideDayCacheKey(catalog.channelId, fromMs)')
    expect(script).toContain('function getCachedGuideDay(channelId, fromMs)')
    expect(script).toContain('Date.now() - entry.fetchedAt >= GUIDE_CACHE_TTL_MS')
    expect(script).toContain('fetchedAt: Date.now()')
    expect(script).toContain('state.guideRequests[cacheKey] = requestRecord')
    expect(script).toContain('requestRecord.xhr = requestJson(')
    expect(script).toContain('state.guideCache[cacheKey] = entry')
    expect(script).toContain("state.catalog.channelId === channelId")
    expect(script).toContain('catalogDayStart(state.catalog.dayIndex).getTime() === fromMs')
    expect(script).toContain('function abortGuideRequestsExcept(cacheKey)')
    expect(script).toContain('request.xhr.abort()')
    expect(script).toContain('abortGuideRequestsExcept(cacheKey)')
    expect(script).toContain('abortGuideRequestsExcept(null)')
    expect(script).toContain('Loading the selected day…')
    expect(script).toContain('}, 140);')
    expect(script).toMatch(/renderCatalogDays\(\);[\s\S]{0,180}loadCatalogDay\(\);/)
    const setCatalogDay = script.slice(
      script.indexOf('function setCatalogDay'),
      script.indexOf('function shiftCatalogDay')
    )
    expect(setCatalogDay).not.toContain('renderCatalogDays()')
    expect(setCatalogDay).toContain("classList.toggle('is-active'")
    expect(script).toContain('shiftCatalogDay(code === 39 ? 1 : -1)')
    expect(script).toContain('shiftCatalogChannel(code === 33 || code === 427 ? 1 : -1)')
    // Selecting a program closes the overlay and tunes live from either view.
    expect(script).toContain('function selectGuideChannelLive(')
    expect(script).toContain("tuneChannel(targetIndex, returnView === 'channels')")
    expect(script).toContain("var sameChannel = returnView === 'player' && active && active.id === channelId")
    expect(styles).toContain('.guide-panel { position: absolute;')
    expect(styles).toContain('background: linear-gradient(to bottom, rgba(0, 0, 0, 0.10)')
    expect(markup).toContain('id="guideContext"')
    expect(markup.indexOf('</aside>')).toBeLessThan(markup.indexOf('id="channelOsd"'))
    // The old Now Playing overlay duplication is gone.
    expect(script).not.toContain('openNowOverlay')
    expect(markup).not.toContain('id="nowOverlay"')
  })

  test('prefetches bounded current-day guides once and reuses them when the EPG opens', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )

    expect(script).toContain('var GUIDE_CACHE_TTL_MS = 300000')
    expect(script).toContain('var GUIDE_PREFETCH_STAGGER_MS = 300')
    expect(script).toContain('guidePrefetchQueue: []')
    expect(script).toContain('scheduleGuidePrefetch(GUIDE_PREFETCH_DELAY_MS)')
    expect(script).toContain('scheduleGuidePrefetch(100)')
    expect(script).toContain('var fromMs = localCatalogDayStart(0).getTime()')
    expect(script).toContain('function runGuidePrefetch()')
    expect(script).toContain("state.overlay === 'guide' || Object.keys(state.guideRequests).length")
    expect(script).toContain('requestGuideDay(next.channelId, next.fromMs)')
    expect(script).toContain('function requestGuideDay(channelId, fromMs)')
    expect(script).toContain("'/guide?hours=24&from=' + fromMs")
    expect(script).toContain('var cached = getCachedGuideDay(catalog.channelId, fromMs)')
    expect(script).toContain('requestGuideDay(catalog.channelId, fromMs)')
    expect(script).toContain('var resumeSavedChannel = state.channels.length && !!readStorage(STORAGE_CHANNEL)')
    expect(script).toContain('if (!resumeSavedChannel) scheduleGuidePrefetch(GUIDE_PREFETCH_DELAY_MS)')
    const closeOverlayBody = script.slice(
      script.indexOf('function closeOverlays()'),
      script.indexOf('function openSetup()')
    )
    expect(closeOverlayBody).toContain('abortGuideRequestsExcept(null)')
    expect(closeOverlayBody).toContain('scheduleGuidePrefetch(GUIDE_PREFETCH_STAGGER_MS)')
  })

  test('backs off then retries a recovered stable HLS channel automatically', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )

    expect(script).toContain('var LIVE_STREAM_RETRY_DELAYS = [300, 750, 1500, 3000, 5000]')
    expect(script).toContain('var TUNING_STABLE_MS = 300')
    expect(script).toContain('var MIN_READY_BUFFER_SECONDS = 0.75')
    expect(script).toContain('var LIVE_EDGE_TOLERANCE_SECONDS = 3')
    expect(script).toContain('var LIVE_JOIN_BEHIND_SECONDS = 1.75')
    expect(script).toContain('scheduleLiveRetry(failedUrl, channel.id)')
    expect(script).toContain('state.failedLiveUrl = null')
    expect(script).toContain("beginTuning('Retrying the live channel…')")
    expect(script).toContain('seekHlsLiveEdge()')
    expect(script).toContain("'tune=' + encodeURIComponent(String(state.tuneGeneration))")
    expect(script).toContain('liveEdge - video.currentTime > DRIFT_LIMIT_SECONDS')
    expect(script).toContain('detachVideoForTune();')
    expect(script).toContain('window.ToastTVPlaybackPolicy.resetMediaElement(standbyVideo())')
    expect(script).toContain('standbyVideo().muted = true')
    expect(script).toContain('window.ToastTVPlaybackPolicy.loadMediaElement(tuneVideo(), source.url)')
    expect(script).toContain('window.ToastTVPlaybackPolicy.isPlaybackStable(video)')
    expect(script).toContain('function playbackHeadroomSeconds(video)')
    expect(script).toContain('event.currentTarget !== tuneVideo()')
    expect(script).toContain('video.muted = false')
    expect(script).toContain('if (!state.hlsSeekPending)')
    expect(script).toContain('generation !== state.tuneGeneration')
    expect(script).toContain('video !== tuneVideo()')
    expect(script).toContain("state.candidateSlot = state.videoSlot === 'A' ? 'B' : 'A'")
    expect(script).toContain('state.videoSlot = state.candidateSlot')
    expect(script).toContain("'&attach=' + encodeURIComponent(String(state.attachAttempt))")
    expect(script).not.toContain('LIVE_EDGE_LOCK_TIMEOUT_MS')
    expect(script).not.toContain("retryLiveStream('Tuning — reacquiring the live position…')")
    expect(script).not.toContain('cloneNode(false)')
    expect(script).not.toContain('Tuning — refreshing the live edge')
    expect(script).not.toContain('Live channel unavailable — trying direct playback')
    expect(script).toContain('scheduleBufferingRecovery(event.currentTarget)')
    expect(script).toContain('var BUFFERING_RECOVERY_MS = 6000')
    expect(script).toContain('(Number(video.currentTime) || 0) > sampledTime + 0.25')
    expect(script).toContain('state.bufferingPrepareFailures >= 2')
    expect(script).toContain("retryLiveStream('Rebuilding the live signal…')")
  })

  test('rejoins live after pause and escalates a healthy tuner with a dead decoder', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )
    const resumeBody = script.slice(
      script.indexOf('function resumeLive('),
      script.indexOf('function renderProgramInfo(')
    )
    const prepareBody = script.slice(
      script.indexOf('function prepareCurrentChannel('),
      script.indexOf('function normalizeServerUrl(')
    )
    const reproveBody = script.slice(
      script.indexOf('function reproveStableTunerAfterPrepare('),
      script.indexOf('function scheduleBufferingRecovery(')
    )
    const bufferingBody = script.slice(
      script.indexOf('function scheduleBufferingRecovery('),
      script.indexOf('function clearBufferingTimers(')
    )

    expect(resumeBody).toContain("state.activeSource.mode === 'channel-hls'")
    expect(resumeBody).toContain('state.hlsSeekPending = false')
    expect(resumeBody.indexOf('seekHlsLiveEdge()')).toBeLessThan(
      resumeBody.indexOf('attemptPlay(++state.playToken)')
    )
    expect(resumeBody).toContain('window.setTimeout(rejoinAfterResume, 300)')
    expect(resumeBody).toContain('window.setTimeout(rejoinAfterResume, 900)')
    expect(resumeBody).toContain('generation !== state.tuneGeneration')
    expect(resumeBody).toContain('state.activeSource.url !== sourceUrl')

    expect(script).toContain('var BUFFERING_REPROVE_MS = 1200')
    expect(prepareBody).toContain('function prepareCurrentChannel(onFailure, shouldContinue, onStableReady)')
    expect(prepareBody).toContain('if (onStableReady) onStableReady(generation)')
    expect(bufferingBody).toContain('reproveStableTunerAfterPrepare(video, generation, recoverySerial)')
    expect(reproveBody.indexOf('seekHlsLiveEdge()')).toBeLessThan(
      reproveBody.indexOf('var sampledTime = Number(video.currentTime) || 0')
    )
    expect(reproveBody).toContain('attemptPlay(++state.playToken)')
    expect(reproveBody).toContain('(Number(video.currentTime) || 0) > sampledTime + 0.25')
    expect(reproveBody).toContain('state.bufferingPrepareFailures += 1')
    expect(reproveBody).toContain('state.bufferingPrepareFailures >= 2')
    expect(reproveBody).toContain("retryLiveStream('Rebuilding the live signal…')")
    expect(reproveBody).toContain('scheduleBufferingRecovery(video)')
  })

  test('toggles the existing player chrome with OK without opening Now Playing', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )
    const markup = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'index.html'),
      'utf8'
    )

    expect(script).toContain("if (state.view === 'player' && code !== 13) showChrome();")
    expect(script).toContain('function toggleChrome()')
    expect(script).toContain("elements.playerScreen.classList.contains('chrome-hidden')")
    expect(script).toContain('else hideChrome();')
    expect(script).toContain('toggleChrome();')
    expect(script).not.toContain('else openNowOverlay()')
    expect(markup).toContain('<b class="remote-key">OK</b> show / hide info')
  })

  test('shows only server-advertised effective channel branding in player chrome', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )
    const markup = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'index.html'),
      'utf8'
    )
    const styles = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'styles.css'),
      'utf8'
    )

    expect(markup).toContain('id="playerChannelLogo"')
    expect(markup).toContain('id="playerChannelMonogram"')
    expect(markup).toContain('class="player-channel-logo hidden"')
    expect(script).toContain('var branding = data && data.branding;')
    expect(script).toContain("branding.enabled !== true")
    expect(script).toContain("typeof branding.logoUrl !== 'string'")
    expect(script).toContain(
      'window.ToastTVPlaybackPolicy.resolveUrl(branding.logoUrl, state.serverUrl)'
    )
    expect(script).toContain("elements.playerChannelLogo.classList.add('hidden')")
    expect(script).toContain('renderChannelLogo(data, channel);')
    expect(styles).toContain('.player-channel-logo')
    expect(styles).toContain('.player-channel__identity')
    expect(styles).toContain('object-fit: contain')
  })

  test('reconciles channel lineup changes in the background without hidden video decoders', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )

    expect(script).toContain('var CHANNEL_REFRESH_INTERVAL_MS = 15000')
    expect(script).toContain('var SCHEDULE_REFRESH_INTERVAL_MS = 60000')
    expect(script).toContain('window.setInterval(refreshChannelList, CHANNEL_REFRESH_INTERVAL_MS)')
    expect(script).toContain('restoreChannelIndexById(')
    expect(script).toContain("showToast('That channel left the lineup")
    expect(script).toContain("state.view === 'channels') hydrateChannelCards()")
    expect(script).toContain('reconcileOpenCatalog();')
    expect(script).toContain("state.overlay !== 'guide' || !state.catalog")
    const renderChannels = script.slice(
      script.indexOf('function renderChannels()'),
      script.indexOf('function createChannelCard(')
    )
    expect(renderChannels).toContain("if (state.view !== 'channels' || state.overlay) return;")
    expect(script).toContain('active.offsetParent !== null')
    expect(script).not.toMatch(/createElement\(['"]video['"]\)/)
  })

  test('relies on the server lineup session instead of adjacent warm calls', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )

    expect(script).toContain("'/api/client/v1/session'")
    expect(script).toContain("'/api/client/v1/session/close'")
    expect(script).toContain('navigator.sendBeacon')
    expect(script).toContain("if (state.view === 'player') reopenLineupSession()")
    expect(script).toContain('if (state.lineupOpening || state.launchCancelled')
    expect(script).not.toContain('else if (state.channels.length) startTelevision()')
    expect(script).toContain('if (document.hidden) return')
    expect(script).not.toContain('/api/client/v1/channels/warm')
    expect(script).not.toContain('scheduleAdjacentWarm')
    expect(script).not.toContain('ADJACENT_WARM_REFRESH_MS')
  })

  test('warms the highlighted channel through the lineup session while browsing', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )
    const warmBody = functionSource(
      script,
      'warmHighlightedChannel',
      'retargetLineupSession'
    )
    const selectBody = functionSource(
      script,
      'selectChannelPreview',
      'resetChannelPreview'
    )
    const flushBody = functionSource(
      script,
      'flushLineupRetarget',
      'attemptPlay'
    )

    /* The encoder cold start is the bulk of a zap on an economy-tier server.
       Starting it while the viewer is still moving the highlight hides it
       behind their own navigation instead of after they press OK. */
    expect(selectBody).toContain('warmHighlightedChannel(state.previewChannelIndex)')
    expect(script).toContain('var WARM_HIGHLIGHT_DELAY_MS = 350')

    // Holding an arrow key through the lineup must not queue a retarget per row.
    expect(warmBody).toContain('clearWarmHighlight();')
    expect(warmBody).toContain('WARM_HIGHLIGHT_DELAY_MS')
    // Never spend a retarget on the channel the lineup already prefers.
    expect(warmBody).toContain('channel.id === state.lineupPreferredChannelId')
    // The viewer may have moved on, or left, during the settle delay.
    expect(warmBody).toContain("state.view !== 'channels'")
    expect(warmBody).toContain('highlighted.id !== channel.id')
    expect(warmBody).toContain('flushLineupRetarget();')
    // Warming reuses the lineup lease, never a second per-channel endpoint.
    expect(warmBody).not.toContain("'/api/client/v1/channels/")

    // A highlight that moves while a retarget is in flight still gets sent.
    expect(flushBody).toContain("state.view !== 'channels' &&")
  })

  test('auto-starts the last channel and prepares zaps before replacing video', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )
    const markup = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'index.html'),
      'utf8'
    )

    expect(script).toContain("'/api/client/v1/session'")
    expect(script).toContain("'/api/client/v1/session/close'")
    expect(script).toContain("'/api/client/v1/channels/' + encodeURIComponent(channel.id) + '/prepare'")
    expect(script).toContain('var ZAP_DEBOUNCE_MS = 80')
    expect(script).toContain('function commitPreparedChannel(')
    expect(script.indexOf('function prepareChannel(')).toBeLessThan(
      script.indexOf('function commitPreparedChannel(')
    )
    expect(script).toContain('writeStorage(STORAGE_CHANNEL, currentChannel().id)')
    expect(script).toContain('retargetLineupSession(currentChannel().id, generation)')
    expect(script).toContain('if (!state.serverUrl || state.lineupRetargetInFlight || !state.lineupDesiredChannelId) return;')
    expect(script).toContain('if (state.lineupPreferredChannelId === state.lineupDesiredChannelId) return;')
    /* The retarget chain now continues while browsing as well, so the guard
       is split: bail on a failed apply, then on views that cannot chain. */
    expect(script).toContain('if (!applied) return;')
    expect(script).toContain("(state.view !== 'player' || !state.hasCommittedVideo)) return;")
    expect(script).toContain('state.lineupPreferredChannelId = data.channel.id')
    expect(script).toContain("data.status !== 'ready'")
    expect(script).toContain("'Looking for ToastTV — reconnecting…'")
    expect(script).toContain("console.log('[ToastTV Tune]")
    expect(script).toContain('function nextAvailableChannelIndex(')
    expect(markup).toContain('id="bootScreen"')
    expect(markup).toContain('id="channelOsd"')
  })

  test('uses a ten-foot channel browser and deterministic player navigation', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )
    const markup = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'index.html'),
      'utf8'
    )
    const styles = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'styles.css'),
      'utf8'
    )

    expect(markup).toContain('id="channelPreview"')
    expect(markup).toContain('id="channelPreviewLogo"')
    expect(markup).not.toContain('id="channelWatchButton"')
    expect(markup).not.toContain('>Watch live<')
    expect(markup).toContain('id="channelPreviewNext2"')
    expect(markup).toContain('id="channelPreviewNext3"')
    expect(markup).toContain('<b class="remote-key">OK</b> tune channel')
    expect(markup).toContain('id="bootBrowseButton"')
    expect(markup).toContain('role="dialog"')
    expect(styles).toContain('.channel-browser')
    expect(styles).toContain('.channel-rail-shell')
    expect(styles).toContain('.channel-preview')
    expect(styles).not.toContain('.channel-card:nth-child')
    expect(script).toContain('channelNow: {}')
    expect(script).toContain("'/api/v1/channels/schedule'")
    expect(script).toContain('function selectChannelPreview(')
    expect(script).toContain('function resetChannelPreview()')
    expect(script).not.toContain('channelWatchButton')
    expect(script).toContain("button.addEventListener('click', function () { tuneChannel(index, true); }")
    expect(script).toContain('function renderChannelPreviewUpcoming(')
    expect(script).toContain('function appendUpcomingPrograms(')
    expect(script).toContain('programs.length < 3')
    expect(script).toContain('var tomorrowStart = localCatalogDayStart(1).getTime()')
    expect(script).toContain('requestGuideDay(channel.id, tomorrowStart)')
    expect(script).toContain('previewChannel.id === channelId')
    expect(script).toContain('elements.channelGuideButton.disabled = true')
    expect(script).toContain('function openChannelBrowser()')
    expect(script).toContain("if (code === 40) { event.preventDefault(); openChannelBrowser(); return; }")
    expect(script).toContain("code === 39 && channelFocus && elements.channelGrid.contains(channelFocus)")
    expect(script).toContain('focusNode(elements.channelGuideButton)')
    expect(script).toContain("code === 37 && channelFocus === elements.channelGuideButton")
    expect(script).toContain("'[data-channel-index=\"' + state.previewChannelIndex + '\"]'")
    expect(script).toContain("elements.errorBackButton.addEventListener('click', openChannelBrowser")
    expect(script).toContain("if (state.view === 'player' || (state.view === 'setup' && state.setupFromChannels))")
    expect(script).toContain("var returnThroughHistory = (state.view === 'player' && state.playerEnteredFromChannels)")
    expect(script).not.toContain("safePushHistory({ view: state.view, overlay: 'guide' })")
  })

  test('releases the outgoing LG decoder before the candidate advances', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )
    const markup = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'index.html'),
      'utf8'
    )
    const styles = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'styles.css'),
      'utf8'
    )
    const captureBody = script.slice(
      script.indexOf('function captureTuningFreezeFrame()'),
      script.indexOf('function clearTuningFreezeFrame()')
    )
    const clearFreezeBody = script.slice(
      script.indexOf('function clearTuningFreezeFrame()'),
      script.indexOf('function connectToServer(')
    )
    const detachStart = script.indexOf('function detachVideoForTune()')
    const rollbackStart = script.indexOf('function rollbackCandidateTune(')
    const detachBody = script.slice(detachStart, rollbackStart)
    const prepareStart = script.indexOf('function prepareChannel(')
    const commitStart = script.indexOf('function commitPreparedChannel(')
    const prepareBody = script.slice(prepareStart, commitStart)
    const commitBody = script.slice(
      commitStart,
      script.indexOf('function recoverRejectedTune(')
    )
    const rollbackBody = script.slice(
      script.indexOf('function rollbackCandidateTune('),
      script.indexOf('function retryLiveStream(')
    )
    const tuneBody = script.slice(
      script.indexOf('function tuneChannel('),
      prepareStart
    )
    const stableCheck = script.indexOf('window.ToastTVPlaybackPolicy.isPlaybackStable(video)')
    const slotCommit = script.indexOf('state.videoSlot = state.candidateSlot')
    const stableCommitBody = script.slice(
      script.indexOf('function commitStableTunerChannel('),
      script.indexOf('function recoverRejectedStableTunerTune(')
    )
    const stabilizeBody = script.slice(
      script.indexOf('function stabilizeTuning()'),
      script.indexOf('function clearTuningTimer(')
    )
    const waitingBody = script.slice(
      script.indexOf('function handleVideoWaiting('),
      script.indexOf('function activeVideo(')
    )
    const abandonBody = script.slice(
      script.indexOf('function abandonCandidateTune('),
      script.indexOf('function rollbackCandidateTune(')
    )
    const invalidateBody = script.slice(
      script.indexOf('function invalidateRemovedCommittedPlayback('),
      script.indexOf('function reconcileOpenCatalog(')
    )

    expect(detachBody).toContain("state.candidateSlot = state.videoSlot === 'A' ? 'B' : 'A'")
    expect(detachBody).not.toContain("state.videoSlot = state.videoSlot === 'A' ? 'B' : 'A'")
    expect(detachBody).toContain('activeVideo().muted = true')
    expect(detachBody).toContain('window.ToastTVPlaybackPolicy.resetMediaElement(activeVideo())')
    expect(detachBody).toContain('state.hasCommittedVideo = false')
    expect(captureBody).toContain('if (!hasCrossChannelHandoff()) return;')
    expect(captureBody).toContain("classList.add('is-zapping')")
    expect(captureBody).toContain("canvas.classList.add('is-visible')")
    expect(captureBody.indexOf("canvas.classList.add('is-visible')")).toBeLessThan(
      captureBody.indexOf('context.drawImage(')
    )
    expect(captureBody).toContain("canvas.getContext('2d')")
    expect(captureBody).toContain('context.drawImage(')
    expect(captureBody).toContain('catch (ignoreFreezeFrame)')
    expect(clearFreezeBody).toContain("classList.remove('is-zapping')")
    expect(clearFreezeBody).toContain("canvas.classList.remove('is-visible')")
    expect(clearFreezeBody).toContain('canvas.width = 1')
    expect(detachBody.indexOf('captureTuningFreezeFrame();')).toBeLessThan(
      detachBody.indexOf('window.ToastTVPlaybackPolicy.resetMediaElement(activeVideo())')
    )
    /* The stable re-attach delegates the whole outgoing release to
       detachVideoForTune(). Muting in place would leave LG's old pipeline
       running and draining that channel's audio under the tuning backdrop. */
    expect(stableCommitBody).not.toContain('activeVideo().muted = true')
    expect(stableCommitBody.indexOf('detachVideoForTune();')).toBeLessThan(
      stableCommitBody.indexOf('applyNowResult(now, timing, requiresStableHandoff)')
    )
    expect(stabilizeBody.indexOf("classList.add('has-video')")).toBeLessThan(
      stabilizeBody.indexOf('clearTuningFreezeFrame();')
    )
    expect(waitingBody).toContain('stabilizeTuning();')
    expect(stabilizeBody).toMatch(
      /if \(!window\.ToastTVPlaybackPolicy\.isPlaybackStable\(video\)\)[\s\S]{0,420}state\.frameProbeAttempts >= TUNING_PROBE_LIMIT[\s\S]{0,260}setTimeout\(stabilizeTuning, TUNING_STABLE_MS\)/
    )
    expect(invalidateBody).toMatch(
      /if \(preserveCandidate\) return;\s*clearTuningFreezeFrame\(\);/
    )
    expect(abandonBody).not.toContain('clearTuningFreezeFrame();')
    for (const lifecycleFunction of [
      'recoverRejectedStableTunerTune',
      'disableStableTunerAndReload',
      'recoverStableTunerPlayback',
      'showOffAir',
      'showPlaybackError',
      'stopPlayback',
    ]) {
      const lifecycleStart = script.indexOf(`function ${lifecycleFunction}(`)
      const lifecycleEnd = script.indexOf('\n  function ', lifecycleStart + 1)
      expect(script.slice(lifecycleStart, lifecycleEnd)).toContain('clearTuningFreezeFrame();')
    }
    expect(slotCommit).toBeGreaterThan(stableCheck)
    expect(script).toContain('var TUNING_PROBE_LIMIT = 20')
    expect(script).toContain('state.frameProbeAttempts >= TUNING_PROBE_LIMIT')
    expect(script).toContain('rollbackCandidateTune();')
    expect(prepareBody).toMatch(/data\.status !== 'ready'[\s\S]{0,240}resolvePreparedChannel\(/)
    expect(commitBody).toContain("recoverRejectedTune(index, 'That channel is no longer available.')")
    expect(commitBody).toContain('var preparedOffAir = prepared && prepared.data && prepared.data.program === null')
    expect(prepareBody).toContain('function createOfflineNowResult(channel)')
    expect(prepareBody).toContain("state.channels[offlineIndex].onAir === false")
    expect(prepareBody).toContain('data: createOfflineNowResult(state.channels[offlineIndex])')
    expect(rollbackBody).toContain('if (previousIndex < 0)')
    expect(rollbackBody).toContain('state.hasCommittedVideo = false')
    expect(rollbackBody).toContain('return false')
    expect(rollbackBody).toContain('if (state.currentNow && !state.currentNow.program)')
    expect(rollbackBody).toContain('showOffAir(state.currentNow.next)')
    expect(rollbackBody.indexOf('showOffAir(state.currentNow.next)')).toBeLessThan(
      rollbackBody.indexOf(
        "beginTuning('Returning to the previous channel…')",
        rollbackBody.indexOf('showOffAir(state.currentNow.next)')
      )
    )
    expect(tuneBody).toContain("state.view === 'player' && state.tuning && !state.hasCommittedVideo")
    expect(tuneBody).toMatch(/!state\.hasCommittedVideo\s*&&\s*!state\.previousTune/)
    expect(tuneBody).toContain('abandonCandidateTune();')
    expect(tuneBody).toContain("showChannelOsd(targetIndex, 'Tuning…', true)")
    expect(tuneBody).toMatch(
      /if \(isChannelChange\) \{[\s\S]{0,420}captureTuningFreezeFrame\(\);[\s\S]{0,160}showChannelOsd/
    )
    expect(script).toContain("if (state.view === 'player' && !restored) openChannelBrowser()")
    expect(script).toContain("updateChannelOsdProgram('Checking off-air schedule…')")
    expect(script).toContain('state.activeSource.baseUrl === baseStreamUrl')
    expect(script).toContain('if (!forceReload && state.activeSource')
    expect(script).toContain("setPlayerStatus('Playing live — schedule update delayed')")
    expect(script).toContain("if (!state.localPaused && !state.tuning) setPlayerStatus('Playing live')")
    expect(script).toContain('scheduleChannelOsdHide();')
    expect(markup).toContain('id="tuningFreezeFrame"')
    expect(markup).toContain('id="channelOsd" class="channel-osd" role="status" aria-live="polite"')
    expect(styles).toContain('.tuning-freeze-frame.is-visible { display: block; }')
    expect(styles).toContain('.player-screen.is-zapping .player-backdrop__brand')
    expect(styles).toContain('.player-screen.is-zapping .tuning-panel')
    expect(styles).toContain('transform: translate(-50%, -15px)')
  })

  test('opens the guide over live TV or the channel browser and resolves streams before decoder handoff', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )
    const styles = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'styles.css'),
      'utf8'
    )
    const openGuideBody = script.slice(
      script.indexOf('function openGuideForChannel('),
      script.indexOf('function catalogChannels(')
    )
    const selectBody = script.slice(
      script.indexOf('function selectGuideChannelLive('),
      script.indexOf('function renderOverlayState(')
    )
    const resolveBody = script.slice(
      script.indexOf('function resolvePreparedChannel('),
      script.indexOf('function commitPreparedChannel(')
    )
    const commitBody = script.slice(
      script.indexOf('function commitPreparedChannel('),
      script.indexOf('function recoverRejectedTune(')
    )
    const renderInfoBody = script.slice(
      script.indexOf('function renderProgramInfo('),
      script.indexOf('function renderChannelLogo(')
    )
    const goBackBody = script.slice(
      script.indexOf('function goBack('),
      script.indexOf('function openChannelBrowser(')
    )

    expect(openGuideBody).toContain("state.view !== 'player' && state.view !== 'channels'")
    expect(openGuideBody).toContain('originChannelId: origin ? origin.id : channel.id')
    expect(openGuideBody).toContain('returnView: returnView || state.view')
    expect(goBackBody).toMatch(/state\.overlay === 'guide'[\s\S]{0,240}closeOverlays\(\)/)
    expect(goBackBody.indexOf('closeOverlays()')).toBeLessThan(goBackBody.indexOf('openChannelBrowser()'))
    expect(goBackBody).toContain('if (cancelPendingChannelChange()) return;')
    expect(script).toContain('function cancelPendingChannelChange()')
    expect(goBackBody).toContain("var stayInBrowser = state.view === 'channels';")
    expect(goBackBody).toMatch(/if \(stayInBrowser\) \{[\s\S]{0,100}return true;/)
    expect(goBackBody).toContain("showToast('Guide opening cancelled.')")
    expect(script).toContain("updateChannelOsdProgram('Switch cancelled')")
    expect(goBackBody).toContain('var guideReturnChannelId = state.catalog && state.catalog.channelId')
    expect(goBackBody).toContain("guideReturnView === 'channels'")
    expect(goBackBody).toContain("'[data-channel-id=\"' + escapeAttribute(guideReturnChannelId) + '\"]'")
    expect(selectBody).toContain('closeOverlays();')
    expect(selectBody).toContain('if (sameChannel)')
    expect(selectBody).toContain("tuneChannel(targetIndex, returnView === 'channels')")
    expect(resolveBody).toContain("'/now'")
    expect(resolveBody).toContain('verifyPreparedManifest(source.url')
    expect(resolveBody).toContain('segments >= 2')
    expect(resolveBody).toContain('commitPreparedChannel(channelId, generation, pushHistory')
    expect(commitBody.indexOf("updateChannelOsdProgram('Switching…')")).toBeLessThan(
      commitBody.indexOf('detachVideoForTune();')
    )
    expect(commitBody).toContain('applyNowResult(prepared.data, prepared.timing, true)')
    expect(commitBody).toContain('if (state.committedChannelId && !state.previousTune)')
    expect(renderInfoBody).toContain(
      'if (state.tuning && (state.previousTune || state.candidateChannelId)) return;'
    )
    expect(styles).toContain('.channel-osd { position: fixed; z-index: 70;')
    expect(styles).toContain('top: 28px; right: auto; left: 50%;')
    expect(styles).toContain('.player-screen.guide-open .player-info')
  })

  test('opens the cached browser guide immediately and tunes only after a program is selected', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )
    const browserGuideBody = script.slice(
      script.indexOf('function openGuideFromChannelBrowser('),
      script.indexOf('function openGuideForChannel(')
    )
    const openGuideBody = script.slice(
      script.indexOf('function openGuideForChannel('),
      script.indexOf('function catalogChannels(')
    )
    const selectBody = script.slice(
      script.indexOf('function selectGuideChannelLive('),
      script.indexOf('function renderOverlayState(')
    )
    const reconcileBody = script.slice(
      script.indexOf('function reconcileChannelList('),
      script.indexOf('function invalidateRemovedCommittedPlayback(')
    )
    expect(browserGuideBody).toContain("openGuideForChannel(state.previewChannelIndex, 'channels')")
    expect(browserGuideBody).not.toContain('tuneChannel(')
    expect(openGuideBody).toContain('returnView: returnView || state.view')
    expect(selectBody).toContain("var returnView = state.catalog.returnView || state.view")
    expect(selectBody).toContain("tuneChannel(targetIndex, returnView === 'channels')")
    expect(script).not.toContain('pendingGuideChannelId')
    expect(script).not.toContain('openPendingGuideAfterCommit')

    // Lineup refresh still reconciles committed playback independently.
    expect(reconcileBody).toContain('var committedChannelId = state.committedChannelId')
    expect(reconcileBody).toContain('if (state.candidateChannelId)')
    expect(reconcileBody).toContain(
      'state.candidateChannelId || (committedAvailable ? committedChannelId : state.requestedChannelId)'
    )
    expect(reconcileBody).toContain('if (committedChannelId && !committedAvailable)')
    expect(reconcileBody).toContain('invalidateRemovedCommittedPlayback(!!state.candidateChannelId)')
  })

  test('keeps remote focus usable for off-air, guide, and tune transitions', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )
    const offAirBody = script.slice(
      script.indexOf('function showOffAir('),
      script.indexOf('function hideOffAir(')
    )
    const pauseBody = script.slice(
      script.indexOf('function pauseLocally()'),
      script.indexOf('function resumeLive()')
    )
    const keyBody = script.slice(
      script.indexOf('function handleKeyDown('),
      script.indexOf('function moveFocus(')
    )
    const nextBody = script.slice(
      script.indexOf('function nextAvailableChannelIndex('),
      script.indexOf('function restoreChannelIndex(')
    )
    const reconcileBody = script.slice(
      script.indexOf('function reconcileChannelList('),
      script.indexOf('function invalidateRemovedCommittedPlayback(')
    )

    expect(offAirBody).toContain('focusNode(elements.offAirGuideButton)')
    expect(keyBody).toContain("if (code === 37) { event.preventDefault(); switchChannel(-1); return; }")
    expect(keyBody).toContain("if (code === 39) { event.preventDefault(); switchChannel(1); return; }")
    expect(keyBody).not.toContain("elements.offAirPanel.classList.contains('hidden')")
    expect(nextBody).toContain('state.channels[candidate].enabled !== false')
    expect(nextBody).not.toContain('.onAir')
    expect(reconcileBody).toContain('var committedAvailable = committedIndex >= 0 && channels[committedIndex].enabled !== false')
    expect(reconcileBody).not.toMatch(/channels\[(?:requestedIndex|candidateIndex|committedIndex)\]\.onAir/)
    expect(script).toContain('rememberedNow.program === null')
    expect(pauseBody).toContain('if (state.tuning)')
    expect(pauseBody.indexOf('if (state.tuning)')).toBeLessThan(
      pauseBody.indexOf('state.localPaused = true')
    )
    expect(script).toContain('state.guideCache = {}')
  })

  test('owns each tuner session with a launch-local epoch and validates reused descriptors', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )
    const bootBody = script.slice(
      script.indexOf('function boot('),
      script.indexOf('function cacheElements(')
    )
    const startBody = script.slice(
      script.indexOf('function startTelevision('),
      script.indexOf('function closeLineupSession(')
    )
    const closeBody = script.slice(
      script.indexOf('function closeLineupSession('),
      script.indexOf('function reopenLineupSession(')
    )
    const switchBody = script.slice(
      script.indexOf('function postStableTunerSwitch('),
      script.indexOf('function committedStableTunerFeedChannelId(')
    )
    const retargetBody = script.slice(
      script.indexOf('function flushLineupRetarget('),
      script.indexOf('function attemptPlay(')
    )
    const ownerBody = script.slice(
      script.indexOf('function createSessionOwnerId('),
      script.indexOf('function getClientName(')
    )

    expect(bootBody).toContain('state.sessionOwnerId = createSessionOwnerId()')
    expect(bootBody).toContain('state.sessionOwnerEpoch = nextSessionOwnerEpoch()')
    expect(bootBody).toContain('writeStorage(STORAGE_SESSION_OWNER, state.sessionOwnerId)')
    expect(bootBody).toContain('writeStorage(STORAGE_SESSION_OWNER_EPOCH, String(state.sessionOwnerEpoch))')
    expect(ownerBody).toContain("return 'launch-' + Date.now().toString(36) + '-' + randomPart")
    expect(ownerBody).toContain('return Math.max(Date.now(), previous + 1)')
    expect(startBody).toContain(
      '{ clientId: state.clientId, ownerId: state.sessionOwnerId, ownerEpoch: state.sessionOwnerEpoch, lastChannelId: savedChannelId, lineup: true, tuner: true }'
    )
    expect(closeBody).toContain('var closePayload = { clientId: state.clientId, ownerId: state.sessionOwnerId, ownerEpoch: state.sessionOwnerEpoch }')
    expect(closeBody).toContain('if (state.tuner) closePayload.sessionId = state.tuner.sessionId')
    expect(switchBody).toContain("state.serverUrl + '/api/client/v1/session/tune'")
    expect(switchBody).toContain('ownerId: state.sessionOwnerId')
    expect(switchBody).toContain('ownerEpoch: state.sessionOwnerEpoch')
    expect(switchBody).toContain('sessionId: state.tuner.sessionId')
    expect(switchBody).toContain('requestId: requestId')
    expect(retargetBody).toContain('ownerId: state.sessionOwnerId')
    expect(retargetBody).toContain('ownerEpoch: state.sessionOwnerEpoch')

    expect(script).toContain("tunerCapability: 'unknown'")
    expect(script).toContain("tuner.mode !== 'stable-hls'")
    expect(script).toContain("!/^[a-f0-9-]{36}$/i.test(tuner.sessionId)")
    expect(script).toContain('typeof tuner.requestIdFloor')
    expect(script).toContain('tuner.requestIdFloor > 9007199254740991')
    expect(script).toContain('state.tunerRequestSerial = Math.max(state.tunerRequestSerial, tuner.requestIdFloor)')
    expect(script).toMatch(/state\.tunerRequestSerial = window\.ToastTVPlaybackPolicy\.nextTunerRequestId\([\s\S]{0,180}var requestId = state\.tunerRequestSerial;/)
    expect(script).toContain('tuner.sessionId !== state.tuner.sessionId')
    expect(script).toContain('tuner.manifestUrl !== state.tuner.manifestUrl')
  })

  test('routes every acquired tuner zap through the tuner and adopts only its matching channel', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )
    const tuneSelectionBody = functionSource(
      script,
      'tuneChannel',
      'openStableTunerForChannel'
    )
    const sourceBody = functionSource(
      script,
      'playbackSourceForNow',
      'hasAttachedStableTunerSource'
    )

    expect(tuneSelectionBody).toMatch(
      /if \(state\.tuner\) \{[\s\S]*?tuneStableTunerChannel\(channel\.id, generation, pushHistory\);[\s\S]*?return;/
    )
    expect(tuneSelectionBody).not.toContain(
      'state.tuner && (hasAttachedStableTunerSource() || !state.hasCommittedVideo)'
    )
    expect(tuneSelectionBody).toContain(
      "if (!state.tuner && state.tunerCapability !== 'incompatible'"
    )
    expect(tuneSelectionBody.indexOf('if (state.tuner)')).toBeLessThan(
      tuneSelectionBody.indexOf('openStableTunerForChannel(channel.id')
    )
    expect(tuneSelectionBody.indexOf('openStableTunerForChannel(channel.id')).toBeLessThan(
      tuneSelectionBody.indexOf('prepareChannel(channel.id')
    )

    expect(sourceBody).toMatch(
      /window\.ToastTVPlaybackPolicy\.canAdoptTuner\(\s*state\.tuner\.channelId,\s*data\.channelId,\s*hasAttachedStableTunerSource\(\),\s*state\.hasCommittedVideo,\s*state\.candidateChannelId,\s*state\.requestedChannelId\s*\)/
    )
    expect(sourceBody).toContain('if (tunerCanBeAdopted) return stableTunerPlaybackSource()')
    expect(sourceBody.indexOf('canAdoptTuner(')).toBeLessThan(
      sourceBody.indexOf('if (tunerCanBeAdopted)')
    )
    expect(sourceBody).not.toContain('if (data && data.program && state.tuner)')
  })

  test('retries tunerError acquisition in the background with capped backoff', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )
    const startBody = functionSource(script, 'startTelevision', 'closeLineupSession')
    const statusBody = functionSource(
      script,
      'tunerFailureMessage',
      'stableTunerResponseMatches'
    )
    const retryBody = functionSource(
      script,
      'retryStableTunerInBackground',
      'stableTunerResponseMatches'
    )
    const setBody = functionSource(script, 'setStableTuner', 'tunerFailureMessage')

    expect(script).toContain('var TUNER_RETRY_DELAYS = [2000, 5000, 15000, 30000]')
    expect(startBody).toContain("markStableTunerUnavailable(data, 'startup')")
    expect(statusBody).toContain('data.tunerError && data.tunerError.message')
    expect(statusBody).toContain("state.tunerCapability = 'unavailable'")
    expect(statusBody).toContain('scheduleStableTunerRetry()')
    expect(statusBody).toContain(
      'Math.min(state.tunerRetryAttempt, TUNER_RETRY_DELAYS.length - 1)'
    )
    expect(statusBody).toContain(
      'tunerRetryTimer = window.setTimeout(retryStableTunerInBackground, delay)'
    )

    expect(retryBody).toContain("state.tunerCapability === 'incompatible'")
    expect(retryBody).toContain('state.tuning || state.requestedChannelId')
    expect(retryBody).toContain('!state.hasCommittedVideo')
    expect(retryBody).toContain('state.committedChannelId !== channel.id')
    expect(retryBody).toContain('lineup: true, tuner: true')
    expect(retryBody).toContain("markStableTunerUnavailable(data, 'background retry', error)")
    expect(retryBody).toContain('setStableTuner(recovered)')
    expect(retryBody).toContain("state.tunerCapability = 'available'")
    expect(retryBody.indexOf('state.tuning || state.requestedChannelId')).toBeLessThan(
      retryBody.indexOf('postJson(')
    )

    expect(setBody).toContain('state.tunerRetryAttempt = 0')
    expect(setBody).toContain('clearStableTunerRetry()')
  })

  test('uses a thirty-second budget for tuner acquisition, switching, and recovery', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )
    const tunerRequestBodies = [
      functionSource(script, 'startTelevision', 'closeLineupSession'),
      functionSource(script, 'reopenLineupSession', 'stableTunerFromResponse'),
      functionSource(script, 'retryStableTunerInBackground', 'stableTunerResponseMatches'),
      functionSource(script, 'postStableTunerSwitch', 'committedStableTunerFeedChannelId'),
      functionSource(script, 'openStableTunerForChannel', 'resolveStableTunerOffAir'),
      functionSource(script, 'recoverStableTunerPlayback', 'prepareChannel'),
    ]

    expect(script).toContain('var TUNER_REQUEST_TIMEOUT_MS = 30000')
    for (const body of tunerRequestBodies) {
      expect(body).toContain('TUNER_REQUEST_TIMEOUT_MS')
    }
  })

  test('holds a zap transition frame until revisioned playback proves the target', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )
    const tuneSelectionBody = script.slice(
      script.indexOf('function tuneChannel('),
      script.indexOf('function openStableTunerForChannel(')
    )
    const stableTuneBody = script.slice(
      script.indexOf('function tuneStableTunerChannel('),
      script.indexOf('function resolveStableTunerNow(')
    )
    const stableCommitBody = script.slice(
      script.indexOf('function commitStableTunerChannel('),
      script.indexOf('function recoverRejectedStableTunerTune(')
    )
    const stableRestoreBody = script.slice(
      script.indexOf('function restoreCommittedStableTuner('),
      script.indexOf('function showChannelStartupFailure(')
    )
    const feedBody = script.slice(
      script.indexOf('function committedStableTunerFeedChannelId('),
      script.indexOf('function restoreCommittedStableTuner(')
    )
    const restartBody = script.slice(
      script.indexOf('function restartPendingStableTunerHandoff('),
      script.indexOf('function rollbackAcceptedStableTunerTune(')
    )
    const rollbackBody = script.slice(
      script.indexOf('function rollbackCandidateTune('),
      script.indexOf('function retryLiveStream(')
    )
    const stabilizeBody = script.slice(
      script.indexOf('function stabilizeTuning('),
      script.indexOf('function playbackHeadroomSeconds(')
    )
    const applyBody = script.slice(
      script.indexOf('function applyNowResult('),
      script.indexOf('function loadProgram(')
    )
    const metadataSyncBody = script.slice(
      script.indexOf('function scheduleStableTunerMetadataSync('),
      script.indexOf('function tuneSessionUrl(')
    )
    const cancelBody = script.slice(
      script.indexOf('function cancelPendingChannelChange('),
      script.indexOf('function openChannelBrowser(')
    )
    const openBrowserBody = script.slice(
      script.indexOf('function openChannelBrowser('),
      script.indexOf('function cancelConnectionAttempt(')
    )
    const reconcileBody = script.slice(
      script.indexOf('function reconcileChannelList('),
      script.indexOf('function invalidateRemovedCommittedPlayback(')
    )

    const inPlaceBeginBody = functionSource(
      script,
      'beginInPlaceStableTunerHandoff',
      'probeInPlaceStableTunerHandoff'
    )
    const inPlaceProbeBody = functionSource(
      script,
      'probeInPlaceStableTunerHandoff',
      'finishInPlaceStableTunerHandoff'
    )
    const inPlaceFinishBody = functionSource(
      script,
      'finishInPlaceStableTunerHandoff',
      'fallbackInPlaceStableTunerHandoff'
    )
    const inPlaceFallbackBody = functionSource(
      script,
      'fallbackInPlaceStableTunerHandoff',
      'ensureAttachedStableTunerPlayback'
    )
    const mediaErrorBody = functionSource(
      script,
      'handleMediaError',
      'retryPlayback'
    )

    expect(tuneSelectionBody).toContain('if (state.tuner) {')
    expect(tuneSelectionBody).not.toContain(
      'state.tuner && (hasAttachedStableTunerSource() || !state.hasCommittedVideo)'
    )
    expect(tuneSelectionBody).toContain('if (hasPendingStableTunerHandoff())')
    expect(tuneSelectionBody).toContain('clearTuningTimer();')
    expect(tuneSelectionBody).toMatch(/if \(hasPendingStableTunerHandoff\(\)\)[\s\S]*else \{\s*abandonCandidateTune\(\);/)
    expect(script).toContain('if (hasAttachedStableTunerSource())')
    expect(cancelBody).toContain('var restoreStableTuner = hasAttachedStableTunerSource()')
    expect(reconcileBody).toContain('var restoreStableTuner = hasAttachedStableTunerSource()')

    expect(stableTuneBody).toContain('var previousChannelId = committedStableTunerFeedChannelId()')
    expect(stableTuneBody).toContain('postStableTunerSwitch(channelId, function')
    expect(stableTuneBody).toContain("data.status !== 'ready'")
    expect(stableTuneBody).toMatch(/data\.status !== 'ready'[\s\S]{0,240}rollbackAcceptedStableTunerTune\(/)
    expect(stableTuneBody).toContain('stableTunerResponseMatches(data, channelId)')
    expect(stableTuneBody).toContain('resolveStableTunerNow(')

    expect(stableCommitBody).toContain('var requiresStableHandoff = !!(tunerSwitched && now.program)')
    expect(stableCommitBody).toContain('channelId: state.committedChannelId')
    expect(stableCommitBody).toContain('currentNow: state.currentNow')
    expect(stableCommitBody).toContain('state.candidateChannelId = requiresStableHandoff ? channelId : null')
    expect(stableCommitBody).toContain('if (!requiresStableHandoff)')
    expect(stableCommitBody).toContain('state.committedChannelId = channelId')
    expect(stableCommitBody).toContain('detachVideoForTune();')
    expect(stableCommitBody).toContain("beginTuning('Switching the live picture…')")
    expect(stableCommitBody).toContain('applyNowResult(now, timing, requiresStableHandoff)')
    expect(stableCommitBody.indexOf('detachVideoForTune();')).toBeLessThan(
      stableCommitBody.indexOf("beginTuning('Switching the live picture…')")
    )
    expect(stableCommitBody.indexOf('if (requiresStableHandoff) {\n      queuePresenceHeartbeat();\n      return;')).toBeLessThan(
      stableCommitBody.indexOf('writeStorage(STORAGE_CHANNEL, channelId)')
    )
    expect(stableCommitBody).not.toContain('requestVideoFrameCallback')
    expect(stableCommitBody).toContain("tunerSwitched && typeof now.branding === 'undefined'")
    expect(stableCommitBody).toContain('scheduleStableTunerMetadataSync(')
    /* The in-place branch must never tear down the decoder; that is the whole
       point of the stable manifest. Only the fallback branch beneath it may,
       because that path re-attaches. Anchor the call after the in-place return. */
    expect(stableCommitBody.indexOf('detachVideoForTune();')).toBeGreaterThan(
      stableCommitBody.indexOf('applyNowResult(now, timing, false)')
    )
    expect(stableCommitBody).not.toContain('resetMediaElement(')
    expect(stableCommitBody).not.toContain('loadMediaElement(')
    expect(stableCommitBody).not.toContain('firstFrameAt = Date.now()')
    expect(script).toContain('function stableTunerSwitchBoundary(')
    expect(script).toContain('switchBoundary: stableTunerSwitchBoundary(tuner.switchBoundary, tuner.revision)')
    expect(script).toContain("value.transportMode === 'seamless'")
    expect(stableCommitBody).toContain('beginInPlaceStableTunerHandoff(')
    // The in-place attempt is always made before the re-attach teardown.
    expect(stableCommitBody.indexOf('beginInPlaceStableTunerHandoff(')).toBeLessThan(
      stableCommitBody.indexOf('detachVideoForTune();')
    )
    expect(inPlaceBeginBody).toContain('hasAttachedStableTunerSource()')
    expect(inPlaceBeginBody).not.toContain('loadMediaElement(')
    expect(inPlaceProbeBody).toContain('probe.manifestBoundaryObserved')
    expect(inPlaceProbeBody).toContain('if (probe.seamlessTransport)')
    expect(inPlaceProbeBody).toContain('seamlessTime > probe.outgoingBufferedEnd + 0.03')
    expect(inPlaceProbeBody).toContain('seamlessHeadroom >= MIN_READY_BUFFER_SECONDS')
    expect(script).toContain('function findProvenTargetRange(')
    expect(script).toContain('!rangeOverlapsAny(candidate, requestRanges)')
    expect(script).toContain('!rangeOverlapsAny(candidate, acceptanceRanges)')
    expect(script).not.toContain('meaningfulAdvance')
    expect(inPlaceProbeBody).toContain('probe.targetRange = targetRange')
    expect(inPlaceProbeBody).toContain('seekToProvenTargetRange(video, probe.targetRange, probe.boundary)')
    expect(inPlaceProbeBody).toContain('currentTargetRange = findProvenTargetRange(')
    expect(inPlaceProbeBody).toContain('targetHeadroom >= minimumRevealHeadroom')
    expect(inPlaceProbeBody).toContain('!state.hlsSeekPending && !video.seeking')
    expect(inPlaceFinishBody).toContain("state.tuneMetrics.src = 'session-tuner-in-place'")
    expect(inPlaceFinishBody).not.toContain('loadMediaElement(')
    /* Setting hasCommittedVideo false before applyNowResult() makes
       loadProgram() skip its detach, so this path has to release the outgoing
       decoder itself or LG keeps playing the previous channel's audio over the
       black tuning backdrop for several seconds. */
    expect(inPlaceFallbackBody).toContain('detachVideoForTune();')
    expect(inPlaceFallbackBody).not.toContain('activeVideo().muted = true')
    expect(inPlaceFallbackBody.indexOf('detachVideoForTune();')).toBeLessThan(
      inPlaceFallbackBody.indexOf('applyNowResult(probe.now, probe.timing, true)')
    )
    expect(inPlaceFallbackBody).toContain('applyNowResult(probe.now, probe.timing, true)')
    expect(inPlaceFallbackBody).toContain("state.tuneMetrics.src = 'session-tuner-reattach-fallback'")
    expect(mediaErrorBody).toContain('state.previousTune.tunerChannelId || state.tunerRollbackChannelId')
    expect(mediaErrorBody).toContain('state.candidateChannelId !== stableRestoreChannelId')
    expect(mediaErrorBody.indexOf('rollbackAcceptedStableTunerTune(')).toBeLessThan(
      mediaErrorBody.indexOf("showPlaybackError(\n        'The switched channel could not start'")
    )

    expect(applyBody).toContain('window.ToastTVPlaybackPolicy.withTunerRevision(')
    expect(applyBody).toContain('++state.attachAttempt')
    expect(script).toContain('window.ToastTVPlaybackPolicy.loadMediaElement(tuneVideo(), source.url)')
    expect(stabilizeBody).toContain('if (state.hardLiveEdgePending) seekHlsLiveEdge(true)')
    expect(stabilizeBody).toContain('window.ToastTVPlaybackPolicy.isPlaybackStable(video)')
    expect(stabilizeBody).toContain('state.committedChannelId = currentChannel().id')
    expect(stabilizeBody).toContain('state.previousTune = null')
    expect(stabilizeBody).toContain('renderProgramInfo()')
    expect(stabilizeBody).toContain('writeStorage(STORAGE_CHANNEL, currentChannel().id)')
    expect(stabilizeBody).toContain('state.tuneMetrics.firstFrameAt = Date.now()')

    expect(feedBody).toContain('return state.tuner.channelId')
    expect(feedBody).not.toContain('state.committedChannelId')
    expect(restartBody).toContain('var pendingNow = state.currentNow')
    expect(restartBody).toContain('state.hardLiveEdgePending = true')
    expect(restartBody).toContain('applyNowResult(pendingNow, null, true)')
    expect(metadataSyncBody).toContain('generation !== state.tuneGeneration')
    expect(metadataSyncBody).toContain('state.tuner.sessionId !== sessionId')
    expect(metadataSyncBody).toContain('state.committedChannelId !== channelId')
    expect(metadataSyncBody).toContain('syncNow(false)')
    expect(metadataSyncBody).not.toContain('loadMediaElement(')
    expect(script).toContain('function committedStableTunerFeedChannelId()')
    expect(stableTuneBody).toContain('state.tunerRollbackChannelId = previousChannelId')
    expect(stabilizeBody).toContain('state.requestedChannelId ||')
    expect(stabilizeBody).toContain('state.tunerRollbackChannelId = null')
    expect(stableRestoreBody).toContain('state.previousTune && state.previousTune.tunerChannelId')
    expect(stableRestoreBody).toContain(
      ': (state.tunerRollbackChannelId || committedStableTunerFeedChannelId())'
    )
    expect(stableRestoreBody.indexOf('setStableTuner(restoredTuner)')).toBeLessThan(
      stableRestoreBody.indexOf('callback(restoredTuner)')
    )
    expect(stableRestoreBody.indexOf('restoreCommittedStableTuner(requestId, function')).toBeLessThan(
      stableRestoreBody.indexOf('rollbackCandidateTune(restoredTuner)')
    )
    expect(rollbackBody).toContain('if (restoredTuner && state.previousTune.currentNow')
    expect(rollbackBody).toContain('state.candidateChannelId = state.previousTune.channelId')
    expect(rollbackBody).toContain('state.hardLiveEdgePending = true')
    expect(rollbackBody).toContain('applyNowResult(restoredNow, null, true)')
    expect(cancelBody).toContain('restoreStableTunerThenRollback(restoreGeneration, function')
    expect(openBrowserBody).toContain('restoreStableTunerThenRollback(restoreGeneration, function')
    expect(reconcileBody).toContain('restoreStableTunerThenRollback(restoreGeneration, function')
    expect(stableCommitBody).toContain('previousTunerChannelId || committedStableTunerFeedChannelId()')
    expect(script).toContain('stableSource=true sourceReloaded=true')
    expect(script).toContain('stableSource=true sourceReloaded=false')
  })

  test('trusts only current cached schedule gaps when selecting the tuner path', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )
    const offAirPredicateSource = functionSource(
      script,
      'isCurrentOffAirResult',
      'isLineupSchedule'
    ).trim()
    const tuneSelectionBody = script.slice(
      script.indexOf('function tuneChannel('),
      script.indexOf('function openStableTunerForChannel(')
    )
    const isCurrentOffAirResult = Function(
      'isNowResult',
      'OFF_AIR_CACHE_MAX_AGE_MS',
      `return (${offAirPredicateSource})`
    )(
      (data: any) => !!data && typeof data.serverTimeMs === 'number' && typeof data.channelId === 'string',
      75_000
    ) as (data: any, channelId: string, serverNow: number) => boolean
    const serverNow = Date.parse('2026-08-26T12:00:00.000Z')
    const freshGap = {
      channelId: 'Nickelodeon',
      serverTimeMs: serverNow - 15_000,
      program: null,
      next: { scheduledStart: '2026-08-26T12:30:00.000Z' },
    }
    const staleGap = { ...freshGap, serverTimeMs: serverNow - 75_001 }
    const elapsedGap = {
      ...freshGap,
      next: { scheduledStart: '2026-08-26T11:59:59.000Z' },
    }

    expect(tuneSelectionBody).toContain('var channelIsExplicitlyOffAir = channel.onAir === false')
    expect(tuneSelectionBody).toContain("var rememberedOffAir = rememberedNow && isNowResult(rememberedNow) && rememberedNow.program === null")
    expect(tuneSelectionBody).toContain('var shouldResolveOffAir = channelIsExplicitlyOffAir || currentRememberedOffAir')
    expect(tuneSelectionBody).toMatch(
      /if \(state\.tuner\)[\s\S]*if \(shouldResolveOffAir\)[\s\S]*tuneStableTunerChannel\(channel\.id, generation, pushHistory\)/
    )
    expect(tuneSelectionBody).toMatch(
      /state\.tunerCapability !== 'incompatible' &&\s*!shouldResolveOffAir[\s\S]*openStableTunerForChannel\(channel\.id, generation, pushHistory\)/
    )
    expect(tuneSelectionBody).toContain('if (rememberedOffAir && shouldResolveOffAir)')
    expect(tuneSelectionBody).not.toContain('channel.onAir !== false && !(rememberedNow')
    expect(tuneSelectionBody).toContain("' cachedOffAir=' + (currentRememberedOffAir ? 'fresh' : (rememberedOffAir ? 'stale' : 'no'))")
    expect(isCurrentOffAirResult(freshGap, 'Nickelodeon', serverNow)).toBe(true)
    expect(isCurrentOffAirResult(staleGap, 'Nickelodeon', serverNow)).toBe(false)
    expect(isCurrentOffAirResult(elapsedGap, 'Nickelodeon', serverNow)).toBe(false)
  })

  test('reconciles off-air programming and recovers a lost or incompatible tuner safely', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )
    const syncBody = script.slice(
      script.indexOf('function syncNow('),
      script.indexOf('function applyNowResult(')
    )
    const applyBody = script.slice(
      script.indexOf('function applyNowResult('),
      script.indexOf('function loadProgram(')
    )
    const recoveryBody = script.slice(
      script.indexOf('function recoverStableTunerPlayback('),
      script.indexOf('function prepareChannel(')
    )
    const reopenBody = script.slice(
      script.indexOf('function reopenLineupSession('),
      script.indexOf('function stableTunerFromResponse(')
    )
    const disableBody = script.slice(
      script.indexOf('function disableStableTunerAndReload('),
      script.indexOf('function recoverStableTunerPlayback(')
    )
    const offAirTuneBody = script.slice(
      script.indexOf('function resolveStableTunerOffAir('),
      script.indexOf('function tuneStableTunerChannel(')
    )
    const offAirBody = script.slice(
      script.indexOf('function showOffAir('),
      script.indexOf('function hideOffAir(')
    )
    const mediaErrorBody = script.slice(
      script.indexOf('function handleMediaError('),
      script.indexOf('function retryPlayback(')
    )

    expect(offAirTuneBody).not.toContain('postStableTunerSwitch(')
    expect(offAirTuneBody).toContain('createOfflineNowResult(state.channels[index])')
    expect(offAirTuneBody).toContain('null, false')
    expect(offAirBody).toContain('var keepStableTuner = hasActiveStableTunerPlayback()')
    expect(offAirBody).toContain('activeVideo().muted = true')
    expect(offAirBody).toContain('state.hasCommittedVideo = keepStableTuner')
    expect(script).toContain('return state.tuner.channelId')
    expect(syncBody).toContain('data.program && state.tuner && state.tuner.channelId !== channel.id')
    expect(syncBody).toContain('data.program && state.tuner && state.tunerNeedsRecovery')
    expect(syncBody.indexOf('state.tunerNeedsRecovery')).toBeLessThan(
      syncBody.indexOf('applyNowResult(data, timing, forceReload)')
    )
    expect(syncBody).toContain('tuneStableTunerChannel(channel.id, generation, false)')
    expect(syncBody.indexOf('tuneStableTunerChannel(channel.id, generation, false)')).toBeLessThan(
      syncBody.indexOf('applyNowResult(data, timing, forceReload)')
    )
    expect(applyBody).toContain("ensureAttachedStableTunerPlayback('Programming is starting…')")

    expect(recoveryBody).toContain('state.tunerRecoveryInFlight = true')
    expect(recoveryBody).toContain('if (!manifestError)')
    expect(script).toContain('var TUNER_DECODER_RECOVERY_LIMIT = 2')
    expect(recoveryBody).toContain(
      'state.tunerDecoderRecoveryAttempts < TUNER_DECODER_RECOVERY_LIMIT'
    )
    expect(recoveryBody).toContain('state.tunerDecoderRecoveryAttempts += 1')
    expect(recoveryBody).toContain("beginTuning('Reattaching the live tuner…')")
    expect(recoveryBody).toContain('resetAllVideos()')
    expect(recoveryBody).toContain('syncNow(true)')
    const decoderRetryStart = recoveryBody.indexOf(
      'state.tunerDecoderRecoveryAttempts < TUNER_DECODER_RECOVERY_LIMIT'
    )
    const incompatibleFallback = recoveryBody.indexOf(
      "'This TV repeatedly rejected fast-tuner playback."
    )
    expect(recoveryBody.indexOf("beginTuning('Reattaching the live tuner…')")).toBeLessThan(
      incompatibleFallback
    )
    expect(recoveryBody.indexOf('syncNow(true)')).toBeLessThan(incompatibleFallback)
    expect(recoveryBody.indexOf('return;', decoderRetryStart)).toBeLessThan(
      incompatibleFallback
    )
    expect(recoveryBody).toContain('ownerId: state.sessionOwnerId')
    expect(recoveryBody).toContain('ownerEpoch: state.sessionOwnerEpoch')
    expect(recoveryBody).toContain('lastChannelId: channelId')
    expect(recoveryBody).toContain('setStableTuner(reopened)')
    expect(recoveryBody).toContain('syncNow(true)')
    expect(reopenBody).toContain('var generation = state.tuneGeneration')
    expect(reopenBody).toContain('generation !== state.tuneGeneration')
    expect(reopenBody.indexOf('generation !== state.tuneGeneration')).toBeLessThan(
      reopenBody.indexOf('state.tuner = null')
    )
    expect(disableBody).toContain("state.tunerCapability = incompatible ? 'incompatible' : 'unavailable'")
    expect(disableBody).toContain('ownerId: state.sessionOwnerId')
    expect(disableBody).toContain('ownerEpoch: state.sessionOwnerEpoch')
    expect(disableBody).toContain('tunerOnly: true')
    expect(mediaErrorBody).toContain('state.activeSource.tunerSessionId')
    expect(mediaErrorBody).toContain('state.tunerNeedsRecovery = true')
    expect(mediaErrorBody.indexOf('state.tunerNeedsRecovery = true')).toBeLessThan(
      mediaErrorBody.indexOf('recoverStableTunerPlayback()')
    )
    const stabilizeBody = functionSource(
      script,
      'stabilizeTuning',
      'playbackHeadroomSeconds'
    )
    expect(stabilizeBody).toContain('state.tunerDecoderRecoveryAttempts = 0')
    expect(script).toContain('seekHlsLiveEdge(state.hardLiveEdgePending)')
    expect(script).toContain('if (state.hardLiveEdgePending) seekHlsLiveEdge(true)')
    expect(script).toContain('must remain best-effort on models that do not')
  })

  test('lets webOS Back close the EPG before leaving live TV and animates guide movement', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )
    const goBackBody = script.slice(
      script.indexOf('function goBack('),
      script.indexOf('function cancelPendingChannelChange(')
    )

    expect(goBackBody.indexOf("state.overlay === 'guide'")).toBeLessThan(goBackBody.indexOf('closeOverlays()'))
    expect(goBackBody.indexOf('closeOverlays()')).toBeLessThan(goBackBody.indexOf('if (cancelPendingChannelChange())'))
    expect(goBackBody).toContain('function exitApplication()')
    expect(goBackBody).toContain('window.webOS.platformBack()')
    expect(script).toContain('if (event.repeat) return;')
    expect(script).toContain('function animateGuideScroll(')
    expect(script).toContain('window.requestAnimationFrame(step)')
    expect(script).toContain('Math.pow(1 - progress, 3)')
    expect(script).toContain('animateGuideScroll(elements.guideList')
    expect(script).toContain('var guideStart = elements.guideList.contains(node) ? elements.guideList.scrollTop : null')
    expect(script).toContain('if (guideStart !== null) elements.guideList.scrollTop = guideStart')
    expect(script).toContain('window.cancelAnimationFrame(guideScrollFrame)')
  })
})
