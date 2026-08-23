import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { applyClientApiCors } from '../src/server'

describe('client API CORS', () => {
  test('allows a packaged-app Range preflight on the read-only v1 API', async () => {
    const app = new Hono()
    applyClientApiCors(app)
    app.get('/api/v1/media/:id/stream', (c) => c.body('media'))

    const response = await app.request('/api/v1/media/7/stream', {
      method: 'OPTIONS',
      headers: {
        Origin: 'null',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'if-range, range',
      },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET')
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('HEAD')
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Range')
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('If-Range')
    expect(response.headers.get('Access-Control-Max-Age')).toBe('86400')
  })

  test('exposes media headers on v1 GET without opening management routes', async () => {
    const app = new Hono()
    applyClientApiCors(app)
    app.get('/api/v1/channels', (c) => c.json({ channels: [] }))
    app.get('/api/media/:id', (c) => c.json({ id: c.req.param('id') }))

    const clientResponse = await app.request('/api/v1/channels', {
      headers: { Origin: 'null' },
    })
    expect(clientResponse.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(clientResponse.headers.get('Access-Control-Expose-Headers')).toContain(
      'Content-Range'
    )

    const managementResponse = await app.request('/api/media/7', {
      headers: { Origin: 'null' },
    })
    expect(managementResponse.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})
