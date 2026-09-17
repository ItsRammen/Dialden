import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { PlaybackHealthService } from '../src/services/PlaybackHealthService'

test('records bounded, session-specific HLS response setup and expiry without URLs', async () => {
  let now = 1000
  const health = new PlaybackHealthService(() => now, false)
  const app = new Hono()
  app.use('*', health.middleware)
  app.get('/api/v1/tuner-sessions/:session/live/:segment', c => { now += 120; return c.text('missing', 404) })
  health.recordLag(400)
  await app.request('/api/v1/tuner-sessions/a/live/secret.ts?token=secret')
  expect(health.snapshot('nick', 'a')).toMatchObject({ hlsRequests60s: 1, hlsNotFound60s: 1, hlsErrors60s: 1, hlsMaxResponseSetupMs60s: 120, serverEventLoopMaxDelayMs60s: 400, hlsLastSegmentResponseAgeMs: -1 })
  expect(health.snapshot('nick', 'b').hlsRequests60s).toBe(0)
  expect(JSON.stringify(health.snapshot('nick', 'a'))).not.toContain('secret')
  now += 61000
  expect(health.snapshot('nick', 'a')).toMatchObject({ hlsRequests60s: 0, serverEventLoopMaxDelayMs60s: 0 })
})

test('records successful segment age separately from manifest responses', async () => {
  let now = 1000
  const health = new PlaybackHealthService(() => now, false)
  const app = new Hono()
  app.use('*', health.middleware)
  app.get('/api/v1/channels/:id/live/:segment', c => c.text('ok'))
  await app.request('/api/v1/channels/nick/live/segment.ts')
  now += 500
  await app.request('/api/v1/channels/nick/live/index.m3u8')
  expect(health.snapshot('nick')).toMatchObject({ hlsRequests60s: 2, hlsErrors60s: 0, hlsLastSegmentResponseAgeMs: 500 })
})
