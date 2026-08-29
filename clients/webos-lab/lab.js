/* ToastTV Lab — an isolated MSE playback probe.
 *
 * Answers three questions the production client cannot, because native HLS
 * owns its buffer and will not give it back:
 *   1. Does hls.js play the existing MPEG-TS tuner stream on this webOS build?
 *   2. Can we hold the forward buffer to a chosen depth?
 *   3. Does flushing the forward buffer on a channel change beat the measured
 *      3110 ms decoder re-attach the production client settles for?
 *
 * Nothing here talks to the production app. It opens its own tuner session
 * under a distinct client id and closes it on unload.
 */
(function () {
  'use strict';

  var SERVER = 'http://TOWER:1993';
  var CLIENT_ID = 'toasttv-lab-probe';
  var OWNER_ID = 'toasttv-lab-owner';

  /* The whole point of the probe: keep the TV's forward buffer shallow so a
     flush has little to discard and the refill is short. */
  var HLS_CONFIG = {
    maxBufferLength: 4,
    maxMaxBufferLength: 8,
    backBufferLength: 8,
    liveSyncDurationCount: 2,
    liveMaxLatencyDurationCount: 5,
    lowLatencyMode: false,
    enableWorker: true,
    debug: false
  };

  var video = document.getElementById('v');
  var hudEl = document.getElementById('hud');
  var logEl = document.getElementById('log');
  var lines = [];

  function log(message) {
    var stamp = new Date().toISOString().slice(11, 23);
    lines.unshift(stamp + '  ' + message);
    if (lines.length > 12) lines.pop();
    logEl.innerHTML = lines.join('<br>');
    try { console.log('[Lab] ' + message); } catch (ignore) {}
  }

  function request(method, path, body, done) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, SERVER + path, true);
    xhr.timeout = 15000;
    if (body) xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function () {
      var parsed = null;
      try { parsed = JSON.parse(xhr.responseText); } catch (ignore) {}
      done(xhr.status >= 200 && xhr.status < 300 ? null : new Error('HTTP ' + xhr.status), parsed);
    };
    xhr.onerror = function () { done(new Error('network'), null); };
    xhr.ontimeout = function () { done(new Error('timeout'), null); };
    xhr.send(body ? JSON.stringify(body) : null);
  }

  var state = {
    tuner: null,
    requestId: 0,
    channels: [],
    channelIndex: 0,
    hls: null,
    switching: null,
    results: []
  };

  function bufferAhead() {
    try {
      var b = video.buffered;
      if (!b || !b.length) return null;
      var t = video.currentTime;
      for (var i = b.length - 1; i >= 0; i -= 1) {
        if (b.start(i) <= t && b.end(i) >= t) return b.end(i) - t;
      }
      return b.end(b.length - 1) - t;
    } catch (ignore) { return null; }
  }

  function bufferRanges() {
    var out = [];
    try {
      for (var i = 0; i < video.buffered.length; i += 1) {
        out.push(video.buffered.start(i).toFixed(1) + '-' + video.buffered.end(i).toFixed(1));
      }
    } catch (ignore) {}
    return out.join(' ');
  }

  function hud() {
    var ahead = bufferAhead();
    var last = state.results.length ? state.results[state.results.length - 1] : null;
    var rows = [
      '<b>ToastTV Lab</b> — hls.js ' + (window.Hls ? Hls.version : '?') + '  ·  MSE ' + (window.MediaSource ? 'yes' : 'no'),
      'channel   ' + (state.tuner ? state.tuner.channelId : '—') + '   (' + (state.channelIndex + 1) + '/' + state.channels.length + ')',
      'time      ' + video.currentTime.toFixed(2) + '   readyState ' + video.readyState + (video.paused ? '  <span class="bad">PAUSED</span>' : ''),
      'ahead     ' + (ahead === null ? '—' : ahead.toFixed(2) + 's') + '   target ' + HLS_CONFIG.maxBufferLength + 's',
      'ranges    ' + bufferRanges(),
      'switching ' + (state.switching ? '<span class="warn">' + state.switching.to + ' (' + (Date.now() - state.switching.startedAt) + 'ms)</span>' : 'idle')
    ];
    if (last) {
      rows.push('last      <span class="' + (last.ms < 3110 ? 'ok' : 'bad') + '">' + last.to + '  ' + last.ms + 'ms</span>   (baseline 3110ms)');
    }
    if (state.results.length > 1) {
      var total = 0;
      for (var i = 0; i < state.results.length; i += 1) total += state.results[i].ms;
      rows.push('mean      ' + Math.round(total / state.results.length) + 'ms over ' + state.results.length + ' switches');
    }
    hudEl.innerHTML = rows.join('<br>');
  }
  window.setInterval(hud, 100);

  /* Flush everything ahead of the playhead. This is the capability native HLS
     does not expose and the entire reason for the prototype. */
  function flushForward() {
    var from = video.currentTime + 0.05;
    var before = bufferAhead();
    try {
      state.hls.trigger(Hls.Events.BUFFER_FLUSHING, {
        startOffset: from,
        endOffset: Infinity,
        type: null
      });
      return { issued: true, before: before };
    } catch (error) {
      log('flush FAILED: ' + error.message);
      return { issued: false, before: before, error: error.message };
    }
  }

  function switchTo(channelId) {
    if (!state.tuner || state.switching) return false;
    state.requestId += 1;
    var started = Date.now();
    var startTime = video.currentTime;
    state.switching = { to: channelId, startedAt: started };
    log('switch -> ' + channelId + ' (ahead ' + (bufferAhead() || 0).toFixed(2) + 's)');

    request('POST', '/api/client/v1/session/tune', {
      clientId: CLIENT_ID,
      ownerId: OWNER_ID,
      ownerEpoch: 0,
      sessionId: state.tuner.sessionId,
      channelId: channelId,
      requestId: state.requestId
    }, function (error, data) {
      var acceptedAt = Date.now();
      if (error || !data || data.status !== 'ready') {
        log('tune REJECTED: ' + (data && data.error ? data.error : error && error.message));
        state.switching = null;
        return;
      }
      var mode = data.tuner && data.tuner.switchBoundary ? data.tuner.switchBoundary.transportMode : '?';
      var fragAtSwitch = state.lastFrag;
      var timeAtSwitch = video.currentTime;
      var flushed = flushForward();
      log('accepted in ' + (acceptedAt - started) + 'ms mode=' + mode +
          ' flush=' + (flushed.issued ? 'issued' : 'failed') +
          ' discarded=' + (flushed.before === null ? '?' : flushed.before.toFixed(2) + 's'));

      /* The new channel is on screen once playback has moved past where we cut
         and the buffer has refilled enough to sustain it. */
      var deadline = started + 15000;
      var poll = window.setInterval(function () {
        var ahead = bufferAhead();
        var advanced = video.currentTime > startTime + 0.1;
        if (advanced && ahead !== null && ahead >= 1 && video.readyState >= 3 && !video.paused) {
          window.clearInterval(poll);
          var ms = Date.now() - started;
          state.results.push({
            to: channelId, ms: ms, mode: mode,
            fragBefore: fragAtSwitch, fragAfter: state.lastFrag,
            timeBefore: Number(timeAtSwitch.toFixed(2)),
            timeAfter: Number(video.currentTime.toFixed(2))
          });
          state.switching = null;
          log('DONE ' + channelId + ' in ' + ms + 'ms  (baseline 3110ms)');
        } else if (Date.now() > deadline) {
          window.clearInterval(poll);
          state.switching = null;
          log('TIMEOUT switching to ' + channelId);
        }
      }, 50);
    });
    return true;
  }

  function nextChannel() {
    if (!state.channels.length) return false;
    state.channelIndex = (state.channelIndex + 1) % state.channels.length;
    return switchTo(state.channels[state.channelIndex].id);
  }

  function start() {
    if (!window.Hls || !Hls.isSupported()) {
      log('hls.js NOT SUPPORTED on this device');
      hudEl.innerHTML = '<span class="bad">hls.js unsupported</span>';
      return;
    }
    log('hls.js ' + Hls.version + ' supported');

    request('GET', '/api/v1/channels', null, function (error, data) {
      if (error || !data || !data.channels || !data.channels.length) {
        log('channel list failed');
        return;
      }
      state.channels = data.channels;
      log('lineup: ' + data.channels.length + ' channels');

      request('POST', '/api/client/v1/session', {
        clientId: CLIENT_ID,
        ownerId: OWNER_ID,
        ownerEpoch: 0,
        lastChannelId: data.channels[0].id,
        lineup: true,
        tuner: true
      }, function (sessionError, sessionData) {
        if (sessionError || !sessionData || !sessionData.tuner) {
          log('tuner open failed: ' + (sessionData && sessionData.error ? sessionData.error : sessionError && sessionError.message));
          return;
        }
        state.tuner = sessionData.tuner;
        state.requestId = (sessionData.tuner.requestIdFloor || -1);
        state.channelIndex = 0;
        for (var i = 0; i < state.channels.length; i += 1) {
          if (state.channels[i].id === state.tuner.channelId) state.channelIndex = i;
        }
        log('session ' + state.tuner.sessionId.slice(0, 8) + ' on ' + state.tuner.channelId);

        var hls = new Hls(HLS_CONFIG);
        state.hls = hls;
        hls.on(Hls.Events.ERROR, function (evt, payload) {
          log('hls ' + (payload.fatal ? 'FATAL ' : '') + payload.type + '/' + payload.details);
          if (payload.fatal) {
            if (payload.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
            else if (payload.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          }
        });
        hls.on(Hls.Events.MANIFEST_PARSED, function () { log('manifest parsed'); video.play(); });
        /* Fragment sequence numbers are the only unambiguous proof that a
           switch reached new media rather than replaying what was already
           advertised: the tuner keeps outgoing entries in the window. */
        hls.on(Hls.Events.FRAG_CHANGED, function (evt, payload) {
          state.lastFrag = payload.frag.sn;
          if (state.switching) {
            log('  frag sn=' + payload.frag.sn + ' start=' + payload.frag.start.toFixed(2) +
                ' t=' + video.currentTime.toFixed(2));
          }
        });
        hls.loadSource(SERVER + state.tuner.manifestUrl);
        hls.attachMedia(video);
      });
    });
  }

  document.addEventListener('keydown', function (event) {
    var code = event.keyCode || event.which;
    if (code === 33 || code === 427 || code === 38) { event.preventDefault(); nextChannel(); }
  });

  window.addEventListener('unload', function () {
    if (!state.tuner) return;
    try {
      navigator.sendBeacon(SERVER + '/api/client/v1/session/close', JSON.stringify({
        clientId: CLIENT_ID, ownerId: OWNER_ID, ownerEpoch: 0, sessionId: state.tuner.sessionId
      }));
    } catch (ignore) {}
  });

  /* Driven over CDP by the measurement rig. */
  window.lab = {
    next: nextChannel,
    switchTo: switchTo,
    flush: flushForward,
    stats: function () {
      return {
        hls: window.Hls ? Hls.version : null,
        channel: state.tuner ? state.tuner.channelId : null,
        time: Number(video.currentTime.toFixed(2)),
        readyState: video.readyState,
        paused: video.paused,
        ahead: bufferAhead(),
        ranges: bufferRanges(),
        switching: state.switching ? state.switching.to : null,
        results: state.results
      };
    }
  };

  start();
})();
