import { describe, expect, test } from 'bun:test'
import { LineupSessionService } from '../src/services/LineupSessionService'
import type {
  ChannelWorkerClock,
  ContinuousChannelWorkerState,
} from '../src/services/ContinuousChannelWorkerManager'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const settle = async () => {
  for (let index = 0; index < 500; index++) await Promise.resolve()
}

class FakeClock implements ChannelWorkerClock {
  time = Date.parse('2026-08-25T12:00:00.000Z')
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
    let due = this.timers.filter((timer) => !timer.cancelled && timer.at <= this.time)
    while (due.length > 0) {
      for (const timer of due) {
        timer.cancelled = true
        timer.callback()
      }
      due = this.timers.filter((timer) => !timer.cancelled && timer.at <= this.time)
    }
  }
}

interface FixtureOptions {
  channels?: readonly string[]
  preferredGate?: ReturnType<typeof deferred<void>>
  maximumConcurrentWorkers?: number
}

function fixture(options: FixtureOptions = {}) {
  const clock = new FakeClock()
  const channels = options.channels ?? ['one', 'two', 'three', 'four']
  const holds: Array<{ clientId: string; channelId: string }> = []
  const releases: Array<{ clientId: string; channelId: string }> = []
  const refreshed: string[] = []
  let gate = options.preferredGate
  const workers = {
    async holdSession(channelId: string, clientId: string) {
      if (gate && channelId === channels[0]) await gate.promise
      holds.push({ clientId, channelId })
      return makeState(channelId, 'live')
    },
    async whenReady(channelId: string) {
      if (gate && channelId === channels[0]) await gate.promise
      return makeState(channelId, 'live')
    },
    refreshSession(channelId: string) {
      refreshed.push(channelId)
      return true
    },
    async releaseSession(channelId: string, clientId: string) {
      releases.push({ clientId, channelId })
    },
    getState(channelId: string) {
      return channels.includes(channelId) ? makeState(channelId, 'live') : null
    },
  }
  const service = new LineupSessionService(workers, () => channels, {
    ttlMs: 60_000,
    staggerDelayMs: 100,
    ...(options.maximumConcurrentWorkers === undefined
      ? {}
      : { maximumConcurrentWorkers: options.maximumConcurrentWorkers }),
    clock,
  })
  return { clock, service, holds, releases, refreshed, setGate(value?: ReturnType<typeof deferred<void>>) { gate = value } }
}

function makeState(
  channelId: string,
  status: ContinuousChannelWorkerState['status']
): ContinuousChannelWorkerState {
  return {
    channelId,
    status,
    viewerCount: 0,
    outputUrl: `/api/v1/channels/${channelId}/live/index.m3u8`,
    transcoding: false,
    usingFallback: false,
  }
}

describe('LineupSessionService', () => {
  test('opens with the preferred channel first and staggers the rest outward', async () => {
    const f = fixture()
    const entry = await f.service.open('tv-1', 'two')
    // Preferred starts immediately; the rest follow on stagger timers.
    expect(f.holds[0]).toEqual({ clientId: 'tv-1', channelId: 'two' })
    f.clock.advance(1_000)
    await settle()
    expect(f.holds.map((hold) => hold.channelId)).toEqual([
      'two',
      'three',
      'four',
      'one',
    ])
    expect(entry.channelIds[0]).toBe('two')
    expect(entry.pending).toBe(0)
    expect(entry.ready).toBe(4)
  })

  test('the open response waits only for the preferred channel', async () => {
    const gate = deferred<void>()
    const f = fixture({ preferredGate: gate })
    let resolved = false
    const opening = f.service.open('tv-1', 'one').then((entry) => {
      resolved = true
      return entry
    })
    await settle()
    expect(resolved).toBe(false)
    gate.resolve()
    await settle()
    const entry = await opening
    expect(resolved).toBe(true)
    expect(entry.ready).toBe(4)
  })

  test('deduplicates overlapping opens for the same TV and preferred channel', async () => {
    const gate = deferred<void>()
    const f = fixture({ preferredGate: gate })
    const first = f.service.open('tv-1', 'one')
    const duplicate = f.service.open('tv-1', 'one')
    expect(duplicate).toBe(first)
    await settle()
    expect(f.holds).toHaveLength(0)

    gate.resolve()
    await Promise.all([first, duplicate])
    expect(f.holds).toEqual([{ clientId: 'tv-1', channelId: 'one' }])
    expect(f.releases).toHaveLength(0)
    expect(f.service.snapshot().totalSessions).toBe(1)
  })

  test('falls back to the first channel when the preferred one is unavailable', async () => {
    const f = fixture()
    await f.service.open('tv-1', 'does-not-exist')
    expect(f.holds[0]?.channelId).toBe('one')
  })

  test('caps speculative workers while keeping the full lineup addressable', async () => {
    const f = fixture({ maximumConcurrentWorkers: 2 })
    const entry = await f.service.open('tv-1', 'two')
    f.clock.advance(10_000)
    await settle()
    expect(f.holds.map((hold) => hold.channelId)).toEqual(['two', 'three'])
    expect(entry.channelIds).toEqual(['two', 'three', 'four', 'one'])
  })

  test('reopening a capped session replaces old speculative leases', async () => {
    const f = fixture({ maximumConcurrentWorkers: 2 })
    await f.service.open('tv-1', 'one')
    f.clock.advance(10_000)
    await settle()
    await f.service.open('tv-1', 'three')
    f.clock.advance(10_000)
    await settle()
    expect(f.releases.map((release) => release.channelId).sort()).toEqual([
      'one',
      'two',
    ])
    expect(f.refreshed).toHaveLength(0)
    expect(f.service.refresh('tv-1')).toBe(true)
    expect(new Set(f.refreshed)).toEqual(new Set(['three', 'four']))
  })

  test('refresh extends expiry and renews every channel lease', async () => {
    const f = fixture()
    await f.service.open('tv-1', 'one')
    await settle()
    f.clock.advance(30_000)
    await settle()
    expect(f.service.refresh('tv-1')).toBe(true)
    expect(new Set(f.refreshed)).toEqual(new Set(['one', 'two', 'three', 'four']))
    // Half a minute later the refreshed session is still inside its TTL.
    f.clock.advance(45_000)
    await settle()
    const snapshot = f.service.snapshot()
    expect(snapshot.totalSessions).toBe(1)
  })

  test('an unrefreshed session expires and releases every channel lease', async () => {
    const f = fixture()
    await f.service.open('tv-1', 'one')
    await settle()
    f.clock.advance(1_000)
    await settle()
    f.clock.advance(60_000)
    await settle()
    expect(f.service.snapshot().totalSessions).toBe(0)
    expect(f.releases.map((release) => release.channelId).sort()).toEqual([
      'four',
      'one',
      'three',
      'two',
    ])
  })

  test('explicit close releases immediately and unknown closes are no-ops', async () => {
    const f = fixture()
    await f.service.open('tv-1', 'one')
    await settle()
    f.clock.advance(1_000)
    await settle()
    await f.service.close('tv-1')
    expect(f.releases).toHaveLength(4)
    await f.service.close('stranger')
    expect(f.service.snapshot().totalSessions).toBe(0)
  })

  test('queued background starts are cancelled when the session closes first', async () => {
    const f = fixture()
    const opening = f.service.open('tv-1', 'one')
    await settle()
    await f.service.close('tv-1')
    await opening
    f.clock.advance(10_000)
    await settle()
    // Only the preferred channel ever received its hold before close.
    expect(f.holds).toHaveLength(1)
  })

  test('rejects configurations without any on-air channel', async () => {
    const service = new LineupSessionService(
      {
        holdSession: async () => makeState('x', 'live'),
        whenReady: async () => makeState('x', 'live'),
        refreshSession: () => false,
        releaseSession: async () => {},
        getState: () => null,
      },
      () => [],
      { ttlMs: 60_000, staggerDelayMs: 0 }
    )
    await expect(service.open('tv-1')).rejects.toThrow('No channels are currently on air')
  })
})
