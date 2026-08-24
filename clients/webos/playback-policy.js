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

  function choose(nowResult, serverUrl, failedLiveUrl, clientId) {
    var live = liveDescriptor(nowResult);
    var liveUrl = live ? resolveUrl(live.url, serverUrl) : null;
    liveUrl = appendClientId(liveUrl, clientId);
    if (liveUrl && liveUrl !== failedLiveUrl) {
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

  function expectedDirectPosition(program, elapsedSinceResponseMs) {
    if (!program) return 0;
    var playback = program.playback || {};
    var sourceOrigin = Number(playback.sourceOffsetAtPlaybackZeroMs || 0);
    return Math.max(0, (Number(program.offsetMs || 0) + elapsedSinceResponseMs - sourceOrigin) / 1000);
  }

  return {
    appendClientId: appendClientId,
    choose: choose,
    expectedDirectPosition: expectedDirectPosition,
    resolveUrl: resolveUrl,
    shouldReload: shouldReload
  };
}));
