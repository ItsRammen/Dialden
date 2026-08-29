import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const engine = require(join(
  import.meta.dir,
  '..',
  'clients',
  'webos',
  'playback-engine.js'
)) as {
  DEFAULT_CONFIG: Record<string, unknown>
  FLUSH_EPSILON_SECONDS: number
  REVEAL_MIN_AHEAD_SECONDS: number
  bufferAhead: (ranges: number[][] | null, currentTime: number) => number | null
  createEngine: (options: any) => any
  forwardFlushRange: (currentTime: number) => { startOffset: number; endOffset: number }
  isRevealed: (stats: any, baseline: any) => boolean
  isSupported: (Hls: unknown) => boolean
}

/** Minimal stand-ins: the engine only ever touches these members. */
function fakeVideo(overrides: Partial<Record<string, unknown>> = {}) {
  const ranges: number[][] = (overrides.ranges as number[][]) ?? []
  return {
    currentTime: (overrides.currentTime as number) ?? 0,
    readyState: (overrides.readyState as number) ?? 4,
    paused: (overrides.paused as boolean) ?? false,
    buffered: {
      length: ranges.length,
      start: (i: number) => ranges[i]![0]!,
      end: (i: number) => ranges[i]![1]!,
    },
  }
}

function fakeHls() {
  const calls: string[] = []
  const instances: any[] = []
  class Hls {
    constructor() { instances.push(this) }
    static Events = {
      ERROR: 'hlsError',
      FRAG_CHANGED: 'hlsFragChanged',
      MANIFEST_PARSED: 'hlsManifestParsed',
      BUFFER_FLUSHING: 'hlsBufferFlushing',
    }
    static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' }
    static isSupported() { return true }
    handlers: Record<string, Function[]> = {}
    triggered: any[] = []
    on(name: string, handler: Function) {
      if (!this.handlers[name]) this.handlers[name] = []
      this.handlers[name].push(handler)
    }
    fire(name: string, payload: unknown) {
      for (const h of this.handlers[name] ?? []) h(name, payload)
    }
    trigger(name: string, payload: unknown) {
      calls.push('trigger:' + name)
      this.triggered.push({ name, payload })
    }
    loadSource() { calls.push('loadSource') }
    attachMedia() { calls.push('attachMedia') }
    stopLoad() { calls.push('stopLoad') }
    startLoad() { calls.push('startLoad') }
    recoverMediaError() { calls.push('recoverMediaError') }
    destroy() { calls.push('destroy') }
  }
  return { Hls, calls, instances }
}

describe('webOS playback engine', () => {
  describe('bufferAhead', () => {
    test('measures the range containing the playhead, not the newest one', () => {
      // A flush can leave a stale island ahead of a gap; that is not playable
      // media and must not be counted as headroom.
      expect(engine.bufferAhead([[0, 10], [20, 30]], 5)).toBe(5)
    })

    test('reports nothing when the playhead sits in a hole', () => {
      expect(engine.bufferAhead([[0, 10], [20, 30]], 15)).toBeNull()
      expect(engine.bufferAhead([], 5)).toBeNull()
      expect(engine.bufferAhead(null, 5)).toBeNull()
    })
  })

  describe('forwardFlushRange', () => {
    test('leaves the displayed frame intact and discards everything after', () => {
      const range = engine.forwardFlushRange(42)
      expect(range.startOffset).toBeCloseTo(42 + engine.FLUSH_EPSILON_SECONDS, 6)
      expect(range.endOffset).toBe(Infinity)
    })

    test('clamps a nonsensical position rather than flushing from NaN', () => {
      expect(engine.forwardFlushRange(Number.NaN).startOffset)
        .toBeCloseTo(engine.FLUSH_EPSILON_SECONDS, 6)
      expect(engine.forwardFlushRange(-3).startOffset)
        .toBeCloseTo(engine.FLUSH_EPSILON_SECONDS, 6)
    })
  })

  describe('isRevealed', () => {
    const baseline = { time: 10, readyState: 4, paused: false, ahead: 3 }

    test('requires playback to pass the cut, since media before it is outgoing', () => {
      expect(engine.isRevealed({ time: 10.05, readyState: 4, paused: false, ahead: 3 }, baseline))
        .toBe(false)
      expect(engine.isRevealed({ time: 10.5, readyState: 4, paused: false, ahead: 3 }, baseline))
        .toBe(true)
    })

    test('requires enough new media to sustain the picture', () => {
      expect(engine.isRevealed({ time: 11, readyState: 4, paused: false, ahead: 0.4 }, baseline))
        .toBe(false)
      expect(engine.isRevealed({ time: 11, readyState: 4, paused: false, ahead: null }, baseline))
        .toBe(false)
    })

    test('does not call a paused or undecoded element revealed', () => {
      expect(engine.isRevealed({ time: 11, readyState: 4, paused: true, ahead: 3 }, baseline))
        .toBe(false)
      expect(engine.isRevealed({ time: 11, readyState: 2, paused: false, ahead: 3 }, baseline))
        .toBe(false)
    })
  })

  describe('switchNow', () => {
    test('stops the loader before flushing, then restarts it', () => {
      const { Hls, calls } = fakeHls()
      const video = fakeVideo({ currentTime: 20, ranges: [[15, 24]] })
      const e = engine.createEngine({ video, Hls })
      e.attach('http://tower/index.m3u8')
      calls.length = 0

      const result = e.switchNow()

      // Flushing underneath a live fragment request aborts it and costs far
      // more than the flush saves, so the order here is the point.
      expect(calls).toEqual(['stopLoad', 'trigger:hlsBufferFlushing', 'startLoad'])
      expect(result.discarded).toBeCloseTo(4, 6)
    })

    test('discards everything ahead of the playhead', () => {
      const { Hls } = fakeHls()
      const video = fakeVideo({ currentTime: 20, ranges: [[15, 24]] })
      const e = engine.createEngine({ video, Hls })
      e.attach('http://tower/index.m3u8')
      const before = e.stats()

      e.switchNow()

      expect(before.ahead).toBeCloseTo(4, 6)
      expect(engine.forwardFlushRange(20).endOffset).toBe(Infinity)
    })

    test('is inert before anything is attached', () => {
      const { Hls } = fakeHls()
      const e = engine.createEngine({ video: fakeVideo(), Hls })
      expect(e.switchNow()).toBeNull()
    })
  })

  describe('error recovery', () => {
    test('retries a fatal network error rather than surfacing it', () => {
      const { Hls, calls, instances } = fakeHls()
      const e = engine.createEngine({ video: fakeVideo(), Hls })
      const lost: unknown[] = []
      e.on('lost', (payload: unknown) => lost.push(payload))
      e.attach('http://tower/index.m3u8')
      calls.length = 0

      // There is no native fallback behind this engine, so recovery has to be
      // exhausted here before the session is declared lost.
      instances[0].fire('hlsError', { fatal: true, type: 'networkError' })

      expect(calls).toContain('startLoad')
      expect(lost).toHaveLength(0)
      expect(e.recoveries()).toBe(1)
    })

    test('retries a fatal media error through recoverMediaError', () => {
      const { Hls, calls, instances } = fakeHls()
      const e = engine.createEngine({ video: fakeVideo(), Hls })
      e.attach('http://tower/index.m3u8')
      calls.length = 0

      instances[0].fire('hlsError', { fatal: true, type: 'mediaError' })

      expect(calls).toContain('recoverMediaError')
      expect(e.recoveries()).toBe(1)
    })

    test('declares the session lost only for a fatal it cannot retry', () => {
      const { Hls, instances } = fakeHls()
      const e = engine.createEngine({ video: fakeVideo(), Hls })
      const lost: any[] = []
      e.on('lost', (payload: any) => lost.push(payload))
      e.attach('http://tower/index.m3u8')

      instances[0].fire('hlsError', { fatal: true, type: 'otherError' })

      expect(lost).toHaveLength(1)
      expect(lost[0].type).toBe('otherError')
    })

    test('passes non-fatal errors through without touching the loader', () => {
      const { Hls, calls, instances } = fakeHls()
      const e = engine.createEngine({ video: fakeVideo(), Hls })
      const seen: any[] = []
      e.on('error', (payload: any) => seen.push(payload))
      e.attach('http://tower/index.m3u8')
      calls.length = 0

      instances[0].fire('hlsError', { fatal: false, details: 'bufferSeekOverHole' })

      expect(seen).toHaveLength(1)
      expect(seen[0].details).toBe('bufferSeekOverHole')
      expect(calls).toEqual([])
      expect(e.recoveries()).toBe(0)
    })

    test('tracks the fragment sequence, the only proof a switch reached new media', () => {
      const { Hls, instances } = fakeHls()
      const e = engine.createEngine({ video: fakeVideo(), Hls })
      e.attach('http://tower/index.m3u8')

      expect(e.stats().fragment).toBeNull()
      instances[0].fire('hlsFragChanged', { frag: { sn: 40 } })
      expect(e.stats().fragment).toBe(40)
    })
  })

  describe('lifecycle', () => {
    test('detach tears down the hls instance exactly once', () => {
      const { Hls, calls } = fakeHls()
      const e = engine.createEngine({ video: fakeVideo(), Hls })
      e.attach('http://tower/index.m3u8')
      calls.length = 0

      expect(e.detach()).toBe(true)
      expect(calls).toContain('destroy')
      expect(e.detach()).toBe(false)
    })

    test('holds the forward buffer shallow by default', () => {
      // The buffer depth is the switch latency: a player cannot show new media
      // until what it already holds has played out.
      expect(engine.DEFAULT_CONFIG.maxBufferLength).toBe(4)
      expect(engine.DEFAULT_CONFIG.liveSyncDurationCount).toBe(2)
    })

    test('isSupported defers to hls.js rather than sniffing', () => {
      expect(engine.isSupported(fakeHls().Hls)).toBe(true)
      expect(engine.isSupported(null)).toBe(false)
      expect(engine.isSupported({})).toBe(false)
    })
  })
})
