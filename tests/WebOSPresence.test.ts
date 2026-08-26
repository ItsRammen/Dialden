import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
    expect(script).toContain("var cacheKey = catalog.channelId + ':' + fromMs")
    expect(script).toContain('Date.now() - cached.fetchedAt < GUIDE_CACHE_TTL_MS')
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
    // Selecting a program closes the overlay and tunes live from the player.
    expect(script).toContain('function selectGuideChannelLive(')
    expect(script).toContain('tuneChannel(targetIndex, false)')
    expect(script).toContain('var sameChannel = active && active.id === channelId')
    expect(styles).toContain('.guide-panel { position: absolute;')
    expect(styles).toContain('background: linear-gradient(to bottom, rgba(0, 0, 0, 0.10)')
    expect(markup).toContain('Live TV guide · video keeps playing')
    expect(markup.indexOf('</aside>')).toBeLessThan(markup.indexOf('id="channelOsd"'))
    // The old Now Playing overlay duplication is gone.
    expect(script).not.toContain('openNowOverlay')
    expect(markup).not.toContain('id="nowOverlay"')
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
    expect(script).toContain("if (!applied || state.view !== 'player' || !state.hasCommittedVideo) return;")
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
    expect(markup).toContain('id="channelWatchButton"')
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
    expect(script).toContain('elements.channelWatchButton.disabled = true')
    expect(script).toContain('elements.channelGuideButton.disabled = true')
    expect(script).toContain('function openChannelBrowser()')
    expect(script).toContain("if (code === 40) { event.preventDefault(); openChannelBrowser(); return; }")
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
    const detachStart = script.indexOf('function detachVideoForTune()')
    const rollbackStart = script.indexOf('function rollbackCandidateTune()')
    const detachBody = script.slice(detachStart, rollbackStart)
    const prepareStart = script.indexOf('function prepareChannel(')
    const commitStart = script.indexOf('function commitPreparedChannel(')
    const prepareBody = script.slice(prepareStart, commitStart)
    const commitBody = script.slice(
      commitStart,
      script.indexOf('function recoverRejectedTune(')
    )
    const rollbackBody = script.slice(
      script.indexOf('function rollbackCandidateTune()'),
      script.indexOf('function retryLiveStream(')
    )
    const tuneBody = script.slice(
      script.indexOf('function tuneChannel('),
      prepareStart
    )
    const stableCheck = script.indexOf('window.ToastTVPlaybackPolicy.isPlaybackStable(video)')
    const slotCommit = script.indexOf('state.videoSlot = state.candidateSlot')

    expect(detachBody).toContain("state.candidateSlot = state.videoSlot === 'A' ? 'B' : 'A'")
    expect(detachBody).not.toContain("state.videoSlot = state.videoSlot === 'A' ? 'B' : 'A'")
    expect(detachBody).toContain('activeVideo().muted = true')
    expect(detachBody).toContain('window.ToastTVPlaybackPolicy.resetMediaElement(activeVideo())')
    expect(detachBody).toContain('state.hasCommittedVideo = false')
    expect(slotCommit).toBeGreaterThan(stableCheck)
    expect(script).toContain('state.frameProbeAttempts >= 12')
    expect(script).toContain('rollbackCandidateTune();')
    expect(prepareBody).toMatch(/data\.status !== 'ready'[\s\S]{0,240}recoverRejectedTune\(/)
    expect(commitBody).toContain("recoverRejectedTune(index, 'That channel is no longer available.')")
    expect(rollbackBody).toContain('if (previousIndex < 0)')
    expect(rollbackBody).toContain('state.hasCommittedVideo = false')
    expect(rollbackBody).toContain('return false')
    expect(rollbackBody).toContain('if (state.currentNow && !state.currentNow.program)')
    expect(rollbackBody).toContain('showOffAir(state.currentNow.next)')
    expect(rollbackBody.indexOf('showOffAir(state.currentNow.next)')).toBeLessThan(
      rollbackBody.indexOf("beginTuning('Returning to the previous channel…')")
    )
    expect(tuneBody).toContain("state.view === 'player' && state.tuning && !state.hasCommittedVideo")
    expect(tuneBody).toMatch(/!state\.hasCommittedVideo\s*&&\s*!state\.previousTune/)
    expect(tuneBody).toContain('abandonCandidateTune();')
    expect(tuneBody).toContain("showChannelOsd(targetIndex, 'Tuning…', true)")
    expect(script).toContain("if (state.view === 'player' && !restored) openChannelBrowser()")
    expect(script).toContain("'That channel could not be tuned. Please try again.'")
    expect(script).toContain('state.activeSource.baseUrl === baseStreamUrl')
    expect(script).toContain('if (!forceReload && state.activeSource')
    expect(script).toContain("setPlayerStatus('Playing live — schedule update delayed')")
    expect(script).toContain("if (!state.localPaused && !state.tuning) setPlayerStatus('Playing live')")
    expect(script).toContain('scheduleChannelOsdHide();')
  })

  test('keeps the guide player-scoped and resolves a destination before decoder handoff', () => {
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

    expect(openGuideBody).toContain("if (state.view !== 'player'")
    expect(openGuideBody).toContain('originChannelId: origin ? origin.id : channel.id')
    expect(goBackBody).toMatch(/state\.overlay === 'guide'[\s\S]{0,100}closeOverlays\(\)/)
    expect(goBackBody.indexOf('closeOverlays()')).toBeLessThan(goBackBody.indexOf('openChannelBrowser()'))
    expect(goBackBody).toContain('if (cancelPendingChannelChange()) return;')
    expect(script).toContain('function cancelPendingChannelChange()')
    expect(goBackBody).toContain("var stayInBrowser = state.view === 'channels';")
    expect(goBackBody).toMatch(/if \(stayInBrowser\) \{[\s\S]{0,100}return true;/)
    expect(goBackBody).toContain("showToast('Guide opening cancelled.')")
    expect(script).toContain("updateChannelOsdProgram('Switch cancelled')")
    expect(selectBody).toContain('closeOverlays();')
    expect(selectBody).toContain('if (sameChannel)')
    expect(selectBody).toContain('tuneChannel(targetIndex, false)')
    expect(resolveBody).toContain("'/now'")
    expect(resolveBody).toContain('verifyPreparedManifest(source.url')
    expect(resolveBody).toContain('segments >= 2')
    expect(resolveBody).toContain('commitPreparedChannel(channelId, generation, pushHistory')
    expect(commitBody.indexOf("updateChannelOsdProgram('Switching…')")).toBeLessThan(
      commitBody.indexOf('detachVideoForTune();')
    )
    expect(commitBody).toContain('applyNowResult(prepared.data, prepared.timing, true)')
    expect(commitBody).toContain('if (state.committedChannelId && !state.previousTune)')
    expect(renderInfoBody).toContain('if (state.tuning && state.previousTune) return;')
    expect(styles).toContain('.channel-osd { position: fixed; z-index: 70;')
    expect(styles).toContain('top: 18px; right: 150px;')
    expect(styles).toContain('.player-screen.guide-open .player-info')
  })

  test('scopes deferred guide intent to the channel tune that actually commits', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )
    const tuneBody = script.slice(
      script.indexOf('function tuneChannel('),
      script.indexOf('function prepareChannel(')
    )
    const browserGuideBody = script.slice(
      script.indexOf('function openGuideFromChannelBrowser('),
      script.indexOf('function openGuideForChannel(')
    )
    const delayedGuideBody = script.slice(
      script.indexOf('function openPendingGuideAfterCommit('),
      script.indexOf('function clearTuningTimer(')
    )
    const offAirBody = script.slice(
      script.indexOf('function showOffAir('),
      script.indexOf('function hideOffAir(')
    )
    const reconcileBody = script.slice(
      script.indexOf('function reconcileChannelList('),
      script.indexOf('function invalidateRemovedCommittedPlayback(')
    )

    // A browser-guide request is explicit tune intent, while an ordinary zap
    // clears any deferred guide left by an older request before every exit.
    expect(tuneBody).toContain('function tuneChannel(index, pushHistory, guideChannelId)')
    expect(tuneBody).toContain("var guideAfterTune = typeof guideChannelId === 'string' ? guideChannelId : null")
    expect(tuneBody.indexOf('state.pendingGuideChannelId = null')).toBeLessThan(
      tuneBody.indexOf('if (!state.channels.length)')
    )
    expect(tuneBody).toContain('state.pendingGuideChannelId = guideAfterTune')
    expect(browserGuideBody).toContain('tuneChannel(returnIndex, true, guideChannel.id)')

    // The delayed callback cannot open a stale guide after another tune, view
    // transition, or commit has superseded the original channel.
    expect(delayedGuideBody).toContain('generation !== state.tuneGeneration')
    expect(delayedGuideBody).toContain('state.requestedChannelId')
    expect(delayedGuideBody).toContain("state.view !== 'player'")
    expect(delayedGuideBody).toContain('state.tuning')
    expect(delayedGuideBody).toContain('state.committedChannelId !== committedChannelId')
    expect(delayedGuideBody).toContain("openGuideForChannel(guideIndex, 'player')")

    // An off-air station is still a completed tune and must resolve the same
    // pending guide intent rather than leaving the browser request stranded.
    expect(offAirBody).toContain('state.committedChannelId = channel ? channel.id : null')
    expect(offAirBody).toContain('openPendingGuideAfterCommit(generation, state.committedChannelId)')
    expect(offAirBody.indexOf('state.committedChannelId = channel ? channel.id : null')).toBeLessThan(
      offAirBody.indexOf('openPendingGuideAfterCommit(generation, state.committedChannelId)')
    )

    // A lineup refresh reconciles the picture that is committed separately
    // from a candidate still being tuned, preserving the candidate only while
    // independently invalidating a removed committed channel.
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

    expect(offAirBody).toContain('focusNode(elements.offAirGuideButton)')
    expect(script).toMatch(/state\.view === 'player' && !state\.overlay &&[\s\S]{0,180}elements\.offAirPanel\.classList\.contains\('hidden'\)/)
    expect(pauseBody).toContain('if (state.tuning)')
    expect(pauseBody.indexOf('if (state.tuning)')).toBeLessThan(
      pauseBody.indexOf('state.localPaused = true')
    )
    expect(script).toContain('state.guideCache = {}')
  })
})
