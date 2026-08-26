import { describe, expect, test } from 'bun:test'
import {
  ContinuousChannelWorkerManager,
  type ChannelPipelineExit,
  type ChannelPipelineHandle,
  type ChannelPipelineRequest,
  type ChannelTimelinePosition,
  type ChannelWorkerClock,
} from '../src/services/ContinuousChannelWorkerManager'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const settle = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve()
}

class FakeClock implements ChannelWorkerClock {
  time = Date.parse('2026-08-24T12:00:00.000Z')
  timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = []
  now = () => new Date(this.time)
  setTimeout(callback: () => void, delayMs: number) {
    const timer = { at: this.time + delayMs, callback, cancelled: false }
    this.timers.push(timer)
    return timer
  }
  clearTimeout(handle: unknown) {
    ;(handle as { cancelled: boolean }).cancelled = true
  }
  advance(ms: number) {
    this.time += ms
    const due = this.timers.filter((timer) => !timer.cancelled && timer.at <= this.time)
    for (const timer of due) {
      timer.cancelled = true
      timer.callback()
    }
  }
}

const position = (overrides: Partial<ChannelTimelinePosition> = {}): ChannelTimelinePosition => ({
  scheduleItemId: 'episode-a',
  nextScheduleItemId: 'bumper-a',
  sourcePath: '/media/episode-a.mkv',
  sourceOffsetSeconds: 780,
  timelineRevision: 'revision-1',
  type: 'program',
  ...overrides,
})

function fixture(options: {
  missing?: boolean
  noFallback?: boolean
  overlay?: boolean
  readiness?: Promise<void>
  stopGate?: Promise<void>
  sessionLeaseTtlMs?: number
} = {}) {
  const clock = new FakeClock()
  const requests: ChannelPipelineRequest[] = []
  const exits: ReturnType<typeof deferred<ChannelPipelineExit>>[] = []
  let stops = 0
  let resolves = 0
  const manager = new ContinuousChannelWorkerManager(
    {
      resolve: async () => {
        resolves += 1
        return position({ sourceOffsetSeconds: 780 + resolves })
      },
      fallback: options.noFallback
        ? undefined
        : async () => position({ scheduleItemId: 'stand-by', sourcePath: '/fallback.mp4', type: 'offair' }),
    },
    {
      start: async (request) => {
        requests.push(request)
        const exit = deferred<ChannelPipelineExit>()
        exits.push(exit)
        const handle: ChannelPipelineHandle = {
          completed: exit.promise,
          stop: async () => {
            stops += 1
            await options.stopGate
          },
        }
        return handle
      },
    },
    {
      prepareOutput: () => {},
      cleanupOutput: () => {},
      sourceExists: (path) => !options.missing || path === '/fallback.mp4',
      ...(options.readiness
        ? { waitForFreshSegment: () => options.readiness! }
        : {}),
    },
    { outputRoot: '/data/streams', idleTimeoutMs: 60_000, restartDelayMs: 10, ...(options.sessionLeaseTtlMs ? { sessionLeaseTtlMs: options.sessionLeaseTtlMs } : {}) },
    clock
  )
  return { manager, clock, requests, exits, get stops() { return stops }, get resolves() { return resolves } }
}

describe('ContinuousChannelWorkerManager', () => {
  test('shares one stable HLS worker between viewers and starts at the live offset', async () => {
    const f = fixture()
    const first = await f.manager.acquire('kids')
    const second = await f.manager.acquire('kids')
    expect(f.requests).toHaveLength(1)
    expect(first.outputUrl).toBe('/api/v1/channels/kids/live/index.m3u8')
    expect(second.viewerCount).toBe(2)
    expect(second.sourceOffsetSeconds).toBe(781)
    expect(f.requests[0]?.playlistPath).toBe('/data/streams/kids/live/index.m3u8')
    expect(f.requests[0]?.appendToExistingPlaylist).toBe(false)
    expect(f.requests[0]?.profile).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2 })
  })

  test('does not advertise a worker as live until its new generation emits a segment', async () => {
    const ready = deferred<void>()
    const f = fixture({ readiness: ready.promise })
    let completed = false
    const acquiring = f.manager.acquire('kids').then((state) => {
      completed = true
      return state
    })

    await settle()
    expect(f.requests).toHaveLength(1)
    expect(f.manager.getState('kids')?.status).toBe('starting')
    expect(completed).toBe(false)

    ready.resolve()
    expect((await acquiring).status).toBe('live')
  })

  test('keeps blocking viewers behind a speculative startup until fresh output exists', async () => {
    const ready = deferred<void>()
    const f = fixture({ readiness: ready.promise })

    const speculative = await f.manager.holdSession('kids', 'lineup-tv')
    expect(speculative.status).toBe('starting')
    await settle()
    expect(f.requests).toHaveLength(1)

    let readyReturned = false
    const waiting = f.manager.whenReady('kids').then((state) => {
      readyReturned = true
      return state
    })
    const touching = f.manager.touch('kids', 'watching-tv')
    await settle()
    expect(readyReturned).toBe(false)

    ready.resolve()
    expect((await waiting).status).toBe('live')
    expect((await touching).status).toBe('live')
  })

  test('surfaces an encoder exit immediately instead of waiting for readiness timeout', async () => {
    const manager = new ContinuousChannelWorkerManager(
      { resolve: async () => position() },
      {
        start: async () => ({
          completed: Promise.resolve({ code: 1, error: 'unsupported codec' }),
          stop: () => {},
        }),
      },
      {
        prepareOutput: () => {},
        cleanupOutput: () => {},
        sourceExists: () => true,
        waitForFreshSegment: () => new Promise<void>(() => {}),
      },
      { outputRoot: '/data/streams', idleTimeoutMs: 60_000 },
      new FakeClock()
    )

    const state = await manager.acquire('kids')

    expect(state.status).toBe('error')
    expect(state.lastError).toBe('unsupported codec')
  })

  test('never passes a burn-in overlay to the pipeline', async () => {
    const f = fixture()
    await f.manager.acquire('kids')
    expect(f.requests[0]).not.toHaveProperty('overlay')
    for (const item of f.requests[0]?.sequence ?? []) {
      expect(item).not.toHaveProperty('overlay')
    }
  })

  test('keeps an idle worker warm, cancels shutdown on rejoin, then stops after timeout', async () => {
    const f = fixture()
    await f.manager.acquire('kids')
    expect(f.manager.release('kids')?.status).toBe('idle')
    f.clock.advance(59_000)
    expect(f.stops).toBe(0)
    await f.manager.acquire('kids')
    f.clock.advance(2_000)
    expect(f.stops).toBe(0)
    f.manager.release('kids')
    f.clock.advance(60_000)
    await Promise.resolve()
    await settle()
    expect(f.stops).toBe(1)
    expect(f.manager.getState('kids')?.status).toBe('stopped')
  })

  test('restarts a crashed pipeline from the newly resolved live position', async () => {
    const f = fixture()
    await f.manager.acquire('kids')
    f.exits[0]?.resolve({ code: 1, error: 'decoder failed' })
    await settle()
    expect(f.manager.getState('kids')?.status).toBe('error')
    await f.manager.touch('kids', 'polling-tv')
    expect(f.requests).toHaveLength(1)
    f.clock.advance(10)
    await settle()
    expect(f.requests).toHaveLength(2)
    expect(f.requests[1]?.position.sourceOffsetSeconds).toBe(782)
    // Crash recovery starts a fresh playlist so stale programme segments are
    // never appended into the replacement generation.
    expect(f.requests[1]?.appendToExistingPlaylist).toBe(false)
    expect(f.manager.getState('kids')?.status).toBe('live')
  })

  test('hands a completed lookahead window directly to the next live window', async () => {
    const f = fixture()
    await f.manager.acquire('kids')

    f.exits[0]?.resolve({ code: 0 })
    await settle()

    expect(f.requests).toHaveLength(2)
    expect(f.requests[1]?.position.sourceOffsetSeconds).toBe(782)
    expect(f.manager.getState('kids')?.status).toBe('live')
  })

  test('uses idempotent expiring client leases instead of counting playlist polls', async () => {
    const f = fixture()
    await f.manager.touch('kids', 'living-room')
    const repeated = await f.manager.touch('kids', 'living-room')
    expect(repeated.viewerCount).toBe(1)
    expect(f.requests).toHaveLength(1)
    f.clock.advance(44_000)
    await f.manager.touch('kids', 'living-room')
    f.clock.advance(2_000)
    expect(f.manager.getState('kids')?.viewerCount).toBe(1)
    f.clock.advance(43_000)
    expect(f.manager.getState('kids')?.viewerCount).toBe(0)
    expect(f.manager.getState('kids')?.status).toBe('idle')
  })

  test('warms two adjacent channels without counting viewers and stops them when the lease expires', async () => {
    const f = fixture()
    const warmed = await f.manager.warm(['preschool', 'cartoons'], 'living-room')

    expect(warmed.map((state) => state.channelId)).toEqual([
      'preschool',
      'cartoons',
    ])
    expect(warmed.every((state) => state.viewerCount === 0)).toBe(true)
    expect(f.requests).toHaveLength(2)

    await f.manager.warm(['preschool', 'cartoons'], 'living-room')
    expect(f.requests).toHaveLength(2)
    f.clock.advance(30_000)
    await settle()
    expect(f.manager.getState('preschool')?.status).toBe('stopped')
    expect(f.manager.getState('cartoons')?.status).toBe('stopped')
    expect(f.stops).toBe(2)
  })

  test('session leases hold workers without inflating viewer counts', async () => {
    const f = fixture()
    const state = await f.manager.holdSession('kids', 'tv-1')
    await settle()
    expect(state.viewerCount).toBe(0)
    expect(state.sessionHeld).toBe(true)
    expect(f.requests).toHaveLength(1)

    // A session-held worker must never idle out while the session is open.
    f.clock.advance(120_000)
    await settle()
    expect(f.manager.getState('kids')?.status).toBe('live')

    // A second client's session keeps the lineup up after the first leaves.
    await f.manager.holdSession('kids', 'tv-2')
    await f.manager.releaseSession('kids', 'tv-1')
    f.clock.advance(120_000)
    await settle()
    expect(f.manager.getState('kids')?.status).toBe('live')

    // Releasing the last session tears the worker down promptly.
    await f.manager.releaseSession('kids', 'tv-2')
    expect(f.manager.getState('kids')?.status).toBe('stopped')
  })

  test('an expired session lease tears the idle lineup down without viewers', async () => {
    const f = fixture({ sessionLeaseTtlMs: 60_000 })
    await f.manager.holdSession('kids', 'tv-1')
    await settle()
    expect(f.manager.getState('kids')?.status).toBe('live')
    f.clock.advance(59_000)
    expect(f.manager.getState('kids')?.status).toBe('live')
    f.clock.advance(2_000)
    await settle()
    expect(f.manager.getState('kids')?.status).toBe('stopped')
  })

  test('refreshSession extends a lease and rejects unknown clients', async () => {
    const f = fixture({ sessionLeaseTtlMs: 60_000 })
    await f.manager.holdSession('kids', 'tv-1')
    await settle()
    expect(f.manager.refreshSession('kids', 'tv-1')).toBe(true)
    expect(f.manager.refreshSession('kids', 'stranger')).toBe(false)

    // Repeated refreshes keep pushing expiry forward; the worker stays live.
    for (let index = 0; index < 5; index += 1) {
      f.clock.advance(30_000)
      f.manager.refreshSession('kids', 'tv-1')
      await settle()
    }
    expect(f.manager.getState('kids')?.status).toBe('live')

    // Stop refreshing: the lease finally lapses.
    f.clock.advance(61_000)
    await settle()
    expect(f.manager.getState('kids')?.status).toBe('stopped')
  })

  test('deactivating an off-air channel removes session leases too', async () => {
    const f = fixture()
    await f.manager.holdSession('kids', 'tv-1')
    await f.manager.deactivate('kids')
    expect(f.manager.hasSessionLease('kids', 'tv-1')).toBe(false)
    expect(f.manager.getState('kids')?.sessionHeld ?? false).toBe(false)
  })

  test('starts both adjacent warm workers concurrently', async () => {
    const slowStart = deferred<void>()
    const starts: string[] = []
    const neverExits = new Promise<ChannelPipelineExit>(() => {})
    const manager = new ContinuousChannelWorkerManager(
      { resolve: async (channelId) => position({ scheduleItemId: channelId }) },
      {
        start: async (request) => {
          starts.push(request.channelId)
          if (request.channelId === 'preschool') await slowStart.promise
          return { completed: neverExits, stop: () => {} }
        },
      },
      {
        prepareOutput: () => {},
        cleanupOutput: () => {},
        sourceExists: () => true,
      },
      { outputRoot: '/data/streams', idleTimeoutMs: 60_000 },
      new FakeClock()
    )

    const warming = manager.warm(['preschool', 'cartoons'], 'living-room')
    await settle()
    expect(starts.sort()).toEqual(['cartoons', 'preschool'])

    slowStart.resolve()
    await warming
  })

  test('honors a reduced speculative cap before starting any warm workers', async () => {
    const clock = new FakeClock()
    const starts: string[] = []
    const manager = new ContinuousChannelWorkerManager(
      { resolve: async (channelId) => position({ scheduleItemId: channelId }) },
      {
        start: async (request) => {
          starts.push(request.channelId)
          return {
            completed: new Promise<ChannelPipelineExit>(() => {}),
            stop: () => {},
          }
        },
      },
      {
        prepareOutput: () => {},
        cleanupOutput: () => {},
        sourceExists: () => true,
      },
      {
        outputRoot: '/data/streams',
        idleTimeoutMs: 60_000,
        maximumWarmChannels: 1,
      },
      clock
    )

    const warmed = await manager.warm(['previous', 'next'], 'living-room')

    expect(starts).toEqual(['previous'])
    expect(warmed.map((state) => state.channelId)).toEqual(['previous'])
    expect(manager.getState('next')).toBeNull()
  })

  test('waits for an old encoder to stop before starting a replacement writer', async () => {
    const stopped = deferred<void>()
    const f = fixture({ stopGate: stopped.promise })
    await f.manager.acquire('kids')
    f.manager.release('kids')
    f.clock.advance(60_000)
    await settle()

    expect(f.stops).toBe(1)
    let returned = false
    const returning = f.manager.touch('kids', 'returning-tv').then((state) => {
      returned = true
      return state
    })
    await settle()
    expect(returned).toBe(false)
    expect(f.requests).toHaveLength(1)

    stopped.resolve()
    expect((await returning).status).toBe('live')
    expect(f.requests).toHaveLength(2)
  })

  test('serializes simultaneous restart requests behind one encoder stop', async () => {
    const stopped = deferred<void>()
    const f = fixture({ stopGate: stopped.promise })
    await f.manager.acquire('kids')

    const first = f.manager.restart('kids', 'first change')
    const second = f.manager.restart('kids', 'second change')
    await settle()
    expect(f.stops).toBe(1)
    expect(f.requests).toHaveLength(1)

    stopped.resolve()
    await Promise.all([first, second])
    expect(f.stops).toBe(1)
    expect(f.requests).toHaveLength(2)
  })

  test('serializes concurrent warm sets and never exceeds the global speculative cap', async () => {
    const clock = new FakeClock()
    const starts: string[] = []
    const stops: string[] = []
    const stopGates = new Map<string, ReturnType<typeof deferred<void>>>()
    const neverExits = new Promise<ChannelPipelineExit>(() => {})
    let active = 0
    let maximumActive = 0
    const manager = new ContinuousChannelWorkerManager(
      { resolve: async (channelId) => position({ scheduleItemId: channelId }) },
      {
        start: async (request) => {
          starts.push(request.channelId)
          active += 1
          maximumActive = Math.max(maximumActive, active)
          const gate = deferred<void>()
          stopGates.set(request.channelId, gate)
          return {
            completed: neverExits,
            stop: async () => {
              stops.push(request.channelId)
              await gate.promise
              active -= 1
            },
          }
        },
      },
      {
        prepareOutput: () => {},
        cleanupOutput: () => {},
        sourceExists: () => true,
      },
      {
        outputRoot: '/data/streams',
        idleTimeoutMs: 60_000,
        maximumWarmChannels: 2,
      },
      clock
    )

    await manager.warm(['one', 'two'], 'first-tv')
    const replacing = manager.warm(['three', 'four'], 'second-tv')
    await settle()
    expect(starts).toEqual(['one', 'two'])
    expect(stops).toEqual(['one'])

    stopGates.get('one')?.resolve()
    for (let attempt = 0; attempt < 200 && !stops.includes('two'); attempt += 1) {
      await Promise.resolve()
    }
    expect(starts).toEqual(['one', 'two'])
    expect(stops).toEqual(['one', 'two'])

    stopGates.get('two')?.resolve()
    await replacing
    expect(starts).toEqual(['one', 'two', 'three', 'four'])
    expect(maximumActive).toBe(2)
    expect(active).toBe(2)
  })

  test('deactivates an off-air worker and removes every viewer and warm lease', async () => {
    const f = fixture()
    await f.manager.touch('kids', 'living-room')
    await f.manager.warm(['kids'], 'living-room')

    const state = await f.manager.deactivate('kids')

    expect(state).toMatchObject({ status: 'stopped', viewerCount: 0 })
    expect(f.stops).toBe(1)
  })

  test('evicts the oldest speculative worker instead of exceeding the global warm cap', async () => {
    const f = fixture()
    await f.manager.warm(['one', 'two'], 'first-tv')
    f.clock.advance(1)
    await f.manager.warm(['three'], 'second-tv')
    await settle()

    expect(f.manager.getState('one')?.status).toBe('stopped')
    expect(f.manager.getState('two')?.status).toBe('idle')
    expect(f.manager.getState('three')?.status).toBe('idle')
    expect(
      f.manager
        .listStates()
        .filter((state) => state.status !== 'stopped' && state.viewerCount === 0)
    ).toHaveLength(2)
  })

  test('surfaces a missing scheduled source and uses emergency fallback', async () => {
    const f = fixture({ missing: true })
    const state = await f.manager.acquire('kids')
    expect(state.status).toBe('live')
    expect(state.usingFallback).toBe(true)
    expect(state.currentScheduleItemId).toBe('stand-by')
    expect(f.requests[0]?.position.sourcePath).toBe('/fallback.mp4')
  })

  test('fails closed when neither scheduled media nor fallback exists', async () => {
    const f = fixture({ missing: true, noFallback: true })
    const state = await f.manager.acquire('kids')
    expect(state.status).toBe('error')
    expect(state.lastError).toContain('Scheduled source is missing')
    expect(f.requests).toHaveLength(0)
  })
})
