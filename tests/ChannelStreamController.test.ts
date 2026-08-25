import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createChannelStreamController } from '../src/controllers/ChannelStreamController'
import { Hono } from 'hono'
import { mutationOriginGuard } from '../src/middleware/mutationOriginGuard'

describe('ChannelStreamController', () => {
  let outputRoot: string
  let touches: Array<{ channelId: string; clientId: string }>
  let warms: Array<{ channelIds: readonly string[]; clientId: string }>
  let closes: string[]

  beforeEach(() => {
    outputRoot = mkdtempSync(join(tmpdir(), 'toasttv-channel-stream-'))
    mkdirSync(join(outputRoot, 'kids', 'live'), { recursive: true })
    writeFileSync(
      join(outputRoot, 'kids', 'live', 'index.m3u8'),
      '#EXTM3U\n#EXT-X-VERSION:6\n'
    )
    writeFileSync(
      join(outputRoot, 'kids', 'live', 'segment-0000000000001.ts'),
      'segment'
    )
    touches = []
    warms = []
    closes = []
  })

  afterEach(() => rmSync(outputRoot, { recursive: true, force: true }))

  function app(options: { startedAt?: string; workerError?: string; lineup?: boolean } = {}) {
    return createChannelStreamController({
      channels: {
        list: () => ({
          serverTime: new Date(0).toISOString(),
          serverTimeMs: 0,
          channels: [
            {
              id: 'kids',
              name: 'Kids',
              enabled: true,
              timezone: 'UTC',
              onAir: true,
              manuallyOffAir: false,
            },
            {
              id: 'cartoons',
              name: 'Cartoons',
              enabled: true,
              timezone: 'UTC',
              onAir: true,
              manuallyOffAir: false,
            },
            {
              id: 'offline',
              name: 'Offline',
              enabled: true,
              timezone: 'UTC',
              onAir: false,
              manuallyOffAir: true,
            },
          ],
        }),
      },
      workers: {
        touch: async (channelId, clientId) => {
          touches.push({ channelId, clientId })
          return {
            ...(options.startedAt ? { startedAt: options.startedAt } : {}),
          } as never
        },
        warm: async (channelIds, clientId) => {
          warms.push({ channelIds, clientId })
          return channelIds.map((channelId) => ({ channelId })) as never
        },
        getState: () =>
          options.workerError
            ? ({ status: 'error', lastError: options.workerError } as never)
            : null,
      },
      outputRoot,
      ...(options.lineup
        ? {
            lineup: {
              open: async (clientId: string, preferredChannelId?: string) => ({
                clientId,
                channelIds: [preferredChannelId ?? 'kids', 'cartoons'],
                ready: 1,
                pending: 1,
                expiresAt: new Date(0).toISOString(),
              }),
              close: async (clientId: string) => {
                closes.push(clientId)
              },
              snapshot: () => ({
                sessions: [],
                totalSessions: 0,
              }),
            },
          }
        : {}),
    })
  }

  test('renews one named viewer lease and serves the live playlist', async () => {
    const response = await app().request(
      '/api/v1/channels/kids/live/index.m3u8?clientId=living-room-tv'
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain(
      'application/vnd.apple.mpegurl'
    )
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.text()).toContain('#EXTM3U')
    expect(touches).toEqual([
      { channelId: 'kids', clientId: 'living-room-tv' },
    ])
  })

  test('serves immutable segments without inflating viewer leases', async () => {
    const response = await app().request(
      '/api/v1/channels/kids/live/segment-0000000000001.ts'
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('video/mp2t')
    expect(await response.text()).toBe('segment')
    expect(touches).toEqual([])
  })

  test('opens a lineup session on the last channel and reports spin-up progress', async () => {
    const response = await app({ lineup: true }).request('/api/client/v1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'tv-1', lastChannelId: 'kids', lineup: true }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.status).toBe('ready')
    expect(body.streamUrl).toBe('/api/v1/channels/kids/live/index.m3u8')
    expect(body.lineup).toEqual({ total: 2, ready: 1, pending: 1 })
  })

  test('session close releases the client and works without a lineup service', async () => {
    const withLineup = await app({ lineup: true }).request('/api/client/v1/session/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'tv-1' }),
    })
    expect(withLineup.status).toBe(200)
    expect(closes).toEqual(['tv-1'])

    const withoutLineup = await app().request('/api/client/v1/session/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'tv-1' }),
    })
    expect(withoutLineup.status).toBe(200)
  })

  test('answers CORS preflights for the session routes', async () => {
    for (const path of ['/api/client/v1/session', '/api/client/v1/session/close']) {
      const response = await app({ lineup: true }).request(path, { method: 'OPTIONS' })
      expect(response.status).toBe(204)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST')
    }
  })

  test('rejects a session request when no channels are on air', async () => {
    const controller = createChannelStreamController({
      channels: {
        list: () => ({
          serverTime: new Date(0).toISOString(),
          serverTimeMs: 0,
          channels: [
            {
              id: 'kids',
              name: 'Kids',
              enabled: true,
              timezone: 'UTC',
              onAir: false,
              manuallyOffAir: true,
            },
          ],
        }),
      },
      workers: {
        touch: async () => ({}) as never,
        warm: async () => [] as never,
        getState: () => null,
      },
      outputRoot,
      lineup: {
        open: async () => ({
          clientId: 'x',
          channelIds: [],
          ready: 0,
          pending: 0,
          expiresAt: new Date(0).toISOString(),
        }),
        close: async () => {},
        snapshot: () => ({ sessions: [], totalSessions: 0 }),
      },
    })
    const response = await controller.request('/api/client/v1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'tv-1', lineup: true }),
    })
    expect(response.status).toBe(404)
  })

  test('warms at most two configured on-air channels without viewer leases', async () => {
    const response = await app().request('/api/client/v1/channels/warm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'living-room-tv',
        channelIds: ['cartoons', 'offline'],
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ warmed: ['cartoons'] })
    expect(warms).toEqual([
      { channelIds: ['cartoons'], clientId: 'living-room-tv' },
    ])
    expect(touches).toEqual([])
  })

  test('starts the last valid channel and warms the adjacent window', async () => {
    const response = await app().request('/api/client/v1/channels/startup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'living-room-tv',
        lastChannelId: 'cartoons',
        warmAdjacent: true,
      }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      channel: { id: string }
      status: string
      streamUrl: string
      warmed: string[]
    }
    expect(body.channel.id).toBe('cartoons')
    expect(body.status).toBe('ready')
    expect(body.streamUrl).toBe(
      '/api/v1/channels/cartoons/live/index.m3u8'
    )
    expect(touches).toEqual([
      { channelId: 'cartoons', clientId: 'living-room-tv' },
    ])
    expect(warms).toEqual([])
    expect(body.warmed).toEqual([])
  })

  test('falls back from a missing or off-air last channel', async () => {
    const response = await app().request('/api/client/v1/channels/startup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'tv', lastChannelId: 'offline' }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      channel: { id: string }
      fallbackReason: string | null
    }
    expect(body.channel.id).toBe('kids')
    expect(body.fallbackReason).toContain('last channel is no longer available')
    expect(touches).toEqual([{ channelId: 'kids', clientId: 'tv' }])
  })

  test('prepares a destination before the client swaps its video source', async () => {
    const response = await app().request(
      '/api/client/v1/channels/cartoons/prepare',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: 'tv' }),
      }
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      channelId: 'cartoons',
      status: 'ready',
    })
    expect(touches).toEqual([{ channelId: 'cartoons', clientId: 'tv' }])
  })

  test('rejects oversized adjacent-channel warm requests', async () => {
    const response = await app().request('/api/client/v1/channels/warm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'tv',
        channelIds: ['one', 'two', 'three'],
      }),
    })

    expect(response.status).toBe(400)
    expect(warms).toEqual([])
  })

  test('allows only the dedicated credentialless client channel mutations across origins', async () => {
    const guarded = new Hono()
    guarded.use('*', mutationOriginGuard)
    guarded.route('/', app())

    const preflight = await guarded.request('/api/client/v1/channels/warm', {
      method: 'OPTIONS',
      headers: {
        Origin: 'null',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('POST')

    const warm = await guarded.request('/api/client/v1/channels/warm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'null',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ clientId: 'tv', channelIds: ['cartoons'] }),
    })
    expect(warm.status).toBe(200)

    const unrelated = await guarded.request('/api/client/v1/not-warm', {
      method: 'POST',
      headers: { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' },
    })
    expect(unrelated.status).toBe(403)
  })

  test('never serves a stale playlist from before a cold worker start', async () => {
    const response = await app({
      startedAt: '2999-01-01T00:00:00.000Z',
      workerError: 'encoder failed',
    }).request('/api/v1/channels/kids/live/index.m3u8?clientId=tv')

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'encoder failed' })
  })

  test('checks worker failure before accepting a fresh-looking playlist', async () => {
    const response = await app({ workerError: 'encoder exited early' }).request(
      '/api/v1/channels/kids/live/index.m3u8?clientId=tv'
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'encoder exited early' })
  })

  test('stops serving playlists and segments as soon as a channel is off air', async () => {
    expect(
      (
        await app().request(
          '/api/v1/channels/offline/live/index.m3u8?clientId=tv'
        )
      ).status
    ).toBe(404)
    expect(
      (
        await app().request(
          '/api/v1/channels/offline/live/segment-0000000000001.ts'
        )
      ).status
    ).toBe(404)
    expect(touches).toEqual([])
  })

  test('rejects unknown channels and unsafe segment names', async () => {
    expect(
      (
        await app().request(
          '/api/v1/channels/missing/live/index.m3u8?clientId=tv'
        )
      ).status
    ).toBe(404)
    expect(
      (await app().request('/api/v1/channels/kids/live/..%2Fconfig.json')).status
    ).toBe(404)
  })
})
