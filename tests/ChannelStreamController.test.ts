import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createChannelStreamController, augmentLivePlaylist, isWellFormedPlaylist } from '../src/controllers/ChannelStreamController'
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
      '#EXTM3U\n#EXT-X-VERSION:6\n#EXTINF:1.0,\nsegment-0000000000001.ts\n#EXTINF:1.0,\nsegment-0000000000002.ts\n'
    )
    writeFileSync(
      join(outputRoot, 'kids', 'live', 'segment-0000000000001.ts'),
      'segment'
    )
    writeFileSync(
      join(outputRoot, 'kids', 'live', 'segment-0000000000002.ts'),
      'segment-two'
    )
    touches = []
    warms = []
    closes = []
  })

  afterEach(() => rmSync(outputRoot, { recursive: true, force: true }))

  function app(options: {
    startedAt?: string
    workerError?: string
    workerStatus?:
      | 'starting'
      | 'live'
      | 'transitioning'
      | 'idle'
      | 'error'
      | 'stopped'
    transcoding?: boolean
    lineup?: boolean
  } = {}) {
    const workerStatus =
      options.workerStatus ?? (options.workerError ? 'error' : 'live')
    const transcoding =
      options.transcoding ??
      (workerStatus === 'live' || workerStatus === 'idle')
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
            status: workerStatus,
            transcoding,
            ...(options.workerError ? { lastError: options.workerError } : {}),
          } as never
        },
        warm: async (channelIds, clientId) => {
          warms.push({ channelIds, clientId })
          return channelIds.map((channelId) => ({ channelId })) as never
        },
        getState: () => ({
          status: workerStatus,
          transcoding,
          ...(options.workerError ? { lastError: options.workerError } : {}),
        } as never),
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

  test('injects the live start tag into the served playlist', async () => {
    const response = await app().request(
      '/api/v1/channels/kids/live/index.m3u8?clientId=living-room-tv'
    )
    const body = await response.text()

    expect(body).toContain('#EXTM3U')
    expect(body).toContain('#EXT-X-START:TIME-OFFSET=-2.0,PRECISE=YES')
    expect(body.indexOf('#EXT-X-START')).toBeGreaterThan(-1)
    expect(body.indexOf('#EXT-X-VERSION')).toBeGreaterThan(
      body.indexOf('#EXT-X-START')
    )
  })

  test('playlist augmentation is idempotent and rejects torn text', () => {
    const wellFormed =
      '#EXTM3U\n#EXT-X-VERSION:6\n#EXTINF:1.0,\nsegment-0000000000001.ts\n'
    const once = augmentLivePlaylist(wellFormed)
    expect(once).toContain('#EXT-X-START:TIME-OFFSET=-2.0,PRECISE=YES')
    expect(augmentLivePlaylist(once)).toBe(once)
    expect(augmentLivePlaylist('#EXTM3U\n#EXT-X-START:TIME-OFFSET=0\n')).not.toContain(
      'TIME-OFFSET=-2.0'
    )
    // Torn text passes through untouched; the route retries the read instead.
    const torn = 'EXTM3U without header'
    expect(isWellFormedPlaylist(torn)).toBe(false)
    expect(augmentLivePlaylist(torn)).toBe(torn)
    expect(
      isWellFormedPlaylist(
        '#EXTM3U\n#EXTINF:not-a-duration,\nsegment-0000000000001.ts\n'
      )
    ).toBe(false)
    expect(
      isWellFormedPlaylist(
        '#EXTM3U\n#EXTINF:0,\nsegment-0000000000001.ts\n'
      )
    ).toBe(false)
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

  test('does not report starting or transitioning workers as prepared', async () => {
    for (const workerStatus of ['starting', 'transitioning'] as const) {
      const response = await app({ workerStatus }).request(
        '/api/client/v1/channels/cartoons/prepare',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId: `tv-${workerStatus}` }),
        }
      )

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        channelId: 'cartoons',
        status: 'pending',
      })
    }
  })

  test('requires an active publisher even when a worker status says live', async () => {
    const response = await app({
      workerStatus: 'live',
      transcoding: false,
    }).request('/api/client/v1/channels/cartoons/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'tv' }),
    })

    expect(await response.json()).toMatchObject({ status: 'pending' })
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

  test('stops reading an oversized client body when content length is absent', async () => {
    const request = new Request(
      'http://localhost/api/client/v1/channels/warm',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ padding: 'x'.repeat(8_192) }),
      }
    )
    expect(request.headers.get('content-length')).toBeNull()

    const response = await app().request(request)
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: 'Request body is too large',
    })
  })

  test('allows only the dedicated credentialless client channel mutations across origins', async () => {
    const guarded = new Hono()
    guarded.use('*', mutationOriginGuard)
    guarded.route('/', app({ lineup: true }))

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

    const clientHeaders = {
      'Content-Type': 'application/json',
      Origin: 'null',
      'Sec-Fetch-Site': 'cross-site',
    }
    const session = await guarded.request('/api/client/v1/session', {
      method: 'POST',
      headers: clientHeaders,
      body: JSON.stringify({ clientId: 'tv', lastChannelId: 'kids', lineup: true }),
    })
    expect(session.status).toBe(200)

    const prepare = await guarded.request('/api/client/v1/channels/kids/prepare', {
      method: 'POST',
      headers: clientHeaders,
      body: JSON.stringify({ clientId: 'tv' }),
    })
    expect(prepare.status).toBe(200)

    const close = await guarded.request('/api/client/v1/session/close', {
      method: 'POST',
      headers: clientHeaders,
      body: JSON.stringify({ clientId: 'tv' }),
    })
    expect(close.status).toBe(200)

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

  test('returns 503 when a torn playlist is still incomplete after retry', async () => {
    writeFileSync(
      join(outputRoot, 'kids', 'live', 'index.m3u8'),
      '#EXTM3U\n#EXT-X-VERSION:6\n#EXTINF:1.0,\nsegment-0000000000001.ts\n#EXTINF:1.0,\n'
    )

    const response = await app().request(
      '/api/v1/channels/kids/live/index.m3u8?clientId=tv'
    )

    expect(response.status).toBe(503)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({
      error: 'Channel playlist is incomplete; retry when the live edge is ready',
    })
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
