/* The channel switch, as one explicit state machine.
 *
 * A switch used to be coordinated by two dozen independent booleans set in a
 * particular order by five commit and rollback paths. Every defect found in
 * that code came from two paths disagreeing about a flag rather than from the
 * transport logic: a helper referenced after its declaration was removed, an
 * early hasCommittedVideo that silently disabled a teardown another path
 * relied on, a fallback that dropped its discontinuity marker.
 *
 * This module owns the shape of a switch instead. It is pure: given a state
 * and an event it returns the next state and the effects to run, and never
 * touches the DOM, the network or the clock. The client applies the effects.
 */
(function (root, factory) {
  'use strict';
  var machine = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = machine;
  root.ToastTVSwitchMachine = machine;
}(this, function () {
  'use strict';

  var STATES = {
    /** Nothing in flight; whatever is on screen is what was asked for. */
    IDLE: 'idle',
    /** The server has been asked to switch and has not answered. */
    REQUESTING: 'requesting',
    /** The server switched the feed; the incoming channel is not on screen yet. */
    REVEALING: 'revealing',
    /** The incoming channel is playing and its identity has been published. */
    PLAYING: 'playing',
    /** The destination has no programme; there is nothing to reveal. */
    OFF_AIR: 'offAir',
    /** The switch could not be completed and the client must recover. */
    FAILED: 'failed'
  };

  var EVENTS = {
    REQUESTED: 'REQUESTED',
    ACCEPTED: 'ACCEPTED',
    REJECTED: 'REJECTED',
    REVEALED: 'REVEALED',
    OFF_AIR: 'OFF_AIR',
    TIMED_OUT: 'TIMED_OUT',
    SUPERSEDED: 'SUPERSEDED',
    LOST: 'LOST'
  };

  /* Effects are names, not closures, so a transition stays comparable in a test
     and the client keeps sole ownership of how each one is carried out. */
  var EFFECTS = {
    POST_TUNE: 'postTune',
    FLUSH: 'flushOutgoingBuffer',
    WATCH_REVEAL: 'watchForReveal',
    PUBLISH_IDENTITY: 'publishChannelIdentity',
    SHOW_OFF_AIR: 'showOffAir',
    REATTACH: 'reattachEngine',
    RECOVER: 'recoverSession',
    CANCEL_WATCH: 'cancelRevealWatch'
  };

  function create(channelId, requestId) {
    return Object.freeze({
      state: STATES.IDLE,
      channelId: channelId || null,
      requestId: typeof requestId === 'number' ? requestId : -1
    });
  }

  function result(context, state, effects, patch) {
    var next = {
      state: state,
      channelId: context.channelId,
      requestId: context.requestId
    };
    var key;
    if (patch) for (key in patch) if (patch.hasOwnProperty(key)) next[key] = patch[key];
    return Object.freeze({ context: Object.freeze(next), effects: effects });
  }

  /**
   * The whole switch in one place.
   *
   * `event` is `{ type, channelId, requestId }`. A transition is ignored rather
   * than applied when the event belongs to an older request: a newer key press
   * always wins, and stale callbacks arriving late must not move the machine.
   */
  function transition(context, event) {
    if (!context || !event) return result(context || create(), (context || create()).state, []);
    var type = event.type;

    /* A newer request supersedes whatever is in flight, from any state. */
    if (type === EVENTS.SUPERSEDED || type === EVENTS.REQUESTED) {
      if (type === EVENTS.REQUESTED) {
        return result(context, STATES.REQUESTING, [EFFECTS.CANCEL_WATCH, EFFECTS.POST_TUNE], {
          channelId: event.channelId,
          requestId: event.requestId
        });
      }
      return result(context, STATES.IDLE, [EFFECTS.CANCEL_WATCH]);
    }

    /* Anything else carrying an older request id is a late callback from a
       superseded attempt and must not move the machine. */
    if (typeof event.requestId === 'number' && event.requestId < context.requestId) {
      return result(context, context.state, []);
    }

    if (type === EVENTS.LOST) {
      return result(context, STATES.FAILED, [EFFECTS.CANCEL_WATCH, EFFECTS.RECOVER]);
    }

    switch (context.state) {
      case STATES.REQUESTING:
        if (type === EVENTS.ACCEPTED) {
          /* The server has already published the incoming channel on the same
             timeline, so discarding what is buffered is the whole switch. */
          return result(context, STATES.REVEALING, [EFFECTS.FLUSH, EFFECTS.WATCH_REVEAL]);
        }
        if (type === EVENTS.OFF_AIR) {
          return result(context, STATES.OFF_AIR, [EFFECTS.SHOW_OFF_AIR, EFFECTS.PUBLISH_IDENTITY]);
        }
        if (type === EVENTS.REJECTED) {
          return result(context, STATES.FAILED, [EFFECTS.RECOVER]);
        }
        return result(context, context.state, []);

      case STATES.REVEALING:
        if (type === EVENTS.REVEALED) {
          /* Identity is published only here. Naming the destination before its
             media is on screen is what used to caption the outgoing picture
             with the incoming channel. */
          return result(context, STATES.PLAYING, [EFFECTS.CANCEL_WATCH, EFFECTS.PUBLISH_IDENTITY]);
        }
        if (type === EVENTS.TIMED_OUT) {
          return result(context, STATES.FAILED, [EFFECTS.CANCEL_WATCH, EFFECTS.REATTACH]);
        }
        if (type === EVENTS.OFF_AIR) {
          return result(context, STATES.OFF_AIR, [EFFECTS.CANCEL_WATCH, EFFECTS.SHOW_OFF_AIR, EFFECTS.PUBLISH_IDENTITY]);
        }
        return result(context, context.state, []);

      case STATES.IDLE:
      case STATES.PLAYING:
      case STATES.OFF_AIR:
      case STATES.FAILED:
      default:
        return result(context, context.state, []);
    }
  }

  /** True while a switch is in flight, which is what the UI calls "tuning". */
  function isSwitching(context) {
    return !!context &&
      (context.state === STATES.REQUESTING || context.state === STATES.REVEALING);
  }

  /** True once the destination may be named on screen. */
  function identityIsPublishable(context) {
    return !!context &&
      (context.state === STATES.PLAYING || context.state === STATES.OFF_AIR);
  }

  return {
    EFFECTS: EFFECTS,
    EVENTS: EVENTS,
    STATES: STATES,
    create: create,
    identityIsPublishable: identityIsPublishable,
    isSwitching: isSwitching,
    transition: transition
  };
}));
