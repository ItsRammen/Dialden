(function (root, factory) {
  'use strict';
  var policy = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = policy;
  root.ToastTVPlaybackPolicy = policy;
}(this, function () {
  'use strict';

  function resolveUrl(value, serverUrl) {
    if (typeof value !== 'string') return null;
    if (value.charAt(0) === '/' && value.charAt(1) !== '/') return serverUrl + value;
    if (/^https?:\/\//i.test(value)) return value;
    return null;
  }

  function liveDescriptor(nowResult) {
    var descriptor = nowResult && (nowResult.liveStream || nowResult.playback);
    if (!descriptor || descriptor.mode !== 'hls' || typeof descriptor.url !== 'string') return null;
    return descriptor;
  }

  function appendClientId(url, clientId) {
    if (!url || !clientId) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'clientId=' + encodeURIComponent(clientId);
  }

  function withTunerRevision(url, revision, attachAttempt) {
    var value = Number(revision);
    if (!url || !isFinite(value) || value < 1 || Math.floor(value) !== value) return url;
    var attach = Number(attachAttempt);
    var suffix = 'tunerRevision=' + encodeURIComponent(String(value));
    if (isFinite(attach) && attach >= 1 && Math.floor(attach) === attach) {
      suffix += '&tunerAttach=' + encodeURIComponent(String(attach));
    }
    return url + (url.indexOf('?') === -1 ? '?' : '&') + suffix;
  }

  function choose(nowResult, serverUrl, failedLiveUrl, clientId) {
    var live = liveDescriptor(nowResult);
    var liveUrl = live ? resolveUrl(live.url, serverUrl) : null;
    liveUrl = appendClientId(liveUrl, clientId);
    /* A server-advertised live stream is already normalized for the TV. Never
       leak back to the original MKV merely because the HLS worker is warming. */
    if (liveUrl) {
      return { mode: 'channel-hls', url: liveUrl, seekToProgramOffset: false };
    }

    var direct = nowResult && nowResult.program && nowResult.program.playback;
    var directUrl = direct && direct.mode === 'direct' ? resolveUrl(direct.url, serverUrl) : null;
    if (directUrl) {
      return { mode: 'direct', url: directUrl, seekToProgramOffset: true };
    }
    return null;
  }

  function shouldReload(activeSource, nextSource) {
    if (!activeSource || !nextSource) return true;
    return activeSource.mode !== nextSource.mode || activeSource.url !== nextSource.url;
  }

  function resetMediaElement(video) {
    if (!video) return;
    try { video.muted = true; } catch (ignoreMuted) {}
    try { video.pause(); } catch (ignorePause) {}
    try { video.removeAttribute('src'); } catch (ignoreSource) {}
    try { video.load(); } catch (ignoreLoad) {}
  }

  function loadMediaElement(video, url) {
    if (!video || !url) return false;
    resetMediaElement(video);
    try {
      video.src = url;
      video.load();
      return true;
    } catch (ignoreLoad) {
      return false;
    }
  }

  function isPlaybackStable(video) {
    return !!video && video.paused === false && Number(video.readyState || 0) >= 3;
  }

  function expectedDirectPosition(program, elapsedSinceResponseMs) {
    if (!program) return 0;
    var playback = program.playback || {};
    var sourceOrigin = Number(playback.sourceOffsetAtPlaybackZeroMs || 0);
    return Math.max(0, (Number(program.offsetMs || 0) + elapsedSinceResponseMs - sourceOrigin) / 1000);
  }

  function nextTunerRequestId(current, requestIdFloor) {
    var currentValue = Number(current);
    var floorValue = Number(requestIdFloor);
    if (!isFinite(currentValue) || currentValue < -1) currentValue = -1;
    if (!isFinite(floorValue) || floorValue < -1) floorValue = -1;
    return Math.floor(Math.max(currentValue, floorValue)) + 1;
  }

  function canAdoptTuner(tunerChannelId, nowChannelId, attached, hasCommittedVideo, candidateChannelId, requestedChannelId) {
    if (typeof tunerChannelId !== 'string' || tunerChannelId !== nowChannelId) return false;
    return attached === true || hasCommittedVideo !== true ||
      candidateChannelId === nowChannelId || requestedChannelId === nowChannelId;
  }

  // Events such as playing/canplay do not prove that playback is advancing.
  // Sample independently, including decoded frames where the TV exposes them.
  function createProgressWatchdog(timeoutMs) {
    var key = null, time = 0, frames = null, progressedAt = 0, framesAt = 0, framesReliable = false;
    return function (sample) {
      if (!sample.enabled || key !== sample.key) {
        key = sample.enabled ? sample.key : null;
        time = sample.time;
        frames = sample.frames;
        framesReliable = false;
        progressedAt = framesAt = sample.now;
        return false;
      }
      if (sample.time > time + 0.1 || sample.time < time - 1) {
        time = sample.time;
        progressedAt = sample.now;
      }
      if (sample.frames === null) framesReliable = false;
      if (sample.frames !== null && frames !== null && sample.frames > frames) framesReliable = true;
      if (sample.frames === null || frames === null || sample.frames !== frames) {
        frames = sample.frames;
        framesAt = sample.now;
      }
      if (sample.now - progressedAt < timeoutMs && (!framesReliable || sample.now - framesAt < timeoutMs)) return false;
      // Throttle retries even when the element emits no events at all.
      progressedAt = framesAt = sample.now;
      return true;
    };
  }

  return {
    createProgressWatchdog: createProgressWatchdog,
    appendClientId: appendClientId,
    canAdoptTuner: canAdoptTuner,
    choose: choose,
    expectedDirectPosition: expectedDirectPosition,
    isPlaybackStable: isPlaybackStable,
    loadMediaElement: loadMediaElement,
    nextTunerRequestId: nextTunerRequestId,
    resetMediaElement: resetMediaElement,
    resolveUrl: resolveUrl,
    shouldReload: shouldReload,
    withTunerRevision: withTunerRevision
  };
}));
