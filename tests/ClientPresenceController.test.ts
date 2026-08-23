import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import {
  ADMIN_CLIENT_PRESENCE_ROUTE,
  CLIENT_HEARTBEAT_ROUTE,
  createClientPresenceController,
} from '../src/controllers/ClientPresenceController'
import { ClientPresenceService } from '../src/services/ClientPresenceService'

function createApp(now = 1_700_000_000_000): {
  app: Hono
  presence: ClientPresenceService
} {
  const app = new Hono()
  const presence = new ClientPresenceService({ now: () => now })
  app.route('/', createClientPresenceController({ presence }))
  return { app, presence }
}

describe('client presence API', () => {
  test('accepts a validated credentialless heartbeat without retaining extras', async () => {
    const { app } = createApp()
    const response = await app.request(CLIENT_HEARTBEAT_ROUTE, {
      method: 'POST',
      headers: {
        Origin: 'null',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientId: 'webos-abcd1234',
        name: 'LG webOS TV',
        channelId: 'kids',
        playbackMode: 'direct-play',
        tmdbApiKey: 'must-not-be-stored',
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({
      ok: true,
      clientId: 'webos-abcd1234',
      serverTimeMs: 1_700_000_000_000,
      heartbeatIntervalMs: 15_000,
    })

    const admin = await app.request(ADMIN_CLIENT_PRESENCE_ROUTE, {
      headers: { Origin: 'https://untrusted.example' },
    })
    const text = await admin.text()
    expect(admin.status).toBe(200)
    expect(admin.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(text).not.toContain('must-not-be-stored')
    expect(JSON.parse(text)).toMatchObject({
      connectedClients: 1,
      activeViewers: 1,
      viewersByChannel: { kids: 1 },
    })
  })

  test('limits CORS to the exact heartbeat route', async () => {
    const { app } = createApp()
    const preflight = await app.request(CLIENT_HEARTBEAT_ROUTE, {
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
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain(
      'Content-Type'
    )

    const adjacent = await app.request('/api/client/v1/not-heartbeat', {
      headers: { Origin: 'null' },
    })
    expect(adjacent.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  test('rejects invalid, non-JSON, and oversized heartbeat bodies', async () => {
    const { app } = createApp()
    const invalid = await app.request(CLIENT_HEARTBEAT_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'bad/id',
        name: 'TV',
        channelId: null,
        playbackMode: 'idle',
      }),
    })
    expect(invalid.status).toBe(400)

    const wrongType = await app.request(CLIENT_HEARTBEAT_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    })
    expect(wrongType.status).toBe(415)

    const oversized = await app.request(CLIENT_HEARTBEAT_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(2_100) }),
    })
    expect(oversized.status).toBe(413)
  })
})
