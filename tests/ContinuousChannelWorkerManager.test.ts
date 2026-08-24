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

function fixture(options: { missing?: boolean; noFallback?: boolean; overlay?: boolean } = {}) {
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
      overlay: options.overlay
        ? async () => ({
            sourcePath: '/data/channel-logos/kids.png',
            opacity: 0.8,
            position: 2,
            x: 20,
            y: 20,
            sizePercent: 12,
          })
        : undefined,
    },
    {
      start: async (request) => {
        requests.push(request)
        const exit = deferred<ChannelPipelineExit>()
        exits.push(exit)
        const handle: ChannelPipelineHandle = {
          completed: exit.promise,
          stop: () => {
            stops += 1
          },
        }
        return handle
      },
    },
    {
      prepareOutput: () => {},
      cleanupOutput: () => {},
      sourceExists: (path) => !options.missing || path === '/fallback.mp4',
    },
    { outputRoot: '/data/streams', idleTimeoutMs: 60_000, restartDelayMs: 10 },
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

  test('passes an available channel overlay to the pipeline', async () => {
    const f = fixture({ overlay: true })
    await f.manager.acquire('kids')
    expect(f.requests[0]?.overlay).toMatchObject({
      sourcePath: '/data/channel-logos/kids.png',
      opacity: 0.8,
      position: 2,
    })
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
    expect(f.requests[1]?.appendToExistingPlaylist).toBe(true)
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
