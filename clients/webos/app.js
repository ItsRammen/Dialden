(function () {
  'use strict';

  var STORAGE_SERVER = 'toasttv.serverUrl.v1';
  var STORAGE_CHANNEL = 'toasttv.channelId.v1';
  var STORAGE_CLIENT_ID = 'toasttv.clientId.v1';
  var STORAGE_CLIENT_NAME = 'toasttv.clientName.v1';
  var STORAGE_SESSION_OWNER = 'toasttv.sessionOwner.v1';
  var STORAGE_SESSION_OWNER_EPOCH = 'toasttv.sessionOwnerEpoch.v1';
  var CLIENT_VERSION = '0.6.4';
  var DEFAULT_SERVER = 'http://TOWER:1993';
  var POLL_INTERVAL_MS = 30000;
  var CHANNEL_REFRESH_INTERVAL_MS = 15000;
  var SCHEDULE_REFRESH_INTERVAL_MS = 60000;
  var OFF_AIR_CACHE_MAX_AGE_MS = SCHEDULE_REFRESH_INTERVAL_MS + 15000;
  var PRESENCE_INTERVAL_MS = 15000;
  var DRIFT_LIMIT_SECONDS = 8;
  var GUIDE_RENDER_LIMIT = 250;
  var GUIDE_CACHE_TTL_MS = 300000;
  var GUIDE_PREFETCH_DELAY_MS = 750;
  var GUIDE_PREFETCH_STAGGER_MS = 300;
  var LIVE_STREAM_RETRY_DELAYS = [300, 750, 1500, 3000, 5000];
  var TUNING_STABLE_MS = 300;
  var TUNING_PROBE_LIMIT = 20;
  var MIN_READY_BUFFER_SECONDS = 0.75;
  var ZAP_DEBOUNCE_MS = 80;
  var CHANNEL_OSD_MS = 2800;
  var LIVE_EDGE_TOLERANCE_SECONDS = 3;
  var LIVE_JOIN_BEHIND_SECONDS = 1.75;
  var TUNER_SWITCH_JOIN_BEHIND_SECONDS = 1.25;
  var BUFFERING_NOTICE_MS = 800;
  var BUFFERING_RECOVERY_MS = 6000;
  var BUFFERING_REPROVE_MS = 1200;
  var RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];
  var TUNER_RETRY_DELAYS = [2000, 5000, 15000, 30000];
  var TUNER_DECODER_RECOVERY_LIMIT = 2;
  var TUNER_REQUEST_TIMEOUT_MS = 30000;
  var IN_PLACE_TUNER_PROBE_MS = 100;
  var IN_PLACE_TUNER_PROGRESS_MS = 650;
  /* Settle time before warming a highlighted channel. Long enough that holding
     an arrow key through the lineup does not queue a retarget per row. */
  var WARM_HIGHLIGHT_DELAY_MS = 350;
  /* Budget for new media to appear after the outgoing buffer is discarded.
     Prototype measurements on this hardware landed between 282 and 1813 ms, so
     this is generous rather than tight; exceeding it means something is wrong,
     not merely slow. */
  var MSE_SWITCH_DEADLINE_MS = 6000;

  var state = {
    view: 'boot',
    overlay: null,
    setupFromChannels: false,
    playerEnteredFromChannels: false,
    serverUrl: '',
    clientId: '',
    sessionOwnerId: '',
    sessionOwnerEpoch: 0,
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
    hardLiveEdgePending: false,
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
    tuner: null,
    tunerCapability: 'unknown',
    tunerRequestSerial: 0,
    tunerRollbackChannelId: null,
    tunerRecoveryInFlight: false,
    tunerNeedsRecovery: false,
    tunerRetryAttempt: 0,
    tunerDecoderRecoveryAttempts: 0,
    tunerInPlaceSwitch: null,
    tuneMetrics: null,
    guideCache: {},
    guideRequests: {},
    guidePrefetchQueue: [],
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
  var guidePrefetchTimer = null;
  var guideScrollFrame = null;
  var catalogRailScrollFrame = null;
  var tunerRetryTimer = null;
  var inPlaceTunerTimer = null;
  var warmHighlightTimer = null;
  /* One engine, one media element, for the life of the session. A channel
     change never detaches either: that is the decoder reset being avoided. */
  var liveEngine = null;
  var liveEngineVideo = null;
  /* The channel switch as one named state rather than a set of booleans set in
     order by several paths. It owns two rules the old code could only imply:
     the destination is named on screen once its media is playing and not
     before, and a callback from a superseded request cannot move anything. */
  var switchContext = null;
  var switchSerial = 0;

  document.addEventListener('DOMContentLoaded', boot, false);

  function boot() {
    cacheElements();
    bindEvents();
    logTunerStatus('log', 'webOS client ' + CLIENT_VERSION + ' starting');
    state.clientId = getOrCreateClientId();
    state.sessionOwnerEpoch = nextSessionOwnerEpoch();
    state.sessionOwnerId = createSessionOwnerId();
    writeStorage(STORAGE_SESSION_OWNER, state.sessionOwnerId);
    writeStorage(STORAGE_SESSION_OWNER_EPOCH, String(state.sessionOwnerEpoch));
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
      'channelPreviewTimelineFill', 'channelPreviewTime', 'channelPreviewUpcoming', 'channelPreviewNext',
      'channelPreviewNext2', 'channelPreviewNext3', 'channelGuideButton',
      'serverLabel', 'videoA', 'tuningFreezeFrame', 'playerBackdrop', 'playerHeader', 'playerChannelName',
      'playerChannelLogo', 'playerChannelMonogram', 'playerChannelNumber', 'playerStatus', 'playerClock', 'playerInfo', 'playerCollection', 'playerTitle', 'playerEpisode',
      'timelineFill', 'programTimes', 'nextTitle', 'offAirPanel', 'offAirNext',
      'offAirGuideButton', 'offAirChannelsButton',
      'playbackError', 'playbackErrorTitle', 'playbackErrorText',
      'retryPlaybackButton', 'errorBackButton', 'guideOverlay', 'guideContext', 'guideChannelName',
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
        seekHlsLiveEdge(state.hardLiveEdgePending);
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
        if (state.activeSource && state.activeSource.mode === 'channel-hls') {
          seekHlsLiveEdge(state.hardLiveEdgePending);
        }
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
      /* Waiting can be the last event Chromium 53 emits for a bad native HLS
         attach. Keep the bounded frame proof alive instead of leaving the
         accepted channel under a tuning screen forever. */
      stabilizeTuning();
    } else if (!state.localPaused) {
      scheduleBufferingRecovery(event.currentTarget);
    }
    queuePresenceHeartbeat();
  }

  function activeVideo() {
    return elements.videoA;
  }

  function tuneVideo() {
    return activeVideo();
  }

  function hasCrossChannelHandoff() {
    var channel = currentChannel();
    var pendingChannelId = state.requestedChannelId || state.candidateChannelId;
    return !!(
      (pendingChannelId && state.committedChannelId &&
        pendingChannelId !== state.committedChannelId) ||
      (channel && state.previousTune && state.previousTune.channelId &&
        state.previousTune.channelId !== channel.id)
    );
  }

  function captureTuningFreezeFrame() {
    if (!hasCrossChannelHandoff()) return;
    elements.playerScreen.classList.add('is-zapping');
    var canvas = elements.tuningFreezeFrame;
    if (canvas && canvas.classList.contains('is-visible')) return;
    var video = activeVideo();
    if (!canvas) return;
    try {
      var width = Math.max(1, elements.playerScreen.clientWidth ||
        (video && video.videoWidth) || 1920);
      var height = Math.max(1, elements.playerScreen.clientHeight ||
        (video && video.videoHeight) || 1080);
      var context = canvas.getContext('2d');
      if (!context) return;
      canvas.width = width;
      canvas.height = height;
      context.fillStyle = '#000';
      context.fillRect(0, 0, width, height);
      var scale = Math.min(width / video.videoWidth, height / video.videoHeight);
      var drawWidth = Math.max(1, Math.round(video.videoWidth * scale));
      var drawHeight = Math.max(1, Math.round(video.videoHeight * scale));
      /* Make the canvas an opaque cover before sampling the hardware plane.
         Some LG models reject drawImage(video); those TVs get a clean black
         cut instead of exposing an unproven destination frame. */
      canvas.classList.add('is-visible');
      if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
      context.drawImage(
        video,
        Math.round((width - drawWidth) / 2),
        Math.round((height - drawHeight) / 2),
        drawWidth,
        drawHeight
      );
    } catch (ignoreFreezeFrame) {
      /* Some LG hardware video planes cannot be sampled by canvas. The
         is-zapping backdrop remains a clean black handoff on those models. */
    }
  }

  function clearTuningFreezeFrame() {
    clearInPlaceStableTunerProbe();
    elements.playerScreen.classList.remove('is-zapping');
    var canvas = elements.tuningFreezeFrame;
    if (!canvas) return;
    canvas.classList.remove('is-visible');
    /* Release the transient 1080p canvas backing store after every zap. */
    canvas.width = 1;
    canvas.height = 1;
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
        abortGuideRequestsExcept(null);
        cancelGuidePrefetch();
        state.clockSamples = [];
        state.clockOffsetMs = 0;
        state.guideCache = {};
        state.guideRequests = {};
        state.lineupPreferredChannelId = null;
        state.lineupDesiredChannelId = null;
        state.lineupRetargetInFlight = null;
        state.tuner = null;
        state.tunerCapability = 'unknown';
        state.tunerRequestSerial = 0;
        state.tunerRollbackChannelId = null;
        state.tunerRecoveryInFlight = false;
        state.tunerNeedsRecovery = false;
        state.tunerRetryAttempt = 0;
        state.tunerDecoderRecoveryAttempts = 0;
        clearStableTunerRetry();
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
      var resumeSavedChannel = state.channels.length && !!readStorage(STORAGE_CHANNEL);
      if (!resumeSavedChannel) scheduleGuidePrefetch(GUIDE_PREFETCH_DELAY_MS);

      if (state.setupFromChannels) {
        state.setupFromChannels = false;
        activateView('channels');
        goBack();
      } else if (resumeSavedChannel) {
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
      { clientId: state.clientId, ownerId: state.sessionOwnerId, ownerEpoch: state.sessionOwnerEpoch, lastChannelId: savedChannelId, lineup: true, tuner: true },
      TUNER_REQUEST_TIMEOUT_MS,
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
        setStableTuner(stableTunerFromResponse(data, data.channel.id));
        if (state.tuner) {
          state.tunerCapability = 'available';
        } else {
          markStableTunerUnavailable(data, 'startup');
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
    clearStableTunerRetry();
    var closePayload = { clientId: state.clientId, ownerId: state.sessionOwnerId, ownerEpoch: state.sessionOwnerEpoch };
    if (state.tuner) closePayload.sessionId = state.tuner.sessionId;
    var payload = JSON.stringify(closePayload);
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(
          state.serverUrl + '/api/client/v1/session/close',
          new Blob([payload], { type: 'application/json' })
        );
        return;
      }
    } catch (ignore) {}
    postJson(state.serverUrl + '/api/client/v1/session/close', closePayload, 3000);
  }

  function reopenLineupSession() {
    var channel = currentChannel();
    if (!channel || !state.serverUrl || state.lineupOpening) return;
    var generation = state.tuneGeneration;
    var sessionChannelId = state.tuner && state.currentNow && !state.currentNow.program
      ? state.tuner.channelId
      : channel.id;
    var requestTuner = state.tunerCapability !== 'incompatible';
    state.lineupOpening = true;
    postJson(
      state.serverUrl + '/api/client/v1/session',
      { clientId: state.clientId, ownerId: state.sessionOwnerId, ownerEpoch: state.sessionOwnerEpoch, lastChannelId: sessionChannelId, lineup: true, tuner: requestTuner },
      TUNER_REQUEST_TIMEOUT_MS,
      function (error, data) {
        state.lineupOpening = false;
        if (generation !== state.tuneGeneration || state.view !== 'player' || !currentChannel() || currentChannel().id !== channel.id) return;
        if (error || !data || data.status !== 'ready') {
          if (requestTuner && !state.tuner) markStableTunerUnavailable(data, 'lineup reopen', error);
          setPlayerStatus('Playing live — background lineup warm-up delayed');
          return;
        }
        var reopenedTuner = stableTunerFromResponse(data, sessionChannelId);
        var priorTuner = state.tuner;
        if (reopenedTuner) {
          setStableTuner(reopenedTuner);
          state.tunerCapability = 'available';
        } else if (!priorTuner) {
          state.tuner = null;
          state.tunerRollbackChannelId = null;
          if (requestTuner) markStableTunerUnavailable(data, 'lineup reopen', error);
        } else {
          logTunerStatus('warn', 'lineup reopen did not replace the active tuner; keeping the current session');
        }
        state.lineupPreferredChannelId = sessionChannelId;
        state.lineupDesiredChannelId = sessionChannelId;
        var tunerEpochChanged = !!priorTuner && !!reopenedTuner && (
          priorTuner.sessionId !== reopenedTuner.sessionId ||
          priorTuner.manifestUrl !== reopenedTuner.manifestUrl);
        var shouldAttachReplacement = tunerEpochChanged && state.activeSource &&
          state.activeSource.tunerSessionId === priorTuner.sessionId;
        if (shouldAttachReplacement) {
          state.candidateChannelId = channel.id;
          state.hasCommittedVideo = false;
          activeVideo().muted = true;
          beginTuning('Restoring the live tuner…');
          syncNow(true);
          return;
        }
        if (!tunerEpochChanged && state.activeSource && state.activeSource.mode === 'channel-hls' &&
            !activeVideo().paused && activeVideo().readyState >= 2) {
          syncNow(false);
        } else {
          syncNow(true);
        }
      }
    );
  }

  function stableTunerSwitchBoundary(value, revision) {
    if (!value || typeof value !== 'object' || value.revision !== revision) return null;
    var first = Number(value.firstMediaSequence);
    var last = Number(value.lastMediaSequence);
    var count = Number(value.segmentCount);
    var targetDuration = Number(value.targetDurationSeconds);
    var duration = Number(value.durationSeconds);
    var transportMode = value.transportMode === 'seamless'
      ? 'seamless'
      : 'discontinuity';
    if (!isFinite(first) || Math.floor(first) !== first || first < 0 ||
        !isFinite(last) || Math.floor(last) !== last || last < first ||
        !isFinite(count) || Math.floor(count) !== count || count < 2 || count > 32 ||
        last - first + 1 !== count ||
        !isFinite(targetDuration) || targetDuration <= 0 || targetDuration > 30 ||
        !isFinite(duration) || duration <= 0 || duration > 300) return null;
    return {
      revision: revision,
      firstMediaSequence: first,
      lastMediaSequence: last,
      segmentCount: count,
      targetDurationSeconds: targetDuration,
      durationSeconds: duration,
      transportMode: transportMode
    };
  }

  function stableTunerFromResponse(data, expectedChannelId) {
    var tuner = data && data.tuner;
    if (!tuner || tuner.mode !== 'stable-hls' || typeof tuner.sessionId !== 'string' ||
        !/^[a-f0-9-]{36}$/i.test(tuner.sessionId) || typeof tuner.manifestUrl !== 'string' ||
        typeof tuner.channelId !== 'string' || typeof tuner.revision !== 'number' ||
        !isFinite(tuner.revision) || Math.floor(tuner.revision) !== tuner.revision || tuner.revision < 1 ||
        typeof tuner.requestIdFloor !== 'number' || !isFinite(tuner.requestIdFloor) ||
        Math.floor(tuner.requestIdFloor) !== tuner.requestIdFloor || tuner.requestIdFloor < -1 ||
        tuner.requestIdFloor > 9007199254740991) {
      return null;
    }
    if (expectedChannelId && tuner.channelId !== expectedChannelId) return null;
    var manifestUrl = window.ToastTVPlaybackPolicy.resolveUrl(tuner.manifestUrl, state.serverUrl);
    if (!manifestUrl) return null;
    return {
      mode: 'stable-hls',
      sessionId: tuner.sessionId,
      manifestUrl: manifestUrl,
      channelId: tuner.channelId,
      revision: tuner.revision,
      requestIdFloor: tuner.requestIdFloor,
      switchBoundary: stableTunerSwitchBoundary(tuner.switchBoundary, tuner.revision)
    };
  }

  function setStableTuner(tuner) {
    state.tuner = tuner;
    if (tuner) {
      state.tunerRequestSerial = Math.max(state.tunerRequestSerial, tuner.requestIdFloor);
      state.tunerRetryAttempt = 0;
      clearStableTunerRetry();
    }
  }

  function tunerFailureMessage(data, error) {
    if (data && data.tunerError && data.tunerError.message) return String(data.tunerError.message);
    if (data && data.error) return String(data.error);
    if (error && error.message) return String(error.message);
    return 'Stable tuner staging did not complete';
  }

  function logTunerStatus(level, message) {
    try {
      var target = console && console[level];
      if (typeof target === 'function') target.call(console, '[ToastTV Tuner] ' + message);
    } catch (ignore) {}
  }

  function markStableTunerUnavailable(data, context, error) {
    if (state.tunerCapability === 'incompatible') return;
    state.tunerCapability = 'unavailable';
    logTunerStatus('warn', context + ' unavailable: ' + tunerFailureMessage(data, error));
    scheduleStableTunerRetry();
  }

  function clearStableTunerRetry() {
    if (tunerRetryTimer) window.clearTimeout(tunerRetryTimer);
    tunerRetryTimer = null;
  }

  function scheduleStableTunerRetry() {
    if (tunerRetryTimer || state.tuner || state.tunerCapability === 'incompatible' ||
        !state.serverUrl || state.launchCancelled) return;
    var index = Math.min(state.tunerRetryAttempt, TUNER_RETRY_DELAYS.length - 1);
    var delay = TUNER_RETRY_DELAYS[index];
    state.tunerRetryAttempt += 1;
    tunerRetryTimer = window.setTimeout(retryStableTunerInBackground, delay);
  }

  function retryStableTunerInBackground() {
    tunerRetryTimer = null;
    if (state.tuner || state.tunerCapability === 'incompatible' || !state.serverUrl ||
        state.launchCancelled) return;
    var channel = currentChannel();
    if (!channel || state.view !== 'player' || state.tuning || state.requestedChannelId ||
        state.lineupOpening || !state.hasCommittedVideo ||
        state.committedChannelId !== channel.id || !state.currentNow || !state.currentNow.program) {
      scheduleStableTunerRetry();
      return;
    }
    var generation = state.tuneGeneration;
    var channelId = channel.id;
    state.lineupOpening = true;
    postJson(
      state.serverUrl + '/api/client/v1/session',
      { clientId: state.clientId, ownerId: state.sessionOwnerId, ownerEpoch: state.sessionOwnerEpoch, lastChannelId: channelId, lineup: true, tuner: true },
      TUNER_REQUEST_TIMEOUT_MS,
      function (error, data) {
        state.lineupOpening = false;
        if (generation !== state.tuneGeneration || state.view !== 'player' ||
            !currentChannel() || currentChannel().id !== channelId ||
            state.committedChannelId !== channelId) {
          scheduleStableTunerRetry();
          return;
        }
        var recovered = !error && data && data.status === 'ready' && data.channel &&
          data.channel.id === channelId ? stableTunerFromResponse(data, channelId) : null;
        if (!recovered) {
          markStableTunerUnavailable(data, 'background retry', error);
          return;
        }
        setStableTuner(recovered);
        state.tunerCapability = 'available';
        state.lineupPreferredChannelId = channelId;
        state.lineupDesiredChannelId = channelId;
        logTunerStatus('log', 'background retry acquired the stable tuner for ' + channelId);
        queuePresenceHeartbeat();
      }
    );
  }

  function stableTunerResponseMatches(data, channelId) {
    var tuner = stableTunerFromResponse(data, channelId);
    if (!tuner || !state.tuner) return null;
    if (tuner.sessionId !== state.tuner.sessionId || tuner.manifestUrl !== state.tuner.manifestUrl) return null;
    return tuner;
  }

  function stableTunerPlaybackSource() {
    if (!state.tuner) return null;
    return {
      mode: 'channel-hls',
      url: state.tuner.manifestUrl,
      seekToProgramOffset: false,
      tunerSessionId: state.tuner.sessionId
    };
  }

  function playbackSourceForNow(data, failedLiveUrl) {
    var tunerCanBeAdopted = data && data.program && state.tuner &&
      window.ToastTVPlaybackPolicy.canAdoptTuner(
        state.tuner.channelId,
        data.channelId,
        hasAttachedStableTunerSource(),
        state.hasCommittedVideo,
        state.candidateChannelId,
        state.requestedChannelId
      );
    if (tunerCanBeAdopted) return stableTunerPlaybackSource();
    return window.ToastTVPlaybackPolicy.choose(data, state.serverUrl, failedLiveUrl, state.clientId);
  }

  function hasAttachedStableTunerSource() {
    return !!(state.tuner && state.activeSource &&
      state.activeSource.tunerSessionId === state.tuner.sessionId &&
      state.activeSource.baseUrl === state.tuner.manifestUrl);
  }

  function hasActiveStableTunerPlayback() {
    return hasAttachedStableTunerSource() && state.hasCommittedVideo === true &&
      activeVideo().readyState >= 2;
  }

  function hasPendingStableTunerHandoff() {
    return !!(state.tuning && state.previousTune && state.candidateChannelId &&
      state.activeSource && state.activeSource.tunerSessionId && state.tuner &&
      state.activeSource.tunerSessionId === state.tuner.sessionId &&
      state.tuner.channelId === state.candidateChannelId);
  }

  function clearInPlaceStableTunerProbe() {
    if (inPlaceTunerTimer) window.clearTimeout(inPlaceTunerTimer);
    inPlaceTunerTimer = null;
    state.tunerInPlaceSwitch = null;
  }

  function scheduleInPlaceStableTunerProbe(probe) {
    if (state.tunerInPlaceSwitch !== probe || inPlaceTunerTimer) return;
    inPlaceTunerTimer = window.setTimeout(function () {
      inPlaceTunerTimer = null;
      probeInPlaceStableTunerHandoff(probe);
    }, IN_PLACE_TUNER_PROBE_MS);
  }

  function switchMachine() {
    return window.ToastTVSwitchMachine;
  }

  function dispatchSwitch(event) {
    var machine = switchMachine();
    if (!machine) return [];
    if (!switchContext) switchContext = machine.create();
    var step = machine.transition(switchContext, event);
    switchContext = step.context;
    return step.effects;
  }

  /** True while the switch owns the screen, whoever else also thinks so. */
  function switchIsInFlight() {
    var machine = switchMachine();
    return !!machine && machine.isSwitching(switchContext);
  }

  /** True once the destination may be named on screen. */
  function switchIdentityIsPublishable() {
    var machine = switchMachine();
    return !machine || machine.identityIsPublishable(switchContext);
  }

  function liveEngineActive() {
    return !!(liveEngine && liveEngineVideo && liveEngineVideo === activeVideo());
  }

  /**
   * Attaches the live channel stream through the MSE engine.
   *
   * hls.js transmuxes the tuner's MPEG-TS to fMP4 in the page, so the server is
   * unchanged. The element is bound once and kept: switching channels later
   * discards the buffer rather than the decoder.
   */
  function attachLiveSource(url) {
    if (!window.ToastTVPlaybackEngine || !window.Hls ||
        !window.ToastTVPlaybackEngine.isSupported(window.Hls)) {
      logTunerStatus('warn', 'MSE playback is unavailable on this device');
      return false;
    }
    var video = activeVideo();
    if (liveEngine && liveEngineVideo !== video) detachLiveEngine();
    if (!liveEngine) {
      liveEngine = window.ToastTVPlaybackEngine.createEngine({
        video: video,
        Hls: window.Hls
      });
      liveEngineVideo = video;
      liveEngine.on('lost', function (payload) {
        logTunerStatus('warn', 'playback engine lost the session: ' +
          (payload && payload.details ? payload.details : 'unrecoverable'));
        dispatchSwitch({
          type: switchMachine().EVENTS.LOST,
          requestId: switchContext ? switchContext.requestId : -1
        });
        handleMediaError();
      });
    }
    liveEngine.attach(url);
    return true;
  }

  function detachLiveEngine() {
    if (!liveEngine) return;
    liveEngine.detach();
    liveEngine = null;
    liveEngineVideo = null;
  }

  /**
   * Switches channel without touching the decoder.
   *
   * The server has already published the incoming channel on the same
   * continuous timeline, so discarding everything ahead of the playhead and
   * refilling is all that is required. There is no drain to wait out, no
   * boundary to observe and no freeze frame to hide, because nothing resets.
   */
  function beginInPlaceStableTunerHandoff(channelId, generation, now, timing) {
    var boundary = state.tuner && state.tuner.switchBoundary;
    if (!boundary || boundary.revision !== state.tuner.revision ||
        !hasAttachedStableTunerSource() || !state.hasCommittedVideo ||
        !liveEngineActive()) return false;
    var switched = liveEngine.switchNow();
    if (!switched) return false;
    var probe = {
      generation: generation,
      channelId: channelId,
      revision: boundary.revision,
      boundary: boundary,
      now: now,
      timing: timing,
      baseline: switched.baseline,
      discarded: switched.discarded,
      switchRequestId: switchContext ? switchContext.requestId : -1,
      deadlineAt: Date.now() + MSE_SWITCH_DEADLINE_MS
    };
    state.tunerInPlaceSwitch = probe;
    state.hardLiveEdgePending = false;
    state.hlsSeekPending = false;
    setPlayerStatus('Switching live picture…');
    logTunerStatus('log', 'flushed ' +
      (switched.discarded === null ? '?' : switched.discarded.toFixed(2)) +
      's of outgoing buffer for ' + channelId);
    scheduleInPlaceStableTunerProbe(probe);
    return true;
  }

  function clearInPlaceStableTunerProbe() {
    if (inPlaceTunerTimer) window.clearTimeout(inPlaceTunerTimer);
    inPlaceTunerTimer = null;
    state.tunerInPlaceSwitch = null;
  }

  function scheduleInPlaceStableTunerProbe(probe) {
    if (state.tunerInPlaceSwitch !== probe || inPlaceTunerTimer) return;
    inPlaceTunerTimer = window.setTimeout(function () {
      inPlaceTunerTimer = null;
      probeInPlaceStableTunerHandoff(probe);
    }, IN_PLACE_TUNER_PROBE_MS);
  }

  function probeInPlaceStableTunerHandoff(probe) {
    if (state.tunerInPlaceSwitch !== probe || probe.generation !== state.tuneGeneration ||
        state.view !== 'player' || !state.tuner || state.tuner.revision !== probe.revision ||
        state.tuner.channelId !== probe.channelId || !state.tuning) return;
    if (!liveEngineActive()) {
      fallbackInPlaceStableTunerHandoff(probe, 'playback engine detached mid-switch');
      return;
    }
    /* Media before the cut is still the outgoing channel, so playback has to
       pass it before the new one is genuinely on screen. */
    if (window.ToastTVPlaybackEngine.isRevealed(liveEngine.stats(), probe.baseline)) {
      dispatchSwitch({
        type: switchMachine().EVENTS.REVEALED,
        channelId: probe.channelId,
        requestId: probe.switchRequestId
      });
      finishInPlaceStableTunerHandoff(probe);
      return;
    }
    if (Date.now() >= probe.deadlineAt) {
      dispatchSwitch({
        type: switchMachine().EVENTS.TIMED_OUT,
        channelId: probe.channelId,
        requestId: probe.switchRequestId
      });
      fallbackInPlaceStableTunerHandoff(probe, 'new media did not appear in time');
      return;
    }
    scheduleInPlaceStableTunerProbe(probe);
  }

  function finishInPlaceStableTunerHandoff(probe) {
    if (state.tunerInPlaceSwitch !== probe) return;
    clearInPlaceStableTunerProbe();
    state.tuning = false;
    state.pendingJoin = false;
    state.liveRetryAttempt = 0;
    state.failedLiveUrl = null;
    state.hlsSeekPending = false;
    state.hardLiveEdgePending = false;
    state.frameProbeAttempts = 0;
    state.hasCommittedVideo = true;
    state.tunerNeedsRecovery = false;
    state.tunerDecoderRecoveryAttempts = 0;
    /* The machine is the authority on whether the destination may be named:
       publishing before its media is on screen is what captioned the outgoing
       picture with the incoming channel. */
    if (!switchIdentityIsPublishable()) return;
    state.committedChannelId = probe.channelId;
    state.tunerRollbackChannelId = null;
    state.candidateChannelId = null;
    state.previousTune = null;
    activeVideo().muted = false;
    elements.playerScreen.classList.remove('is-tuning');
    elements.playerScreen.classList.add('has-video');
    clearTuningFreezeFrame();
    renderProgramInfo();
    // The dock waited for this; it now has a programme to announce.
    showChrome();
    updateChannelOsdProgram(state.currentNow && state.currentNow.program
      ? state.currentNow.program.title : 'Live');
    scheduleChannelOsdHide();
    writeStorage(STORAGE_CHANNEL, probe.channelId);
    retargetLineupSession(probe.channelId, probe.generation);
    if (state.tuneMetrics && state.tuneMetrics.channelId === probe.channelId) {
      state.tuneMetrics.firstFrameAt = Date.now();
      state.tuneMetrics.src = 'session-tuner-mse';
      logTuneMetrics(state.tuneMetrics);
      state.tuneMetrics = null;
    }
    setPlayerStatus('Playing live');
    scheduleGuidePrefetch(100);
    scheduleChromeHide();
    queuePresenceHeartbeat();
    window.setTimeout(function () {
      if (probe.generation === state.tuneGeneration && state.view === 'player' &&
          state.committedChannelId === probe.channelId && !state.tuning) syncNow(false);
    }, 300);
  }

  /**
   * Rebuilds the engine on the tuner's current revision.
   *
   * This is not the old decoder re-attach: the media element is never dropped,
   * so there is no black frame to cover and no freeze frame to capture.
   */
  function fallbackInPlaceStableTunerHandoff(probe, reason) {
    if (state.tunerInPlaceSwitch !== probe) return;
    clearInPlaceStableTunerProbe();
    logTunerStatus('warn', 'switch to ' + probe.channelId +
      ' fell back to an engine reattach: ' + reason);
    state.hasCommittedVideo = false;
    state.frameProbeAttempts = 0;
    state.hlsSeekPending = false;
    state.hardLiveEdgePending = false;
    if (state.tuneMetrics) state.tuneMetrics.src = 'session-tuner-engine-reattach';
    beginTuning('Switching the live picture…');
    applyNowResult(probe.now, probe.timing, true);
    queuePresenceHeartbeat();
  }

  function ensureAttachedStableTunerPlayback(message) {
    if (!hasAttachedStableTunerSource()) return false;
    var video = activeVideo();
    if (hasActiveStableTunerPlayback()) {
      video.muted = false;
      elements.playerScreen.classList.remove('is-tuning');
      elements.playerScreen.classList.add('has-video');
      if (video.paused && !state.localPaused) attemptPlay(++state.playToken);
      return true;
    }

    /* The permanent source is still attached, but an attached manifest is not
       evidence that this TV has decoded a usable frame. Keep the accepted
       channel metadata, re-prove playback without replacing src, and leave the
       tuning cover up until stabilizeTuning observes forward progress. */
    video.muted = true;
    state.hasCommittedVideo = false;
    state.pendingJoin = true;
    if (!state.tuning) beginTuning(message || 'Locking onto the live channel…');
    seekHlsLiveEdge();
    if (!state.localPaused) attemptPlay(++state.playToken);
    stabilizeTuning();
    return false;
  }

  function postStableTunerSwitch(channelId, callback) {
    if (!state.tuner) {
      callback(new Error('The stable tuner is unavailable'));
      return;
    }
    state.tunerRequestSerial = window.ToastTVPlaybackPolicy.nextTunerRequestId(
      state.tunerRequestSerial,
      state.tuner.requestIdFloor
    );
    var requestId = state.tunerRequestSerial;
    postJson(
      state.serverUrl + '/api/client/v1/session/tune',
      {
        clientId: state.clientId,
        ownerId: state.sessionOwnerId,
        ownerEpoch: state.sessionOwnerEpoch,
        sessionId: state.tuner.sessionId,
        channelId: channelId,
        requestId: requestId
      },
      TUNER_REQUEST_TIMEOUT_MS,
      callback
    );
  }

  function committedStableTunerFeedChannelId() {
    if (!state.tuner) return null;
    /* The descriptor is the actual server feed even while the UI remains on an
       older committed identity under the black curtain. Rapid zaps must roll
       back to this feed, then separately preserve the UI rollback snapshot. */
    return state.tuner.channelId;
  }

  function restoreCommittedStableTuner(requestId, callback) {
    var channelId = state.previousTune && state.previousTune.tunerChannelId
      ? state.previousTune.tunerChannelId
      : (state.tunerRollbackChannelId || committedStableTunerFeedChannelId());
    var sessionId = state.tuner && state.tuner.sessionId;
    if (!channelId || !sessionId) {
      if (callback) callback(null);
      return;
    }
    postStableTunerSwitch(channelId, function (error, data) {
      if (requestId !== state.tuneGeneration || !state.tuner || state.tuner.sessionId !== sessionId) return;
      var restoredTuner = !error && data && data.status === 'ready'
        ? stableTunerResponseMatches(data, channelId)
        : null;
      if (restoredTuner) {
        setStableTuner(restoredTuner);
        state.tunerRollbackChannelId = null;
        if (callback) callback(restoredTuner);
        return;
      }
      state.tuner = null;
      state.tunerRollbackChannelId = null;
      if (callback) {
        callback(null);
        return;
      }
      if (state.view === 'player' && currentChannel()) syncNow(true);
    });
  }

  function restoreStableTunerThenRollback(requestId, callback) {
    restoreCommittedStableTuner(requestId, function (restoredTuner) {
      if (requestId !== state.tuneGeneration) return;
      var restored = rollbackCandidateTune(restoredTuner);
      if (callback) callback(restored, restoredTuner);
    });
  }

  function showChannelStartupFailure(message) {
    safeReplaceHistory({ view: 'channels' });
    activateView('channels');
    hydrateChannelCards();
    scheduleGuidePrefetch(100);
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
    clearStableTunerRetry();
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

  function prepareCurrentChannel(onFailure, shouldContinue, onStableReady) {
    var channel = currentChannel();
    if (!channel || !state.serverUrl) return;
    if (hasAttachedStableTunerSource()) {
      if (state.requestedChannelId) return;
      var generation = ++state.tuneGeneration;
      postStableTunerSwitch(channel.id, function (error, data) {
        if (generation !== state.tuneGeneration || state.view !== 'player' ||
            !currentChannel() || currentChannel().id !== channel.id) return;
        if (shouldContinue && !shouldContinue()) return;
        var refreshedTuner = !error && data && data.status === 'ready'
          ? stableTunerResponseMatches(data, channel.id)
          : null;
        if (!refreshedTuner) {
          if (onFailure) onFailure(data && data.error ? data.error : 'The session tuner is unavailable.');
          return;
        }
        setStableTuner(refreshedTuner);
        syncNow(false);
        if (onStableReady) onStableReady(generation);
      });
      return;
    }
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

  function isCurrentOffAirResult(data, channelId, serverNow) {
    if (!isNowResult(data) || data.channelId !== channelId || data.program !== null) return false;
    var ageMs = serverNow - data.serverTimeMs;
    if (!isFinite(ageMs) || ageMs < -5000 || ageMs > OFF_AIR_CACHE_MAX_AGE_MS) return false;
    if (data.next) {
      var nextStartMs = Date.parse(data.next.scheduledStart);
      if (!isFinite(nextStartMs) || nextStartMs <= serverNow) return false;
    }
    return true;
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
    button.setAttribute('aria-label', 'Channel ' + channelNumber(index) + ', ' + channel.name + '. Press OK to tune.');
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
      scheduleGuidePrefetch(100);
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
    scheduleGuidePrefetch(GUIDE_PREFETCH_DELAY_MS);
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
    warmHighlightedChannel(state.previewChannelIndex);
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
    setChannelPreviewUpcoming([], 'Waiting for a channel lineup');
    elements.channelPreviewTimelineFill.style.width = '0%';
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
    elements.channelGuideButton.disabled = channel.enabled === false;
    if (!data) {
      setChannelCardState(elements.channelPreviewState, 'CHECKING', 'checking');
      elements.channelPreviewProgram.textContent = 'Loading the live schedule…';
      elements.channelPreviewEpisode.textContent = 'Every channel joins at the point already in progress.';
      elements.channelPreviewTime.textContent = '—';
      renderChannelPreviewUpcoming(channel, data, 'Checking the schedule…');
      elements.channelPreviewTimelineFill.style.width = '0%';
      return;
    }
    if (data.error) {
      setChannelCardState(elements.channelPreviewState, 'UNAVAILABLE', 'unavailable');
      elements.channelPreviewProgram.textContent = 'Schedule unavailable';
      elements.channelPreviewEpisode.textContent = 'ToastTV will check this channel again automatically.';
      elements.channelPreviewTime.textContent = '—';
      renderChannelPreviewUpcoming(channel, data, 'Try refreshing the lineup in a moment.');
      elements.channelPreviewTimelineFill.style.width = '0%';
      return;
    }
    if (!data.program) {
      setChannelCardState(elements.channelPreviewState, 'OFF AIR', 'off-air');
      elements.channelPreviewProgram.textContent = 'This channel is off air';
      elements.channelPreviewEpisode.textContent = data.next ? 'Programming resumes at ' + formatTime(data.next.scheduledStart) : 'No later program is scheduled.';
      elements.channelPreviewTime.textContent = '—';
      renderChannelPreviewUpcoming(channel, data, 'No later program scheduled');
      elements.channelPreviewTimelineFill.style.width = '0%';
      return;
    }
    setChannelCardState(elements.channelPreviewState, 'ON AIR', 'on-air');
    elements.channelPreviewProgram.textContent = data.program.title;
    elements.channelPreviewEpisode.textContent = programEpisodeText(data.program) || data.program.collectionTitle || 'Live now';
    elements.channelPreviewTime.textContent = formatTime(data.program.scheduledStart) + ' – ' + formatTime(data.program.scheduledEnd);
    renderChannelPreviewUpcoming(channel, data, 'Last show on the schedule');
    updateChannelPreviewTimeline();
  }

  function renderChannelPreviewUpcoming(channel, data, fallbackText) {
    var programs = [];
    var todayStart = localCatalogDayStart(0).getTime();
    var cached = channel
      ? getCachedGuideDay(channel.id, todayStart)
      : null;
    var now = Date.now() + state.clockOffsetMs;
    appendUpcomingPrograms(cached, programs, now);
    if (cached && programs.length < 3 && channel) {
      var tomorrowStart = localCatalogDayStart(1).getTime();
      var tomorrow = getCachedGuideDay(channel.id, tomorrowStart);
      appendUpcomingPrograms(tomorrow, programs, now);
      if (!tomorrow && state.view === 'channels') requestGuideDay(channel.id, tomorrowStart);
    }
    if (!programs.length && data && data.next) programs.push(data.next);
    setChannelPreviewUpcoming(programs, fallbackText);
  }

  function appendUpcomingPrograms(cached, programs, now) {
    if (cached && isArray(cached.programs)) {
      var index;
      for (index = 0; index < cached.programs.length && programs.length < 3; index += 1) {
        var program = cached.programs[index];
        var startsAt = Date.parse(program.scheduledStart);
        if (isFinite(startsAt) && startsAt > now) programs.push(program);
      }
    }
  }

  function setChannelPreviewUpcoming(programs, fallbackText) {
    var targets = [elements.channelPreviewNext, elements.channelPreviewNext2, elements.channelPreviewNext3];
    var index;
    for (index = 0; index < targets.length; index += 1) {
      var program = programs[index];
      if (program) {
        targets[index].textContent = formatTime(program.scheduledStart) + '  ' + program.title;
        targets[index].classList.remove('hidden');
      } else if (index === 0) {
        targets[index].textContent = fallbackText || 'No later program scheduled';
        targets[index].classList.remove('hidden');
      } else {
        targets[index].textContent = '';
        targets[index].classList.add('hidden');
      }
    }
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

  function tuneChannel(index, pushHistory) {
    if (!state.channels.length) return;
    if (state.view === 'player' && state.tuning && !state.hasCommittedVideo &&
        !state.previousTune && !state.committedChannelId) {
      showToast('The first channel is still tuning. Please wait a moment.');
      return;
    }
    var targetIndex = normalizeChannelIndex(index);
    var channel = state.channels[targetIndex];
    if (!channel) return;
    if (state.requestedChannelId === channel.id) return;
    if (state.view === 'player' && !state.tuning && state.committedChannelId === channel.id) {
      state.channelIndex = targetIndex;
      showChrome();
      return;
    }
    var isChannelChange = state.view === 'player' &&
      (state.committedChannelId || state.previousTune) &&
      state.committedChannelId !== channel.id;
    if (state.view === 'player' && state.tuning && !state.hasCommittedVideo && state.previousTune) {
      if (hasPendingStableTunerHandoff()) {
        /* Keep the accepted server feed and its metadata intact while a newer
           key press supersedes it. If the newer request fails, this handoff can
           be revision-reattached instead of falling into an empty tune state. */
        clearTuningTimer();
        clearBufferingTimers();
      } else {
        abandonCandidateTune();
      }
    }
    /* A newer zap supersedes the probe but keeps its accepted candidate and
       outgoing visual snapshot available for rollback or continuation. */
    if (state.tunerInPlaceSwitch) clearInPlaceStableTunerProbe();
    state.tuneGeneration += 1;
    var generation = state.tuneGeneration;
    state.requestedChannelIndex = targetIndex;
    state.requestedChannelId = channel.id;
    state.tuneMetrics = { requestedAt: Date.now(), preparedAt: 0, attachedAt: 0, firstFrameAt: 0, channelId: channel.id, src: 'zap' };
    if (isChannelChange) {
      /* The engine never resets the decoder: the outgoing channel keeps
         rendering until the incoming one replaces it mid-stream. Covering that
         with a freeze frame would replace good video with a black still for the
         length of the switch, which is the whole visible cost we just removed.
         The native path still needs the cover, because it does reset. */
      if (!liveEngineActive()) captureTuningFreezeFrame();
      showChannelOsd(targetIndex, 'Tuning…', true);
    }
    if (zapTimer) window.clearTimeout(zapTimer);
    zapTimer = window.setTimeout(function () {
      zapTimer = null;
      var rememberedNow = state.channelNow[channel.id];
      var rememberedOffAir = rememberedNow && isNowResult(rememberedNow) && rememberedNow.program === null;
      var currentRememberedOffAir = isCurrentOffAirResult(
        rememberedNow,
        channel.id,
        Date.now() + state.clockOffsetMs
      );
      var channelIsExplicitlyOffAir = channel.onAir === false;
      var shouldResolveOffAir = channelIsExplicitlyOffAir || currentRememberedOffAir;
      if (state.tuner) {
        logTunerStatus(
          'log',
          'zap ' + (state.committedChannelId || '?') + ' -> ' + channel.id +
            ' branch=stable attached=' + (hasAttachedStableTunerSource() ? 'yes' : 'no') +
            ' revision=' + state.tuner.revision
        );
        if (shouldResolveOffAir) {
          if (state.tuneMetrics) state.tuneMetrics.src = 'session-tuner-off-air';
          resolveStableTunerOffAir(channel.id, generation, pushHistory, rememberedNow);
          return;
        }
        if (state.tuneMetrics) state.tuneMetrics.src = 'session-tuner';
        tuneStableTunerChannel(channel.id, generation, pushHistory);
        return;
      }
      if (!state.tuner && state.tunerCapability !== 'incompatible' &&
          !shouldResolveOffAir) {
        logTunerStatus('log', 'zap ' + (state.committedChannelId || '?') + ' -> ' + channel.id + ' branch=acquire');
        openStableTunerForChannel(channel.id, generation, pushHistory);
        return;
      }
      logTunerStatus(
        'warn',
        'zap ' + (state.committedChannelId || '?') + ' -> ' + channel.id +
          ' branch=compatibility capability=' + state.tunerCapability +
          ' onAir=' + String(channel.onAir) +
          ' cachedOffAir=' + (currentRememberedOffAir ? 'fresh' : (rememberedOffAir ? 'stale' : 'no'))
      );
      if (rememberedOffAir && shouldResolveOffAir) {
        commitPreparedChannel(channel.id, generation, pushHistory, { data: rememberedNow, timing: null });
        return;
      }
      prepareChannel(channel.id, generation, pushHistory);
    }, ZAP_DEBOUNCE_MS);
  }

  function openStableTunerForChannel(channelId, generation, pushHistory) {
    var previousChannelId = state.committedChannelId;
    postJson(
      state.serverUrl + '/api/client/v1/session',
      { clientId: state.clientId, ownerId: state.sessionOwnerId, ownerEpoch: state.sessionOwnerEpoch, lastChannelId: channelId, lineup: true, tuner: true },
      TUNER_REQUEST_TIMEOUT_MS,
      function (error, data) {
        if (generation !== state.tuneGeneration || state.requestedChannelId !== channelId) return;
        var tuner = !error && data && data.status === 'ready' && data.channel && data.channel.id === channelId
          ? stableTunerFromResponse(data, channelId)
          : null;
        setStableTuner(tuner);
        state.tunerCapability = tuner ? 'available' : 'unavailable';
        if (!tuner) {
          markStableTunerUnavailable(data, 'channel tune', error);
          prepareChannel(channelId, generation, pushHistory);
          return;
        }
        state.lineupPreferredChannelId = channelId;
        state.lineupDesiredChannelId = channelId;
        if (state.tuneMetrics) {
          state.tuneMetrics.preparedAt = Date.now();
          state.tuneMetrics.src = 'startup-tuner';
        }
        if (previousChannelId && previousChannelId !== channelId && state.hasCommittedVideo) {
          state.tunerRollbackChannelId = previousChannelId;
          if (state.tuneMetrics) state.tuneMetrics.src = 'session-tuner-recovered';
          resolveStableTunerNow(
            channelId,
            previousChannelId,
            generation,
            pushHistory,
            0
          );
          return;
        }
        resolvePreparedChannel(channelId, generation, pushHistory, false);
      }
    );
  }

  function resolveStableTunerOffAir(channelId, generation, pushHistory, rememberedNow) {
    if (isNowResult(rememberedNow) && rememberedNow.channelId === channelId && rememberedNow.program === null) {
      commitStableTunerChannel(channelId, generation, pushHistory, rememberedNow, null, false);
      return;
    }
    requestJson(
      state.serverUrl + '/api/v1/channels/' + encodeURIComponent(channelId) + '/now',
      8000,
      function (error, data, timing) {
        if (generation !== state.tuneGeneration || state.requestedChannelId !== channelId) return;
        if (!error && isNowResult(data) && data.channelId === channelId && data.program === null) {
          commitStableTunerChannel(channelId, generation, pushHistory, data, timing, false);
          return;
        }
        var index = findChannelIndex(channelId);
        if (index >= 0 && state.channels[index].enabled !== false && state.channels[index].onAir === false) {
          commitStableTunerChannel(channelId, generation, pushHistory,
            createOfflineNowResult(state.channels[index]), null, false);
          return;
        }
        recoverRejectedStableTunerTune('That channel schedule is not ready yet. The current channel was kept playing.');
      }
    );
  }

  function tuneStableTunerChannel(channelId, generation, pushHistory) {
    /* A prior accepted zap may still be waiting for its metadata when a newer
       remote-key press arrives. Roll back to the last UI-committed playable
       channel, not that intermediate server-side destination. */
    var previousChannelId = committedStableTunerFeedChannelId();
    if (!previousChannelId || !state.tuner || generation !== state.tuneGeneration) {
      prepareChannel(channelId, generation, pushHistory);
      return;
    }
    if (!state.tunerRollbackChannelId) {
      state.tunerRollbackChannelId = previousChannelId;
    }
    if (!liveEngineActive()) updateChannelOsdProgram('Switching live signal…');
    switchSerial += 1;
    var switchRequestId = switchSerial;
    dispatchSwitch({
      type: switchMachine().EVENTS.REQUESTED,
      channelId: channelId,
      requestId: switchRequestId
    });
    postStableTunerSwitch(channelId, function (error, data) {
      if (generation !== state.tuneGeneration || state.requestedChannelId !== channelId) return;
      if (error || !data) {
        logTunerStatus('warn', 'switch to ' + channelId + ' failed: ' + tunerFailureMessage(data, error));
        if (data && data.code === 'TUNER_SESSION_NOT_FOUND') {
          recoverStableTunerPlayback();
          return;
        }
        if (data && data.code === 'TUNER_UNAVAILABLE') {
          /* The server rejected this candidate before the atomic manifest
             commit. The outgoing stable feed is still authoritative, so do
             not risk a second same-channel readiness wait just to roll back. */
          state.requestedChannelId = null;
          state.requestedChannelIndex = null;
          clearInPlaceStableTunerProbe();
          if (restartPendingStableTunerHandoff()) {
            showToast(data.error || 'That channel is unavailable. Continuing the prepared channel.');
            return;
          }
          var originalChannelId = state.tunerRollbackChannelId || state.committedChannelId;
          if (originalChannelId && state.tuner) {
            rollbackAcceptedStableTunerTune(
              originalChannelId,
              data.error || 'That channel is unavailable. The previous channel was restored.'
            );
            return;
          }
          state.tunerRollbackChannelId = null;
          recoverRejectedStableTunerTune(
            data.error || 'That channel is still preparing. The previous channel was kept playing.'
          );
          return;
        }
        rollbackAcceptedStableTunerTune(previousChannelId,
          'The channel switch could not be confirmed. The previous channel was restored.');
        return;
      }
      if (data.status !== 'ready') {
        rollbackAcceptedStableTunerTune(
          previousChannelId,
          data.error
            ? data.error
            : 'That channel could not be switched. The previous channel was restored.'
        );
        return;
      }
      var acceptedTuner = stableTunerResponseMatches(data, channelId);
      if (!acceptedTuner || !data.channel || data.channel.id !== channelId) {
        disableStableTunerAndReload('The tuner returned an invalid session response. Returning to normal channel playback.');
        return;
      }
      setStableTuner(acceptedTuner);
      dispatchSwitch({
        type: switchMachine().EVENTS.ACCEPTED,
        channelId: channelId,
        requestId: switchRequestId
      });
      logTunerStatus('log', 'switch to ' + channelId + ' accepted at revision ' + acceptedTuner.revision);
      if (state.tuneMetrics) state.tuneMetrics.preparedAt = Date.now();
      if (!liveEngineActive()) updateChannelOsdProgram('Loading channel schedule…');
      if (isNowResult(data.now) && data.now.channelId === channelId) {
        commitStableTunerChannel(
          channelId,
          generation,
          pushHistory,
          data.now,
          null,
          true,
          previousChannelId
        );
        return;
      }
      resolveStableTunerNow(channelId, previousChannelId, generation, pushHistory, 0);
    });
  }

  function resolveStableTunerNow(channelId, previousChannelId, generation, pushHistory, attempt) {
    requestJson(
      state.serverUrl + '/api/v1/channels/' + encodeURIComponent(channelId) + '/now',
      8000,
      function (error, data, timing) {
        if (generation !== state.tuneGeneration || state.requestedChannelId !== channelId) return;
        if (!error && isNowResult(data) && data.channelId === channelId) {
          commitStableTunerChannel(
            channelId,
            generation,
            pushHistory,
            data,
            timing,
            true,
            previousChannelId
          );
          return;
        }
        if (attempt < 2) {
          window.setTimeout(function () {
            resolveStableTunerNow(channelId, previousChannelId, generation, pushHistory, attempt + 1);
          }, 180 + attempt * 170);
          return;
        }
        rollbackAcceptedStableTunerTune(previousChannelId,
          'The new channel switched, but its schedule was unavailable. The previous channel was restored.');
      }
    );
  }

  function commitStableTunerChannel(
    channelId,
    generation,
    pushHistory,
    now,
    timing,
    tunerSwitched,
    previousTunerChannelId
  ) {
    if (generation !== state.tuneGeneration || state.requestedChannelId !== channelId) return;
    var index = findChannelIndex(channelId);
    if (index < 0 || state.channels[index].enabled === false || !isNowResult(now) || now.channelId !== channelId) {
      rollbackAcceptedStableTunerTune(
        previousTunerChannelId || committedStableTunerFeedChannelId(),
        'That channel is no longer available.'
      );
      return;
    }
    /* The tune response proves that the server published target segments, but
       Chromium 53 may still drain buffered frames from the outgoing channel.
       Keep that channel's identity as the rollback snapshot, cover the decoder,
       and reattach the stable manifest at its new revision. stabilizeTuning is
       then the only place that may publish the destination identity. */
    var requiresStableHandoff = !!(tunerSwitched && now.program);
    if (requiresStableHandoff && !state.previousTune && state.committedChannelId) {
      state.previousTune = {
        channelId: state.committedChannelId,
        currentNow: state.currentNow,
        programId: state.programId,
        activeSource: state.activeSource,
        tunerChannelId: state.tunerRollbackChannelId ||
          previousTunerChannelId || state.committedChannelId
      };
    } else if (requiresStableHandoff && state.previousTune &&
               !state.previousTune.tunerChannelId &&
               (state.tunerRollbackChannelId || previousTunerChannelId)) {
      state.previousTune.tunerChannelId = state.tunerRollbackChannelId ||
        previousTunerChannelId;
    }
    var priorView = state.view;
    if (priorView !== 'player') state.playerEnteredFromChannels = pushHistory === true;
    closeOverlays();
    clearBoundaryTimer();
    clearReconnectTimer();
    clearSourceRefreshTimer();
    clearTuningTimer();
    clearLiveRetryTimer();
    state.channelIndex = index;
    state.requestedChannelIndex = null;
    state.requestedChannelId = null;
    state.candidateChannelId = requiresStableHandoff ? channelId : null;
    if (!requiresStableHandoff) {
      state.previousTune = null;
      state.committedChannelId = channelId;
      state.tunerRollbackChannelId = null;
    }
    if (tunerSwitched) state.tuner.channelId = channelId;
    var lineupChannelId = tunerSwitched ? channelId : state.tuner.channelId;
    state.lineupPreferredChannelId = lineupChannelId;
    state.lineupDesiredChannelId = lineupChannelId;
    state.reconnectAttempt = 0;
    state.tuning = requiresStableHandoff;
    state.localPaused = false;
    state.awaitingGesture = false;
    state.failedLiveUrl = null;
    state.liveRetryAttempt = 0;
    state.hlsSeekPending = false;
    state.hardLiveEdgePending = requiresStableHandoff;
    clearPlaybackError();
    if (pushHistory) safePushHistory({ view: 'player' });
    activateView('player');
    if (requiresStableHandoff) {
      if (beginInPlaceStableTunerHandoff(channelId, generation, now, timing)) {
        applyNowResult(now, timing, false);
        if (state.tuneMetrics && state.tuneMetrics.channelId === channelId) {
          state.tuneMetrics.metadataAt = Date.now();
        }
        queuePresenceHeartbeat();
        return;
      }
      // Same outgoing-decoder release as the in-place fallback above.
      detachVideoForTune();
      state.frameProbeAttempts = 0;
      beginTuning('Switching the live picture…');
    }
    applyNowResult(now, timing, requiresStableHandoff);
    if (state.tuneMetrics && state.tuneMetrics.channelId === channelId) {
      state.tuneMetrics.metadataAt = Date.now();
    }
    if (requiresStableHandoff) {
      queuePresenceHeartbeat();
      return;
    }
    renderProgramInfo();
    updateChannelOsdProgram(now.program ? now.program.title : 'Off air');
    scheduleChannelOsdHide();
    writeStorage(STORAGE_CHANNEL, channelId);
    if (tunerSwitched && typeof now.branding === 'undefined') {
      scheduleStableTunerMetadataSync(generation, state.tuner.sessionId, channelId);
    }
    if (state.tuneMetrics && state.tuneMetrics.channelId === channelId) {
      logTuneMetrics(state.tuneMetrics);
      state.tuneMetrics = null;
    }
    setPlayerStatus(now.program
      ? (state.tuning ? 'Tuning — waiting for live video…' : 'Playing live')
      : 'Off air');
    scheduleGuidePrefetch(100);
    scheduleChromeHide();
    queuePresenceHeartbeat();
  }

  function recoverRejectedStableTunerTune(message) {
    clearTuningFreezeFrame();
    state.requestedChannelIndex = null;
    state.requestedChannelId = null;
    state.tuneMetrics = null;
    updateChannelOsdProgram('Signal unavailable');
    scheduleChannelOsdHide();
    showToast(message);
    showChrome();
  }

  function restartPendingStableTunerHandoff() {
    if (!hasPendingStableTunerHandoff() || !state.currentNow ||
        !state.currentNow.program) return false;
    var pendingNow = state.currentNow;
    state.requestSerial += 1;
    clearTuningTimer();
    clearBufferingTimers();
    state.hlsSeekPending = false;
    state.hardLiveEdgePending = true;
    state.frameProbeAttempts = 0;
    // Clears pendingJoin and hasCommittedVideo, and releases both decoders.
    detachVideoForTune();
    beginTuning('Resuming the selected channel…');
    applyNowResult(pendingNow, null, true);
    updateChannelOsdProgram(pendingNow.program.title);
    return true;
  }

  function rollbackAcceptedStableTunerTune(previousChannelId, message) {
    clearInPlaceStableTunerProbe();
    if (!previousChannelId || !state.tuner) {
      disableStableTunerAndReload(message);
      return;
    }
    var rollbackGeneration = ++state.tuneGeneration;
    state.requestedChannelId = previousChannelId;
    state.requestedChannelIndex = findChannelIndex(previousChannelId);
    postStableTunerSwitch(previousChannelId, function (error, data) {
      if (rollbackGeneration !== state.tuneGeneration || state.requestedChannelId !== previousChannelId) return;
      var restoredTuner = !error && data && data.status === 'ready'
        ? stableTunerResponseMatches(data, previousChannelId)
        : null;
      if (!restoredTuner) {
        disableStableTunerAndReload('The session tuner could not restore the previous channel. Returning to normal channel playback.');
        return;
      }
      setStableTuner(restoredTuner);
      state.requestedChannelId = null;
      state.requestedChannelIndex = null;
      state.tuneMetrics = null;
      if (restartPendingStableTunerHandoff()) {
        showToast(message);
        showChrome();
        return;
      }
      state.tunerRollbackChannelId = null;
      rollbackCandidateTune(restoredTuner);
      if (!state.tuning) clearTuningFreezeFrame();
      updateChannelOsdProgram(state.tuning ? 'Restoring previous channel…' : 'Signal unavailable');
      scheduleChannelOsdHide();
      showToast(message);
      showChrome();
    });
  }

  function disableStableTunerAndReload(message, incompatible) {
    clearTuningFreezeFrame();
    var tuner = state.tuner;
    state.tuner = null;
    state.tunerRollbackChannelId = null;
    state.tunerCapability = incompatible ? 'incompatible' : 'unavailable';
    state.tunerRecoveryInFlight = false;
    state.tunerNeedsRecovery = false;
    state.tunerDecoderRecoveryAttempts = 0;
    if (incompatible) clearStableTunerRetry();
    state.requestedChannelId = null;
    state.requestedChannelIndex = null;
    state.tuneMetrics = null;
    state.activeSource = null;
    state.failedLiveUrl = null;
    state.programId = null;
    state.previousTune = null;
    state.hasCommittedVideo = false;
    resetAllVideos();
    elements.playerScreen.classList.remove('has-video');
    updateChannelOsdProgram('Rejoining channel…');
    showToast(message);
    if (tuner) {
      postJson(
        state.serverUrl + '/api/client/v1/session/close',
        {
          clientId: state.clientId,
          ownerId: state.sessionOwnerId,
          ownerEpoch: state.sessionOwnerEpoch,
          sessionId: tuner.sessionId,
          tunerOnly: true
        },
        3000
      );
    }
    if (state.view === 'player' && currentChannel()) {
      beginTuning('Rejoining the channel…');
      syncNow(true);
    }
    if (!incompatible) scheduleStableTunerRetry();
  }

  function recoverStableTunerPlayback() {
    if (state.tunerRecoveryInFlight || !state.tuner || !currentChannel()) return;
    clearTuningFreezeFrame();
    var failedTuner = state.tuner;
    var channelId = currentChannel().id;
    var generation = ++state.tuneGeneration;
    state.tunerRecoveryInFlight = true;
    state.tunerNeedsRecovery = false;
    state.requestedChannelId = null;
    state.requestedChannelIndex = null;
    state.tuneMetrics = null;
    setPlayerStatus('Checking the live tuner…');
    requestText(failedTuner.manifestUrl, 3500, function (manifestError) {
      if (generation !== state.tuneGeneration || !state.tuner ||
          state.tuner.sessionId !== failedTuner.sessionId) {
        state.tunerRecoveryInFlight = false;
        return;
      }
      if (!manifestError) {
        /* A healthy playlist does not prove that a one-off decoder or segment
           fetch error is a permanent TV incompatibility. Reattach the same
           target-only manifest with a fresh revision query before abandoning
           fast switching for the rest of this app launch. */
        state.tunerRecoveryInFlight = false;
        if (state.tunerDecoderRecoveryAttempts < TUNER_DECODER_RECOVERY_LIMIT) {
          state.tunerDecoderRecoveryAttempts += 1;
          state.tunerNeedsRecovery = false;
          state.activeSource = null;
          state.failedLiveUrl = null;
          state.programId = null;
          state.previousTune = null;
          state.hasCommittedVideo = false;
          resetAllVideos();
          elements.playerScreen.classList.remove('has-video');
          beginTuning('Reattaching the live tuner…');
          logTunerStatus(
            'warn',
            'decoder recovery ' + state.tunerDecoderRecoveryAttempts + '/' +
              TUNER_DECODER_RECOVERY_LIMIT + ' for ' + channelId
          );
          syncNow(true);
          return;
        }
        disableStableTunerAndReload(
          'This TV repeatedly rejected fast-tuner playback. Using compatible channel playback instead.',
          true
        );
        return;
      }
      postJson(
        state.serverUrl + '/api/client/v1/session',
        {
          clientId: state.clientId,
          ownerId: state.sessionOwnerId,
          ownerEpoch: state.sessionOwnerEpoch,
          lastChannelId: channelId,
          lineup: true,
          tuner: true
        },
        TUNER_REQUEST_TIMEOUT_MS,
        function (error, data) {
          if (generation !== state.tuneGeneration || state.view !== 'player' ||
              !currentChannel() || currentChannel().id !== channelId) {
            state.tunerRecoveryInFlight = false;
            return;
          }
          var reopened = !error && data && data.status === 'ready' && data.channel &&
            data.channel.id === channelId ? stableTunerFromResponse(data, channelId) : null;
          state.tunerRecoveryInFlight = false;
          if (!reopened) {
            disableStableTunerAndReload('The fast tuner session was lost. Using compatible channel playback instead.');
            return;
          }
          setStableTuner(reopened);
          state.tunerCapability = 'available';
          state.tunerNeedsRecovery = false;
          state.activeSource = null;
          state.failedLiveUrl = null;
          state.programId = null;
          state.previousTune = null;
          state.hasCommittedVideo = false;
          resetAllVideos();
          elements.playerScreen.classList.remove('has-video');
          beginTuning('Restoring the live tuner…');
          syncNow(true);
        }
      );
    });
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
          updateChannelOsdProgram('Checking off-air schedule…');
          resolvePreparedChannel(channelId, generation, pushHistory, false);
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
          var offlineIndex = findChannelIndex(channelId);
          if (!startup && offlineIndex >= 0 && state.channels[offlineIndex].enabled !== false &&
              state.channels[offlineIndex].onAir === false) {
            commitPreparedChannel(channelId, generation, pushHistory, {
              data: createOfflineNowResult(state.channels[offlineIndex]),
              timing: null
            });
            return;
          }
          rejectPrepared('That channel schedule or live source is not ready yet. The current channel was kept playing.');
          return;
        }
        var source = data.program ? playbackSourceForNow(data, null) : null;
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

  function createOfflineNowResult(channel) {
    var serverTimeMs = Date.now() + state.clockOffsetMs;
    return {
      channelId: channel.id,
      serverTime: new Date(serverTimeMs).toISOString(),
      serverTimeMs: serverTimeMs,
      timezone: channel.timezone || 'UTC',
      timelineRevision: 'off-air:' + channel.id,
      program: null,
      next: null,
      branding: null
    };
  }

  function verifyPreparedManifest(url, channelId, generation, attempt, callback) {
    var separator = url.indexOf('?') === -1 ? '?' : '&';
    requestText(url + separator + 'probe=' + encodeURIComponent(String(generation) + '-' + String(attempt)), 5000, function (error, text) {
      if (generation !== state.tuneGeneration || state.requestedChannelId !== channelId) return;
      var lines = String(text || '').split(/\r?\n/);
      var segments = 0;
      var awaitingSegmentUri = false;
      var index;
      for (index = 0; index < lines.length; index += 1) {
        var line = lines[index].replace(/^\s+|\s+$/g, '');
        if (/^#EXTINF:/i.test(line)) {
          awaitingSegmentUri = true;
        } else if (awaitingSegmentUri && line && line.charAt(0) !== '#') {
          segments += 1;
          awaitingSegmentUri = false;
        }
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
    var preparedOffAir = prepared && prepared.data && prepared.data.program === null;
    if (index < 0 || state.channels[index].enabled === false ||
        (state.channels[index].onAir === false && !preparedOffAir)) {
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
    state.hardLiveEdgePending = false;
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
      if (requestedIndex < 0 || channels[requestedIndex].enabled === false) {
        var restoreStableTuner = hasAttachedStableTunerSource();
        state.tuneGeneration += 1;
        state.requestedChannelId = null;
        state.requestedChannelIndex = null;
        if (restoreStableTuner) {
          var restoreGeneration = state.tuneGeneration;
          restoreStableTunerThenRollback(restoreGeneration, function () {
            if (restoreGeneration !== state.tuneGeneration) return;
            showToast('The channel you selected left the lineup.');
            finishChannelListReconciliation(channels, committedChannelId, priorIndex);
          });
          return;
        }
        rollbackCandidateTune();
        showToast('The channel you selected left the lineup.');
      }
    }
    if (state.candidateChannelId) {
      var candidateIndex = findChannelIndex(state.candidateChannelId);
      if (candidateIndex < 0 || channels[candidateIndex].enabled === false) {
        state.tuneGeneration += 1;
        state.requestedChannelId = null;
        state.requestedChannelIndex = null;
        rollbackCandidateTune();
        showToast('The channel being tuned left the lineup.');
      }
    }
    finishChannelListReconciliation(channels, committedChannelId, priorIndex);
  }

  function finishChannelListReconciliation(channels, committedChannelId, priorIndex) {
    var committedIndex = committedChannelId ? findChannelIndex(committedChannelId) : -1;
    var committedAvailable = committedIndex >= 0 && channels[committedIndex].enabled !== false;
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
    clearTuningFreezeFrame();
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
      if (state.channels[index].id === channelId && state.channels[index].enabled !== false) {
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
      /* Media errors can arrive while an off-air selection deliberately keeps
         the last tuner feed attached and muted. Recover that source before
         publishing fresh program metadata; otherwise an errored element has
         no later media event with which to finish tuning. */
      if (data.program && state.tuner && state.tunerNeedsRecovery) {
        recoverStableTunerPlayback();
        return;
      }
      /* An off-air selection intentionally leaves the last playable tuner
         feed muted. When this channel starts programming, switch the server
         tuner before committing its metadata so picture and labels can never
         describe different channels. A newer remote-key request wins. */
      if (data.program && state.tuner && state.tuner.channelId !== channel.id) {
        if (state.requestedChannelId) return;
        var generation = ++state.tuneGeneration;
        state.requestedChannelIndex = state.channelIndex;
        state.requestedChannelId = channel.id;
        state.tuneMetrics = {
          requestedAt: Date.now(), preparedAt: 0, attachedAt: 0,
          firstFrameAt: 0, channelId: channel.id, src: 'session-tuner'
        };
        setPlayerStatus('Tuning — programming is starting…');
        tuneStableTunerChannel(channel.id, generation, false);
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
    var source = playbackSourceForNow(data, state.failedLiveUrl);
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
        if (source.tunerSessionId && previousNow && !previousNow.program) {
          ensureAttachedStableTunerPlayback('Programming is starting…');
        }
        if (!state.localPaused && !state.tuning) setPlayerStatus('Playing live');
        return true;
      }
      source.baseUrl = baseStreamUrl;
      source.url = source.tunerSessionId
        ? window.ToastTVPlaybackPolicy.withTunerRevision(
          baseStreamUrl,
          state.tuner && state.tuner.revision,
          ++state.attachAttempt
        )
        : tuneSessionUrl(baseStreamUrl);
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
    var live = source.mode === 'channel-hls';
    /* Direct play is a plain file, which MSE cannot take and hls.js cannot
       parse, so it keeps the native element and the slot handoff. */
    if (!live && state.hasCommittedVideo) detachVideoForTune();
    beginTuning(live ? 'Joining live channel…' : 'Loading ' + program.title + '…');
    state.pendingJoin = true;
    state.frameProbeAttempts = 0;
    state.hlsSeekPending = false;
    state.activeSource = source;
    state.playToken += 1;
    if (live) {
      if (!attachLiveSource(source.url)) handleMediaError();
    } else {
      detachLiveEngine();
      if (!window.ToastTVPlaybackPolicy.loadMediaElement(tuneVideo(), source.url)) handleMediaError();
    }
    if (state.tuneMetrics && !state.tuneMetrics.attachedAt) state.tuneMetrics.attachedAt = Date.now();
    /* Playback can fail without emitting canplay, waiting, or error. Start the
       bounded proof from attachment rather than relying on a media event. */
    if (live) stabilizeTuning();
  }

  function joinLive() {
    if (!state.pendingJoin || !state.currentNow || !state.currentNow.program || state.localPaused) return;
    state.pendingJoin = false;
    if (state.activeSource && state.activeSource.mode === 'channel-hls') {
      seekHlsLiveEdge(state.hardLiveEdgePending);
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

  function seekHlsLiveEdge(forceLiveEdge) {
    /* The engine keeps its own live sync through liveSyncDurationCount. Seeking
       the element underneath it fights that and can strand the playhead in a
       range the loader is about to discard. */
    if (liveEngineActive()) {
      state.hlsSeekPending = false;
      if (forceLiveEdge) state.hardLiveEdgePending = false;
      return true;
    }
    try {
      var video = tuneVideo();
      if (!video.seekable || video.seekable.length < 1) return false;
      var rangeIndex = video.seekable.length - 1;
      var edge = video.seekable.end(rangeIndex);
      if (!isFinite(edge) || !isFinite(video.currentTime)) return false;
      if (video.seeking) return false;
      var lag = edge - video.currentTime;
      if (forceLiveEdge || lag > LIVE_EDGE_TOLERANCE_SECONDS || lag < -1) {
        if (!state.hlsSeekPending) {
          var joinBehind = forceLiveEdge
            ? TUNER_SWITCH_JOIN_BEHIND_SECONDS
            : LIVE_JOIN_BEHIND_SECONDS;
          var rangeStart = video.seekable.start(rangeIndex);
          state.hlsSeekPending = true;
          video.currentTime = Math.max(
            isFinite(rangeStart) ? rangeStart : 0,
            edge - joinBehind
          );
          if (forceLiveEdge) state.hardLiveEdgePending = false;
        }
        return false;
      }
      state.hlsSeekPending = false;
      if (forceLiveEdge) state.hardLiveEdgePending = false;
      return true;
    } catch (ignore) { return false; }
  }

  function scheduleStableTunerMetadataSync(generation, sessionId, channelId) {
    window.setTimeout(function () {
      if (generation !== state.tuneGeneration || state.view !== 'player' ||
          state.requestedChannelId || !state.tuner || state.tuner.sessionId !== sessionId ||
          state.committedChannelId !== channelId) return;
      /* The tune response carries authoritative schedule data, while /now also
         decorates channel branding and playback fields. Refresh those details
         after commit without replacing the permanent tuner source. */
      syncNow(false);
    }, 80);
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
    /* With no picture yet the tuning card is the whole screen, and it already
       names the channel. Showing the dock underneath it stacks a second
       announcement over the first, filled with placeholders that visibly
       change to the real programme the moment a frame arrives. Hold it back
       so the commit can reveal it once, with the truth already in it. */
    if (state.hasCommittedVideo) showChrome();
    else hideChrome();
  }

  function stabilizeTuning() {
    if (state.tunerInPlaceSwitch) {
      probeInPlaceStableTunerHandoff(state.tunerInPlaceSwitch);
      return;
    }
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
        state.requestedChannelId ||
        !state.tuning
      ) return;
      /* The revisioned target-only manifest makes advancing playback the
         identity proof. A hard live-edge seek reduces latency when LG exposes a
         seekable range, but must remain best-effort on models that do not. */
      if (state.hardLiveEdgePending) seekHlsLiveEdge(true);
      if (state.hlsSeekPending || video.seeking) {
        state.frameProbeAttempts += 1;
        if (state.frameProbeAttempts >= TUNING_PROBE_LIMIT) {
          handleMediaError();
          return;
        }
        window.setTimeout(stabilizeTuning, TUNING_STABLE_MS);
        return;
      }
      if (!window.ToastTVPlaybackPolicy.isPlaybackStable(video)) {
        state.frameProbeAttempts += 1;
        setPlayerStatus('Tuning — waiting for the decoder…');
        if (state.frameProbeAttempts >= TUNING_PROBE_LIMIT) {
          handleMediaError();
          return;
        }
        window.setTimeout(stabilizeTuning, TUNING_STABLE_MS);
        return;
      }
      var headroom = playbackHeadroomSeconds(video);
      if ((Number(video.currentTime) || 0) <= sampledTime + 0.03 ||
          (headroom !== null && headroom < MIN_READY_BUFFER_SECONDS)) {
        state.frameProbeAttempts += 1;
        setPlayerStatus(headroom !== null && headroom < MIN_READY_BUFFER_SECONDS
          ? 'Tuning — building a stable live buffer…'
          : 'Tuning — waiting for the first frame…');
        if (state.frameProbeAttempts >= TUNING_PROBE_LIMIT) {
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
      state.hardLiveEdgePending = false;
      state.frameProbeAttempts = 0;
      video.muted = false;
      state.hasCommittedVideo = true;
      state.tunerNeedsRecovery = false;
      state.tunerDecoderRecoveryAttempts = 0;
      state.committedChannelId = currentChannel().id;
      state.tunerRollbackChannelId = null;
      state.candidateChannelId = null;
      state.previousTune = null;
      elements.playerScreen.classList.remove('is-tuning');
      elements.playerScreen.classList.add('has-video');
      clearTuningFreezeFrame();
      renderProgramInfo();
      // The dock waited for this; it now has a programme to announce.
      showChrome();
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
      scheduleGuidePrefetch(100);
      scheduleChromeHide();
      queuePresenceHeartbeat();
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

  function clearTuningTimer() {
    if (tuningTimer) window.clearTimeout(tuningTimer);
    tuningTimer = null;
  }

  function clearWarmHighlight() {
    if (warmHighlightTimer) window.clearTimeout(warmHighlightTimer);
    warmHighlightTimer = null;
  }

  /**
   * Starts the highlighted channel's encoder while the viewer is still
   * browsing, so the cold start happens behind their own navigation instead of
   * after they press OK. Entering this view has already stopped playback, so
   * moving the lineup lease here cannot disturb anything on screen.
   */
  function warmHighlightedChannel(index) {
    clearWarmHighlight();
    var channel = state.channels[index];
    if (!state.serverUrl || !channel || channel.enabled === false) return;
    if (channel.id === state.lineupPreferredChannelId) return;
    warmHighlightTimer = window.setTimeout(function () {
      warmHighlightTimer = null;
      /* Only warm what is still highlighted: the viewer may have moved on, or
         left the lineup entirely, during the settle delay. */
      if (state.view !== 'channels') return;
      var highlighted = state.channels[state.previewChannelIndex];
      if (!highlighted || highlighted.id !== channel.id ||
          highlighted.enabled === false) return;
      state.lineupDesiredChannelId = channel.id;
      flushLineupRetarget();
    }, WARM_HIGHLIGHT_DELAY_MS);
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
      { clientId: state.clientId, ownerId: state.sessionOwnerId, ownerEpoch: state.sessionOwnerEpoch, lastChannelId: channelId, lineup: true },
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
        if (!applied) return;
        /* Browsing continues the chain too. The highlight can move on while a
           retarget is in flight, and nothing else would resend the newer one. */
        if (state.view !== 'channels' &&
            (state.view !== 'player' || !state.hasCommittedVideo)) return;
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
    if (state.view !== 'player') return;
    if (state.tunerInPlaceSwitch && state.previousTune && state.tuner) {
      var restoreChannelId = state.tunerRollbackChannelId || state.previousTune.channelId;
      captureTuningFreezeFrame();
      clearInPlaceStableTunerProbe();
      rollbackAcceptedStableTunerTune(
        restoreChannelId,
        'The new channel did not cross cleanly. The previous channel is being restored.'
      );
      return;
    }
    var stableRestoreChannelId = state.previousTune &&
      (state.previousTune.tunerChannelId || state.tunerRollbackChannelId);
    if (state.tuning && state.previousTune && state.candidateChannelId &&
        stableRestoreChannelId && state.candidateChannelId !== stableRestoreChannelId &&
        state.tuner && state.activeSource &&
        state.activeSource.tunerSessionId === state.tuner.sessionId) {
      captureTuningFreezeFrame();
      clearInPlaceStableTunerProbe();
      rollbackAcceptedStableTunerTune(
        stableRestoreChannelId,
        'The switched channel could not start. The previous channel is being restored.'
      );
      return;
    }
    if (state.activeSource && state.activeSource.tunerSessionId &&
        (!state.currentNow || !state.currentNow.program)) {
      state.tunerNeedsRecovery = true;
      return;
    }
    if (!state.currentNow || !state.currentNow.program) return;
    if (state.tuning && !state.activeSource && liveRetryTimer) return;
    if (state.tuning && state.previousTune) {
      showPlaybackError(
        'The switched channel could not start',
        'ToastTV is returning to the previous channel.'
      );
      return;
    }
    if (state.activeSource && state.activeSource.tunerSessionId) {
      recoverStableTunerPlayback();
      return;
    }
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
      var generation = state.tuneGeneration;
      var video = activeVideo();
      var sourceUrl = state.activeSource.url;
      /* A live channel is not a resumable recording. Rejoin its current edge
         before play, then try again after native HLS has resumed manifest work. */
      state.hlsSeekPending = false;
      seekHlsLiveEdge();
      attemptPlay(++state.playToken);
      var rejoinAfterResume = function () {
        if (generation !== state.tuneGeneration || state.view !== 'player' ||
            state.localPaused || video !== activeVideo() || !state.activeSource ||
            state.activeSource.url !== sourceUrl) return;
        seekHlsLiveEdge();
      };
      window.setTimeout(rejoinAfterResume, 300);
      window.setTimeout(rejoinAfterResume, 900);
    } else {
      syncNow(true);
    }
  }

  function renderProgramInfo() {
    var data = state.currentNow;
    var channel = currentChannel();
    if (!data || !channel) return;
    /* Keep the complete identity and now-playing card on the committed station
       until the destination video clock advances. candidateChannelId also gates
       the first render after a stable-manifest reattach, so a target logo can
       never appear over the black tuning curtain before playback is proven. */
    if (state.tuning && (state.previousTune || state.candidateChannelId)) return;
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
    detachLiveEngine();
    window.ToastTVPlaybackPolicy.resetMediaElement(elements.videoA);
  }

  function showOffAir(nextProgram) {
    clearTuningFreezeFrame();
    var generation = state.tuneGeneration;
    var channel = currentChannel();
    var keepStableTuner = hasActiveStableTunerPlayback();
    state.pendingJoin = false;
    state.playToken += 1;
    if (keepStableTuner) {
      activeVideo().muted = true;
    } else {
      state.activeSource = null;
      resetAllVideos();
    }
    state.candidateChannelId = null;
    state.hardLiveEdgePending = false;
    state.hasCommittedVideo = keepStableTuner;
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
      retargetLineupSession(keepStableTuner && state.tuner ? state.tuner.channelId : channel.id, generation);
    }
    state.tuneMetrics = null;
    queuePresenceHeartbeat();
    scheduleGuidePrefetch(100);
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
    clearTuningFreezeFrame();
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
    openGuideForChannel(state.previewChannelIndex, 'channels');
  }

  function openGuideForChannel(index, returnView) {
    var channel = state.channels[index];
    if ((state.view !== 'player' && state.view !== 'channels') || !channel || !state.channels.length) return;
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
      returnView: returnView || state.view
    };
    elements.guideContext.textContent = state.view === 'player'
      ? 'Live TV guide · video keeps playing'
      : 'Live TV guide · select a program to tune live';
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

  function abortGuideRequestsExcept(cacheKey) {
    var keys = Object.keys(state.guideRequests);
    var index;
    for (index = 0; index < keys.length; index += 1) {
      var key = keys[index];
      if (cacheKey !== null && key === cacheKey) continue;
      var request = state.guideRequests[key];
      delete state.guideRequests[key];
      if (request && request.xhr && request.xhr.readyState !== 4) {
        try { request.xhr.abort(); } catch (ignore) {}
      }
    }
  }

  function guideDayCacheKey(channelId, fromMs) {
    return channelId + ':' + fromMs;
  }

  function getCachedGuideDay(channelId, fromMs) {
    var cacheKey = guideDayCacheKey(channelId, fromMs);
    var entry = state.guideCache[cacheKey];
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt >= GUIDE_CACHE_TTL_MS) {
      delete state.guideCache[cacheKey];
      return null;
    }
    return entry;
  }

  function cancelGuidePrefetch() {
    if (guidePrefetchTimer) window.clearTimeout(guidePrefetchTimer);
    guidePrefetchTimer = null;
    state.guidePrefetchQueue = [];
  }

  function scheduleGuidePrefetch(delayMs) {
    if (!state.serverUrl || !state.channels.length) return;
    if (guidePrefetchTimer) window.clearTimeout(guidePrefetchTimer);
    guidePrefetchTimer = null;
    state.guidePrefetchQueue = [];
    var fromMs = localCatalogDayStart(0).getTime();
    var preferred = currentChannel();
    var preferredId = preferred ? preferred.id : readStorage(STORAGE_CHANNEL);
    var queued = {};

    function queueChannel(channel) {
      if (!channel || channel.enabled === false || queued[channel.id]) return;
      var cacheKey = guideDayCacheKey(channel.id, fromMs);
      queued[channel.id] = true;
      if (getCachedGuideDay(channel.id, fromMs) || state.guideRequests[cacheKey]) return;
      state.guidePrefetchQueue.push({
        channelId: channel.id,
        fromMs: fromMs,
        serverUrl: state.serverUrl
      });
    }

    var preferredIndex = findChannelIndex(preferredId);
    if (preferredIndex >= 0) queueChannel(state.channels[preferredIndex]);
    var index;
    for (index = 0; index < state.channels.length; index += 1) queueChannel(state.channels[index]);
    if (!state.guidePrefetchQueue.length) return;
    guidePrefetchTimer = window.setTimeout(runGuidePrefetch, Math.max(0, Number(delayMs) || 0));
  }

  function runGuidePrefetch() {
    guidePrefetchTimer = null;
    if (!state.serverUrl || !state.guidePrefetchQueue.length) return;
    if (state.overlay === 'guide' || Object.keys(state.guideRequests).length) {
      guidePrefetchTimer = window.setTimeout(runGuidePrefetch, GUIDE_PREFETCH_STAGGER_MS);
      return;
    }
    var next = null;
    while (state.guidePrefetchQueue.length && !next) {
      var candidate = state.guidePrefetchQueue.shift();
      var channelIndex = findChannelIndex(candidate.channelId);
      if (candidate.serverUrl === state.serverUrl && channelIndex >= 0 &&
          state.channels[channelIndex].enabled !== false &&
          !getCachedGuideDay(candidate.channelId, candidate.fromMs)) {
        next = candidate;
      }
    }
    if (!next) return;
    requestGuideDay(next.channelId, next.fromMs);
    if (state.guidePrefetchQueue.length) {
      guidePrefetchTimer = window.setTimeout(runGuidePrefetch, GUIDE_PREFETCH_STAGGER_MS);
    }
  }

  function requestGuideDay(channelId, fromMs) {
    var cacheKey = guideDayCacheKey(channelId, fromMs);
    if (getCachedGuideDay(channelId, fromMs) || state.guideRequests[cacheKey]) return;
    var serverAtStart = state.serverUrl;
    var requestRecord = { xhr: null };
    state.guideRequests[cacheKey] = requestRecord;
    requestRecord.xhr = requestJson(
      serverAtStart + '/api/v1/channels/' + encodeURIComponent(channelId) +
        '/guide?hours=24&from=' + fromMs,
      15000,
      function (error, data) {
        if (state.guideRequests[cacheKey] !== requestRecord) return;
        delete state.guideRequests[cacheKey];
        var isSelected = state.overlay === 'guide' && state.catalog &&
          state.catalog.channelId === channelId &&
          catalogDayStart(state.catalog.dayIndex).getTime() === fromMs;
        if (state.serverUrl !== serverAtStart || error || !data ||
            data.channelId !== channelId || !isArray(data.programs)) {
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
        var previewChannel = state.channels[state.previewChannelIndex];
        if (state.view === 'channels' && previewChannel && previewChannel.id === channelId &&
            (fromMs === localCatalogDayStart(0).getTime() ||
             fromMs === localCatalogDayStart(1).getTime())) {
          renderChannelPreview(state.previewChannelIndex);
        }
        if (isSelected) {
          state.catalog.dayStarts = entry.dayStarts;
          updateCatalogDayLabels();
          renderCatalogWeekDay(entry);
        }
      }
    );
  }

  function loadCatalogDay() {
    var catalog = state.catalog;
    if (!catalog) return;
    var dayIndex = catalog.dayIndex;
    var fromMs = catalogDayStart(dayIndex).getTime();
    var cacheKey = guideDayCacheKey(catalog.channelId, fromMs);
    abortGuideRequestsExcept(cacheKey);
    var cached = getCachedGuideDay(catalog.channelId, fromMs);
    if (cached) {
      catalog.dayStarts = cached.dayStarts;
      updateCatalogDayLabels();
      renderCatalogWeekDay(cached);
      return;
    }
    if (state.guideRequests[cacheKey]) {
      clearChildren(elements.guideList);
      elements.guideMessage.textContent = 'Loading the selected day…';
      return;
    }
    clearChildren(elements.guideList);
    elements.guideMessage.textContent = 'Loading the selected day…';
    requestGuideDay(catalog.channelId, fromMs);
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
      details.className = 'guide-item__body';
      var title = document.createElement('h3');
      title.className = 'guide-item__title';
      title.textContent = program.title;
      var collection = document.createElement('p');
      collection.className = 'guide-item__meta';
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
    if (!state.catalog || (state.view !== 'player' && state.view !== 'channels')) return;
    var returnView = state.catalog.returnView || state.view;
    var targetIndex = findChannelIndex(channelId);
    var active = displayedChannel();
    var sameChannel = returnView === 'player' && active && active.id === channelId &&
      state.committedChannelId === channelId && !state.tuning;
    closeOverlays();
    if (sameChannel) {
      showChrome();
    } else if (targetIndex >= 0) {
      tuneChannel(targetIndex, returnView === 'channels');
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
    if (guideScrollFrame && window.cancelAnimationFrame) window.cancelAnimationFrame(guideScrollFrame);
    if (catalogRailScrollFrame && window.cancelAnimationFrame) window.cancelAnimationFrame(catalogRailScrollFrame);
    guideScrollFrame = null;
    catalogRailScrollFrame = null;
    abortGuideRequestsExcept(null);
    state.overlay = null;
    state.catalog = null;
    renderOverlayState();
    scheduleGuidePrefetch(GUIDE_PREFETCH_STAGGER_MS);
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
    if (view !== 'channels') clearWarmHighlight();
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
      var guideReturnChannelId = state.catalog && state.catalog.channelId;
      var guideReturnView = state.catalog && state.catalog.returnView;
      closeOverlays();
      if (state.view === 'player') showChrome();
      else if (guideReturnView === 'channels' && guideReturnChannelId) {
        var returnIndex = findChannelIndex(guideReturnChannelId);
        if (returnIndex >= 0) selectChannelPreview(returnIndex);
        window.setTimeout(function () {
          var returnCard = elements.channelGrid.querySelector(
            '[data-channel-id="' + escapeAttribute(guideReturnChannelId) + '"]'
          );
          if (returnCard) focusNode(returnCard);
          else focusFirst();
        }, 40);
      } else window.setTimeout(focusFirst, 40);
      return;
    }
    if (cancelPendingChannelChange()) return;
    if (state.view === 'player' || (state.view === 'setup' && state.setupFromChannels)) {
      openChannelBrowser();
      return;
    }
    if (state.view === 'setup') cancelConnectionAttempt();
    exitApplication();
  }

  function exitApplication() {
    try {
      if (window.webOS && typeof window.webOS.platformBack === 'function') {
        window.webOS.platformBack();
        return;
      }
    } catch (ignorePlatformBack) {}
    try { window.close(); } catch (ignoreClose) {}
  }

  function cancelPendingChannelChange() {
    if ((state.view !== 'player' && state.view !== 'channels') ||
        (!state.requestedChannelId && !state.candidateChannelId && !state.previousTune)) return false;
    var stayInBrowser = state.view === 'channels';
    var restoreStableTuner = hasAttachedStableTunerSource() &&
      !!(state.requestedChannelId || (state.previousTune && state.previousTune.tunerChannelId));
    clearInPlaceStableTunerProbe();
    state.tuneGeneration += 1;
    if (zapTimer) window.clearTimeout(zapTimer);
    zapTimer = null;
    state.requestedChannelId = null;
    state.requestedChannelIndex = null;
    state.tuneMetrics = null;
    if (restoreStableTuner) {
      var restoreGeneration = state.tuneGeneration;
      setPlayerStatus('Returning to the previous channel…');
      restoreStableTunerThenRollback(restoreGeneration, function (restored, restoredTuner) {
        if (restoreGeneration !== state.tuneGeneration) return;
        if (stayInBrowser) {
          showToast('Guide opening cancelled.');
          return;
        }
        updateChannelOsdProgram(restoredTuner ? 'Restoring previous channel…' : 'Switch cancelled');
        if (!restoredTuner) scheduleChannelOsdHide();
        showChrome();
      });
      return true;
    }
    rollbackCandidateTune();
    if (stayInBrowser) {
      showToast('Guide opening cancelled.');
      return true;
    }
    updateChannelOsdProgram('Switch cancelled');
    scheduleChannelOsdHide();
    showChrome();
    return true;
  }

  function openChannelBrowser() {
    var returnThroughHistory = (state.view === 'player' && state.playerEnteredFromChannels) ||
      (state.view === 'setup' && state.setupFromChannels);
    function finishOpenChannelBrowser() {
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
    if (state.view === 'setup') cancelConnectionAttempt();
    state.setupFromChannels = false;
    var restoreStableTuner = hasAttachedStableTunerSource() &&
      !!(state.requestedChannelId || (state.previousTune && state.previousTune.tunerChannelId));
    if (state.view === 'boot') cancelStartupWork();
    else {
      clearInPlaceStableTunerProbe();
      state.tuneGeneration += 1;
    }
    state.requestedChannelId = null;
    state.requestedChannelIndex = null;
    if (restoreStableTuner) {
      var restoreGeneration = state.tuneGeneration;
      setPlayerStatus('Returning to the previous channel…');
      restoreStableTunerThenRollback(restoreGeneration, function () {
        if (restoreGeneration !== state.tuneGeneration) return;
        finishOpenChannelBrowser();
      });
      return;
    }
    rollbackCandidateTune();
    finishOpenChannelBrowser();
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
      if (event.repeat) return;
      goBack();
      return;
    }
    if (state.view === 'channels' && !state.overlay && (code === 37 || code === 39)) {
      var channelFocus = closestFocusable(document.activeElement);
      if (code === 39 && channelFocus && elements.channelGrid.contains(channelFocus)) {
        event.preventDefault();
        focusNode(elements.channelGuideButton);
        return;
      }
      if (code === 37 && channelFocus === elements.channelGuideButton) {
        event.preventDefault();
        var previewCard = elements.channelGrid.querySelector(
          '[data-channel-index="' + state.previewChannelIndex + '"]'
        );
        if (previewCard) focusNode(previewCard);
        return;
      }
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
        elements.playbackError.classList.contains('hidden')) {
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
    var guideStart = elements.guideList.contains(node) ? elements.guideList.scrollTop : null;
    var railStart = elements.catalogRail.contains(node) ? elements.catalogRail.scrollLeft : null;
    var focused = document.querySelectorAll('.is-focused');
    var index;
    for (index = 0; index < focused.length; index += 1) focused[index].classList.remove('is-focused');
    node.classList.add('is-focused');
    try { node.focus(); } catch (ignore) {}
    if (guideStart !== null) elements.guideList.scrollTop = guideStart;
    if (railStart !== null) elements.catalogRail.scrollLeft = railStart;
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
      if (top < elements.guideList.scrollTop) animateGuideScroll(elements.guideList, top, false);
      else if (bottom > elements.guideList.scrollTop + elements.guideList.clientHeight) {
        animateGuideScroll(elements.guideList, bottom - elements.guideList.clientHeight, false);
      }
    }
    /* The channel rail is a horizontal row, so it is measured across rather
       than down. Reading offsetTop here meant every chip reported the same
       position, no condition ever fired, and the rail never moved -- which
       left every channel past the screen edge unreachable. */
    if (elements.catalogRail.contains(node)) {
      var railLeft = node.offsetLeft;
      var railRight = railLeft + node.offsetWidth;
      if (railLeft < elements.catalogRail.scrollLeft) {
        animateGuideScroll(elements.catalogRail, railLeft, true);
      } else if (railRight > elements.catalogRail.scrollLeft + elements.catalogRail.clientWidth) {
        animateGuideScroll(elements.catalogRail, railRight - elements.catalogRail.clientWidth, true);
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

  /** `isRail` selects the horizontal axis; everything else scrolls down. */
  function animateGuideScroll(container, target, isRail) {
    if (!container) return;
    var maximum = isRail
      ? Math.max(0, container.scrollWidth - container.clientWidth)
      : Math.max(0, container.scrollHeight - container.clientHeight);
    var destination = Math.max(0, Math.min(maximum, target));
    var start = isRail ? container.scrollLeft : container.scrollTop;
    var distance = destination - start;
    var activeFrame = isRail ? catalogRailScrollFrame : guideScrollFrame;
    if (activeFrame && window.cancelAnimationFrame) window.cancelAnimationFrame(activeFrame);
    if (!window.requestAnimationFrame || Math.abs(distance) < 2) {
      if (isRail) container.scrollLeft = destination;
      else container.scrollTop = destination;
      return;
    }
    var startedAt = null;
    function step(timestamp) {
      if (startedAt === null) startedAt = timestamp;
      var progress = Math.min(1, (timestamp - startedAt) / 150);
      var eased = 1 - Math.pow(1 - progress, 3);
      var position = Math.round(start + distance * eased);
      if (isRail) container.scrollLeft = position;
      else container.scrollTop = position;
      if (progress < 1) {
        var frame = window.requestAnimationFrame(step);
        if (isRail) catalogRailScrollFrame = frame;
        else guideScrollFrame = frame;
      } else if (isRail) catalogRailScrollFrame = null;
      else guideScrollFrame = null;
    }
    var frame = window.requestAnimationFrame(step);
    if (isRail) catalogRailScrollFrame = frame;
    else guideScrollFrame = frame;
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

  function reproveStableTunerAfterPrepare(video, generation, recoverySerial) {
    if (generation !== state.tuneGeneration || recoverySerial !== bufferingRecoverySerial ||
        video !== activeVideo() || state.view !== 'player' || state.localPaused ||
        !state.activeSource || !state.activeSource.tunerSessionId) return;
    seekHlsLiveEdge();
    var sampledTime = Number(video.currentTime) || 0;
    attemptPlay(++state.playToken);
    window.setTimeout(function () {
      if (generation !== state.tuneGeneration || recoverySerial !== bufferingRecoverySerial ||
          video !== activeVideo() || state.view !== 'player' || state.localPaused ||
          !state.activeSource || !state.activeSource.tunerSessionId) return;
      if ((Number(video.currentTime) || 0) > sampledTime + 0.25) {
        state.bufferingPrepareFailures = 0;
        clearBufferingTimers();
        setPlayerStatus('Playing live');
        return;
      }
      state.bufferingPrepareFailures += 1;
      if (state.bufferingPrepareFailures >= 2) {
        retryLiveStream('Rebuilding the live signal…');
        return;
      }
      setPlayerStatus('Buffering — retrying the live signal…');
      scheduleBufferingRecovery(video);
    }, BUFFERING_REPROVE_MS);
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
        }, recoveryStillNeeded, function (generation) {
          reproveStableTunerAfterPrepare(video, generation, recoverySerial);
        });
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
    /* Resetting the element underneath an attached MediaSource strands the
       engine on a source it no longer owns. Tear it down so the next attach
       builds a clean one. */
    detachLiveEngine();
    captureTuningFreezeFrame();
    state.pendingJoin = false;
    state.playToken += 1;
    /* Release the outgoing decoder before re-attaching. Muting alone leaves
       LG's pipeline running and draining the previous channel's audio under the
       tuning backdrop. */
    activeVideo().muted = true;
    window.ToastTVPlaybackPolicy.resetMediaElement(activeVideo());
    state.hasCommittedVideo = false;
    elements.playerScreen.classList.remove('has-video');
    elements.playerBackdrop.classList.remove('hidden');
  }

  function abandonCandidateTune() {
    /* A rapid replacement zap reuses the last outgoing freeze frame. Clearing
       it here would flash the branded startup backdrop between key presses. */
    clearTuningTimer();
    clearLiveRetryTimer();
    clearBufferingTimers();
    state.requestSerial += 1;
    state.pendingJoin = false;
    state.failedLiveUrl = null;
    state.hardLiveEdgePending = false;
    state.activeSource = null;
    state.programId = null;
    state.currentNow = null;
    state.candidateChannelId = null;
  }

  function rollbackCandidateTune(restoredTuner) {
    clearInPlaceStableTunerProbe();
    if (!state.previousTune) {
      clearTuningFreezeFrame();
      return state.hasCommittedVideo;
    }
    clearTuningTimer();
    clearLiveRetryTimer();
    state.candidateChannelId = null;
    state.tuning = false;
    state.pendingJoin = false;
    state.hardLiveEdgePending = false;
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
      clearTuningFreezeFrame();
      hideChannelLogo();
      queuePresenceHeartbeat();
      scheduleChannelOsdHide();
      return false;
    }
    if (restoredTuner && state.previousTune.currentNow &&
        state.previousTune.currentNow.program) {
      var restoredNow = state.previousTune.currentNow;
      state.channelIndex = previousIndex;
      state.committedChannelId = state.previousTune.channelId;
      state.currentNow = restoredNow;
      state.programId = state.previousTune.programId;
      state.activeSource = state.previousTune.activeSource;
      state.candidateChannelId = state.previousTune.channelId;
      state.tuning = true;
      state.hasCommittedVideo = false;
      state.hlsSeekPending = false;
      state.hardLiveEdgePending = true;
      activeVideo().muted = true;
      elements.playerScreen.classList.remove('has-video');
      beginTuning('Returning to the previous channel…');
      applyNowResult(restoredNow, null, true);
      queuePresenceHeartbeat();
      return true;
    }
    state.channelIndex = previousIndex;
    state.committedChannelId = state.previousTune.channelId;
    state.currentNow = state.previousTune.currentNow;
    state.programId = state.previousTune.programId;
    state.activeSource = state.previousTune.activeSource;
    state.previousTune = null;
    if (state.hasCommittedVideo) clearTuningFreezeFrame();
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
    if (state.activeSource && state.activeSource.tunerSessionId) {
      recoverStableTunerPlayback();
      return;
    }
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
    clearTuningFreezeFrame();
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
    state.hardLiveEdgePending = false;
    state.liveRetryAttempt = 0;
    state.candidateChannelId = null;
    state.hasCommittedVideo = false;
    state.tunerNeedsRecovery = false;
    state.committedChannelId = null;
    state.tunerRollbackChannelId = null;
    state.previousTune = null;
    clearStableTunerRetry();
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
    if (metrics.src === 'session-tuner-off-air') {
      var switchAcceptedMs = metrics.preparedAt ? metrics.preparedAt - metrics.requestedAt : 0;
      var metadataReadyMs = metrics.metadataAt ? metrics.metadataAt - metrics.requestedAt : 0;
      try {
        console.log('[ToastTV Tune] channel=' + metrics.channelId + ' src=' + metrics.src +
          ' switchAcceptedMs=' + switchAcceptedMs + ' metadataReadyMs=' + metadataReadyMs +
          ' stableSource=true sourceReloaded=false');
      } catch (ignoreTunerLog) {}
      return;
    }
    var prepareMs = metrics.preparedAt ? metrics.preparedAt - metrics.requestedAt : 0;
    var attachMs = metrics.attachedAt ? metrics.attachedAt - metrics.requestedAt : 0;
    var frameAfterAttachMs = metrics.firstFrameAt && metrics.attachedAt
      ? metrics.firstFrameAt - metrics.attachedAt : 0;
    var firstFrameMs = metrics.firstFrameAt - metrics.requestedAt;
    try {
      console.log('[ToastTV Tune] channel=' + metrics.channelId + ' src=' + (metrics.src || '?') +
        ' prepareMs=' + prepareMs + ' attachMs=' + attachMs +
        ' frameAfterAttachMs=' + frameAfterAttachMs + ' firstFrameMs=' + firstFrameMs +
        (metrics.src === 'session-tuner'
          ? ' stableSource=true sourceReloaded=true'
          : ''));
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
      if (state.channels[candidate].enabled !== false) return candidate;
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

  function createSessionOwnerId() {
    var randomPart = '';
    try {
      if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        var values = new Uint32Array(2);
        window.crypto.getRandomValues(values);
        randomPart = values[0].toString(36) + values[1].toString(36);
      }
    } catch (ignore) {}
    if (!randomPart) randomPart = Math.floor(Math.random() * 0x100000000).toString(36);
    return 'launch-' + Date.now().toString(36) + '-' + randomPart;
  }

  function nextSessionOwnerEpoch() {
    var stored = Number(readStorage(STORAGE_SESSION_OWNER_EPOCH));
    var previous = isFinite(stored) && stored >= 0 && Math.floor(stored) === stored
      ? stored
      : -1;
    return Math.max(Date.now(), previous + 1);
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
