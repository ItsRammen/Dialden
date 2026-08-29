/**
 * SettingsController Tests
 *
 * Verifies API endpoints for config updates and validation.
 */

import { describe, expect, test, beforeEach } from 'bun:test'
import { mock, type MockProxy } from 'jest-mock-extended'
import { createSettingsController } from '../src/controllers/SettingsController'
import type { ConfigService } from '../src/services/ConfigService'
import type { MediaService } from '../src/services/MediaService'
import type { UpdateService } from '../src/services/UpdateService'
import { Hono } from 'hono'

describe('SettingsController', () => {
  let configService: MockProxy<ConfigService>
  let mediaService: MockProxy<MediaService>
  let updateService: MockProxy<UpdateService>
  let app: Hono

  beforeEach(() => {
    configService = mock<ConfigService>()
    mediaService = mock<MediaService>()
    updateService = mock<UpdateService>()
    Object.defineProperty(updateService, 'currentVersion', { value: '0.8.0' })
    Object.defineProperty(updateService, 'isEnabled', { value: false })

    const controller = createSettingsController({
      config: configService,
      media: mediaService,
      update: updateService,
    })

    app = new Hono()
    app.route('/', controller)
  })

  test('POST /api/config parses form data correctly', async () => {
    const formData = new FormData()
    formData.append('serverPort', '8080')
    formData.append('sessionLimit', '120')
    formData.append('interludeEnabled', 'true')
    formData.append('interludeFrequency', '2')
    formData.append('mpvSocket', '/tmp/updated.sock')
    formData.append('logoOpacity', '255')
    formData.append('safetyScanIntervalMinutes', '10')

    const req = new Request('http://localhost/api/config', {
      method: 'POST',
      body: formData,
    })

    const res = await app.request(req)

    expect(res.status).toBe(200)

    // Verify update call
    expect(configService.update).toHaveBeenCalledWith(
      expect.objectContaining({
        server: { port: 8080 },
        session: expect.objectContaining({ limitMinutes: 120 }),
        interlude: { enabled: true, frequency: 2 },
        mpv: expect.objectContaining({ ipcSocket: '/tmp/updated.sock' }),
        logo: expect.objectContaining({ opacity: 255 }),
        library: { safetyScanIntervalMinutes: 10 },
      })
    )
  })

  test('POST /api/config handles invalid numbers securely', async () => {
    const formData = new FormData()
    formData.append('serverPort', 'invalid') // should fallback
    formData.append('sessionLimit', '') // should determine 0 or fallback
    formData.append('logoX', 'NaN')

    const req = new Request('http://localhost/api/config', {
      method: 'POST',
      body: formData,
    })

    await app.request(req)

    expect(configService.update).toHaveBeenCalledWith(
      expect.objectContaining({
        server: { port: 1993 }, // fallback
        session: expect.objectContaining({ limitMinutes: 0 }),
        logo: expect.objectContaining({ x: 8 }), // fallback
      })
    )
  })

  test('GET /api/config returns JSON', async () => {
    configService.get.mockResolvedValue({
      server: { port: 3000 },
    } as any)

    const req = new Request('http://localhost/api/config')
    const res = await app.request(req)

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ server: { port: 3000 } })
  })

  test('headless settings do not overwrite the hidden legacy MPV configuration', async () => {
    const controller = createSettingsController({
      config: configService,
      media: mediaService,
      update: updateService,
      localPlaybackEnabled: false,
    })
    const local = new Hono().route('/', controller)

    await local.request('/api/config', {
      method: 'POST',
      body: new URLSearchParams({ serverPort: '1993' }),
    })

    expect(configService.update).toHaveBeenCalledTimes(1)
    expect(configService.update.mock.calls[0]![0]).not.toHaveProperty('mpv')
  })

  test('persists and applies the library safety-scan interval', async () => {
    const applied: number[] = []
    const controller = createSettingsController({
      config: configService,
      media: mediaService,
      update: updateService,
      onLibraryMonitoringUpdated: (minutes) => applied.push(minutes),
    })
    const local = new Hono().route('/', controller)
    await local.request('/api/config', {
      method: 'POST',
      body: new URLSearchParams({
        serverPort: '1993',
        safetyScanIntervalMinutes: '30',
      }),
    })

    expect(configService.update).toHaveBeenCalledWith(
      expect.objectContaining({
        library: { safetyScanIntervalMinutes: 30 },
      })
    )
    expect(applied).toEqual([30])
  })

  test('GET /settings renders the resolved transcoding backend status', async () => {
    configService.get.mockResolvedValue({
      server: { port: 1993 },
      session: {
        limitMinutes: 60,
        resetHour: 6,
        offAirAssetId: null,
        introVideoId: null,
        outroVideoId: null,
      },
      interlude: { enabled: true, frequency: 2 },
      mpv: { ipcSocket: '/tmp/toasttv.sock' },
      logo: {
        enabled: false,
        imagePath: null,
        opacity: 128,
        position: 2,
        x: 8,
        y: 8,
      },
      detection: { cecEnabled: false, heartbeatIntervalMs: 30_000 },
      playback: { safeMode: true },
      library: { safetyScanIntervalMinutes: 15 },
    })
    mediaService.getMediaDirectory.mockReturnValue('/media')
    const controller = createSettingsController({
      config: configService,
      media: mediaService,
      update: updateService,
      transcodingStatus: {
        configuredMode: 'intel-qsv',
        activeBackend: 'intel-qsv',
        hardwareAcceleration: true,
        device: '/dev/dri/renderD128',
      },
    })
    const local = new Hono().route('/', controller)

    const response = await local.request('/settings')
    const markup = await response.text()

    expect(response.status).toBe(200)
    expect(markup).toContain('Hardware transcoding is enabled and active.')
    expect(markup).toContain('/dev/dri/renderD128')
  })

  test('refreshes inherited live channel branding after settings save', async () => {
    const refreshed: string[] = []
    const controller = createSettingsController({
      config: configService,
      media: mediaService,
      update: updateService,
      onLogoUpdated: async () => {
        refreshed.push('logo')
      },
    })
    const local = new Hono().route('/', controller)

    const response = await local.request('/api/config', {
      method: 'POST',
      body: new URLSearchParams({ serverPort: '1993' }),
    })

    expect(response.status).toBe(200)
    expect(refreshed).toEqual(['logo'])
  })
})
