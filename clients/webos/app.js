(function () {
  'use strict';

  var STORAGE_SERVER = 'toasttv.serverUrl.v1';
  var STORAGE_CHANNEL = 'toasttv.channelId.v1';
  var STORAGE_CLIENT_ID = 'toasttv.clientId.v1';
  var STORAGE_CLIENT_NAME = 'toasttv.clientName.v1';
  var DEFAULT_SERVER = 'http://TOWER:1993';
  var POLL_INTERVAL_MS = 30000;
  var PRESENCE_INTERVAL_MS = 15000;
  var DRIFT_LIMIT_SECONDS = 8;
  var GUIDE_RENDER_LIMIT = 250;
  var LIVE_STREAM_RETRY_MS = 15000;
  var RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];

  var state = {
    view: 'boot',
    overlay: null,
    setupFromChannels: false,
    serverUrl: '',
    clientId: '',
    clientName: 'LG webOS TV',
    channels: [],
    channelIndex: 0,
    currentNow: null,
    programId: null,
    activeSource: null,
    failedLiveUrl: null,
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
    guideSerial: 0
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

  document.addEventListener('DOMContentLoaded', boot, false);

  function boot() {
    cacheElements();
    bindEvents();
    state.clientId = getOrCreateClientId();
    state.clientName = getClientName();
    safeReplaceHistory({ view: 'setup' });
    tickClock();
    window.setInterval(tickClock, 1000);

    var previewServer = null;
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      previewServer = window.location.protocol + '//' + window.location.host;
    }
    var savedServer = readStorage(STORAGE_SERVER);
    elements.serverInput.value = previewServer || savedServer || DEFAULT_SERVER;
    activateView('setup');

    if (previewServer || savedServer) {
      connectToServer(previewServer || savedServer, false, true);
    } else {
      window.setTimeout(focusFirst, 60);
    }
  }

  function cacheElements() {
    var ids = [
      'setupScreen', 'channelsScreen', 'playerScreen', 'serverInput',
      'connectButton', 'cancelSetupButton', 'setupMessage', 'settingsButton',
      'retryChannelsButton', 'channelGrid', 'emptyChannels', 'homeClock',
      'serverLabel', 'video', 'playerBackdrop', 'playerHeader', 'playerChannelName',
      'playerStatus', 'playerClock', 'playerInfo', 'playerCollection', 'playerTitle',
      'timelineFill', 'programTimes', 'nextTitle', 'offAirPanel', 'offAirNext',
      'playbackError', 'playbackErrorTitle', 'playbackErrorText',
      'retryPlaybackButton', 'errorBackButton', 'guideOverlay', 'guideChannelName',
      'guideList', 'guideMessage', 'closeGuideButton', 'nowOverlay',
      'nowChannelName', 'nowTitle', 'nowTime', 'nowTimelineFill', 'nowNextTitle',
      'closeNowButton', 'toast'
    ];
    var index;
    for (index = 0; index < ids.length; index += 1) {
      elements[ids[index]] = document.getElementById(ids[index]);
    }
  }

  function bindEvents() {
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
    elements.errorBackButton.addEventListener('click', goBack, false);
    elements.closeGuideButton.addEventListener('click', goBack, false);
    elements.closeNowButton.addEventListener('click', goBack, false);

    elements.video.addEventListener('loadedmetadata', joinLive, false);
    elements.video.addEventListener('canplay', function () {
      if (state.pendingJoin) joinLive();
    }, false);
    elements.video.addEventListener('playing', function () {
      elements.playerScreen.classList.add('has-video');
      state.awaitingGesture = false;
      setPlayerStatus('Playing live');
      queuePresenceHeartbeat();
      scheduleChromeHide();
    }, false);
    elements.video.addEventListener('waiting', function () {
      if (!state.localPaused) setPlayerStatus('Buffering…');
      queuePresenceHeartbeat();
    }, false);
    elements.video.addEventListener('pause', function () {
      if (state.localPaused) setPlayerStatus('Paused — press Play to rejoin live');
      queuePresenceHeartbeat();
    }, false);
    elements.video.addEventListener('error', handleMediaError, false);

    document.addEventListener('keydown', handleKeyDown, false);
    document.addEventListener('mouseover', function (event) {
      var target = closestFocusable(event.target);
      if (target) focusNode(target);
    }, false);
    document.addEventListener('mousemove', showChrome, false);
    window.addEventListener('popstate', handlePopState, false);
    window.addEventListener('online', function () {
      if (state.view === 'player') syncNow(false);
    }, false);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && state.view === 'player') syncNow(false);
    }, false);
  }

  function connectToServer(rawValue, remember, automatic) {
    var attemptId = ++state.connectSerial;
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
        activateView('setup');
        setSetupMessage('Could not reach ToastTV. Check the address and make sure the server is running.');
        focusNode(elements.connectButton);
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
      }
      state.serverUrl = normalized;
      state.channels = data.channels;
      state.reconnectAttempt = 0;
      recordClockSample(data.serverTimeMs, timing);
      if (remember || !readStorage(STORAGE_SERVER)) writeStorage(STORAGE_SERVER, normalized);
      restoreChannelIndex();
      renderChannels();
      elements.serverLabel.textContent = normalized;
      setSetupMessage('');
      startPresenceHeartbeat();

      if (state.setupFromChannels) {
        state.setupFromChannels = false;
        activateView('channels');
        goBack();
      } else {
        safeReplaceHistory({ view: 'channels' });
        activateView('channels');
      }
      hydrateChannelCards();
    });
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

  function renderChannels() {
    clearChildren(elements.channelGrid);
    elements.emptyChannels.classList.toggle('hidden', state.channels.length !== 0);
    elements.channelGrid.classList.toggle('hidden', state.channels.length === 0);
    var index;
    for (index = 0; index < state.channels.length; index += 1) {
      elements.channelGrid.appendChild(createChannelCard(state.channels[index], index));
    }
    window.setTimeout(focusFirst, 50);
  }

  function createChannelCard(channel, index) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'channel-card';
    button.setAttribute('data-focusable', '');
    button.setAttribute('data-channel-index', String(index));
    button.setAttribute('aria-label', 'Watch ' + channel.name);

    var number = document.createElement('span');
    number.className = 'channel-card__number';
    number.textContent = String(index + 1).length < 2 ? '0' + String(index + 1) : String(index + 1);
    var live = document.createElement('span');
    live.className = 'channel-card__live';
    live.textContent = 'CHANNEL';
    live.setAttribute('data-channel-state', channel.id);
    var title = document.createElement('h3');
    title.textContent = channel.name;
    var program = document.createElement('p');
    program.className = 'channel-card__program';
    program.textContent = 'Checking the schedule…';
    program.setAttribute('data-channel-program', channel.id);
    button.appendChild(number);
    button.appendChild(live);
    button.appendChild(title);
    button.appendChild(program);
    button.addEventListener('click', function () { tuneChannel(index, true); }, false);
    return button;
  }

  function hydrateChannelCards() {
    var serverAtStart = state.serverUrl;
    var index;
    for (index = 0; index < state.channels.length; index += 1) {
      (function (channel) {
        requestJson(serverAtStart + '/api/v1/channels/' + encodeURIComponent(channel.id) + '/now', 6000, function (error, data) {
          if (state.serverUrl !== serverAtStart) return;
          var target = document.querySelector('[data-channel-program="' + escapeAttribute(channel.id) + '"]');
          var channelState = document.querySelector('[data-channel-state="' + escapeAttribute(channel.id) + '"]');
          if (!target) return;
          if (error || !isNowResult(data)) {
            target.textContent = 'Schedule unavailable';
            if (channelState) channelState.textContent = 'UNAVAILABLE';
          } else if (!data.program) {
            target.textContent = data.next ? 'Next: ' + data.next.title : 'Off air';
            if (channelState) channelState.textContent = 'OFF AIR';
          } else {
            target.textContent = data.program.title;
            if (channelState) channelState.textContent = 'ON AIR';
          }
        });
      }(state.channels[index]));
    }
  }

  function tuneChannel(index, pushHistory) {
    if (!state.channels.length) return;
    state.channelIndex = ((index % state.channels.length) + state.channels.length) % state.channels.length;
    var channel = currentChannel();
    if (!channel) return;
    writeStorage(STORAGE_CHANNEL, channel.id);
    state.sourceRetryUsed = false;
    state.localPaused = false;
    state.awaitingGesture = false;
    state.currentNow = null;
    state.programId = null;
    state.activeSource = null;
    state.failedLiveUrl = null;
    clearLiveRetryTimer();
    clearPlaybackError();
    elements.playerChannelName.textContent = channel.name;
    elements.playerScreen.classList.remove('has-video');
    elements.playerBackdrop.classList.remove('hidden');
    if (pushHistory) safePushHistory({ view: 'player' });
    activateView('player');
    setPlayerStatus('Tuning…');
    showChrome();
    syncNow(true);
    startPlayerTimers();
  }

  function switchChannel(delta) {
    if (!state.channels.length) return;
    tuneChannel(state.channelIndex + delta, false);
    showToast(currentChannel().name);
  }

  function syncNow(forceReload) {
    if (state.view !== 'player' || !currentChannel() || !state.serverUrl) return;
    var requestId = ++state.requestSerial;
    var channel = currentChannel();
    requestJson(state.serverUrl + '/api/v1/channels/' + encodeURIComponent(channel.id) + '/now', 7000, function (error, data, timing) {
      if (requestId !== state.requestSerial || state.view !== 'player' || currentChannel().id !== channel.id) return;
      if (error) {
        setPlayerStatus('Server unavailable — reconnecting…');
        showToast('ToastTV server is unavailable. Retrying…');
        scheduleReconnect();
        return;
      }
      if (!isNowResult(data)) {
        showPlaybackError('Incompatible server response', 'Update the ToastTV server and try this channel again.');
        return;
      }
      state.reconnectAttempt = 0;
      clearReconnectTimer();
      recordClockSample(data.serverTimeMs, timing);
      var previousProgramId = state.programId;
      state.currentNow = data;
      queuePresenceHeartbeat();
      renderProgramInfo();
      scheduleBoundary();

      if (!data.program) {
        state.programId = null;
        showOffAir(data.next);
        return;
      }

      hideOffAir();
      var source = window.ToastTVPlaybackPolicy.choose(data, state.serverUrl, state.failedLiveUrl, state.clientId);
      if (!source) {
        showPlaybackError('No compatible playback source', 'The channel stream and direct-play fallback are unavailable.');
        return;
      }

      /* A channel HLS URL represents the broadcast, not the current program. Keep
         the TV attached while schedule metadata advances underneath it. */
      if (source.mode === 'channel-hls' && !window.ToastTVPlaybackPolicy.shouldReload(state.activeSource, source)) {
        state.programId = data.program.id;
        return;
      }

      if (source.mode === 'direct' && !forceReload && previousProgramId === data.program.id &&
          !window.ToastTVPlaybackPolicy.shouldReload(state.activeSource, source) && elements.video.readyState >= 1) {
        reconcileLivePosition();
        return;
      }

      if (previousProgramId !== data.program.id) state.sourceRetryUsed = false;
      state.programId = data.program.id;
      loadProgram(data.program, source);
    });
  }

  function loadProgram(program, source) {
    clearPlaybackError();
    hideOffAir();
    elements.playerScreen.classList.remove('has-video');
    state.pendingJoin = true;
    state.activeSource = source;
    state.playToken += 1;
    setPlayerStatus(source.mode === 'channel-hls' ? 'Joining live channel…' : 'Loading ' + program.title + '…');
    try {
      elements.video.pause();
      elements.video.removeAttribute('src');
      elements.video.load();
      elements.video.src = source.url;
      elements.video.load();
    } catch (error) {
      handleMediaError();
    }
  }

  function joinLive() {
    if (!state.pendingJoin || !state.currentNow || !state.currentNow.program || state.localPaused) return;
    state.pendingJoin = false;
    if (state.activeSource && state.activeSource.mode === 'channel-hls') {
      attemptPlay(++state.playToken);
      return;
    }
    var target = expectedPositionSeconds();
    if (isFinite(elements.video.duration) && elements.video.duration > 0) {
      target = Math.min(target, Math.max(0, elements.video.duration - 0.25));
    }
    target = Math.max(0, target);
    var token = ++state.playToken;
    var completed = false;
    function finishSeek() {
      if (completed || token !== state.playToken) return;
      completed = true;
      elements.video.removeEventListener('seeked', finishSeek, false);
      attemptPlay(token);
    }
    elements.video.addEventListener('seeked', finishSeek, false);
    window.setTimeout(finishSeek, 1800);
    try {
      if (Math.abs(elements.video.currentTime - target) > 0.5) elements.video.currentTime = target;
      else window.setTimeout(finishSeek, 0);
    } catch (error) {
      finishSeek();
    }
  }

  function attemptPlay(token) {
    if (token !== state.playToken || state.localPaused) return;
    var result;
    try { result = elements.video.play(); } catch (error) { handlePlayRejected(); return; }
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
    if (state.activeSource && state.activeSource.mode === 'channel-hls') return;
    var target = expectedPositionSeconds();
    if (Math.abs(elements.video.currentTime - target) > DRIFT_LIMIT_SECONDS) {
      try {
        if (isFinite(elements.video.duration)) target = Math.min(target, Math.max(0, elements.video.duration - 0.25));
        elements.video.currentTime = Math.max(0, target);
        setPlayerStatus('Rejoined live');
      } catch (ignore) {}
    }
  }

  function handleMediaError() {
    if (state.view !== 'player' || !state.currentNow || !state.currentNow.program) return;
    if (state.activeSource && state.activeSource.mode === 'channel-hls') {
      state.failedLiveUrl = state.activeSource.url;
      scheduleLiveRetry(state.failedLiveUrl, currentChannel().id);
      state.activeSource = null;
      setPlayerStatus('Live channel unavailable — trying direct playback…');
      window.setTimeout(function () { syncNow(true); }, 250);
      return;
    }
    if (!state.sourceRetryUsed) {
      state.sourceRetryUsed = true;
      setPlayerStatus('Refreshing the live source…');
      window.setTimeout(function () { syncNow(true); }, 650);
      return;
    }
    showPlaybackError('This program could not be played', 'This TV may not support the file’s container, video codec, or audio codec. MP4 with H.264 video and AAC audio is the safest direct-play format.');
  }

  function retryPlayback() {
    state.sourceRetryUsed = false;
    state.failedLiveUrl = null;
    state.activeSource = null;
    clearLiveRetryTimer();
    state.localPaused = false;
    clearPlaybackError();
    syncNow(true);
  }

  function pauseLocally() {
    if (state.view !== 'player' || !state.currentNow || !state.currentNow.program) return;
    state.localPaused = true;
    elements.video.pause();
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
    elements.playerChannelName.textContent = channel.name;
    elements.nowChannelName.textContent = channel.name;
    if (!data.program) {
      elements.playerCollection.textContent = 'Off air';
      elements.playerTitle.textContent = 'We’ll be back soon';
      elements.programTimes.textContent = '—';
      elements.nextTitle.textContent = data.next ? 'Next: ' + data.next.title : 'No later program scheduled';
      elements.timelineFill.style.width = '0%';
      elements.nowTitle.textContent = 'This channel is off air';
      elements.nowTime.textContent = data.next ? 'Returns at ' + formatTime(data.next.scheduledStart) : 'No later program scheduled';
      elements.nowNextTitle.textContent = data.next ? data.next.title : 'No later program scheduled';
      elements.nowTimelineFill.style.width = '0%';
      return;
    }
    var program = data.program;
    elements.playerCollection.textContent = program.collectionTitle || 'Now playing';
    elements.playerTitle.textContent = program.title;
    elements.programTimes.textContent = formatTime(program.scheduledStart) + ' – ' + formatTime(program.scheduledEnd);
    elements.nextTitle.textContent = data.next ? 'Next: ' + data.next.title : 'Last show on the schedule';
    elements.nowTitle.textContent = program.title;
    elements.nowTime.textContent = formatTime(program.scheduledStart) + ' – ' + formatTime(program.scheduledEnd);
    elements.nowNextTitle.textContent = data.next ? data.next.title : 'No later program scheduled';
    updateTimeline();
  }

  function updateTimeline() {
    if (!state.currentNow || !state.currentNow.program) return;
    var program = state.currentNow.program;
    var duration = Number(program.durationMs || (program.durationSeconds * 1000));
    if (!duration) return;
    var percent = Math.max(0, Math.min(100, expectedPositionSeconds() * 1000 / duration * 100));
    elements.timelineFill.style.width = percent.toFixed(2) + '%';
    elements.nowTimelineFill.style.width = percent.toFixed(2) + '%';
  }

  function showOffAir(nextProgram) {
    state.pendingJoin = false;
    state.playToken += 1;
    state.activeSource = null;
    try {
      elements.video.pause();
      elements.video.removeAttribute('src');
      elements.video.load();
    } catch (ignore) {}
    elements.playerScreen.classList.remove('has-video');
    elements.offAirPanel.classList.remove('hidden');
    elements.offAirNext.textContent = nextProgram ? 'Next: ' + nextProgram.title + ' at ' + formatTime(nextProgram.scheduledStart) : 'Check the guide for what’s next.';
    setPlayerStatus('Off air');
    showChrome();
  }

  function hideOffAir() { elements.offAirPanel.classList.add('hidden'); }

  function showPlaybackError(title, message) {
    state.pendingJoin = false;
    state.playToken += 1;
    elements.playbackErrorTitle.textContent = title;
    elements.playbackErrorText.textContent = message;
    elements.playbackError.classList.remove('hidden');
    setPlayerStatus('Playback error');
    queuePresenceHeartbeat();
    showChrome();
    window.setTimeout(focusFirst, 60);
  }

  function clearPlaybackError() { elements.playbackError.classList.add('hidden'); }

  function openGuide() {
    var channel = currentChannel();
    if (state.view !== 'player' || !channel) return;
    var guideRequestId = ++state.guideSerial;
    state.overlay = 'guide';
    safePushHistory({ view: 'player', overlay: 'guide' });
    renderOverlayState();
    elements.guideChannelName.textContent = channel.name;
    elements.guideMessage.textContent = 'Loading the guide…';
    clearChildren(elements.guideList);
    showChrome();
    requestJson(state.serverUrl + '/api/v1/channels/' + encodeURIComponent(channel.id) + '/guide?hours=8', 7000, function (error, data) {
      if (
        guideRequestId !== state.guideSerial ||
        state.overlay !== 'guide' ||
        !currentChannel() ||
        currentChannel().id !== channel.id
      ) return;
      if (error || !data || !isArray(data.programs)) {
        elements.guideMessage.textContent = 'The guide is unavailable right now.';
        return;
      }
      var visiblePrograms = data.programs.slice(0, GUIDE_RENDER_LIMIT);
      if (!data.programs.length) {
        elements.guideMessage.textContent = 'Nothing else is scheduled in the next eight hours.';
      } else if (data.truncated === true) {
        elements.guideMessage.textContent = 'This unusually dense guide was shortened at ' + formatTime(data.coverageEnd) + '.';
      } else if (data.programs.length > GUIDE_RENDER_LIMIT) {
        elements.guideMessage.textContent = 'Showing the first ' + GUIDE_RENDER_LIMIT + ' programs.';
      } else {
        elements.guideMessage.textContent = '';
      }
      renderGuide(visiblePrograms, guideRequestId, channel.id);
    });
  }

  function renderGuide(programs, guideRequestId, channelId) {
    clearChildren(elements.guideList);
    var currentId = state.currentNow && state.currentNow.program ? state.currentNow.program.id : null;
    var index;
    for (index = 0; index < programs.length; index += 1) {
      var program = programs[index];
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'guide-item' + (program.id === currentId ? ' is-now' : '');
      item.setAttribute('data-focusable', '');
      var time = document.createElement('span');
      time.className = 'guide-item__time';
      time.textContent = formatTime(program.scheduledStart);
      var details = document.createElement('span');
      var title = document.createElement('h3');
      title.textContent = program.title;
      var collection = document.createElement('p');
      collection.textContent = program.id === currentId ? 'On now' : (program.collectionTitle || 'Scheduled');
      details.appendChild(title);
      details.appendChild(collection);
      item.appendChild(time);
      item.appendChild(details);
      item.addEventListener('click', function () { goBack(); }, false);
      elements.guideList.appendChild(item);
    }
    window.setTimeout(function () {
      if (
        guideRequestId !== state.guideSerial ||
        state.overlay !== 'guide' ||
        !currentChannel() ||
        currentChannel().id !== channelId
      ) return;
      var current = elements.guideList.querySelector('.is-now');
      focusNode(current || elements.guideList.querySelector('[data-focusable]') || elements.closeGuideButton);
    }, 40);
  }

  function openNowOverlay() {
    if (state.view !== 'player') return;
    state.overlay = 'now';
    safePushHistory({ view: 'player', overlay: 'now' });
    renderProgramInfo();
    renderOverlayState();
    showChrome();
    window.setTimeout(function () { focusNode(elements.closeNowButton); }, 50);
  }

  function renderOverlayState() {
    elements.guideOverlay.classList.toggle('is-open', state.overlay === 'guide');
    elements.guideOverlay.setAttribute('aria-hidden', state.overlay === 'guide' ? 'false' : 'true');
    elements.nowOverlay.classList.toggle('is-open', state.overlay === 'now');
    elements.nowOverlay.setAttribute('aria-hidden', state.overlay === 'now' ? 'false' : 'true');
  }

  function closeOverlays() {
    state.overlay = null;
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
    elements.setupScreen.classList.toggle('is-active', view === 'setup');
    elements.channelsScreen.classList.toggle('is-active', view === 'channels');
    elements.playerScreen.classList.toggle('is-active', view === 'player');
    elements.setupScreen.setAttribute('aria-hidden', view === 'setup' ? 'false' : 'true');
    elements.channelsScreen.setAttribute('aria-hidden', view === 'channels' ? 'false' : 'true');
    elements.playerScreen.setAttribute('aria-hidden', view === 'player' ? 'false' : 'true');

    if (priorView === 'player' && view !== 'player') stopPlayback();
    if (view !== 'player') stopPlayerTimers();
    if (view === 'player') startPlayerTimers();
    if (view !== 'player') closeOverlays();
    queuePresenceHeartbeat();
    window.setTimeout(focusFirst, 50);
  }

  function handlePopState(event) {
    var historyState = event.state || {};
    if (historyState.view === 'player') {
      activateView('player');
      state.overlay = historyState.overlay || null;
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
    if (state.view === 'setup') cancelConnectionAttempt();
    try { window.history.back(); } catch (ignore) {
      if (state.view === 'player' || state.view === 'setup') activateView('channels');
    }
  }

  function cancelConnectionAttempt() {
    state.connectSerial += 1;
    elements.connectButton.disabled = false;
  }

  function handleKeyDown(event) {
    var code = event.keyCode || event.which;
    var target = event.target;
    var isTextInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
    if (state.view === 'player') showChrome();

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

    if (state.view === 'player' && !state.overlay && elements.playbackError.classList.contains('hidden')) {
      if (code === 37) { event.preventDefault(); switchChannel(-1); return; }
      if (code === 39) { event.preventDefault(); switchChannel(1); return; }
      if (code === 38) { event.preventDefault(); openGuide(); return; }
      if (code === 40) { event.preventDefault(); openNowOverlay(); return; }
      if (code === 13) {
        event.preventDefault();
        if (state.awaitingGesture) {
          state.awaitingGesture = false;
          attemptPlay(state.playToken);
        } else openNowOverlay();
        return;
      }
    }

    if (code === 13) {
      var active = closestFocusable(document.activeElement);
      if (active && active !== elements.serverInput) {
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
    else if (state.overlay === 'now') scope = elements.nowOverlay;
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
    else if (state.overlay === 'now') preferred = elements.closeNowButton;
    else if (state.view === 'channels') preferred = elements.channelGrid.querySelector('.channel-card') || elements.retryChannelsButton;
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
    if (boundaryTimer) window.clearTimeout(boundaryTimer);
    boundaryTimer = null;
    clearReconnectTimer();
    clearLiveRetryTimer();
  }

  function scheduleLiveRetry(failedUrl, channelId) {
    clearLiveRetryTimer();
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
      setPlayerStatus('Retrying the live channel…');
      syncNow(true);
    }, LIVE_STREAM_RETRY_MS);
  }

  function clearLiveRetryTimer() {
    if (liveRetryTimer) window.clearTimeout(liveRetryTimer);
    liveRetryTimer = null;
  }

  function scheduleBoundary() {
    if (boundaryTimer) window.clearTimeout(boundaryTimer);
    boundaryTimer = null;
    if (!state.currentNow || !state.currentNow.program) {
      if (state.currentNow && state.currentNow.next) {
        var untilNext = Date.parse(state.currentNow.next.scheduledStart) - (Date.now() + state.clockOffsetMs) + 300;
        boundaryTimer = window.setTimeout(function () { syncNow(true); }, clampTimer(untilNext));
      }
      return;
    }
    var remaining = Date.parse(state.currentNow.program.scheduledEnd) - (Date.now() + state.clockOffsetMs) + 300;
    boundaryTimer = window.setTimeout(function () { syncNow(true); }, clampTimer(remaining));
  }

  function clampTimer(value) { return Math.max(250, Math.min(2147480000, value)); }

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
    state.localPaused = false;
    state.awaitingGesture = false;
    try {
      elements.video.pause();
      elements.video.removeAttribute('src');
      elements.video.load();
    } catch (ignore) {}
    elements.playerScreen.classList.remove('has-video');
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
    updateTimeline();
  }

  function formatClock(date) {
    try { return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
    catch (ignore) { return pad2(date.getHours()) + ':' + pad2(date.getMinutes()); }
  }

  function formatTime(value) {
    var date = new Date(value);
    return isNaN(date.getTime()) ? '—' : formatClock(date);
  }

  function pad2(value) { return value < 10 ? '0' + value : String(value); }

  function setPlayerStatus(value) { elements.playerStatus.textContent = value; }
  function setSetupMessage(value) { elements.setupMessage.textContent = value; }

  function showChrome() {
    if (!elements.playerScreen) return;
    elements.playerScreen.classList.remove('chrome-hidden');
    scheduleChromeHide();
  }

  function scheduleChromeHide() {
    if (chromeTimer) window.clearTimeout(chromeTimer);
    chromeTimer = window.setTimeout(function () {
      if (state.view === 'player' && !state.overlay && !state.localPaused && elements.playbackError.classList.contains('hidden') && elements.offAirPanel.classList.contains('hidden')) {
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

  function restoreChannelIndex() {
    var id = readStorage(STORAGE_CHANNEL);
    var index;
    for (index = 0; index < state.channels.length; index += 1) {
      if (state.channels[index].id === id) { state.channelIndex = index; return; }
    }
    state.channelIndex = 0;
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
    if (elements.video.paused || elements.video.readyState < 3) return 'buffering';
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
