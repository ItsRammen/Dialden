import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { mock } from 'jest-mock-extended'
import { createHealthController } from '../src/controllers/HealthController'
import type { IMediaRepository } from '../src/repositories/IMediaRepository'

describe('HealthController', () => {
  test('returns ok when SQLite and the FFmpeg toolchain are ready', async () => {
    const database = mock<IMediaRepository>()
    database.getAllSettings.mockResolvedValue({})
    const controller = createHealthController({
      database,
      checkFfmpeg: async () => true,
    })
    const app = new Hono()
    app.route('/', controller)

    const response = await app.request('/api/v1/health')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({
      status: 'ok',
      database: 'ok',
      ffmpeg: 'ok',
    })
  })

  test('returns degraded when a required dependency is unavailable', async () => {
    const database = mock<IMediaRepository>()
    database.getAllSettings.mockRejectedValue(new Error('database unavailable'))
    const controller = createHealthController({
      database,
      checkFfmpeg: async () => false,
    })
    const app = new Hono()
    app.route('/', controller)

    const response = await app.request('/api/v1/health')
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toEqual({
      status: 'degraded',
      database: 'error',
      ffmpeg: 'unavailable',
    })
  })
})
