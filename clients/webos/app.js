(function () {
  'use strict';

  var STORAGE_SERVER = 'toasttv.serverUrl.v1';
  var STORAGE_CHANNEL = 'toasttv.channelId.v1';
  var STORAGE_CLIENT_ID = 'toasttv.clientId.v1';
  var STORAGE_CLIENT_NAME = 'toasttv.clientName.v1';
  var DEFAULT_SERVER = 'http://TOWER:1993';
  var POLL_INTERVAL_MS = 30000;
  var CHANNEL_REFRESH_INTERVAL_MS = 15000;
  var SCHEDULE_REFRESH_INTERVAL_MS = 60000;
  var PRESENCE_INTERVAL_MS = 15000;
  var DRIFT_LIMIT_SECONDS = 8;
  var GUIDE_RENDER_LIMIT = 250;
  var GUIDE_CACHE_TTL_MS = 60000;
  var LIVE_STREAM_RETRY_DELAYS = [300, 750, 1500, 3000, 5000];
  var TUNING_STABLE_MS = 300;
  var MIN_READY_BUFFER_SECONDS = 0.75;
  var ZAP_DEBOUNCE_MS = 80;
  var CHANNEL_OSD_MS = 2800;
  var LIVE_EDGE_TOLERANCE_SECONDS = 3;
  var LIVE_JOIN_BEHIND_SECONDS = 1.75;
  var BUFFERING_NOTICE_MS = 800;
  var BUFFERING_RECOVERY_MS = 6000;
  var RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];

  var state = {
    view: 'boot',
    overlay: null,
    setupFromChannels: false,
    playerEnteredFromChannels: false,
    serverUrl: '',
    clientId: '',
    clientName: 'LG webOS TV',
    channels: [],
    channelNow: {},
    channelIndex: 0,
    previewChannelIndex: 0,
    requestedChannelIndex: null,
    requestedChannelId: null,
    currentNow: null,
    programId: null,
    activeSource: null,
    failedLiveUrl: null,
    liveRetryAttempt: 0,
    tuning: false,
    hlsSeekPending: false,
    tuneGeneration: 0,
    clockOffsetMs: 0,
    clockSamples: [],
    sourceRetryUsed: false,
    localPaused: false,
    awaitingGesture: false,
    pendingJoin: false,
    playToken: 0,
    reconnectAttempt: 0,
    requestSerial: 0,
    connectSerial: 0,
    guideSerial: 0,
    channelRefreshSerial: 0,
    scheduleRefreshSerial: 0,
    scheduleHydrating: false,
    scheduleHydratedAt: 0,
    videoSlot: 'A',
    candidateSlot: null,
    candidateChannelId: null,
    hasCommittedVideo: false,
    committedChannelId: null,
    previousTune: null,
    attachAttempt: 0,
    frameProbeAttempts: 0,
    lineupOpening: false,
    lineupPreferredChannelId: null,
    lineupDesiredChannelId: null,
    lineupRetargetInFlight: null,
    tuneMetrics: null,
    guideCache: {},
    guideRequests: {},
    pendingGuideChannelId: null,
    bufferingPrepareFailures: 0,
    launchCancelled: false
  };

  var elements = {};
  var pollTimer = null;
  var boundaryTimer = null;
  var reconnectTimer = null;
  var presenceTimer = null;
  var presenceChangeTimer = null;
  var chromeTimer = null;
  var toastTimer = null;
  var liveRetryTimer = null;
  var tuningTimer = null;
  var channelRefreshTimer = null;
  var sourceRefreshTimer = null;
  var zapTimer = null;
  var channelOsdTimer = null;
  var startupReconnectTimer = null;
  var bootActionTimer = null;
  var bufferingStatusTimer = null;
  var stallRecoveryTimer = null;
  var bufferingRecoverySerial = 0;
  var guidePreviewTimer = null;

  document.addEventListener('DOMContentLoaded', boot, false);

  function boot() {
    cacheElements();
    bindEvents();
    state.clientId = getOrCreateClientId();
    state.clientName = getClientName();
    safeReplaceHistory({ view: 'boot' });
    tickClock();
    window.setInterval(tickClock, 1000);

    var previewServer = null;
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      previewServer = window.location.protocol + '//' + window.location.host;
    }
    var savedServer = readStorage(STORAGE_SERVER);
    elements.serverInput.value = previewServer || savedServer || DEFAULT_SERVER;
    activateView('boot');

    if (previewServer || savedServer) {
      connectToServer(previewServer || savedServer, false, true);
    } else {
      activateView('setup');
      window.setTimeout(focusFirst, 60);
    }
  }

  function cacheElements() {
    var ids = [
      'bootScreen', 'bootMessage', 'bootRetryButton', 'bootBrowseButton', 'bootSettingsButton', 'setupScreen', 'channelsScreen', 'playerScreen', 'serverInput',
      'connectButton', 'cancelSetupButton', 'setupMessage', 'settingsButton',
      'retryChannelsButton', 'channelGrid', 'emptyChannels', 'homeClock', 'channelCount',
      'channelPreview', 'channelPreviewLogo', 'channelPreviewMonogram', 'channelPreviewNumber',
      'channelPreviewState', 'channelPreviewName', 'channelPreviewProgram', 'channelPreviewEpisode',
      'channelPreviewTimelineFill', 'channelPreviewTime', 'channelPreviewNext', 'channelWatchButton', 'channelGuideButton',
      'serverLabel', 'videoA', 'videoB', 'playerBackdrop', 'playerHeader', 'playerChannelName',
      'playerChannelLogo', 'playerChannelMonogram', 'playerChannelNumber', 'playerStatus', 'playerClock', 'playerInfo', 'playerCollection', 'playerTitle', 'playerEpisode',
      'timelineFill', 'programTimes', 'nextTitle', 'offAirPanel', 'offAirNext',
      'offAirGuideButton', 'offAirChannelsButton',
      'playbackError', 'playbackErrorTitle', 'playbackErrorText',
      'retryPlaybackButton', 'errorBackButton', 'guideOverlay', 'guideChannelName',
      'catalogRail', 'catalogDays',
      'guideList', 'guideMessage', 'closeGuideButton', 'tuningPanel', 'channelOsd', 'channelOsdNumber',
      'channelOsdName', 'channelOsdProgram', 'tuningChannelName', 'tuningMessage', 'guideClock', 'toast'
    ];
    var index;
    for (index = 0; index < ids.length; index += 1) {
      elements[ids[index]] = document.getElementById(ids[index]);
    }
  }

  function bindEvents() {
    elements.bootRetryButton.addEventListener('click', retryLaunch, false);
    elements.bootBrowseButton.addEventListener('click', openChannelBrowser, false);
    elements.bootSettingsButton.addEventListener('click', function () {
      cancelStartupWork();
      activateView('setup');
      window.setTimeout(focusFirst, 60);
    }, false);
    elements.connectButton.addEventListener('click', function () {
      connectToServer(elements.serverInput.value, true, false);
    }, false);
    elements.serverInput.addEventListener('keydown', function (event) {
      if ((event.keyCode || event.which) === 13) {
        event.preventDefault();
        connectToServer(elements.serverInput.value, true, false);
      }
    }, false);
    elements.settingsButton.addEventListener('click', openSetup, false);
    elements.cancelSetupButton.addEventListener('click', goBack, false);
    elements.retryChannelsButton.addEventListener('click', function () {
      connectToServer(state.serverUrl || elements.serverInput.value, false, false);
    }, false);
    elements.retryPlaybackButton.addEventListener('click', retryPlayback, false);
    elements.errorBackButton.addEventListener('click', openChannelBrowser, false);
    elements.offAirGuideButton.addEventListener('click', openGuide, false);
    elements.offAirChannelsButton.addEventListener('click', openChannelBrowser, false);
    elements.closeGuideButton.addEventListener('click', goBack, false);
    elements.channelWatchButton.addEventListener('click', function () {
      tuneChannel(state.previewChannelIndex, true);
    }, false);
    elements.channelGuideButton.addEventListener('click', openGuideFromChannelBrowser, false);
    elements.channelGrid.addEventListener('focusin', function (event) {
      var card = event.target && event.target.closest ? event.target.closest('[data-channel-index]') : null;
      if (card) selectChannelPreview(Number(card.getAttribute('data-channel-index')));
    }, false);
    elements.catalogRail.addEventListener('focusin', function (event) {
      var chip = event.target && event.target.closest ? event.target.closest('[data-catalog-channel]') : null;
      if (!chip) return;
      if (guidePreviewTimer) window.clearTimeout(guidePreviewTimer);
      var channelId = chip.getAttribute('data-catalog-channel');
      guidePreviewTimer = window.setTimeout(function () {
        guidePreviewTimer = null;
        if (state.overlay !== 'guide') return;
        var focused = closestFocusable(document.activeElement);
        if (focused && focused.getAttribute('data-catalog-channel') === channelId) {
          setCatalogChannel(channelId);
        }
      }, 140);
    }, false);
    elements.catalogDays.addEventListener('focusin', function (event) {
      var chip = event.target && event.target.closest ? event.target.closest('[data-catalog-day]') : null;
      if (chip) setCatalogDay(Number(chip.getAttribute('data-catalog-day')));
    }, false);
    elements.playerChannelLogo.addEventListener('load', function () {
      if (elements.playerChannelLogo.getAttribute('src')) {
        elements.playerChannelLogo.classList.remove('hidden');
        elements.playerChannelMonogram.classList.add('hidden');
      }
    }, false);
    elements.playerChannelLogo.addEventListener('error', hideChannelLogo, false);
    elements.channelPreviewLogo.addEventListener('load', function () {
      if (elements.channelPreviewLogo.getAttribute('src')) {
        elements.channelPreviewLogo.classList.remove('hidden');
        elements.channelPreviewMonogram.classList.add('hidden');
      }
    }, false);
    elements.channelPreviewLogo.addEventListener('error', hideChannelPreviewLogo, false);

    bindVideoEvents(elements.videoA);
    bindVideoEvents(elements.videoB);
    applyVideoVisibility();

    document.addEventListener('keydown', handleKeyDown, false);
    document.addEventListener('mouseover', function (event) {
      var target = closestFocusable(event.target);
      if (target) focusNode(target);
    }, false);
    document.addEventListener('mousemove', showChrome, false);
    window.addEventListener('popstate', handlePopState, false);
    window.addEventListener('online', function () {
      refreshChannelList();
      if (state.view === 'player') syncNow(false);
    }, false);
    document.addEventListener('visibilitychange', function () {
      /* webOS fires transient visibility changes while its own system UI is
         opening. Closing and immediately reopening the lineup here races the
         encoder startup. pagehide/beforeunload still close a genuine exit,
         while the server TTL handles a suspended or killed application. */
      if (document.hidden) return;
      refreshChannelList();
      if (state.view === 'player') reopenLineupSession();
    }, false);
    window.addEventListener('pagehide', closeLineupSession, false);
    window.addEventListener('beforeunload', closeLineupSession, false);
  }

  function bindVideoEvents(video) {
    video.addEventListener('loadedmetadata', function (event) {
      if (event.currentTarget !== tuneVideo()) return;
      joinLive();
    }, false);
    video.addEventListener('canplay', function (event) {
      if (event.currentTarget !== tuneVideo()) return;
      clearBufferingTimers();
      state.bufferingPrepareFailures = 0;
      if (state.tuning && state.activeSource && state.activeSource.mode === 'channel-hls') {
        seekHlsLiveEdge();
        stabilizeTuning();
      }
      else if (!state.localPaused) setPlayerStatus('Playing live');
      if (state.pendingJoin) joinLive();
    }, false);
    video.addEventListener('playing', function (event) {
      if (event.currentTarget !== tuneVideo()) return;
      clearBufferingTimers();
      state.bufferingPrepareFailures = 0;
      state.awaitingGesture = false;
      if (state.tuning) {
        if (state.activeSource && state.activeSource.mode === 'channel-hls') seekHlsLiveEdge();
        stabilizeTuning();
      }
      else setPlayerStatus('Playing live');
      queuePresenceHeartbeat();
    }, false);
    video.addEventListener('seeked', function (event) {
      if (event.currentTarget !== tuneVideo()) return;
      state.hlsSeekPending = false;
      if (state.tuning && state.activeSource && state.activeSource.mode === 'channel-hls') stabilizeTuning();
    }, false);
    video.addEventListener('waiting', handleVideoWaiting, false);
    video.addEventListener('stalled', handleVideoWaiting, false);
    video.addEventListener('pause', function (event) {
      if (event.currentTarget !== tuneVideo()) return;
      if (state.localPaused) {
        clearBufferingTimers();
        setPlayerStatus('Paused — press Play to rejoin live');
      }
      queuePresenceHeartbeat();
    }, false);
    video.addEventListener('error', function (event) {
      if (event.currentTarget !== tuneVideo()) return;
      clearBufferingTimers();
      handleMediaError();
    }, false);
  }

  function handleVideoWaiting(event) {
    if (event.currentTarget !== tuneVideo()) return;
    if (state.tuning) {
      clearBufferingTimers();
      clearTuningTimer();
      setPlayerStatus('Tuning — preparing live video…');
    } else if (!state.localPaused) {
      scheduleBufferingRecovery(event.currentTarget);
    }
    queuePresenceHeartbeat();
  }

  function activeVideo() {
    return videoForSlot(state.videoSlot);
  }

  function standbyVideo() {
    return state.videoSlot === 'A' ? elements.videoB : elements.videoA;
  }

  function videoForSlot(slot) {
    return slot === 'A' ? elements.videoA : elements.videoB;
  }

  function tuneVideo() {
    return state.candidateSlot ? videoForSlot(state.candidateSlot) : activeVideo();
  }

  function applyVideoVisibility() {
    elements.videoA.classList.toggle('player-video--standby', state.videoSlot !== 'A');
    elements.videoB.classList.toggle('player-video--standby', state.videoSlot !== 'B');
  }

  function connectToServer(rawValue, remember, automatic) {
    var attemptId = ++state.connectSerial;
    state.launchCancelled = false;
    var normalized;
    try {
      normalized = normalizeServerUrl(rawValue);
    } catch (error) {
      elements.connectButton.disabled = false;
      activateView('setup');
      setSetupMessage(error.message || 'Enter a valid server address.');
      focusNode(elements.serverInput);
      return;
    }

    elements.serverInput.value = normalized;
    setSetupMessage(automatic ? 'Finding your ToastTV server…' : 'Connecting…');
    elements.connectButton.disabled = true;
    requestJson(normalized + '/api/v1/channels', 7000, function (error, data, timing) {
      if (attemptId !== state.connectSerial) return;
      elements.connectButton.disabled = false;
      if (error) {
        if (automatic) {
          showBootMessage(
            state.reconnectAttempt < 2
              ? 'Looking for ToastTV — reconnecting…'
              : 'Server unavailable — still reconnecting…',
            true
          );
          scheduleStartupReconnect(normalized);
        } else {
          activateView('setup');
          setSetupMessage('Could not reach ToastTV. Check the address and make sure the server is running.');
          focusNode(elements.connectButton);
        }
        return;
      }
      if (!isChannelList(data)) {
        activateView('setup');
        setSetupMessage('That server answered, but it is not a compatible ToastTV server.');
        focusNode(elements.connectButton);
        return;
      }

      if (state.serverUrl && state.serverUrl !== normalized) {
        state.clockSamples = [];
        state.clockOffsetMs = 0;
        state.guideCache = {};
        state.guideRequests = {};
        state.lineupPreferredChannelId = null;
        state.lineupDesiredChannelId = null;
        state.lineupRetargetInFlight = null;
      }
      state.serverUrl = normalized;
      state.scheduleRefreshSerial += 1;
      state.scheduleHydrating = false;
      state.scheduleHydratedAt = 0;
      state.channels = data.channels;
      state.channelNow = {};
      state.reconnectAttempt = 0;
      recordClockSample(data.serverTimeMs, timing);
      if (remember || !readStorage(STORAGE_SERVER)) writeStorage(STORAGE_SERVER, normalized);
      restoreChannelIndex();
      renderChannels();
      elements.serverLabel.textContent = normalized;
      setSetupMessage('');
      startPresenceHeartbeat();
      startChannelRefresh();

      if (state.setupFromChannels) {
        state.setupFromChannels = false;
        activateView('channels');
        goBack();
      } else if (state.channels.length && readStorage(STORAGE_CHANNEL)) {
        activateView('boot');
        startTelevision();
      } else {
        safeReplaceHistory({ view: 'channels' });
        activateView('channels');
      }
      if (state.view === 'channels') hydrateChannelCards();
    });
  }

  function startTelevision() {
    if (state.lineupOpening || state.launchCancelled || state.view === 'setup') return;
    state.lineupOpening = true;
    var generation = ++state.tuneGeneration;
    var requestedAt = Date.now();
    var savedChannelId = readStorage(STORAGE_CHANNEL);
    showBootMessage('Tuning your last channel…', false);
    revealBootActionsLater();
    postJson(
      state.serverUrl + '/api/client/v1/session',
      { clientId: state.clientId, lastChannelId: savedChannelId, lineup: true },
      18000,
      function (error, data) {
        state.lineupOpening = false;
        if (generation !== state.tuneGeneration || state.launchCancelled || state.view === 'setup') return;
        if (error || !data || !data.channel) {
          if (data && data.error) {
            showChannelStartupFailure(data.error);
          } else {
            showBootMessage('The channel is taking longer to start — retrying…', true);
            scheduleStartupRetry();
          }
          return;
        }
        if (data.status !== 'ready') {
          showChannelStartupFailure(data.error || 'The last channel could not start. Choose another channel to continue.');
          return;
        }
        state.lineupPreferredChannelId = data.channel.id;
        state.lineupDesiredChannelId = data.channel.id;
        state.reconnectAttempt = 0;
        var index = findChannelIndex(data.channel.id);
        if (index < 0) index = firstAvailableChannelIndex();
        if (index < 0) {
          safeReplaceHistory({ view: 'channels' });
          activateView('channels');
          return;
        }
        state.tuneMetrics = { requestedAt: requestedAt, preparedAt: Date.now(), attachedAt: 0, firstFrameAt: 0, channelId: state.channels[index].id, src: 'startup' };
        state.requestedChannelIndex = index;
        state.requestedChannelId = state.channels[index].id;
        safeReplaceHistory({ view: 'player' });
        resolvePreparedChannel(state.channels[index].id, generation, false, true);
      }
    );
  }

  function closeLineupSession() {
    if (!state.serverUrl || !state.clientId) return;
    var payload = JSON.stringify({ clientId: state.clientId });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(
          state.serverUrl + '/api/client/v1/session/close',
          new Blob([payload], { type: 'application/json' })
        );
        return;
      }
    } catch (ignore) {}
    postJson(state.serverUrl + '/api/client/v1/session/close', { clientId: state.clientId }, 3000);
  }

  function reopenLineupSession() {
    var channel = currentChannel();
    if (!channel || !state.serverUrl || state.lineupOpening) return;
    state.lineupOpening = true;
    postJson(
      state.serverUrl + '/api/client/v1/session',
      { clientId: state.clientId, lastChannelId: channel.id, lineup: true },
      18000,
      function (error, data) {
        state.lineupOpening = false;
        if (error || state.view !== 'player' || !currentChannel() || currentChannel().id !== channel.id) return;
        if (!data || data.status !== 'ready') {
          setPlayerStatus('Playing live — background lineup warm-up delayed');
          return;
        }
        state.lineupPreferredChannelId = channel.id;
        state.lineupDesiredChannelId = channel.id;
        if (state.activeSource && state.activeSource.mode === 'channel-hls' &&
            !activeVideo().paused && activeVideo().readyState >= 2) {
          syncNow(false);
        } else {
          syncNow(true);
        }
      }
    );
  }

  function showChannelStartupFailure(message) {
    safeReplaceHistory({ view: 'channels' });
    activateView('channels');
    hydrateChannelCards();
    showToast(message || 'The last channel could not start. Choose another channel.');
  }

  function scheduleStartupRetry() {
    if (startupReconnectTimer || state.launchCancelled) return;
    var index = Math.min(state.reconnectAttempt, RECONNECT_DELAYS.length - 1);
    var delay = RECONNECT_DELAYS[index];
    state.reconnectAttempt += 1;
    startupReconnectTimer = window.setTimeout(function () {
      startupReconnectTimer = null;
      if (state.launchCancelled || state.view === 'setup') return;
      startTelevision();
    }, delay);
  }

  function scheduleStartupReconnect(serverUrl) {
    if (startupReconnectTimer || state.launchCancelled) return;
    var index = Math.min(state.reconnectAttempt, RECONNECT_DELAYS.length - 1);
    var delay = RECONNECT_DELAYS[index];
    state.reconnectAttempt += 1;
    startupReconnectTimer = window.setTimeout(function () {
      startupReconnectTimer = null;
      if (state.launchCancelled || state.view === 'setup') return;
      connectToServer(serverUrl, false, true);
    }, delay);
  }

  function showBootMessage(message, showSettings) {
    activateView('boot');
    elements.bootMessage.textContent = message;
    elements.bootRetryButton.classList.toggle('hidden', !showSettings);
    elements.bootBrowseButton.classList.add('hidden');
    elements.bootSettingsButton.classList.toggle('hidden', !showSettings);
  }

  function revealBootActionsLater() {
    if (bootActionTimer) window.clearTimeout(bootActionTimer);
    bootActionTimer = window.setTimeout(function () {
      bootActionTimer = null;
      if (state.view !== 'boot' || state.launchCancelled) return;
      elements.bootBrowseButton.classList.toggle('hidden', !state.channels.length);
      elements.bootSettingsButton.classList.remove('hidden');
      focusNode(state.channels.length ? elements.bootBrowseButton : elements.bootSettingsButton);
    }, 2200);
  }

  function cancelStartupWork() {
    state.launchCancelled = true;
    state.lineupOpening = false;
    state.connectSerial += 1;
    state.tuneGeneration += 1;
    if (startupReconnectTimer) window.clearTimeout(startupReconnectTimer);
    startupReconnectTimer = null;
    if (bootActionTimer) window.clearTimeout(bootActionTimer);
    bootActionTimer = null;
  }

  function retryLaunch() {
    cancelStartupWork();
    state.launchCancelled = false;
    elements.bootRetryButton.classList.add('hidden');
    elements.bootBrowseButton.classList.add('hidden');
    elements.bootSettingsButton.classList.add('hidden');
    if (state.serverUrl && state.channels.length) startTelevision();
    else connectToServer(state.serverUrl || elements.serverInput.value, false, true);
  }

  function prepareCurrentChannel(onFailure, shouldContinue) {
    var channel = currentChannel();
    if (!channel || !state.serverUrl) return;
    postJson(
      state.serverUrl + '/api/client/v1/channels/' + encodeURIComponent(channel.id) + '/prepare',
      { clientId: state.clientId },
      15000,
      function (error, data) {
        if (state.view !== 'player' || !currentChannel() || currentChannel().id !== channel.id) return;
        if (shouldContinue && !shouldContinue()) return;
        if (error || !data || data.status !== 'ready') {
          if (onFailure) onFailure(data && data.error ? data.error : 'The channel encoder is unavailable.');
          return;
        }
        syncNow(true);
      }
    );
  }

  function normalizeServerUrl(value) {
    var raw = String(value || '').replace(/^\s+|\s+$/g, '');
    if (!raw) throw new Error('Enter the ToastTV server address.');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'http://' + raw;

    var match = /^(https?):\/\/([^\/?#]+)\/?$/i.exec(raw);
    if (!match) throw new Error('Use only a server name or IP address, with no extra path.');
    var protocol = match[1].toLowerCase();
    var authority = match[2];
    if (authority.indexOf('@') !== -1) throw new Error('Usernames and passwords are not allowed in the server address.');
    if (/\s/.test(authority)) throw new Error('The server address cannot contain spaces.');

    var host = authority;
    var port = '';
    if (authority.charAt(0) === '[') {
      var closeBracket = authority.indexOf(']');
      if (closeBracket < 2) throw new Error('Enter a valid IP address.');
      host = authority.slice(0, closeBracket + 1);
      if (authority.length > closeBracket + 1) {
        if (authority.charAt(closeBracket + 1) !== ':') throw new Error('Enter a valid server port.');
        port = authority.slice(closeBracket + 2);
      }
    } else {
      var colon = authority.lastIndexOf(':');
      if (colon !== -1) {
        if (authority.indexOf(':') !== colon) throw new Error('Wrap an IPv6 address in square brackets.');
        host = authority.slice(0, colon);
        port = authority.slice(colon + 1);
      }
    }
    if (!host) throw new Error('Enter a server name or IP address.');
    if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
      throw new Error('The server port must be between 1 and 65535.');
    }
    return protocol + '://' + host + ':' + (port || '1993');
  }

  function requestJson(url, timeoutMs, callback) {
    var xhr = new XMLHttpRequest();
    var startedAt = Date.now();
    var finished = false;
    function finish(error, data) {
      if (finished) return;
      finished = true;
      callback(error, data, { startedAt: startedAt, endedAt: Date.now() });
    }
    try {
      xhr.open('GET', url, true);
      xhr.timeout = timeoutMs;
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        var payload = null;
        try { payload = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch (ignore) {}
        if (xhr.status >= 200 && xhr.status < 300) finish(null, payload);
        else finish(new Error('ToastTV returned HTTP ' + xhr.status), payload);
      };
      xhr.onerror = function () { finish(new Error('Network error')); };
      xhr.ontimeout = function () { finish(new Error('Connection timed out')); };
      xhr.send();
    } catch (error) {
      finish(error);
    }
    return xhr;
  }

  function requestText(url, timeoutMs, callback) {
    var xhr = new XMLHttpRequest();
    var finished = false;
    function finish(error, value) {
      if (finished) return;
      finished = true;
      callback(error, value);
    }
    try {
      xhr.open('GET', url, true);
      xhr.timeout = timeoutMs;
      xhr.setRequestHeader('Accept', 'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain');
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) finish(null, xhr.responseText || '');
        else finish(new Error('ToastTV returned HTTP ' + xhr.status), xhr.responseText || '');
      };
      xhr.onerror = function () { finish(new Error('Network error')); };
      xhr.ontimeout = function () { finish(new Error('Connection timed out')); };
      xhr.send();
    } catch (error) {
      finish(error);
    }
    return xhr;
  }

  function postJson(url, payload, timeoutMs, callback) {
    var xhr = new XMLHttpRequest();
    var finished = false;
    function finish(error, data) {
      if (finished) return;
      finished = true;
      if (callback) callback(error, data);
    }
    try {
      xhr.open('POST', url, true);
      xhr.timeout = timeoutMs;
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        var data = null;
        try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch (ignore) {}
        if (xhr.status >= 200 && xhr.status < 300) finish(null, data);
        else finish(new Error('ToastTV returned HTTP ' + xhr.status), data);
      };
      xhr.onerror = function () { finish(new Error('Network error')); };
      xhr.ontimeout = function () { finish(new Error('Connection timed out')); };
      xhr.send(JSON.stringify(payload));
    } catch (error) {
      finish(error);
    }
    return xhr;
  }

  function isChannelList(data) {
    if (!data || typeof data.serverTimeMs !== 'number' || !isArray(data.channels)) return false;
    var index;
    for (index = 0; index < data.channels.length; index += 1) {
      if (!data.channels[index] || typeof data.channels[index].id !== 'string' || typeof data.channels[index].name !== 'string') return false;
    }
    return true;
  }

  function isNowResult(data) {
    if (!data || typeof data.serverTimeMs !== 'number' || typeof data.channelId !== 'string') return false;
    if (data.program === null) return true;
    var hasDirectPlayback = data.program && data.program.playback &&
      data.program.playback.mode === 'direct' && typeof data.program.playback.url === 'string';
    var channelPlayback = data.liveStream || data.playback;
    var hasChannelPlayback = channelPlayback && channelPlayback.mode === 'hls' &&
      typeof channelPlayback.url === 'string';
    return data.program && typeof data.program.id === 'string' &&
      typeof data.program.title === 'string' && typeof data.program.offsetMs === 'number' &&
      (hasDirectPlayback || hasChannelPlayback);
  }

  function isLineupSchedule(data) {
    if (!data || typeof data.serverTimeMs !== 'number' || !isArray(data.schedules)) return false;
    var index;
    for (index = 0; index < data.schedules.length; index += 1) {
      if (!isNowResult(data.schedules[index])) return false;
    }
    return true;
  }

  function renderChannels() {
    var focused = closestFocusable(document.activeElement);
    var focusedChannelId = focused && focused.getAttribute('data-channel-id');
    clearChildren(elements.channelGrid);
    elements.channelCount.textContent = String(state.channels.length);
    elements.emptyChannels.classList.toggle('hidden', state.channels.length !== 0);
    elements.channelGrid.classList.toggle('hidden', state.channels.length === 0);
    var index;
    for (index = 0; index < state.channels.length; index += 1) {
      elements.channelGrid.appendChild(createChannelCard(state.channels[index], index));
    }
    if (state.channels.length) {
      var previewIndex = focusedChannelId ? findChannelIndex(focusedChannelId) : state.channelIndex;
      selectChannelPreview(previewIndex < 0 ? 0 : previewIndex);
    } else resetChannelPreview();
    window.setTimeout(function () {
      if (state.view !== 'channels' || state.overlay) return;
      var preferred = focusedChannelId && document.querySelector('[data-channel-id="' + escapeAttribute(focusedChannelId) + '"]');
      var current = document.querySelector('[data-channel-index="' + state.channelIndex + '"]');
      if (preferred) focusNode(preferred);
      else if (current) focusNode(current);
      else focusFirst();
    }, 50);
  }

  function createChannelCard(channel, index) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'channel-card';
    button.setAttribute('data-focusable', '');
    button.setAttribute('data-channel-index', String(index));
    button.setAttribute('data-channel-id', channel.id);
    button.setAttribute('aria-label', 'Channel ' + channelNumber(index) + ', ' + channel.name + '. Watch live.');
    if (index === state.channelIndex) button.classList.add('is-current');

    var number = document.createElement('span');
    number.className = 'channel-card__number';
    number.textContent = channelNumber(index);
    var logo = document.createElement('span');
    logo.className = 'channel-card__logo';
    logo.setAttribute('data-channel-logo', channel.id);
    logo.textContent = channelMonogram(channel.name);
    var copy = document.createElement('span');
    copy.className = 'channel-card__copy';
    var topLine = document.createElement('span');
    topLine.className = 'channel-card__topline';
    var live = document.createElement('span');
    live.className = 'channel-card__live';
    live.textContent = channel.onAir === false ? 'OFF AIR' : 'CHANNEL';
    live.setAttribute('data-air-status', channel.onAir === false ? 'off-air' : 'checking');
    live.setAttribute('data-channel-state', channel.id);
    var title = document.createElement('h3');
    title.textContent = channel.name;
    var program = document.createElement('p');
    program.className = 'channel-card__program';
    program.textContent = 'Checking the schedule…';
    program.setAttribute('data-channel-program', channel.id);
    var next = document.createElement('p');
    next.className = 'channel-card__next';
    next.textContent = channel.onAir === false ? 'Channel is currently off air' : 'Loading what\u2019s next\u2026';
    next.setAttribute('data-channel-next', channel.id);
    button.appendChild(number);
    button.appendChild(logo);
    topLine.appendChild(title);
    topLine.appendChild(live);
    copy.appendChild(topLine);
    copy.appendChild(program);
    copy.appendChild(next);
    button.appendChild(copy);
    button.addEventListener('click', function () { tuneChannel(index, true); }, false);
    return button;
  }

  function hydrateChannelCards(force) {
    if (!state.serverUrl || state.scheduleHydrating) return;
    if (!force && state.scheduleHydratedAt && Date.now() - state.scheduleHydratedAt < SCHEDULE_REFRESH_INTERVAL_MS) {
      renderRememberedChannelSchedules();
      return;
    }
    var serverAtStart = state.serverUrl;
    var refreshId = ++state.scheduleRefreshSerial;
    state.scheduleHydrating = true;
    requestJson(serverAtStart + '/api/v1/channels/schedule', 15000, function (error, data, timing) {
      if (refreshId !== state.scheduleRefreshSerial || state.serverUrl !== serverAtStart) return;
      state.scheduleHydrating = false;
      if (error || !isLineupSchedule(data)) {
        markChannelSchedulesStale();
        return;
      }
      recordClockSample(data.serverTimeMs, timing);
      state.scheduleHydratedAt = Date.now();
      var schedules = {};
      var index;
      for (index = 0; index < data.schedules.length; index += 1) {
        schedules[data.schedules[index].channelId] = data.schedules[index];
      }
      for (index = 0; index < state.channels.length; index += 1) {
        var channel = state.channels[index];
        var schedule = schedules[channel.id];
        if (schedule && isNowResult(schedule)) {
          var previous = state.channelNow[channel.id];
          if (previous && previous.timelineRevision && previous.timelineRevision !== schedule.timelineRevision) {
            invalidateGuideCacheForChannel(channel.id);
          }
          state.channelNow[channel.id] = schedule;
          renderChannelScheduleCard(channel, schedule, false);
        } else if (state.channelNow[channel.id] && isNowResult(state.channelNow[channel.id])) {
          renderChannelScheduleCard(channel, state.channelNow[channel.id], true);
        }
      }
    });
  }

  function renderRememberedChannelSchedules() {
    var index;
    for (index = 0; index < state.channels.length; index += 1) {
      var channel = state.channels[index];
      var schedule = state.channelNow[channel.id];
      if (schedule && isNowResult(schedule)) renderChannelScheduleCard(channel, schedule, false);
    }
  }

  function invalidateGuideCacheForChannel(channelId) {
    var prefix = channelId + ':';
    var keys = Object.keys(state.guideCache);
    var index;
    for (index = 0; index < keys.length; index += 1) {
      if (keys[index].slice(0, prefix.length) === prefix) delete state.guideCache[keys[index]];
    }
  }

  function renderChannelScheduleCard(channel, data, stale) {
    var target = document.querySelector('[data-channel-program="' + escapeAttribute(channel.id) + '"]');
    var channelState = document.querySelector('[data-channel-state="' + escapeAttribute(channel.id) + '"]');
    var nextTarget = document.querySelector('[data-channel-next="' + escapeAttribute(channel.id) + '"]');
    if (!target) return;
    if (!data.program) {
      target.textContent = data.next ? 'Next: ' + data.next.title : 'Off air';
      setChannelCardState(channelState, stale ? 'UPDATING' : 'OFF AIR', stale ? 'checking' : 'off-air');
      if (nextTarget) nextTarget.textContent = data.next ? 'Starts ' + formatTime(data.next.scheduledStart) : 'No later program scheduled';
    } else {
      target.textContent = data.program.title;
      setChannelCardState(channelState, stale ? 'UPDATING' : 'ON AIR', stale ? 'checking' : 'on-air');
      if (nextTarget) nextTarget.textContent = data.next ? 'Next: ' + data.next.title : 'Last show scheduled';
    }
    renderChannelCardLogo(channel.id, data);
    if (state.channels[state.previewChannelIndex] && state.channels[state.previewChannelIndex].id === channel.id) {
      renderChannelPreview(state.previewChannelIndex);
    }
  }

  function markChannelSchedulesStale() {
    var index;
    for (index = 0; index < state.channels.length; index += 1) {
      var channel = state.channels[index];
      var existing = state.channelNow[channel.id];
      if (existing && isNowResult(existing)) {
        renderChannelScheduleCard(channel, existing, true);
        continue;
      }
      var target = document.querySelector('[data-channel-program="' + escapeAttribute(channel.id) + '"]');
      var channelState = document.querySelector('[data-channel-state="' + escapeAttribute(channel.id) + '"]');
      var nextTarget = document.querySelector('[data-channel-next="' + escapeAttribute(channel.id) + '"]');
      if (target) target.textContent = 'Schedule is still loading…';
      setChannelCardState(channelState, 'RETRYING', 'checking');
      if (nextTarget) nextTarget.textContent = 'The channel itself may still be available';
    }
  }

  function setChannelCardState(element, label, status) {
    if (!element) return;
    element.textContent = label;
    element.setAttribute('data-air-status', status);
  }

  function selectChannelPreview(index) {
    if (!state.channels.length) return;
    state.previewChannelIndex = Math.max(0, Math.min(Number(index) || 0, state.channels.length - 1));
    var cards = elements.channelGrid.querySelectorAll('[data-channel-index]');
    var cardIndex;
    for (cardIndex = 0; cardIndex < cards.length; cardIndex += 1) {
      cards[cardIndex].classList.toggle('is-previewed', Number(cards[cardIndex].getAttribute('data-channel-index')) === state.previewChannelIndex);
    }
    renderChannelPreview(state.previewChannelIndex);
  }

  function resetChannelPreview() {
    state.previewChannelIndex = 0;
    hideChannelPreviewLogo();
    elements.channelPreviewNumber.textContent = '—';
    elements.channelPreviewName.textContent = 'No channels available';
    elements.channelPreviewMonogram.textContent = 'TV';
    setChannelCardState(elements.channelPreviewState, 'OFFLINE', 'unavailable');
    elements.channelPreviewProgram.textContent = 'There is nothing to watch yet';
    elements.channelPreviewEpisode.textContent = 'Add or enable a channel on the ToastTV server, then refresh this screen.';
    elements.channelPreviewTime.textContent = '—';
    elements.channelPreviewNext.textContent = 'Waiting for a channel lineup';
    elements.channelPreviewTimelineFill.style.width = '0%';
    elements.channelWatchButton.disabled = true;
    elements.channelGuideButton.disabled = true;
  }

  function renderChannelPreview(index) {
    var channel = state.channels[index];
    if (!channel) return;
    var data = state.channelNow[channel.id];
    elements.channelPreviewNumber.textContent = channelNumber(index);
    elements.channelPreviewName.textContent = channel.name;
    elements.channelPreviewMonogram.textContent = channelMonogram(channel.name);
    hideChannelPreviewLogo();
    var logoUrl = channelBrandingUrl(data);
    if (logoUrl) {
      elements.channelPreviewLogo.alt = channel.name + ' logo';
      elements.channelPreviewLogo.src = logoUrl;
    }
    elements.channelWatchButton.disabled = channel.enabled === false || channel.onAir === false;
    elements.channelGuideButton.disabled = channel.enabled === false;
    if (!data) {
      setChannelCardState(elements.channelPreviewState, 'CHECKING', 'checking');
      elements.channelPreviewProgram.textContent = 'Loading the live schedule…';
      elements.channelPreviewEpisode.textContent = 'Every channel joins at the point already in progress.';
      elements.channelPreviewTime.textContent = '—';
      elements.channelPreviewNext.textContent = 'Checking the schedule…';
      elements.channelPreviewTimelineFill.style.width = '0%';
      return;
    }
    if (data.error) {
      setChannelCardState(elements.channelPreviewState, 'UNAVAILABLE', 'unavailable');
      elements.channelPreviewProgram.textContent = 'Schedule unavailable';
      elements.channelPreviewEpisode.textContent = 'ToastTV will check this channel again automatically.';
      elements.channelPreviewTime.textContent = '—';
      elements.channelPreviewNext.textContent = 'Try refreshing the lineup in a moment.';
      elements.channelPreviewTimelineFill.style.width = '0%';
      return;
    }
    if (!data.program) {
      setChannelCardState(elements.channelPreviewState, 'OFF AIR', 'off-air');
      elements.channelPreviewProgram.textContent = 'This channel is off air';
      elements.channelPreviewEpisode.textContent = data.next ? 'Programming resumes at ' + formatTime(data.next.scheduledStart) : 'No later program is scheduled.';
      elements.channelPreviewTime.textContent = '—';
      elements.channelPreviewNext.textContent = data.next ? data.next.title : 'No later program scheduled';
      elements.channelPreviewTimelineFill.style.width = '0%';
      return;
    }
    setChannelCardState(elements.channelPreviewState, 'ON AIR', 'on-air');
    elements.channelPreviewProgram.textContent = data.program.title;
    elements.channelPreviewEpisode.textContent = programEpisodeText(data.program) || data.program.collectionTitle || 'Live now';
    elements.channelPreviewTime.textContent = formatTime(data.program.scheduledStart) + ' – ' + formatTime(data.program.scheduledEnd);
    elements.channelPreviewNext.textContent = data.next
      ? formatTime(data.next.scheduledStart) + '  ' + data.next.title
      : 'Last show on the schedule';
    updateChannelPreviewTimeline();
  }

  function updateChannelPreviewTimeline() {
    if (!state.channels.length) return;
    var channel = state.channels[state.previewChannelIndex];
    var data = channel && state.channelNow[channel.id];
    if (!data || data.error || !data.program) return;
    var start = Date.parse(data.program.scheduledStart);
    var end = Date.parse(data.program.scheduledEnd);
    var now = Date.now() + state.clockOffsetMs;
    if (!isFinite(start) || !isFinite(end) || end <= start) return;
    var percent = Math.max(0, Math.min(100, (now - start) * 100 / (end - start)));
    elements.channelPreviewTimelineFill.style.width = percent.toFixed(2) + '%';
    if (elements.channelPreviewTimelineFill.parentNode) elements.channelPreviewTimelineFill.parentNode.setAttribute('aria-valuenow', String(Math.round(percent)));
  }

  function renderChannelCardLogo(channelId, data) {
    var target = elements.channelGrid.querySelector('[data-channel-logo="' + escapeAttribute(channelId) + '"]');
    var url = channelBrandingUrl(data);
    if (!target) return;
    clearChildren(target);
    if (!url) {
      target.textContent = channelMonogram((state.channels[findChannelIndex(channelId)] || {}).name || 'TV');
      return;
    }
    var image = document.createElement('img');
    image.alt = '';
    image.src = url;
    image.addEventListener('error', function () {
      target.textContent = channelMonogram((state.channels[findChannelIndex(channelId)] || {}).name || 'TV');
    }, false);
    target.appendChild(image);
  }

  function channelBrandingUrl(data) {
    var branding = data && data.branding;
    if (!branding || branding.enabled !== true || typeof branding.logoUrl !== 'string') return null;
    return window.ToastTVPlaybackPolicy.resolveUrl(branding.logoUrl, state.serverUrl);
  }

  function hideChannelPreviewLogo() {
    elements.channelPreviewLogo.classList.add('hidden');
    elements.channelPreviewLogo.removeAttribute('src');
    elements.channelPreviewLogo.alt = '';
    elements.channelPreviewMonogram.classList.remove('hidden');
  }

  function channelMonogram(name) {
    var words = String(name || 'TV').replace(/^\s+|\s+$/g, '').split(/\s+/);
    if (words.length > 1) return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
    return String(words[0] || 'TV').slice(0, 2).toUpperCase();
  }

  function tuneChannel(index, pushHistory, guideChannelId) {
    var guideAfterTune = typeof guideChannelId === 'string' ? guideChannelId : null;
    /* Every tune is a new user intent. An ordinary zap must not inherit a
       deferred guide request created by an earlier channel-browser action. */
    state.pendingGuideChannelId = null;
    if (!state.channels.length) return;
    if (state.view === 'player' && state.tuning && !state.hasCommittedVideo &&
        !state.previousTune && !state.committedChannelId) {
      showToast('The first channel is still tuning. Please wait a moment.');
      return;
    }
    var targetIndex = normalizeChannelIndex(index);
    var channel = state.channels[targetIndex];
    if (!channel) return;
    if (state.requestedChannelId === channel.id) {
      state.pendingGuideChannelId = guideAfterTune;
      return;
    }
    if (state.view === 'player' && !state.tuning && state.committedChannelId === channel.id) {
      state.channelIndex = targetIndex;
      showChrome();
      return;
    }
    var isChannelChange = state.view === 'player' &&
      (state.committedChannelId || state.previousTune) &&
      state.committedChannelId !== channel.id;
    if (state.view === 'player' && state.tuning && !state.hasCommittedVideo && state.previousTune) {
      abandonCandidateTune();
    }
    state.tuneGeneration += 1;
    var generation = state.tuneGeneration;
    state.requestedChannelIndex = targetIndex;
    state.requestedChannelId = channel.id;
    state.pendingGuideChannelId = guideAfterTune;
    state.tuneMetrics = { requestedAt: Date.now(), preparedAt: 0, attachedAt: 0, firstFrameAt: 0, channelId: channel.id, src: 'zap' };
    if (isChannelChange) showChannelOsd(targetIndex, 'Tuning…', true);
    if (zapTimer) window.clearTimeout(zapTimer);
    zapTimer = window.setTimeout(function () {
      zapTimer = null;
      prepareChannel(channel.id, generation, pushHistory);
    }, ZAP_DEBOUNCE_MS);
  }

  function prepareChannel(channelId, generation, pushHistory) {
    var index = findChannelIndex(channelId);
    var channel = index >= 0 ? state.channels[index] : null;
    if (!channel || generation !== state.tuneGeneration) return;
    postJson(
      state.serverUrl + '/api/client/v1/channels/' + encodeURIComponent(channel.id) + '/prepare',
      { clientId: state.clientId },
      15000,
      function (error, data) {
        if (generation !== state.tuneGeneration || state.requestedChannelId !== channelId) return;
        if (error || !data || data.status !== 'ready') {
          recoverRejectedTune(index, data && data.error ? data.error : 'That channel could not be tuned. Please try again.');
          return;
        }
        if (state.tuneMetrics) state.tuneMetrics.preparedAt = Date.now();
        updateChannelOsdProgram('Checking live signal…');
        resolvePreparedChannel(channelId, generation, pushHistory, false);
      }
    );
  }

  function resolvePreparedChannel(channelId, generation, pushHistory, startup) {
    function rejectPrepared(message) {
      if (startup) {
        state.pendingGuideChannelId = null;
        state.requestedChannelIndex = null;
        state.requestedChannelId = null;
        showChannelStartupFailure(message);
        return;
      }
      recoverRejectedTune(findChannelIndex(channelId), message);
    }
    requestJson(
      state.serverUrl + '/api/v1/channels/' + encodeURIComponent(channelId) + '/now',
      15000,
      function (error, data, timing) {
        if (generation !== state.tuneGeneration || state.requestedChannelId !== channelId) return;
        if (error || !isNowResult(data) || data.channelId !== channelId) {
          rejectPrepared('That channel schedule or live source is not ready yet. The current channel was kept playing.');
          return;
        }
        var source = data.program
          ? window.ToastTVPlaybackPolicy.choose(data, state.serverUrl, null, state.clientId)
          : null;
        if (data.program && !source) {
          rejectPrepared('That channel does not have a compatible live source.');
          return;
        }
        if (!source || source.mode !== 'channel-hls') {
          commitPreparedChannel(channelId, generation, pushHistory, { data: data, timing: timing });
          return;
        }
        updateChannelOsdProgram('Locking live signal…');
        verifyPreparedManifest(source.url, channelId, generation, 0, function (manifestError) {
          if (generation !== state.tuneGeneration || state.requestedChannelId !== channelId) return;
          if (manifestError) {
            rejectPrepared('That channel did not publish a complete live signal. The current channel was kept playing.');
            return;
          }
          commitPreparedChannel(channelId, generation, pushHistory, { data: data, timing: timing });
        });
      }
    );
  }

  function verifyPreparedManifest(url, channelId, generation, attempt, callback) {
    var separator = url.indexOf('?') === -1 ? '?' : '&';
    requestText(url + separator + 'probe=' + encodeURIComponent(String(generation) + '-' + String(attempt)), 5000, function (error, text) {
      if (generation !== state.tuneGeneration || state.requestedChannelId !== channelId) return;
      var lines = String(text || '').split(/\r?\n/);
      var segments = 0;
      var index;
      for (index = 0; index < lines.length; index += 1) {
        if (/^segment-\d+\.ts$/i.test(lines[index].replace(/^\s+|\s+$/g, '').split('?')[0])) segments += 1;
      }
      if (!error && /^#EXTM3U(?:\r?\n|$)/.test(String(text || '')) && segments >= 2) {
        callback(null);
        return;
      }
      if (attempt < 2) {
        window.setTimeout(function () {
          verifyPreparedManifest(url, channelId, generation, attempt + 1, callback);
        }, 180 + attempt * 170);
        return;
      }
      callback(error || new Error('Live manifest is incomplete'));
    });
  }

  function commitPreparedChannel(channelId, generation, pushHistory, prepared) {
    if (generation !== state.tuneGeneration) return;
    var index = findChannelIndex(channelId);
    if (index < 0 || state.channels[index].enabled === false || state.channels[index].onAir === false) {
      recoverRejectedTune(index, 'That channel is no longer available.');
      return;
    }
    if (state.committedChannelId && !state.previousTune) {
      state.previousTune = {
        channelId: state.committedChannelId,
        currentNow: state.currentNow,
        programId: state.programId,
        activeSource: state.activeSource
      };
    }
    var priorView = state.view;
    if (priorView !== 'player') state.playerEnteredFromChannels = pushHistory === true;
    state.channelIndex = index;
    state.candidateChannelId = channelId;
    state.requestedChannelIndex = null;
    state.requestedChannelId = null;
    state.reconnectAttempt = 0;
    var channel = currentChannel();
    if (!channel) return;
    state.requestSerial += 1;
    state.guideSerial += 1;
    closeOverlays();
    clearBoundaryTimer();
    clearReconnectTimer();
    clearSourceRefreshTimer();
    clearTuningTimer();
    state.sourceRetryUsed = false;
    state.localPaused = false;
    state.awaitingGesture = false;
    state.currentNow = null;
    state.programId = null;
    state.activeSource = null;
    state.failedLiveUrl = null;
    state.liveRetryAttempt = 0;
    state.attachAttempt = 0;
    state.frameProbeAttempts = 0;
    state.hlsSeekPending = false;
    updateChannelOsdProgram('Switching…');
    detachVideoForTune();
    clearLiveRetryTimer();
    clearPlaybackError();
    if (!state.previousTune) {
      hideChannelLogo();
      elements.playerChannelName.textContent = channel.name;
      elements.playerChannelNumber.textContent = channelLabel(index);
    }
    beginTuning('Switching to the prepared channel…');
    elements.playerBackdrop.classList.remove('hidden');
    if (pushHistory) safePushHistory({ view: 'player' });
    activateView('player');
    showChrome();
    applyNowResult(prepared.data, prepared.timing, true);
    startPlayerTimers();
  }

  function recoverRejectedTune(index, message) {
    state.pendingGuideChannelId = null;
    state.requestedChannelIndex = null;
    state.requestedChannelId = null;
    var restored = rollbackCandidateTune();
    updateChannelOsdProgram('Signal unavailable');
    scheduleChannelOsdHide();
    showToast(message);
    if (state.view === 'player' && !restored) openChannelBrowser();
  }

  function switchChannel(delta) {
    if (!state.channels.length) return;
    var requestedIndex = state.requestedChannelId ? findChannelIndex(state.requestedChannelId) : -1;
    var base = requestedIndex < 0 ? state.channelIndex : requestedIndex;
    tuneChannel(nextAvailableChannelIndex(base, delta), false);
  }

  function startChannelRefresh() {
    if (channelRefreshTimer) return;
    channelRefreshTimer = window.setInterval(refreshChannelList, CHANNEL_REFRESH_INTERVAL_MS);
  }

  function refreshChannelList() {
    if (!state.serverUrl || state.view === 'setup' || document.hidden) return;
    var serverAtStart = state.serverUrl;
    var refreshId = ++state.channelRefreshSerial;
    requestJson(serverAtStart + '/api/v1/channels', 6000, function (error, data, timing) {
      if (refreshId !== state.channelRefreshSerial || serverAtStart !== state.serverUrl || error || !isChannelList(data)) return;
      recordClockSample(data.serverTimeMs, timing);
      reconcileChannelList(data.channels);
    });
  }

  function reconcileChannelList(channels) {
    var committedChannelId = state.committedChannelId;
    var priorIndex = state.channelIndex;
    var changed = channelListSignature(state.channels) !== channelListSignature(channels);
    if (!changed) {
      if (state.view === 'channels') hydrateChannelCards(false);
      return;
    }

    state.channels = channels;
    if (state.requestedChannelId) {
      var requestedIndex = findChannelIndex(state.requestedChannelId);
      if (requestedIndex < 0 || channels[requestedIndex].enabled === false || channels[requestedIndex].onAir === false) {
        state.tuneGeneration += 1;
        state.requestedChannelId = null;
        state.requestedChannelIndex = null;
        state.pendingGuideChannelId = null;
        rollbackCandidateTune();
        showToast('The channel you selected left the lineup.');
      }
    }
    if (state.candidateChannelId) {
      var candidateIndex = findChannelIndex(state.candidateChannelId);
      if (candidateIndex < 0 || channels[candidateIndex].enabled === false || channels[candidateIndex].onAir === false) {
        state.tuneGeneration += 1;
        state.requestedChannelId = null;
        state.requestedChannelIndex = null;
        state.pendingGuideChannelId = null;
        rollbackCandidateTune();
        showToast('The channel being tuned left the lineup.');
      }
    }
    var committedIndex = committedChannelId ? findChannelIndex(committedChannelId) : -1;
    var committedAvailable = committedIndex >= 0 &&
      channels[committedIndex].enabled !== false && channels[committedIndex].onAir !== false;
    restoreChannelIndexById(
      state.candidateChannelId || (committedAvailable ? committedChannelId : state.requestedChannelId),
      priorIndex
    );
    renderChannels();
    if (state.view === 'channels') hydrateChannelCards(true);
    reconcileOpenCatalog();

    if (state.view !== 'player') return;
    if (!channels.length) {
      showToast('No channels are currently available');
      safeReplaceHistory({ view: 'channels' });
      activateView('channels');
      return;
    }
    if (committedChannelId && !committedAvailable) {
      var transitionChannelId = state.candidateChannelId || state.requestedChannelId;
      invalidateRemovedCommittedPlayback(!!state.candidateChannelId);
      if (transitionChannelId) {
        showToast('The current channel left the lineup — finishing your pending switch.');
        return;
      }
      showToast('That channel left the lineup — tuning ' + currentChannel().name);
      showChannelOsd(state.channelIndex, 'Tuning…', true);
      tuneChannel(state.channelIndex, false);
      return;
    }
    if (!committedChannelId && !state.requestedChannelId && !state.candidateChannelId) {
      tuneChannel(state.channelIndex, false);
      return;
    }
    if (!state.previousTune && !state.requestedChannelId && !state.candidateChannelId) {
      elements.playerChannelName.textContent = currentChannel().name;
      syncNow(false);
    }
  }

  function invalidateRemovedCommittedPlayback(preserveCandidate) {
    state.committedChannelId = null;
    state.previousTune = null;
    if (preserveCandidate) return;
    state.pendingJoin = false;
    state.playToken += 1;
    state.currentNow = null;
    state.programId = null;
    state.activeSource = null;
    state.hasCommittedVideo = false;
    state.tuning = false;
    clearBufferingTimers();
    clearTuningTimer();
    resetAllVideos();
    elements.playerScreen.classList.remove('has-video');
    elements.playerScreen.classList.remove('is-tuning');
    elements.playerBackdrop.classList.remove('hidden');
    hideChannelLogo();
    queuePresenceHeartbeat();
  }

  function reconcileOpenCatalog() {
    if (state.overlay !== 'guide' || !state.catalog) return;
    var focused = closestFocusable(document.activeElement);
    var focusedRailId = focused && elements.catalogRail.contains(focused)
      ? focused.getAttribute('data-catalog-channel')
      : null;
    var channels = catalogChannels();
    if (!channels.length) {
      closeOverlays();
      showToast('No channels are available for the guide.');
      window.setTimeout(focusFirst, 40);
      return;
    }
    var selectedIndex = findChannelIndex(state.catalog.channelId);
    var selectionChanged = selectedIndex < 0 || state.channels[selectedIndex].enabled === false;
    if (selectionChanged) {
      state.guideSerial += 1;
      state.catalog.channelId = channels[0].id;
      state.catalog.loadingKey = null;
      state.catalog.dayStarts = null;
      updateCatalogDayLabels();
    }
    renderCatalogRail();
    if (selectionChanged) loadCatalogDay();
    if (focusedRailId) {
      var replacement = elements.catalogRail.querySelector(
        '[data-catalog-channel="' + escapeAttribute(focusedRailId) + '"]'
      ) || elements.catalogRail.querySelector(
        '[data-catalog-channel="' + escapeAttribute(state.catalog.channelId) + '"]'
      );
      if (replacement) focusNode(replacement);
    }
  }

  function channelListSignature(channels) {
    var parts = [];
    var index;
    for (index = 0; index < channels.length; index += 1) {
      parts.push([
        channels[index].id,
        channels[index].name,
        channels[index].enabled === false ? '0' : '1',
        channels[index].onAir === false ? '0' : '1',
        channels[index].timezone || ''
      ].join('|'));
    }
    return parts.join('||');
  }

  function restoreChannelIndexById(channelId, fallbackIndex) {
    var index;
    for (index = 0; index < state.channels.length; index += 1) {
      if (state.channels[index].id === channelId && state.channels[index].enabled !== false && state.channels[index].onAir !== false) {
        state.channelIndex = index;
        return;
      }
    }
    var available = firstAvailableChannelIndex();
    state.channelIndex = available >= 0
      ? available
      : Math.max(0, Math.min(Number(fallbackIndex) || 0, state.channels.length - 1));
  }

  function syncNow(forceReload) {
    if (state.view !== 'player' || !currentChannel() || !state.serverUrl) return;
    var requestId = ++state.requestSerial;
    var channel = currentChannel();
    requestJson(state.serverUrl + '/api/v1/channels/' + encodeURIComponent(channel.id) + '/now', 15000, function (error, data, timing) {
      var activeChannel = currentChannel();
      if (requestId !== state.requestSerial || state.view !== 'player' || !activeChannel || activeChannel.id !== channel.id) return;
      if (error) {
        if (state.previousTune && state.reconnectAttempt >= 3) {
          var delayedChannel = currentChannel();
          if (rollbackCandidateTune()) {
            showToast((delayedChannel ? delayedChannel.name : 'That channel') + ' did not become ready. Returning to the previous channel.');
            return;
          }
        }
        if (state.tuning || !state.hasCommittedVideo || state.previousTune) {
          setPlayerStatus('Tuning — channel is still preparing…');
          if (elements.tuningMessage) elements.tuningMessage.textContent = 'The broadcast is still preparing. Retrying automatically…';
        } else {
          setPlayerStatus('Playing live — schedule update delayed');
        }
        if (state.reconnectAttempt === 2) showToast('The server is slow to respond. Playback will keep trying.');
        scheduleReconnect();
        return;
      }
      if (!isNowResult(data)) {
        showPlaybackError('Incompatible server response', 'Update the ToastTV server and try this channel again.');
        return;
      }
      if (data.channelId !== channel.id) {
        setPlayerStatus('Tuning — refreshing channel data…');
        scheduleReconnect();
        return;
      }
      applyNowResult(data, timing, forceReload);
    });
  }

  function applyNowResult(data, timing, forceReload) {
    var channel = currentChannel();
    if (!channel || !isNowResult(data) || data.channelId !== channel.id) return false;
    state.reconnectAttempt = 0;
    clearReconnectTimer();
    recordClockSample(data.serverTimeMs, timing);
    var previousNow = state.currentNow;
    var previousProgramId = state.programId;
    var previousSource = state.activeSource;
    if (previousNow && previousNow.timelineRevision && previousNow.timelineRevision !== data.timelineRevision) {
      invalidateGuideCacheForChannel(channel.id);
    }
    state.currentNow = data;
    queuePresenceHeartbeat();
    renderProgramInfo();
    updateChannelOsdProgram(data.program ? data.program.title : 'Off air');
    scheduleBoundary();

    if (!data.program) {
      state.programId = null;
      showOffAir(data.next);
      return true;
    }

    hideOffAir();
    var source = window.ToastTVPlaybackPolicy.choose(data, state.serverUrl, state.failedLiveUrl, state.clientId);
    if (!source) {
      showPlaybackError('No compatible playback source', 'The channel stream and direct-play fallback are unavailable.');
      return false;
    }
    /* A channel HLS URL represents the broadcast, not the current program. Keep
       the TV attached while schedule metadata advances underneath it. */
    if (source.mode === 'channel-hls') {
      var baseStreamUrl = source.url;
      if (!forceReload && state.activeSource && state.activeSource.mode === 'channel-hls' &&
          state.activeSource.baseUrl === baseStreamUrl) {
        state.programId = data.program.id;
        if (!state.localPaused && !state.tuning) setPlayerStatus('Playing live');
        return true;
      }
      source.baseUrl = baseStreamUrl;
      source.url = tuneSessionUrl(baseStreamUrl);
    }

    if (source.mode === 'direct' && !forceReload && previousProgramId === data.program.id &&
        !window.ToastTVPlaybackPolicy.shouldReload(state.activeSource, source) && tuneVideo().readyState >= 1) {
      reconcileLivePosition();
      return true;
    }

    if (previousProgramId !== data.program.id) state.sourceRetryUsed = false;
    if (state.hasCommittedVideo && !state.previousTune) {
      state.previousTune = {
        channelId: channel.id,
        currentNow: previousNow,
        programId: previousProgramId,
        activeSource: previousSource
      };
    }
    state.programId = data.program.id;
    loadProgram(data.program, source);
    return true;
  }

  function loadProgram(program, source) {
    clearPlaybackError();
    hideOffAir();
    if (state.hasCommittedVideo && !state.candidateSlot) detachVideoForTune();
    beginTuning(source.mode === 'channel-hls' ? 'Joining live channel…' : 'Loading ' + program.title + '…');
    state.pendingJoin = true;
    state.hlsSeekPending = false;
    state.activeSource = source;
    state.playToken += 1;
    if (!window.ToastTVPlaybackPolicy.loadMediaElement(tuneVideo(), source.url)) handleMediaError();
    if (state.tuneMetrics && !state.tuneMetrics.attachedAt) state.tuneMetrics.attachedAt = Date.now();
  }

  function joinLive() {
    if (!state.pendingJoin || !state.currentNow || !state.currentNow.program || state.localPaused) return;
    state.pendingJoin = false;
    if (state.activeSource && state.activeSource.mode === 'channel-hls') {
      seekHlsLiveEdge();
      attemptPlay(++state.playToken);
      return;
    }
    var target = expectedPositionSeconds();
    var video = tuneVideo();
    if (isFinite(video.duration) && video.duration > 0) {
      target = Math.min(target, Math.max(0, video.duration - 0.25));
    }
    target = Math.max(0, target);
    var token = ++state.playToken;
    var completed = false;
    function finishSeek() {
      if (completed || token !== state.playToken) return;
      completed = true;
      video.removeEventListener('seeked', finishSeek, false);
      attemptPlay(token);
    }
    video.addEventListener('seeked', finishSeek, false);
    window.setTimeout(finishSeek, 1800);
    try {
      if (Math.abs(video.currentTime - target) > 0.5) video.currentTime = target;
      else window.setTimeout(finishSeek, 0);
    } catch (error) {
      finishSeek();
    }
  }

  function seekHlsLiveEdge() {
    try {
      var video = tuneVideo();
      if (!video.seekable || video.seekable.length < 1) return false;
      var edge = video.seekable.end(video.seekable.length - 1);
      if (!isFinite(edge) || !isFinite(video.currentTime)) return false;
      if (video.seeking) return false;
      var lag = edge - video.currentTime;
      if (lag > LIVE_EDGE_TOLERANCE_SECONDS || lag < -1) {
        if (!state.hlsSeekPending) {
          state.hlsSeekPending = true;
          video.currentTime = Math.max(0, edge - LIVE_JOIN_BEHIND_SECONDS);
        }
        return false;
      }
      state.hlsSeekPending = false;
      return true;
    } catch (ignore) { return false; }
  }

  function tuneSessionUrl(url) {
    if (!url) return url;
    state.attachAttempt += 1;
    return url + (url.indexOf('?') === -1 ? '?' : '&') +
      'tune=' + encodeURIComponent(String(state.tuneGeneration)) +
      '&attach=' + encodeURIComponent(String(state.attachAttempt));
  }

  function beginTuning(message) {
    state.tuning = true;
    clearTuningTimer();
    elements.playerScreen.classList.add('is-tuning');
    if (!state.hasCommittedVideo) {
      elements.playerScreen.classList.remove('has-video');
      elements.playerBackdrop.classList.remove('hidden');
    }
    if (elements.tuningChannelName && currentChannel()) elements.tuningChannelName.textContent = currentChannel().name;
    if (elements.tuningMessage) elements.tuningMessage.textContent = message || 'Preparing the live broadcast…';
    setPlayerStatus(message || 'Tuning…');
    showChrome();
  }

  function stabilizeTuning() {
    if (tuningTimer) return;
    setPlayerStatus('Locking onto live broadcast…');
    var generation = state.tuneGeneration;
    var video = tuneVideo();
    var sourceUrl = state.activeSource && state.activeSource.url;
    var sampledTime = Number(video.currentTime) || 0;
    tuningTimer = window.setTimeout(function () {
      tuningTimer = null;
      if (
        generation !== state.tuneGeneration ||
        video !== tuneVideo() ||
        !state.activeSource ||
        state.activeSource.url !== sourceUrl ||
        !state.tuning ||
        !window.ToastTVPlaybackPolicy.isPlaybackStable(video)
      ) return;
      var headroom = playbackHeadroomSeconds(video);
      if ((Number(video.currentTime) || 0) <= sampledTime + 0.03 ||
          (headroom !== null && headroom < MIN_READY_BUFFER_SECONDS)) {
        state.frameProbeAttempts += 1;
        setPlayerStatus(headroom !== null && headroom < MIN_READY_BUFFER_SECONDS
          ? 'Tuning — building a stable live buffer…'
          : 'Tuning — waiting for the first frame…');
        if (state.frameProbeAttempts >= 12) {
          handleMediaError();
          return;
        }
        window.setTimeout(stabilizeTuning, TUNING_STABLE_MS);
        return;
      }
      /* Some LG HLS players expose no seekable range (or remain in seeking)
         while playback is healthy. Joining the live edge is best-effort; actual
         stable playback must never be torn down just because it cannot be proven. */
      if (state.activeSource.mode === 'channel-hls') seekHlsLiveEdge();
      state.tuning = false;
      state.liveRetryAttempt = 0;
      state.failedLiveUrl = null;
      state.hlsSeekPending = false;
      state.frameProbeAttempts = 0;
      var oldVideo = activeVideo();
      if (state.candidateSlot) {
        state.videoSlot = state.candidateSlot;
        state.candidateSlot = null;
        applyVideoVisibility();
      }
      video.muted = false;
      if (oldVideo !== video) window.ToastTVPlaybackPolicy.resetMediaElement(oldVideo);
      else window.ToastTVPlaybackPolicy.resetMediaElement(standbyVideo());
      state.hasCommittedVideo = true;
      state.committedChannelId = currentChannel().id;
      state.candidateChannelId = null;
      state.previousTune = null;
      elements.playerScreen.classList.remove('is-tuning');
      elements.playerScreen.classList.add('has-video');
      renderProgramInfo();
      updateChannelOsdProgram(state.currentNow && state.currentNow.program ? state.currentNow.program.title : 'Live');
      scheduleChannelOsdHide();
      writeStorage(STORAGE_CHANNEL, currentChannel().id);
      retargetLineupSession(currentChannel().id, generation);
      if (state.tuneMetrics && state.tuneMetrics.channelId === currentChannel().id) {
        state.tuneMetrics.firstFrameAt = Date.now();
        logTuneMetrics(state.tuneMetrics);
        state.tuneMetrics = null;
      }
      setPlayerStatus('Playing live');
      scheduleChromeHide();
      queuePresenceHeartbeat();
      openPendingGuideAfterCommit(generation, state.committedChannelId);
      window.setTimeout(function () {
        if (
          generation === state.tuneGeneration &&
          video === activeVideo() &&
          state.activeSource &&
          state.activeSource.url === sourceUrl &&
          state.view === 'player' &&
          !state.tuning
        ) syncNow(false);
      }, 300);
    }, TUNING_STABLE_MS);
  }

  function playbackHeadroomSeconds(video) {
    try {
      if (!video || !video.buffered || video.buffered.length < 1) return null;
      var current = Number(video.currentTime) || 0;
      var index;
      for (index = video.buffered.length - 1; index >= 0; index -= 1) {
        if (video.buffered.start(index) <= current && video.buffered.end(index) >= current) {
          return Math.max(0, video.buffered.end(index) - current);
        }
      }
    } catch (ignore) {}
    return null;
  }

  function openPendingGuideAfterCommit(generation, committedChannelId) {
    var pendingGuideChannelId = state.pendingGuideChannelId;
    state.pendingGuideChannelId = null;
    if (!pendingGuideChannelId) return;
    window.setTimeout(function () {
      if (
        generation !== state.tuneGeneration ||
        state.requestedChannelId ||
        state.view !== 'player' ||
        state.tuning ||
        state.committedChannelId !== committedChannelId
      ) return;
      var guideIndex = findChannelIndex(pendingGuideChannelId);
      if (guideIndex >= 0) openGuideForChannel(guideIndex, 'player');
    }, 80);
  }

  function clearTuningTimer() {
    if (tuningTimer) window.clearTimeout(tuningTimer);
    tuningTimer = null;
  }

  function retargetLineupSession(channelId, generation) {
    if (!state.serverUrl || !channelId || generation !== state.tuneGeneration) return;
    state.lineupDesiredChannelId = channelId;
    flushLineupRetarget();
  }

  function flushLineupRetarget() {
    if (!state.serverUrl || state.lineupRetargetInFlight || !state.lineupDesiredChannelId) return;
    if (state.lineupPreferredChannelId === state.lineupDesiredChannelId) return;
    var channelId = state.lineupDesiredChannelId;
    var serverAtStart = state.serverUrl;
    var requestToken = { channelId: channelId, serverUrl: serverAtStart };
    state.lineupRetargetInFlight = requestToken;
    postJson(
      state.serverUrl + '/api/client/v1/session',
      { clientId: state.clientId, lastChannelId: channelId, lineup: true },
      12000,
      function (error, data) {
        if (state.lineupRetargetInFlight !== requestToken || state.serverUrl !== serverAtStart) return;
        state.lineupRetargetInFlight = null;
        var applied = !error && data && data.status === 'ready';
        if (applied) {
          /* The server applied this preference even when the viewer completed
             another zap while the request was in flight. Record it, then send
             the newest desired channel serially below. */
          state.lineupPreferredChannelId = channelId;
        }
        var current = currentChannel();
        if (state.view === 'player' && state.hasCommittedVideo && current) {
          state.lineupDesiredChannelId = current.id;
        }
        if (!applied || state.view !== 'player' || !state.hasCommittedVideo) return;
        if (state.lineupDesiredChannelId !== state.lineupPreferredChannelId) {
          flushLineupRetarget();
        }
      }
    );
  }

  function attemptPlay(token) {
    if (token !== state.playToken || state.localPaused) return;
    var result;
    try { result = tuneVideo().play(); } catch (error) { handlePlayRejected(); return; }
    if (result && typeof result.then === 'function') {
      result.then(function () {}, handlePlayRejected);
    }
  }

  function handlePlayRejected() {
    state.awaitingGesture = true;
    setPlayerStatus('Press OK to start playback');
    showChrome();
  }

  function expectedPositionSeconds() {
    if (!state.currentNow || !state.currentNow.program) return 0;
    var program = state.currentNow.program;
    var elapsedSinceResponse = Date.now() + state.clockOffsetMs - state.currentNow.serverTimeMs;
    return window.ToastTVPlaybackPolicy.expectedDirectPosition(program, elapsedSinceResponse);
  }

  function reconcileLivePosition() {
    if (!state.currentNow || !state.currentNow.program || state.localPaused) return;
    if (state.activeSource && state.activeSource.mode === 'channel-hls') {
      try {
        var video = activeVideo();
        if (video.seekable && video.seekable.length > 0) {
          var liveEdge = video.seekable.end(video.seekable.length - 1);
          if (liveEdge - video.currentTime > DRIFT_LIMIT_SECONDS) {
            seekHlsLiveEdge();
            setPlayerStatus('Rejoined live');
          }
        }
      } catch (ignore) {}
      return;
    }
    var target = expectedPositionSeconds();
    if (Math.abs(activeVideo().currentTime - target) > DRIFT_LIMIT_SECONDS) {
      try {
        if (isFinite(activeVideo().duration)) target = Math.min(target, Math.max(0, activeVideo().duration - 0.25));
        activeVideo().currentTime = Math.max(0, target);
        setPlayerStatus('Rejoined live');
      } catch (ignore) {}
    }
  }

  function handleMediaError() {
    if (state.view !== 'player' || !state.currentNow || !state.currentNow.program) return;
    if (state.tuning && !state.activeSource && liveRetryTimer) return;
    if (state.activeSource && state.activeSource.mode === 'channel-hls') {
      retryLiveStream('Tuning — live stream is warming up…');
      return;
    }
    if (!state.sourceRetryUsed) {
      state.sourceRetryUsed = true;
      setPlayerStatus('Refreshing the live source…');
      var generation = state.tuneGeneration;
      clearSourceRefreshTimer();
      sourceRefreshTimer = window.setTimeout(function () {
        sourceRefreshTimer = null;
        if (generation === state.tuneGeneration && state.view === 'player') syncNow(true);
      }, 650);
      return;
    }
    showPlaybackError('This program could not be played', 'This TV may not support the file’s container, video codec, or audio codec. MP4 with H.264 video and AAC audio is the safest direct-play format.');
  }

  function retryPlayback() {
    state.sourceRetryUsed = false;
    state.failedLiveUrl = null;
    state.liveRetryAttempt = 0;
    state.activeSource = null;
    clearLiveRetryTimer();
    state.localPaused = false;
    clearPlaybackError();
    syncNow(true);
  }

  function pauseLocally() {
    if (state.view !== 'player' || !state.currentNow || !state.currentNow.program) return;
    if (state.tuning) {
      showToast('Wait for the channel to finish tuning before pausing.');
      return;
    }
    state.localPaused = true;
    activeVideo().pause();
    queuePresenceHeartbeat();
    showChrome();
  }

  function resumeLive() {
    if (state.view !== 'player') return;
    state.localPaused = false;
    state.awaitingGesture = false;
    queuePresenceHeartbeat();
    if (state.activeSource && state.activeSource.mode === 'channel-hls') {
      attemptPlay(++state.playToken);
    } else {
      syncNow(true);
    }
  }

  function renderProgramInfo() {
    var data = state.currentNow;
    var channel = currentChannel();
    if (!data || !channel) return;
    /* Keep the complete identity and now-playing card on the committed station
       until the destination video clock advances. This prevents target metadata
       appearing over the previous channel during the single-decoder handoff. */
    if (state.tuning && state.previousTune) return;
    elements.playerChannelName.textContent = channel.name;
    elements.playerChannelNumber.textContent = channelLabel(state.channelIndex);
    renderChannelLogo(data, channel);
    if (!data.program) {
      elements.playerCollection.textContent = 'Off air';
      elements.playerTitle.textContent = 'We’ll be back soon';
      elements.playerEpisode.textContent = '';
      elements.programTimes.textContent = '—';
      elements.nextTitle.textContent = data.next ? 'Next: ' + data.next.title : 'No later program scheduled';
      elements.timelineFill.style.width = '0%';
      return;
    }
    var program = data.program;
    elements.playerCollection.textContent = program.collectionTitle || 'Now playing';
    elements.playerTitle.textContent = program.title;
    elements.playerEpisode.textContent = programEpisodeText(program);
    elements.programTimes.textContent = formatTime(program.scheduledStart) + ' – ' + formatTime(program.scheduledEnd);
    elements.nextTitle.textContent = data.next ? 'Next: ' + data.next.title : 'Last show on the schedule';
    updateTimeline();
  }

  function renderChannelLogo(data, channel) {
    hideChannelLogo();
    elements.playerChannelMonogram.textContent = channelMonogram(channel && channel.name);
    var branding = data && data.branding;
    if (!branding || branding.enabled !== true || typeof branding.logoUrl !== 'string') return;
    var url = window.ToastTVPlaybackPolicy.resolveUrl(branding.logoUrl, state.serverUrl);
    if (!url) return;
    elements.playerChannelLogo.alt = channel.name + ' logo';
    elements.playerChannelLogo.src = url;
  }

  function hideChannelLogo() {
    if (!elements.playerChannelLogo) return;
    elements.playerChannelLogo.classList.add('hidden');
    elements.playerChannelLogo.removeAttribute('src');
    elements.playerChannelLogo.alt = '';
    if (elements.playerChannelMonogram) {
      var channel = displayedChannel();
      elements.playerChannelMonogram.textContent = channelMonogram(channel && channel.name);
      elements.playerChannelMonogram.classList.remove('hidden');
    }
  }

  function displayedChannel() {
    if (state.tuning && state.previousTune && state.previousTune.channelId) {
      var previousIndex = findChannelIndex(state.previousTune.channelId);
      if (previousIndex >= 0) return state.channels[previousIndex];
    }
    return currentChannel();
  }

  function updateTimeline() {
    if (!state.currentNow || !state.currentNow.program) return;
    var program = state.currentNow.program;
    var duration = Number(program.durationMs || (program.durationSeconds * 1000));
    if (!duration) return;
    var percent = Math.max(0, Math.min(100, expectedPositionSeconds() * 1000 / duration * 100));
    elements.timelineFill.style.width = percent.toFixed(2) + '%';
    if (elements.timelineFill.parentNode) elements.timelineFill.parentNode.setAttribute('aria-valuenow', String(Math.round(percent)));
  }

  function resetAllVideos() {
    window.ToastTVPlaybackPolicy.resetMediaElement(elements.videoA);
    window.ToastTVPlaybackPolicy.resetMediaElement(elements.videoB);
  }

  function showOffAir(nextProgram) {
    var generation = state.tuneGeneration;
    var channel = currentChannel();
    state.pendingJoin = false;
    state.playToken += 1;
    state.activeSource = null;
    resetAllVideos();
    state.candidateSlot = null;
    state.candidateChannelId = null;
    state.hasCommittedVideo = false;
    state.committedChannelId = channel ? channel.id : null;
    state.previousTune = null;
    state.tuning = false;
    elements.playerScreen.classList.remove('has-video');
    elements.playerScreen.classList.remove('is-tuning');
    elements.playerScreen.classList.add('is-off-air');
    elements.offAirPanel.classList.remove('hidden');
    elements.offAirNext.textContent = nextProgram ? 'Next: ' + nextProgram.title + ' at ' + formatTime(nextProgram.scheduledStart) : 'Check the guide for what’s next.';
    renderProgramInfo();
    setPlayerStatus('Off air');
    if (channel) {
      writeStorage(STORAGE_CHANNEL, channel.id);
      retargetLineupSession(channel.id, generation);
    }
    state.tuneMetrics = null;
    queuePresenceHeartbeat();
    openPendingGuideAfterCommit(generation, state.committedChannelId);
    showChrome();
    window.setTimeout(function () {
      if (state.view === 'player' && !state.overlay && !elements.offAirPanel.classList.contains('hidden')) {
        focusNode(elements.offAirGuideButton);
      }
    }, 60);
  }

  function hideOffAir() {
    elements.offAirPanel.classList.add('hidden');
    elements.playerScreen.classList.remove('is-off-air');
  }

  function showPlaybackError(title, message) {
    state.pendingGuideChannelId = null;
    if (state.previousTune) {
      var attemptedChannel = currentChannel();
      var previousStillPlaying = state.hasCommittedVideo;
      if (rollbackCandidateTune()) {
        showToast((attemptedChannel ? attemptedChannel.name : 'That channel') +
          (previousStillPlaying ? ' could not tune. Kept the previous channel playing.' : ' could not tune. Returning to the previous channel.'));
        showChrome();
      } else {
        showToast('The previous channel left the lineup. Choose another channel.');
        openChannelBrowser();
      }
      return;
    }
    state.pendingJoin = false;
    state.playToken += 1;
    elements.playbackErrorTitle.textContent = title;
    elements.playbackErrorText.textContent = message;
    elements.playbackError.classList.remove('hidden');
    elements.playerScreen.classList.add('has-error');
    elements.playerScreen.classList.remove('is-tuning');
    setPlayerStatus('Playback error');
    queuePresenceHeartbeat();
    showChrome();
    window.setTimeout(focusFirst, 60);
  }

  function clearPlaybackError() {
    elements.playbackError.classList.add('hidden');
    elements.playerScreen.classList.remove('has-error');
  }

  function openGuide() {
    var channel = currentChannel();
    if (state.view !== 'player' || !channel || !state.channels.length) return;
    openGuideForChannel(state.channelIndex, 'player');
  }

  function openGuideFromChannelBrowser() {
    if (state.view !== 'channels' || !state.channels.length) return;
    var guideChannel = state.channels[state.previewChannelIndex];
    if (!guideChannel) return;
    var returnIndex = findChannelIndex(readStorage(STORAGE_CHANNEL));
    if (returnIndex < 0 || state.channels[returnIndex].enabled === false || state.channels[returnIndex].onAir === false) {
      returnIndex = state.previewChannelIndex;
    }
    showToast('Returning to live TV before opening the guide…');
    tuneChannel(returnIndex, true, guideChannel.id);
  }

  function openGuideForChannel(index, returnView) {
    var channel = state.channels[index];
    if (state.view !== 'player' || !channel || !state.channels.length) return;
    var origin = displayedChannel();
    state.guideSerial += 1;
    state.overlay = 'guide';
    state.catalog = {
      channelId: channel.id,
      originChannelId: origin ? origin.id : channel.id,
      dayIndex: 0,
      programsByWeek: state.guideCache,
      loadingKey: null,
      requestFromMs: localCatalogDayStart(0).getTime(),
      dayStarts: null,
      focusProgramsOnLoad: true,
      focusMinute: null,
      returnView: 'player'
    };
    renderOverlayState();
    showChrome();
    renderCatalogRail();
    renderCatalogDays();
    clearChildren(elements.guideList);
    elements.guideMessage.textContent = '';
    loadCatalogDay();
    window.setTimeout(function () {
      if (!state.catalog) return;
      var active = elements.catalogRail.querySelector('[data-catalog-channel="' + state.catalog.channelId + '"]') ||
        elements.catalogRail.querySelector('[data-focusable]');
      if (!elements.guideList.querySelector('[data-focusable]')) focusNode(active || elements.closeGuideButton);
    }, 50);
  }

  function catalogChannels() {
    return state.channels.filter(function (channel) {
      return channel.enabled !== false;
    });
  }

  function localCatalogDayStart(dayIndex) {
    var start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() + dayIndex);
    return start;
  }

  function catalogDayStart(dayIndex) {
    if (state.catalog && isArray(state.catalog.dayStarts) && state.catalog.dayStarts[dayIndex]) {
      var stationStart = new Date(state.catalog.dayStarts[dayIndex]);
      if (!isNaN(stationStart.getTime())) return stationStart;
    }
    return localCatalogDayStart(dayIndex);
  }

  function catalogDayLabel(dayIndex) {
    if (dayIndex === 0) return 'Today';
    if (dayIndex === 1) return 'Tomorrow';
    var day = catalogDayStart(dayIndex);
    try {
      return day.toLocaleDateString([], { weekday: 'short', day: 'numeric' });
    } catch (ignore) {
      return 'Day ' + (dayIndex + 1);
    }
  }

  function renderCatalogRail() {
    if (!state.catalog) return;
    clearChildren(elements.catalogRail);
    var channels = catalogChannels();
    var index;
    for (index = 0; index < channels.length; index += 1) {
      var channel = channels[index];
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'catalog-channel' + (channel.id === state.catalog.channelId ? ' is-active' : '');
      chip.setAttribute('data-focusable', '');
      chip.setAttribute('data-catalog-channel', channel.id);
      var number = document.createElement('span');
      number.className = 'catalog-channel__num';
      number.textContent = 'CH ' + channelNumber(findChannelIndex(channel.id));
      var name = document.createElement('span');
      name.className = 'catalog-channel__name';
      name.textContent = channel.name;
      chip.appendChild(number);
      chip.appendChild(name);
      chip.addEventListener('click', function (event) {
        tuneCatalogChannelLive(event.currentTarget.getAttribute('data-catalog-channel'));
      }, false);
      elements.catalogRail.appendChild(chip);
    }
    elements.guideChannelName.textContent =
      (state.channels[findChannelIndex(state.catalog.channelId)] || {}).name || 'Week ahead';
  }

  function renderCatalogDays() {
    if (!state.catalog) return;
    clearChildren(elements.catalogDays);
    var index;
    for (index = 0; index < 7; index += 1) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'catalog-day' +
        (index === state.catalog.dayIndex ? ' is-active' : '') +
        (index === 0 ? ' is-today' : '');
      chip.setAttribute('data-focusable', '');
      chip.setAttribute('data-catalog-day', String(index));
      chip.textContent = catalogDayLabel(index);
      chip.addEventListener('click', function (event) {
        var selectedDay = Number(event.currentTarget.getAttribute('data-catalog-day'));
        if (state.catalog && state.catalog.dayIndex === selectedDay) {
          focusCatalogProgram(null);
          return;
        }
        if (state.catalog) {
          state.catalog.focusProgramsOnLoad = true;
          state.catalog.focusMinute = null;
        }
        setCatalogDay(selectedDay);
      }, false);
      elements.catalogDays.appendChild(chip);
    }
  }

  function updateCatalogDayLabels() {
    var chips = elements.catalogDays.querySelectorAll('[data-catalog-day]');
    var index;
    for (index = 0; index < chips.length; index += 1) {
      chips[index].textContent = catalogDayLabel(Number(chips[index].getAttribute('data-catalog-day')));
    }
  }

  function setCatalogChannel(channelId) {
    if (!state.catalog || state.catalog.channelId === channelId) return;
    state.guideSerial += 1;
    state.catalog.channelId = channelId;
    state.catalog.dayIndex = Math.min(state.catalog.dayIndex, 6);
    state.catalog.loadingKey = null;
    state.catalog.dayStarts = null;
    updateCatalogDayLabels();
    var channelChips = elements.catalogRail.querySelectorAll('[data-catalog-channel]');
    var chipIndex;
    for (chipIndex = 0; chipIndex < channelChips.length; chipIndex += 1) {
      channelChips[chipIndex].classList.toggle(
        'is-active',
        channelChips[chipIndex].getAttribute('data-catalog-channel') === channelId
      );
    }
    elements.guideChannelName.textContent =
      (state.channels[findChannelIndex(channelId)] || {}).name || 'Week ahead';
    loadCatalogDay();
  }

  function setCatalogDay(dayIndex) {
    if (!state.catalog || state.catalog.dayIndex === dayIndex) return;
    state.catalog.dayIndex = dayIndex;
    /* Keep the day buttons mounted while focus moves across the strip. Rebuilding
       it from focusin detaches the focused node on older webOS Chromium builds. */
    var dayChips = elements.catalogDays.querySelectorAll('[data-catalog-day]');
    var chipIndex;
    for (chipIndex = 0; chipIndex < dayChips.length; chipIndex += 1) {
      var chipDay = Number(dayChips[chipIndex].getAttribute('data-catalog-day'));
      dayChips[chipIndex].classList.toggle('is-active', chipDay === dayIndex);
    }
    loadCatalogDay();
  }

  function shiftCatalogDay(delta) {
    if (!state.catalog) return false;
    var next = Math.max(0, Math.min(6, state.catalog.dayIndex + delta));
    if (next === state.catalog.dayIndex) return false;
    setCatalogDay(next);
    return true;
  }

  function shiftCatalogChannel(delta) {
    if (!state.catalog) return;
    var channels = catalogChannels();
    if (!channels.length) return;
    var index;
    var current = 0;
    for (index = 0; index < channels.length; index += 1) {
      if (channels[index].id === state.catalog.channelId) current = index;
    }
    var next = ((current + (delta < 0 ? -1 : 1)) % channels.length + channels.length) % channels.length;
    var focused = closestFocusable(document.activeElement);
    var keepProgramFocus = focused && elements.guideList.contains(focused);
    if (keepProgramFocus) {
      state.catalog.focusProgramsOnLoad = true;
      state.catalog.focusMinute = guideProgramMinute(focused);
    }
    setCatalogChannel(channels[next].id);
    if (!keepProgramFocus) {
      var chip = elements.catalogRail.querySelector('[data-catalog-channel="' + escapeAttribute(channels[next].id) + '"]');
      if (chip) focusNode(chip);
    }
  }

  function guideProgramMinute(row) {
    if (!row) return null;
    var date = new Date(row.getAttribute('data-guide-start'));
    if (isNaN(date.getTime())) return null;
    return date.getHours() * 60 + date.getMinutes();
  }

  function loadCatalogDay() {
    var catalog = state.catalog;
    if (!catalog) return;
    var dayIndex = catalog.dayIndex;
    var fromMs = catalog.requestFromMs;
    var cacheKey = catalog.channelId + ':' + fromMs;
    var cached = catalog.programsByWeek[cacheKey];
    if (cached && Date.now() - cached.fetchedAt < GUIDE_CACHE_TTL_MS) {
      catalog.dayStarts = cached.dayStarts;
      updateCatalogDayLabels();
      renderCatalogWeekDay(cached);
      return;
    }
    if (cached) delete catalog.programsByWeek[cacheKey];
    if (state.guideRequests[cacheKey]) {
      clearChildren(elements.guideList);
      elements.guideMessage.textContent = 'Loading the seven-day schedule…';
      return;
    }
    clearChildren(elements.guideList);
    elements.guideMessage.textContent = 'Loading the seven-day schedule…';
    var channelId = catalog.channelId;
    var serverAtStart = state.serverUrl;
    var requestToken = {};
    state.guideRequests[cacheKey] = requestToken;
    requestJson(
      state.serverUrl + '/api/v1/channels/' + encodeURIComponent(channelId) +
        '/guide?hours=168&calendar=1&from=' + fromMs,
      15000,
      function (error, data) {
        if (state.guideRequests[cacheKey] === requestToken) delete state.guideRequests[cacheKey];
        if (state.serverUrl !== serverAtStart) return;
        var isSelected = state.overlay === 'guide' && state.catalog && state.catalog.channelId === channelId;
        if (error || !data || data.channelId !== channelId || !isArray(data.programs)) {
          if (isSelected) elements.guideMessage.textContent = 'The guide is unavailable right now.';
          return;
        }
        var entry = {
          programs: data.programs,
          truncated: data.truncated === true,
          coverageEnd: data.coverageEnd,
          timelineRevision: data.timelineRevision,
          dayStarts: isArray(data.dayStarts) ? data.dayStarts : null,
          fetchedAt: Date.now()
        };
        state.guideCache[cacheKey] = entry;
        if (isSelected) {
          state.catalog.dayStarts = entry.dayStarts;
          updateCatalogDayLabels();
          renderCatalogWeekDay(entry);
        }
      }
    );
  }

  function renderCatalogWeekDay(entry) {
    if (!state.catalog) return;
    var startMs = catalogDayStart(state.catalog.dayIndex).getTime();
    var endMs = catalogDayStart(state.catalog.dayIndex + 1).getTime();
    var matches = entry.programs.filter(function (program) {
      return Date.parse(program.scheduledEnd) > startMs && Date.parse(program.scheduledStart) < endMs;
    });
    var wasTrimmed = matches.length > GUIDE_RENDER_LIMIT;
    var coverageMs = Date.parse(entry.coverageEnd || '');
    var coverageEndedBeforeDay = entry.truncated && isFinite(coverageMs) && coverageMs <= startMs;
    var coverageEndsThisDay = entry.truncated && isFinite(coverageMs) && coverageMs > startMs && coverageMs < endMs;
    renderCatalogPrograms(
      matches.slice(0, GUIDE_RENDER_LIMIT),
      coverageEndedBeforeDay || coverageEndsThisDay || wasTrimmed,
      wasTrimmed ? matches[GUIDE_RENDER_LIMIT - 1].scheduledEnd : entry.coverageEnd,
      state.catalog.channelId
    );
  }

  function renderCatalogPrograms(programs, truncated, coverageEnd, channelId) {
    var catalog = state.catalog;
    if (!catalog) return;
    clearChildren(elements.guideList);
    var serverNow = Date.now() + state.clockOffsetMs;
    if (!programs.length) {
      elements.guideMessage.textContent = truncated && coverageEnd
        ? 'Guide coverage ended at ' + formatTime(coverageEnd) + ' because this is a very dense schedule.'
        : 'Nothing is scheduled on this day yet.';
      return;
    }
    elements.guideMessage.textContent = truncated && coverageEnd
      ? 'This dense day was shortened at ' + formatTime(coverageEnd) + '.'
      : '';
    var index;
    for (index = 0; index < programs.length; index += 1) {
      var program = programs[index];
      var item = document.createElement('button');
      item.type = 'button';
      var startsAt = Date.parse(program.scheduledStart);
      var endsAt = Date.parse(program.scheduledEnd);
      var isNow = isFinite(startsAt) && isFinite(endsAt) && startsAt <= serverNow && endsAt > serverNow;
      item.className = 'guide-item' + (isNow ? ' is-now' : '');
      item.setAttribute('data-focusable', '');
      item.setAttribute('data-guide-channel', channelId);
      item.setAttribute('data-guide-start', program.scheduledStart);
      var time = document.createElement('span');
      time.className = 'guide-item__time';
      time.textContent = formatTime(program.scheduledStart);
      var details = document.createElement('span');
      var title = document.createElement('h3');
      title.textContent = program.title;
      var collection = document.createElement('p');
      collection.textContent = isNow
        ? 'On now · ' + (programEpisodeText(program) || program.collectionTitle || 'Live')
        : (programEpisodeText(program) || program.collectionTitle || 'Scheduled') + ' · Watch channel live';
      details.appendChild(title);
      details.appendChild(collection);
      item.appendChild(time);
      item.appendChild(details);
      item.addEventListener('click', function (event) {
        var selectedStart = Date.parse(event.currentTarget.getAttribute('data-guide-start'));
        selectGuideChannelLive(event.currentTarget.getAttribute('data-guide-channel'), selectedStart);
      }, false);
      elements.guideList.appendChild(item);
    }
    if (catalog.focusProgramsOnLoad) {
      var minute = catalog.focusMinute;
      catalog.focusProgramsOnLoad = false;
      catalog.focusMinute = null;
      window.setTimeout(function () { focusCatalogProgram(minute); }, 20);
    }
  }

  function focusCatalogProgram(minuteOfDay) {
    var rows = elements.guideList.querySelectorAll('[data-guide-start]');
    if (!rows.length) return;
    var best = elements.guideList.querySelector('.is-now') || rows[0];
    if (minuteOfDay !== null && minuteOfDay !== undefined) {
      var bestDistance = Infinity;
      var index;
      for (index = 0; index < rows.length; index += 1) {
        var date = new Date(rows[index].getAttribute('data-guide-start'));
        var rowMinute = date.getHours() * 60 + date.getMinutes();
        var distance = Math.abs(rowMinute - minuteOfDay);
        if (distance < bestDistance) {
          best = rows[index];
          bestDistance = distance;
        }
      }
    }
    focusNode(best);
  }

  function tuneCatalogChannelLive(channelId) {
    selectGuideChannelLive(channelId, null);
  }

  function selectGuideChannelLive(channelId, selectedStart) {
    if (!state.catalog || state.view !== 'player') return;
    var targetIndex = findChannelIndex(channelId);
    var active = displayedChannel();
    var sameChannel = active && active.id === channelId && state.committedChannelId === channelId && !state.tuning;
    closeOverlays();
    if (sameChannel) {
      showChrome();
    } else if (targetIndex >= 0) {
      tuneChannel(targetIndex, false);
    }
    if (isFinite(selectedStart) && selectedStart > Date.now() + state.clockOffsetMs) {
      showToast('Tuned live. This future show will begin at its scheduled time.');
    }
  }

  function renderOverlayState() {
    elements.guideOverlay.classList.toggle('is-open', state.overlay === 'guide');
    elements.guideOverlay.setAttribute('aria-hidden', state.overlay === 'guide' ? 'false' : 'true');
    elements.playerScreen.classList.toggle('guide-open', state.overlay === 'guide' && state.view === 'player');
  }

  function closeOverlays() {
    if (guidePreviewTimer) window.clearTimeout(guidePreviewTimer);
    guidePreviewTimer = null;
    state.overlay = null;
    state.catalog = null;
    renderOverlayState();
  }

  function openSetup() {
    state.setupFromChannels = state.view === 'channels';
    elements.serverInput.value = state.serverUrl || readStorage(STORAGE_SERVER) || DEFAULT_SERVER;
    elements.cancelSetupButton.classList.toggle('hidden', !state.setupFromChannels);
    setSetupMessage('');
    safePushHistory({ view: 'setup' });
    activateView('setup');
  }

  function activateView(view) {
    var priorView = state.view;
    if (priorView === 'setup' && view !== 'setup') cancelConnectionAttempt();
    state.view = view;
    elements.bootScreen.classList.toggle('is-active', view === 'boot');
    elements.setupScreen.classList.toggle('is-active', view === 'setup');
    elements.channelsScreen.classList.toggle('is-active', view === 'channels');
    elements.playerScreen.classList.toggle('is-active', view === 'player');
    elements.bootScreen.setAttribute('aria-hidden', view === 'boot' ? 'false' : 'true');
    elements.setupScreen.setAttribute('aria-hidden', view === 'setup' ? 'false' : 'true');
    elements.channelsScreen.setAttribute('aria-hidden', view === 'channels' ? 'false' : 'true');
    elements.playerScreen.setAttribute('aria-hidden', view === 'player' ? 'false' : 'true');

    if (priorView === 'player' && view !== 'player') stopPlayback();
    if (view !== 'player') stopPlayerTimers();
    if (view === 'player') startPlayerTimers();
    if (view !== 'player') closeOverlays();
    if (view === 'channels' && state.channels.length) selectChannelPreview(state.channelIndex);
    queuePresenceHeartbeat();
    window.setTimeout(focusFirst, 50);
  }

  function handlePopState(event) {
    var historyState = event.state || {};
    if (historyState.view === 'player') {
      activateView('player');
      state.overlay = historyState.overlay || null;
      if (state.overlay === 'guide' && !state.catalog && currentChannel()) {
        state.catalog = {
          channelId: currentChannel().id,
          originChannelId: currentChannel().id,
          dayIndex: 0,
          programsByWeek: state.guideCache,
          loadingKey: null,
          requestFromMs: localCatalogDayStart(0).getTime(),
          dayStarts: null,
          focusProgramsOnLoad: true,
          focusMinute: null,
          returnView: 'player'
        };
        renderCatalogRail();
        renderCatalogDays();
        loadCatalogDay();
      }
      renderOverlayState();
      if (!state.currentNow && currentChannel()) syncNow(true);
      return;
    }
    closeOverlays();
    if (historyState.view === 'setup') {
      activateView('setup');
      return;
    }
    activateView('channels');
  }

  function goBack() {
    if (state.overlay === 'guide') {
      closeOverlays();
      if (state.view === 'player') showChrome();
      else window.setTimeout(focusFirst, 40);
      return;
    }
    if (cancelPendingChannelChange()) return;
    if (state.view === 'player' || (state.view === 'setup' && state.setupFromChannels)) {
      openChannelBrowser();
      return;
    }
    if (state.view === 'setup') cancelConnectionAttempt();
    try { window.history.back(); } catch (ignore) {}
  }

  function cancelPendingChannelChange() {
    if ((state.view !== 'player' && state.view !== 'channels') ||
        (!state.requestedChannelId && !state.candidateChannelId && !state.previousTune && !state.pendingGuideChannelId)) return false;
    var stayInBrowser = state.view === 'channels';
    var returnToBrowser = state.view === 'player' &&
      state.playerEnteredFromChannels && !!state.pendingGuideChannelId;
    state.tuneGeneration += 1;
    if (zapTimer) window.clearTimeout(zapTimer);
    zapTimer = null;
    state.requestedChannelId = null;
    state.requestedChannelIndex = null;
    state.pendingGuideChannelId = null;
    state.tuneMetrics = null;
    rollbackCandidateTune();
    if (stayInBrowser) {
      showToast('Guide opening cancelled.');
      return true;
    }
    if (returnToBrowser) return false;
    updateChannelOsdProgram('Switch cancelled');
    scheduleChannelOsdHide();
    showChrome();
    return true;
  }

  function openChannelBrowser() {
    var returnThroughHistory = (state.view === 'player' && state.playerEnteredFromChannels) ||
      (state.view === 'setup' && state.setupFromChannels);
    if (state.view === 'setup') cancelConnectionAttempt();
    state.setupFromChannels = false;
    if (state.view === 'boot') cancelStartupWork();
    else state.tuneGeneration += 1;
    state.requestedChannelId = null;
    state.requestedChannelIndex = null;
    state.pendingGuideChannelId = null;
    rollbackCandidateTune();
    closeOverlays();
    if (returnThroughHistory) {
      state.playerEnteredFromChannels = false;
      try { window.history.back(); } catch (ignoreHistory) {}
      return;
    }
    state.playerEnteredFromChannels = false;
    safeReplaceHistory({ view: 'channels' });
    activateView('channels');
    renderChannels();
    hydrateChannelCards();
  }

  function cancelConnectionAttempt() {
    state.connectSerial += 1;
    elements.connectButton.disabled = false;
  }

  function handleKeyDown(event) {
    var code = event.keyCode || event.which;
    var target = event.target;
    var isTextInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
    if (state.view === 'player' && code !== 13) showChrome();

    if (code === 461 || code === 27) {
      event.preventDefault();
      goBack();
      return;
    }
    if (code === 415) {
      event.preventDefault();
      resumeLive();
      return;
    }
    if (code === 19) {
      event.preventDefault();
      pauseLocally();
      return;
    }
    if (code === 413 && state.view === 'player') {
      event.preventDefault();
      goBack();
      return;
    }
    if ((code === 33 || code === 427) && state.view === 'player' && !state.overlay) {
      event.preventDefault();
      switchChannel(1);
      return;
    }
    if ((code === 34 || code === 428) && state.view === 'player' && !state.overlay) {
      event.preventDefault();
      switchChannel(-1);
      return;
    }

    if (state.overlay === 'guide' && state.catalog && (code === 33 || code === 34 || code === 427 || code === 428)) {
      event.preventDefault();
      shiftCatalogChannel(code === 33 || code === 427 ? 1 : -1);
      return;
    }

    if (state.overlay === 'guide' && state.catalog && (code === 37 || code === 39)) {
      /* Inside the catalog, LEFT/RIGHT page through days. The channel rail
         keeps arrow-to-arrow chip movement instead, so previews follow focus. */
      var focusInRail = closestFocusable(document.activeElement);
      if (!(focusInRail && elements.catalogRail.contains(focusInRail))) {
        event.preventDefault();
        if (code === 37 && state.catalog.dayIndex === 0) {
          var selectedChannel = elements.catalogRail.querySelector('[data-catalog-channel="' + escapeAttribute(state.catalog.channelId) + '"]');
          if (selectedChannel) focusNode(selectedChannel);
          return;
        }
        var focusInPrograms = focusInRail && elements.guideList.contains(focusInRail);
        var focusInDays = focusInRail && elements.catalogDays.contains(focusInRail);
        if (focusInPrograms) {
          state.catalog.focusProgramsOnLoad = true;
          state.catalog.focusMinute = guideProgramMinute(focusInRail);
        }
        if (shiftCatalogDay(code === 39 ? 1 : -1) && focusInDays) {
          var dayChip = elements.catalogDays.querySelector('[data-catalog-day="' + state.catalog.dayIndex + '"]');
          if (dayChip) focusNode(dayChip);
        }
        return;
      }
    }

    if (state.view === 'player' && !state.overlay &&
        elements.playbackError.classList.contains('hidden') &&
        elements.offAirPanel.classList.contains('hidden')) {
      if (code === 37) { event.preventDefault(); switchChannel(-1); return; }
      if (code === 39) { event.preventDefault(); switchChannel(1); return; }
      if (code === 38) { event.preventDefault(); openGuide(); return; }
      if (code === 40) { event.preventDefault(); openChannelBrowser(); return; }
      if (code === 13) {
        event.preventDefault();
        if (state.awaitingGesture) {
          state.awaitingGesture = false;
          showChrome();
          attemptPlay(state.playToken);
        } else {
          toggleChrome();
        }
        return;
      }
    }

    if (code === 13) {
      var active = closestFocusable(document.activeElement);
      if (active && active !== elements.serverInput && active.offsetParent !== null) {
        event.preventDefault();
        active.click();
      }
      return;
    }
    if (code >= 37 && code <= 40) {
      if (isTextInput && (code === 37 || code === 39)) return;
      event.preventDefault();
      moveFocus(code);
    }
  }

  function moveFocus(code) {
    var nodes = visibleFocusables();
    if (!nodes.length) return;
    var current = closestFocusable(document.activeElement);
    if (!current || nodes.indexOf(current) === -1) {
      focusNode(nodes[0]);
      return;
    }
    var rect = current.getBoundingClientRect();
    var fromX = rect.left + rect.width / 2;
    var fromY = rect.top + rect.height / 2;
    var best = null;
    var bestScore = Infinity;
    var index;
    for (index = 0; index < nodes.length; index += 1) {
      if (nodes[index] === current) continue;
      var candidateRect = nodes[index].getBoundingClientRect();
      var toX = candidateRect.left + candidateRect.width / 2;
      var toY = candidateRect.top + candidateRect.height / 2;
      var dx = toX - fromX;
      var dy = toY - fromY;
      var primary;
      var secondary;
      if (code === 37 && dx < -2) { primary = -dx; secondary = Math.abs(dy); }
      else if (code === 39 && dx > 2) { primary = dx; secondary = Math.abs(dy); }
      else if (code === 38 && dy < -2) { primary = -dy; secondary = Math.abs(dx); }
      else if (code === 40 && dy > 2) { primary = dy; secondary = Math.abs(dx); }
      else continue;
      var score = primary * 10 + secondary * 2 + (secondary > primary * 2 ? 5000 : 0);
      if (score < bestScore) { best = nodes[index]; bestScore = score; }
    }
    if (best) focusNode(best);
  }

  function visibleFocusables() {
    var scope = document;
    if (state.overlay === 'guide') scope = elements.guideOverlay;
    else if (state.view === 'setup') scope = elements.setupScreen;
    else if (state.view === 'channels') scope = elements.channelsScreen;
    else if (state.view === 'player') scope = elements.playerScreen;
    var all = scope.querySelectorAll('[data-focusable]');
    var output = [];
    var index;
    for (index = 0; index < all.length; index += 1) {
      if (!all[index].disabled && all[index].offsetParent !== null) output.push(all[index]);
    }
    return output;
  }

  function focusFirst() {
    var preferred = null;
    if (state.overlay === 'guide') preferred = elements.guideList.querySelector('.is-now') || elements.closeGuideButton;
    else if (state.view === 'channels') preferred = elements.channelGrid.querySelector('[data-channel-index="' + state.channelIndex + '"]') || elements.channelGrid.querySelector('.channel-card') || elements.retryChannelsButton;
    else if (state.view === 'setup') preferred = elements.serverInput;
    else if (state.view === 'player' && !elements.playbackError.classList.contains('hidden')) preferred = elements.retryPlaybackButton;
    if (preferred && preferred.offsetParent !== null) {
      focusNode(preferred);
      return;
    }
    var nodes = visibleFocusables();
    if (nodes.length) focusNode(nodes[0]);
  }

  function focusNode(node) {
    if (!node || typeof node.focus !== 'function') return;
    var focused = document.querySelectorAll('.is-focused');
    var index;
    for (index = 0; index < focused.length; index += 1) focused[index].classList.remove('is-focused');
    node.classList.add('is-focused');
    try { node.focus(); } catch (ignore) {}
    if (elements.channelGrid.contains(node)) {
      var channelTop = node.offsetTop;
      var channelBottom = channelTop + node.offsetHeight;
      if (channelTop < elements.channelGrid.scrollTop) elements.channelGrid.scrollTop = channelTop;
      else if (channelBottom > elements.channelGrid.scrollTop + elements.channelGrid.clientHeight) {
        elements.channelGrid.scrollTop = channelBottom - elements.channelGrid.clientHeight;
      }
    }
    if (elements.guideList.contains(node)) {
      var top = node.offsetTop;
      var bottom = top + node.offsetHeight;
      if (top < elements.guideList.scrollTop) elements.guideList.scrollTop = top;
      else if (bottom > elements.guideList.scrollTop + elements.guideList.clientHeight) {
        elements.guideList.scrollTop = bottom - elements.guideList.clientHeight;
      }
    }
    if (elements.catalogRail.contains(node)) {
      var railTop = node.offsetTop;
      var railBottom = railTop + node.offsetHeight;
      if (railTop < elements.catalogRail.scrollTop) elements.catalogRail.scrollTop = railTop;
      else if (railBottom > elements.catalogRail.scrollTop + elements.catalogRail.clientHeight) {
        elements.catalogRail.scrollTop = railBottom - elements.catalogRail.clientHeight;
      }
    }
    if (elements.catalogDays.contains(node)) {
      var dayLeft = node.offsetLeft;
      var dayRight = dayLeft + node.offsetWidth;
      if (dayLeft < elements.catalogDays.scrollLeft) elements.catalogDays.scrollLeft = dayLeft;
      else if (dayRight > elements.catalogDays.scrollLeft + elements.catalogDays.clientWidth) {
        elements.catalogDays.scrollLeft = dayRight - elements.catalogDays.clientWidth;
      }
    }
  }

  function closestFocusable(node) {
    while (node && node !== document) {
      if (node.getAttribute && node.hasAttribute('data-focusable')) return node;
      node = node.parentNode;
    }
    return null;
  }

  function startPlayerTimers() {
    if (!pollTimer) pollTimer = window.setInterval(function () { syncNow(false); }, POLL_INTERVAL_MS);
  }

  function stopPlayerTimers() {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = null;
    clearBoundaryTimer();
    clearReconnectTimer();
    clearLiveRetryTimer();
    clearSourceRefreshTimer();
    clearBufferingTimers();
  }

  function scheduleLiveRetry(failedUrl, channelId) {
    clearLiveRetryTimer();
    if (state.liveRetryAttempt >= LIVE_STREAM_RETRY_DELAYS.length) {
      if (rollbackCandidateTune()) {
        showToast('That channel lost its signal. Returning to the previous channel.');
        return;
      }
      state.tuning = false;
      showPlaybackError(
        'This channel could not be prepared',
        'ToastTV could not start the normalized live stream. Check the server dashboard for the FFmpeg or source-file error, then retry.'
      );
      return;
    }
    var delay = LIVE_STREAM_RETRY_DELAYS[state.liveRetryAttempt];
    state.liveRetryAttempt += 1;
    liveRetryTimer = window.setTimeout(function () {
      liveRetryTimer = null;
      var channel = currentChannel();
      if (
        state.view !== 'player' ||
        !channel ||
        channel.id !== channelId ||
        state.failedLiveUrl !== failedUrl
      ) return;
      state.failedLiveUrl = null;
      state.sourceRetryUsed = false;
      beginTuning('Retrying the live channel…');
      syncNow(true);
    }, delay);
  }

  function clearLiveRetryTimer() {
    if (liveRetryTimer) window.clearTimeout(liveRetryTimer);
    liveRetryTimer = null;
  }

  function scheduleBufferingRecovery(video) {
    if (state.localPaused || state.tuning || state.view !== 'player') return;
    if (!bufferingStatusTimer) {
      bufferingStatusTimer = window.setTimeout(function () {
        bufferingStatusTimer = null;
        if (video === activeVideo() && state.view === 'player' && !state.tuning && !state.localPaused) {
          setPlayerStatus('Buffering — keeping the live channel open…');
        }
      }, BUFFERING_NOTICE_MS);
    }
    if (!stallRecoveryTimer) {
      var sampledTime = Number(video.currentTime) || 0;
      var recoverySerial = ++bufferingRecoverySerial;
      stallRecoveryTimer = window.setTimeout(function () {
        stallRecoveryTimer = null;
        if (recoverySerial !== bufferingRecoverySerial) return;
        if (video !== activeVideo() || state.view !== 'player' || state.tuning || state.localPaused) return;
        if (!state.activeSource || state.activeSource.mode !== 'channel-hls') return;
        if ((Number(video.currentTime) || 0) > sampledTime + 0.25) {
          clearBufferingTimers();
          setPlayerStatus('Playing live');
          return;
        }
        var prepareTime = Number(video.currentTime) || 0;
        setPlayerStatus('Rejoining the live broadcast…');
        var recoveryStillNeeded = function () {
          var needed = recoverySerial === bufferingRecoverySerial &&
            video === activeVideo() && state.view === 'player' &&
            !state.tuning && !state.localPaused &&
            (Number(video.currentTime) || 0) <= prepareTime + 0.25;
          if (!needed && video === activeVideo() && state.view === 'player' && !state.localPaused) {
            setPlayerStatus('Playing live');
          }
          return needed;
        };
        prepareCurrentChannel(function () {
          if (!recoveryStillNeeded()) return;
          state.bufferingPrepareFailures += 1;
          if (state.bufferingPrepareFailures >= 2) {
            retryLiveStream('Rebuilding the live signal…');
            return;
          }
          setPlayerStatus('Buffering — retrying the live signal…');
          scheduleBufferingRecovery(video);
        }, recoveryStillNeeded);
      }, BUFFERING_RECOVERY_MS);
    }
  }

  function clearBufferingTimers() {
    if (bufferingStatusTimer) window.clearTimeout(bufferingStatusTimer);
    if (stallRecoveryTimer) window.clearTimeout(stallRecoveryTimer);
    bufferingStatusTimer = null;
    stallRecoveryTimer = null;
    bufferingRecoverySerial += 1;
  }

  function scheduleBoundary() {
    clearBoundaryTimer();
    if (!state.currentNow || !state.currentNow.program) {
      if (state.currentNow && state.currentNow.next) {
        var untilNext = Date.parse(state.currentNow.next.scheduledStart) - (Date.now() + state.clockOffsetMs) + 300;
        boundaryTimer = window.setTimeout(function () { syncNow(false); }, clampTimer(untilNext));
      }
      return;
    }
    var remaining = Date.parse(state.currentNow.program.scheduledEnd) - (Date.now() + state.clockOffsetMs) + 300;
    boundaryTimer = window.setTimeout(function () { syncNow(false); }, clampTimer(remaining));
  }

  function clampTimer(value) { return Math.max(250, Math.min(2147480000, value)); }

  function clearBoundaryTimer() {
    if (boundaryTimer) window.clearTimeout(boundaryTimer);
    boundaryTimer = null;
  }

  function clearSourceRefreshTimer() {
    if (sourceRefreshTimer) window.clearTimeout(sourceRefreshTimer);
    sourceRefreshTimer = null;
  }

  function detachVideoForTune() {
    state.pendingJoin = false;
    state.playToken += 1;
    state.candidateSlot = state.videoSlot === 'A' ? 'B' : 'A';
    /* LG does not officially support two simultaneous video decoders. Release
       the outgoing decoder before attaching the hidden candidate; the tuning
       backdrop covers this short handoff and avoids the audio-loop failures
       caused by overlapping playback pipelines on physical TVs. */
    standbyVideo().muted = true;
    window.ToastTVPlaybackPolicy.resetMediaElement(standbyVideo());
    activeVideo().muted = true;
    window.ToastTVPlaybackPolicy.resetMediaElement(activeVideo());
    state.hasCommittedVideo = false;
    elements.playerScreen.classList.remove('has-video');
    elements.playerBackdrop.classList.remove('hidden');
    applyVideoVisibility();
  }

  function abandonCandidateTune() {
    clearTuningTimer();
    clearLiveRetryTimer();
    clearBufferingTimers();
    state.requestSerial += 1;
    state.pendingJoin = false;
    state.failedLiveUrl = null;
    state.activeSource = null;
    state.programId = null;
    state.currentNow = null;
    if (state.candidateSlot) {
      window.ToastTVPlaybackPolicy.resetMediaElement(videoForSlot(state.candidateSlot));
    }
    state.candidateSlot = null;
    state.candidateChannelId = null;
  }

  function rollbackCandidateTune() {
    if (!state.candidateSlot && !state.previousTune) return state.hasCommittedVideo;
    clearTuningTimer();
    clearLiveRetryTimer();
    if (state.candidateSlot) window.ToastTVPlaybackPolicy.resetMediaElement(videoForSlot(state.candidateSlot));
    state.candidateSlot = null;
    state.candidateChannelId = null;
    state.tuning = false;
    state.pendingJoin = false;
    state.activeSource = null;
    elements.playerScreen.classList.remove('is-tuning');
    if (state.hasCommittedVideo) elements.playerScreen.classList.add('has-video');
    if (!state.previousTune) return state.hasCommittedVideo;
    var previousIndex = findChannelIndex(state.previousTune.channelId);
    if (previousIndex < 0) {
      /* The committed picture belongs to a channel that left the refreshed
         lineup. Never pair that stale picture with another channel's metadata. */
      state.previousTune = null;
      state.committedChannelId = null;
      state.currentNow = null;
      state.programId = null;
      state.activeSource = null;
      state.hasCommittedVideo = false;
      resetAllVideos();
      elements.playerScreen.classList.remove('has-video');
      hideChannelLogo();
      queuePresenceHeartbeat();
      scheduleChannelOsdHide();
      return false;
    }
    state.channelIndex = previousIndex;
    state.committedChannelId = state.previousTune.channelId;
    state.currentNow = state.previousTune.currentNow;
    state.programId = state.previousTune.programId;
    state.activeSource = state.previousTune.activeSource;
    state.previousTune = null;
    var channel = currentChannel();
    if (channel) {
      elements.playerChannelName.textContent = channel.name;
      elements.playerChannelNumber.textContent = channelLabel(state.channelIndex);
    }
    renderProgramInfo();
    queuePresenceHeartbeat();
    if (!state.hasCommittedVideo) {
      if (state.currentNow && !state.currentNow.program) {
        showOffAir(state.currentNow.next);
        scheduleChannelOsdHide();
        return true;
      }
      state.programId = null;
      state.activeSource = null;
      beginTuning('Returning to the previous channel…');
      prepareCurrentChannel(function () {
        state.tuning = false;
        showPlaybackError('The previous channel is no longer available', 'Choose another channel from the live lineup.');
      });
    }
    scheduleChannelOsdHide();
    return true;
  }

  function retryLiveStream(message) {
    var channel = currentChannel();
    var failedUrl = state.activeSource && state.activeSource.mode === 'channel-hls'
      ? state.activeSource.url
      : null;
    if (!channel || !failedUrl) return;
    state.failedLiveUrl = failedUrl;
    state.activeSource = null;
    state.pendingJoin = false;
    state.playToken += 1;
    window.ToastTVPlaybackPolicy.resetMediaElement(tuneVideo());
    beginTuning(message);
    scheduleLiveRetry(failedUrl, channel.id);
  }

  function scheduleReconnect() {
    if (reconnectTimer || state.view !== 'player') return;
    var index = Math.min(state.reconnectAttempt, RECONNECT_DELAYS.length - 1);
    var delay = RECONNECT_DELAYS[index];
    state.reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(function () {
      reconnectTimer = null;
      syncNow(false);
    }, delay);
  }

  function clearReconnectTimer() {
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function stopPlayback() {
    state.requestSerial += 1;
    state.pendingJoin = false;
    state.playToken += 1;
    state.currentNow = null;
    state.programId = null;
    state.activeSource = null;
    state.failedLiveUrl = null;
    state.localPaused = false;
    state.awaitingGesture = false;
    state.tuning = false;
    state.hlsSeekPending = false;
    state.liveRetryAttempt = 0;
    state.candidateSlot = null;
    state.candidateChannelId = null;
    state.hasCommittedVideo = false;
    state.committedChannelId = null;
    state.previousTune = null;
    state.pendingGuideChannelId = null;
    clearBufferingTimers();
    clearTuningTimer();
    clearSourceRefreshTimer();
    resetAllVideos();
    elements.playerScreen.classList.remove('has-video');
    elements.playerScreen.classList.remove('is-tuning');
    hideChannelLogo();
    hideOffAir();
    clearPlaybackError();
    queuePresenceHeartbeat();
  }

  function recordClockSample(serverTimeMs, timing) {
    if (typeof serverTimeMs !== 'number' || !timing) return;
    var rtt = Math.max(0, timing.endedAt - timing.startedAt);
    var offset = serverTimeMs - (timing.startedAt + timing.endedAt) / 2;
    state.clockSamples.push({ offset: offset, rtt: rtt, recordedAt: Date.now() });
    var cutoff = Date.now() - 120000;
    var recent = [];
    var index;
    for (index = 0; index < state.clockSamples.length; index += 1) {
      if (state.clockSamples[index].recordedAt >= cutoff) recent.push(state.clockSamples[index]);
    }
    if (recent.length > 8) recent = recent.slice(recent.length - 8);
    state.clockSamples = recent;
    var best = recent[0];
    for (index = 1; index < recent.length; index += 1) {
      if (recent[index].rtt < best.rtt) best = recent[index];
    }
    if (best) state.clockOffsetMs = best.offset;
  }

  function tickClock() {
    var current = new Date(Date.now() + state.clockOffsetMs);
    var label = formatClock(current);
    if (elements.homeClock) elements.homeClock.textContent = label;
    if (elements.playerClock) elements.playerClock.textContent = label;
    if (elements.guideClock) elements.guideClock.textContent = label;
    updateTimeline();
    updateChannelPreviewTimeline();
  }

  function formatClock(date) {
    try { return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
    catch (ignore) { return pad2(date.getHours()) + ':' + pad2(date.getMinutes()); }
  }

  function formatTime(value) {
    var date = new Date(value);
    return isNaN(date.getTime()) ? '—' : formatClock(date);
  }

  function programEpisodeText(program) {
    if (!program) return '';
    var parts = [];
    if (program.episodeLabel) parts.push(program.episodeLabel);
    if (program.collectionTitle && program.collectionTitle !== program.title) parts.push(program.collectionTitle);
    return parts.join(' · ');
  }

  function pad2(value) { return value < 10 ? '0' + value : String(value); }

  function setPlayerStatus(value) { elements.playerStatus.textContent = value; }
  function setSetupMessage(value) { elements.setupMessage.textContent = value; }

  function showChrome() {
    if (!elements.playerScreen) return;
    elements.playerScreen.classList.remove('chrome-hidden');
    scheduleChromeHide();
  }

  function hideChrome() {
    if (!elements.playerScreen) return;
    if (chromeTimer) window.clearTimeout(chromeTimer);
    chromeTimer = null;
    elements.playerScreen.classList.add('chrome-hidden');
  }

  function toggleChrome() {
    if (!elements.playerScreen) return;
    if (elements.playerScreen.classList.contains('chrome-hidden')) showChrome();
    else hideChrome();
  }

  function scheduleChromeHide() {
    if (chromeTimer) window.clearTimeout(chromeTimer);
    chromeTimer = window.setTimeout(function () {
      if (state.view === 'player' && !state.overlay && !state.localPaused && !state.tuning && elements.playbackError.classList.contains('hidden') && elements.offAirPanel.classList.contains('hidden')) {
        elements.playerScreen.classList.add('chrome-hidden');
      }
    }, 7000);
  }

  function showToast(message) {
    if (toastTimer) window.clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add('is-visible');
    toastTimer = window.setTimeout(function () { elements.toast.classList.remove('is-visible'); }, 2600);
  }

  function showChannelOsd(index, program, holdUntilCommit) {
    if (!elements.channelOsd || !state.channels.length) return;
    var normalized = normalizeChannelIndex(index);
    var channel = state.channels[normalized];
    if (!channel) return;
    if (channelOsdTimer) window.clearTimeout(channelOsdTimer);
    elements.channelOsdNumber.textContent = channelNumber(normalized);
    elements.channelOsdName.textContent = channel.name;
    elements.channelOsdProgram.textContent = program || 'Tuning…';
    elements.channelOsd.classList.add('is-visible');
    elements.channelOsd.setAttribute('aria-hidden', 'false');
    if (!holdUntilCommit) scheduleChannelOsdHide();
  }

  function scheduleChannelOsdHide() {
    if (!elements.channelOsd || !elements.channelOsd.classList.contains('is-visible')) return;
    if (channelOsdTimer) window.clearTimeout(channelOsdTimer);
    channelOsdTimer = window.setTimeout(function () {
      channelOsdTimer = null;
      elements.channelOsd.classList.remove('is-visible');
      elements.channelOsd.setAttribute('aria-hidden', 'true');
    }, CHANNEL_OSD_MS);
  }

  function updateChannelOsdProgram(program) {
    if (elements.channelOsd && elements.channelOsd.classList.contains('is-visible')) {
      elements.channelOsdProgram.textContent = program || 'Live';
    }
  }

  function logTuneMetrics(metrics) {
    var prepareMs = metrics.preparedAt ? metrics.preparedAt - metrics.requestedAt : 0;
    var attachMs = metrics.attachedAt ? metrics.attachedAt - metrics.requestedAt : 0;
    var frameAfterAttachMs = metrics.firstFrameAt && metrics.attachedAt
      ? metrics.firstFrameAt - metrics.attachedAt : 0;
    var firstFrameMs = metrics.firstFrameAt - metrics.requestedAt;
    try {
      console.log('[ToastTV Tune] channel=' + metrics.channelId + ' src=' + (metrics.src || '?') +
        ' prepareMs=' + prepareMs + ' attachMs=' + attachMs +
        ' frameAfterAttachMs=' + frameAfterAttachMs + ' firstFrameMs=' + firstFrameMs);
    } catch (ignore) {}
  }

  function normalizeChannelIndex(index) {
    return ((index % state.channels.length) + state.channels.length) % state.channels.length;
  }

  function channelNumber(index) { return String(101 + index); }
  function channelLabel(index) { return 'CH ' + channelNumber(index); }

  function findChannelIndex(channelId) {
    var index;
    for (index = 0; index < state.channels.length; index += 1) {
      if (state.channels[index].id === channelId) return index;
    }
    return -1;
  }

  function firstAvailableChannelIndex() {
    var index;
    for (index = 0; index < state.channels.length; index += 1) {
      if (state.channels[index].enabled !== false && state.channels[index].onAir !== false) return index;
    }
    return -1;
  }

  function nextAvailableChannelIndex(base, delta) {
    var direction = delta < 0 ? -1 : 1;
    var candidate = base;
    var checked;
    for (checked = 0; checked < state.channels.length; checked += 1) {
      candidate = normalizeChannelIndex(candidate + direction);
      if (state.channels[candidate].enabled !== false && state.channels[candidate].onAir !== false) return candidate;
    }
    return normalizeChannelIndex(base);
  }

  function restoreChannelIndex() {
    var id = readStorage(STORAGE_CHANNEL);
    var index;
    for (index = 0; index < state.channels.length; index += 1) {
      if (state.channels[index].id === id && state.channels[index].enabled !== false && state.channels[index].onAir !== false) { state.channelIndex = index; return; }
    }
    state.channelIndex = Math.max(0, firstAvailableChannelIndex());
  }

  function currentChannel() { return state.channels[state.channelIndex] || null; }
  function isArray(value) { return Object.prototype.toString.call(value) === '[object Array]'; }

  function startPresenceHeartbeat() {
    if (presenceTimer) window.clearInterval(presenceTimer);
    presenceTimer = window.setInterval(sendPresenceHeartbeat, PRESENCE_INTERVAL_MS);
    sendPresenceHeartbeat();
  }

  function queuePresenceHeartbeat() {
    if (!state.serverUrl || !state.clientId) return;
    if (presenceChangeTimer) window.clearTimeout(presenceChangeTimer);
    presenceChangeTimer = window.setTimeout(function () {
      presenceChangeTimer = null;
      sendPresenceHeartbeat();
    }, 75);
  }

  function sendPresenceHeartbeat() {
    if (!state.serverUrl || !state.clientId) return;
    var channel = state.view === 'player' ? currentChannel() : null;
    if (state.view === 'player' && state.tuning && state.previousTune && state.previousTune.channelId) {
      var previousIndex = findChannelIndex(state.previousTune.channelId);
      if (previousIndex >= 0) channel = state.channels[previousIndex];
    }
    var mode = currentPlaybackMode();
    var xhr = new XMLHttpRequest();
    try {
      xhr.open('POST', state.serverUrl + '/api/client/v1/heartbeat', true);
      xhr.timeout = 5000;
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify({
        clientId: state.clientId,
        name: state.clientName,
        channelId: channel ? channel.id : null,
        playbackMode: mode
      }));
    } catch (ignore) {}
  }

  function currentPlaybackMode() {
    if (state.view !== 'player' || !currentChannel()) return 'idle';
    if (elements.playbackError && !elements.playbackError.classList.contains('hidden')) return 'error';
    if (!state.currentNow || !state.currentNow.program) return 'idle';
    if (state.localPaused) return 'paused';
    if (activeVideo().paused || activeVideo().readyState < 3) return 'buffering';
    if (state.activeSource && state.activeSource.mode === 'channel-hls') return 'transcode';
    return 'direct-play';
  }

  function getOrCreateClientId() {
    var existing = readStorage(STORAGE_CLIENT_ID);
    if (existing && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(existing)) return existing;

    var randomPart = '';
    try {
      if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        var values = new Uint32Array(2);
        window.crypto.getRandomValues(values);
        randomPart = values[0].toString(36) + values[1].toString(36);
      }
    } catch (ignore) {}
    if (!randomPart) randomPart = Math.floor(Math.random() * 0x100000000).toString(36);

    var clientId = 'webos-' + Date.now().toString(36) + '-' + randomPart;
    writeStorage(STORAGE_CLIENT_ID, clientId);
    return clientId;
  }

  function getClientName() {
    var saved = readStorage(STORAGE_CLIENT_NAME);
    if (saved) {
      saved = String(saved).replace(/^\s+|\s+$/g, '');
      if (saved.length > 0 && saved.length <= 80 && !/[\u0000-\u001f\u007f]/.test(saved)) return saved;
    }
    return 'LG webOS TV';
  }

  function readStorage(key) {
    try { return window.localStorage.getItem(key); } catch (ignore) { return null; }
  }

  function writeStorage(key, value) {
    try { window.localStorage.setItem(key, value); } catch (ignore) {}
  }

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function escapeAttribute(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/(["\\])/g, '\\$1');
  }

  function safePushHistory(value) {
    try { window.history.pushState(value, ''); } catch (ignore) {}
  }

  function safeReplaceHistory(value) {
    try { window.history.replaceState(value, ''); } catch (ignore) {}
  }
}());
