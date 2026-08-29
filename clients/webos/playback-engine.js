/* Live playback engine for the webOS client.
 *
 * The native HLS player owns its buffer and exposes no way to discard it, so a
 * server-side channel change cannot reach the screen until whatever the TV has
 * already downloaded has played out — measured at 3110 ms per switch on an LG
 * 65QNED91SPA against a 203 ms server tune. Media Source Extensions hand the
 * buffer back: the application appends and, crucially, removes.
 *
 * The virtual tuner keeps every channel on one continuous timeline with no
 * discontinuity and no codec change, which is what makes discarding the
 * outgoing buffer safe. Eviction here, continuity there; neither works alone.
 */
(function (root, factory) {
  'use strict';
  var engine = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = engine;
  root.ToastTVPlaybackEngine = engine;
}(this, function () {
  'use strict';

  /* Hold the forward buffer shallow. This is the same lever as the server's
     advertised window, but under our control and far more precise. */
  var DEFAULT_CONFIG = {
    maxBufferLength: 4,
    maxMaxBufferLength: 8,
    backBufferLength: 8,
    liveSyncDurationCount: 2,
    liveMaxLatencyDurationCount: 5,
    lowLatencyMode: false,
    enableWorker: true,
    debug: false
  };

  /* Leave a sliver of the current position intact so the cut never lands on the
     frame being displayed, which would stall the element instead of the load. */
  var FLUSH_EPSILON_SECONDS = 0.05;
  /* A switch counts as revealed once this much new media is buffered behind the
     playhead's new position. Below roughly a second the picture can appear and
     immediately stall. */
  var REVEAL_MIN_AHEAD_SECONDS = 1;
  var REVEAL_MIN_PROGRESS_SECONDS = 0.1;

  /**
   * Seconds of contiguous media buffered ahead of `currentTime`.
   * `ranges` is an array of [start, end] pairs, so this tests without a DOM.
   */
  function bufferAhead(ranges, currentTime) {
    if (!ranges || !ranges.length) return null;
    var index;
    for (index = ranges.length - 1; index >= 0; index -= 1) {
      if (ranges[index][0] <= currentTime && ranges[index][1] >= currentTime) {
        return ranges[index][1] - currentTime;
      }
    }
    return null;
  }

  /** The span to discard on a channel change: everything ahead of the playhead. */
  function forwardFlushRange(currentTime) {
    var start = Number(currentTime);
    if (!isFinite(start) || start < 0) start = 0;
    return { startOffset: start + FLUSH_EPSILON_SECONDS, endOffset: Infinity };
  }

  /**
   * Whether the incoming channel is genuinely on screen.
   *
   * Playback must have moved past where we cut — media before that point is
   * still the outgoing channel — and enough new media must be buffered to
   * sustain it.
   */
  function isRevealed(stats, baseline) {
    if (!stats || !baseline) return false;
    if (stats.readyState < 3 || stats.paused) return false;
    if (stats.ahead === null || stats.ahead < REVEAL_MIN_AHEAD_SECONDS) return false;
    return stats.time > baseline.time + REVEAL_MIN_PROGRESS_SECONDS;
  }

  function readRanges(video) {
    var out = [];
    var index;
    try {
      for (index = 0; index < video.buffered.length; index += 1) {
        out.push([video.buffered.start(index), video.buffered.end(index)]);
      }
    } catch (ignoreRanges) {}
    return out;
  }

  /**
   * Wraps one hls.js instance bound to one media element for the life of the
   * session. Nothing here ever detaches the media element on a channel change:
   * that is the decoder reset being avoided.
   */
  function createEngine(options) {
    var video = options.video;
    var Hls = options.Hls;
    var config = options.config || DEFAULT_CONFIG;
    var handlers = {};
    var hls = null;
    var lastFragment = null;
    var recoveries = 0;

    function emit(name, payload) {
      var list = handlers[name] || [];
      var index;
      for (index = 0; index < list.length; index += 1) {
        try { list[index](payload); } catch (ignoreHandler) {}
      }
    }

    function stats() {
      var time = Number(video.currentTime) || 0;
      return {
        time: time,
        readyState: Number(video.readyState) || 0,
        paused: !!video.paused,
        ahead: bufferAhead(readRanges(video), time),
        fragment: lastFragment
      };
    }

    function onError(event, payload) {
      emit('error', payload);
      if (!payload.fatal) return;
      /* There is no native fallback behind this engine, so recovery has to be
         exhausted here before the session is declared lost. */
      if (payload.type === Hls.ErrorTypes.NETWORK_ERROR) {
        recoveries += 1;
        hls.startLoad();
        return;
      }
      if (payload.type === Hls.ErrorTypes.MEDIA_ERROR) {
        recoveries += 1;
        hls.recoverMediaError();
        return;
      }
      emit('lost', payload);
    }

    function attach(url) {
      detach();
      hls = new Hls(config);
      hls.on(Hls.Events.ERROR, onError);
      hls.on(Hls.Events.FRAG_CHANGED, function (event, payload) {
        lastFragment = payload && payload.frag ? payload.frag.sn : null;
      });
      hls.on(Hls.Events.MANIFEST_PARSED, function () { emit('ready', stats()); });
      hls.loadSource(url);
      hls.attachMedia(video);
      return true;
    }

    function detach() {
      if (!hls) return false;
      try { hls.destroy(); } catch (ignoreDestroy) {}
      hls = null;
      lastFragment = null;
      return true;
    }

    /**
     * Discards the outgoing channel and refills from the live edge.
     *
     * The loader is stopped first. The prototype flushed underneath a live
     * fragment request, which aborted it and cost most of the difference
     * between its 282 ms best case and its 1813 ms worst.
     */
    function switchNow() {
      if (!hls) return null;
      var baseline = stats();
      var range = forwardFlushRange(baseline.time);
      try {
        hls.stopLoad();
        hls.trigger(Hls.Events.BUFFER_FLUSHING, {
          startOffset: range.startOffset,
          endOffset: range.endOffset,
          type: null
        });
        hls.startLoad();
        return { baseline: baseline, discarded: baseline.ahead };
      } catch (error) {
        emit('error', { fatal: false, details: 'flushFailed', reason: error.message });
        return null;
      }
    }

    return {
      attach: attach,
      detach: detach,
      switchNow: switchNow,
      stats: stats,
      recoveries: function () { return recoveries; },
      on: function (name, handler) {
        if (!handlers[name]) handlers[name] = [];
        handlers[name].push(handler);
      }
    };
  }

  function isSupported(Hls) {
    return !!(Hls && typeof Hls.isSupported === 'function' && Hls.isSupported());
  }

  return {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    FLUSH_EPSILON_SECONDS: FLUSH_EPSILON_SECONDS,
    REVEAL_MIN_AHEAD_SECONDS: REVEAL_MIN_AHEAD_SECONDS,
    bufferAhead: bufferAhead,
    createEngine: createEngine,
    forwardFlushRange: forwardFlushRange,
    isRevealed: isRevealed,
    isSupported: isSupported
  };
}));
