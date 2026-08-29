import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const machine = require(join(
  import.meta.dir,
  '..',
  'clients',
  'webos',
  'switch-machine.js'
)) as {
  EFFECTS: {
    POST_TUNE: string
    FLUSH: string
    WATCH_REVEAL: string
    PUBLISH_IDENTITY: string
    SHOW_OFF_AIR: string
    REATTACH: string
    RECOVER: string
    CANCEL_WATCH: string
  }
  EVENTS: {
    REQUESTED: string
    ACCEPTED: string
    REJECTED: string
    REVEALED: string
    OFF_AIR: string
    TIMED_OUT: string
    SUPERSEDED: string
    LOST: string
  }
  STATES: {
    IDLE: string
    REQUESTING: string
    REVEALING: string
    PLAYING: string
    OFF_AIR: string
    FAILED: string
  }
  create: (channelId?: string, requestId?: number) => any
  identityIsPublishable: (context: any) => boolean
  isSwitching: (context: any) => boolean
  transition: (context: any, event: any) => { context: any; effects: string[] }
}

const { EFFECTS, EVENTS, STATES } = machine

/** Applies a sequence of events, returning the final context and every effect. */
function run(start: any, events: any[]) {
  let context = start
  const effects: string[] = []
  for (const event of events) {
    const step = machine.transition(context, event)
    context = step.context
    effects.push(...step.effects)
  }
  return { context, effects }
}

const request = (channelId: string, requestId: number) => ({
  type: EVENTS.REQUESTED,
  channelId,
  requestId,
})

describe('webOS switch machine', () => {
  test('a switch runs request, accept, reveal', () => {
    const { context, effects } = run(machine.create(), [
      request('disney', 1),
      { type: EVENTS.ACCEPTED, requestId: 1 },
      { type: EVENTS.REVEALED, requestId: 1 },
    ])

    expect(context.state).toBe(STATES.PLAYING)
    expect(context.channelId).toBe('disney')
    expect(effects).toEqual([
      EFFECTS.CANCEL_WATCH,
      EFFECTS.POST_TUNE,
      EFFECTS.FLUSH,
      EFFECTS.WATCH_REVEAL,
      EFFECTS.CANCEL_WATCH,
      EFFECTS.PUBLISH_IDENTITY,
    ])
  })

  test('names the destination only once its media is on screen', () => {
    // Publishing on ACCEPTED is what used to caption the outgoing picture with
    // the incoming channel's title for the length of the switch.
    const accepted = run(machine.create(), [
      request('disney', 1),
      { type: EVENTS.ACCEPTED, requestId: 1 },
    ])
    expect(accepted.effects).not.toContain(EFFECTS.PUBLISH_IDENTITY)
    expect(machine.identityIsPublishable(accepted.context)).toBe(false)

    const revealed = machine.transition(accepted.context, {
      type: EVENTS.REVEALED,
      requestId: 1,
    })
    expect(revealed.effects).toContain(EFFECTS.PUBLISH_IDENTITY)
    expect(machine.identityIsPublishable(revealed.context)).toBe(true)
  })

  test('discards the outgoing buffer exactly once, on acceptance', () => {
    const { effects } = run(machine.create(), [
      request('disney', 1),
      { type: EVENTS.ACCEPTED, requestId: 1 },
      { type: EVENTS.ACCEPTED, requestId: 1 },
    ])

    expect(effects.filter((e) => e === EFFECTS.FLUSH)).toHaveLength(1)
  })

  describe('superseded requests', () => {
    test('a newer request takes over from any state', () => {
      const mid = run(machine.create(), [
        request('disney', 1),
        { type: EVENTS.ACCEPTED, requestId: 1 },
      ])
      expect(mid.context.state).toBe(STATES.REVEALING)

      const next = machine.transition(mid.context, request('nickelodeon', 2))
      expect(next.context.state).toBe(STATES.REQUESTING)
      expect(next.context.channelId).toBe('nickelodeon')
      // The watch on the abandoned switch must not survive to fire later.
      expect(next.effects).toEqual([EFFECTS.CANCEL_WATCH, EFFECTS.POST_TUNE])
    })

    test('a late callback from a superseded request cannot move the machine', () => {
      // This is the shape of the old bug class: a stale response arriving after
      // a newer key press and committing the wrong channel.
      const { context } = run(machine.create(), [
        request('disney', 1),
        request('nickelodeon', 2),
      ])

      const stale = machine.transition(context, { type: EVENTS.ACCEPTED, requestId: 1 })
      expect(stale.context.state).toBe(STATES.REQUESTING)
      expect(stale.context.channelId).toBe('nickelodeon')
      expect(stale.effects).toEqual([])

      const staleReveal = machine.transition(context, { type: EVENTS.REVEALED, requestId: 1 })
      expect(staleReveal.effects).toEqual([])
    })
  })

  describe('failure paths', () => {
    test('a rejected tune recovers rather than revealing', () => {
      const { context, effects } = run(machine.create(), [
        request('disney', 1),
        { type: EVENTS.REJECTED, requestId: 1 },
      ])

      expect(context.state).toBe(STATES.FAILED)
      expect(effects).toContain(EFFECTS.RECOVER)
      expect(effects).not.toContain(EFFECTS.FLUSH)
    })

    test('media that never appears reattaches the engine', () => {
      const { context, effects } = run(machine.create(), [
        request('disney', 1),
        { type: EVENTS.ACCEPTED, requestId: 1 },
        { type: EVENTS.TIMED_OUT, requestId: 1 },
      ])

      expect(context.state).toBe(STATES.FAILED)
      expect(effects).toContain(EFFECTS.REATTACH)
      expect(effects).not.toContain(EFFECTS.PUBLISH_IDENTITY)
    })

    test('a lost engine recovers from any state and cancels the watch', () => {
      const revealing = run(machine.create(), [
        request('disney', 1),
        { type: EVENTS.ACCEPTED, requestId: 1 },
      ]).context

      const lost = machine.transition(revealing, { type: EVENTS.LOST, requestId: 1 })
      expect(lost.context.state).toBe(STATES.FAILED)
      expect(lost.effects).toEqual([EFFECTS.CANCEL_WATCH, EFFECTS.RECOVER])
    })
  })

  describe('off air', () => {
    test('an off-air destination publishes without waiting to reveal', () => {
      // There is no incoming media to wait for, so the identity is safe at once.
      const { context, effects } = run(machine.create(), [
        request('disney', 1),
        { type: EVENTS.OFF_AIR, requestId: 1 },
      ])

      expect(context.state).toBe(STATES.OFF_AIR)
      expect(effects).toContain(EFFECTS.SHOW_OFF_AIR)
      expect(effects).toContain(EFFECTS.PUBLISH_IDENTITY)
      expect(effects).not.toContain(EFFECTS.FLUSH)
    })

    test('a channel going off air mid-reveal stops the watch', () => {
      const { context, effects } = run(machine.create(), [
        request('disney', 1),
        { type: EVENTS.ACCEPTED, requestId: 1 },
        { type: EVENTS.OFF_AIR, requestId: 1 },
      ])

      expect(context.state).toBe(STATES.OFF_AIR)
      expect(effects).toContain(EFFECTS.CANCEL_WATCH)
    })

    test('an off-air channel can still be switched away from', () => {
      const offAir = run(machine.create(), [
        request('disney', 1),
        { type: EVENTS.OFF_AIR, requestId: 1 },
      ]).context

      const next = machine.transition(offAir, request('nickelodeon', 2))
      expect(next.context.state).toBe(STATES.REQUESTING)
      expect(next.context.channelId).toBe('nickelodeon')
    })
  })

  describe('isSwitching', () => {
    test('is true only while something is in flight', () => {
      const idle = machine.create()
      expect(machine.isSwitching(idle)).toBe(false)

      const requesting = machine.transition(idle, request('disney', 1)).context
      expect(machine.isSwitching(requesting)).toBe(true)

      const revealing = machine.transition(requesting, {
        type: EVENTS.ACCEPTED,
        requestId: 1,
      }).context
      expect(machine.isSwitching(revealing)).toBe(true)

      const playing = machine.transition(revealing, {
        type: EVENTS.REVEALED,
        requestId: 1,
      }).context
      expect(machine.isSwitching(playing)).toBe(false)
    })
  })

  test('contexts are frozen so no caller can mutate the state behind its back', () => {
    // The flags this replaces were mutable and set in different orders by five
    // different paths, which is where the disagreements came from.
    const context = machine.transition(machine.create(), request('disney', 1)).context
    expect(Object.isFrozen(context)).toBe(true)
  })

  test('an unknown event leaves the machine exactly where it was', () => {
    const requesting = machine.transition(machine.create(), request('disney', 1)).context
    const step = machine.transition(requesting, { type: 'NONSENSE', requestId: 1 })

    expect(step.context.state).toBe(STATES.REQUESTING)
    expect(step.effects).toEqual([])
  })
})
