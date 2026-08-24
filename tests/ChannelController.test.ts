import { describe, expect, test } from 'bun:test'
import { mock } from 'jest-mock-extended'
import { Hono } from 'hono'
import {
  createChannelController,
  parseChannelSlots,
} from '../src/controllers/ChannelController'
import type { ChannelService } from '../src/services/ChannelService'
import type { ChannelLogoStore } from '../src/services/ChannelLogoStore'

describe('ChannelController', () => {
  test('serves list and now endpoints and returns 404 for unknown channels', async () => {
    const channels = mock<ChannelService>()
    channels.list.mockReturnValue({
      serverTime: '2026-08-23T22:35:00.000Z',
      serverTimeMs: 1787524500000,
      channels: [
        {
          id: 'kids-club',
          name: 'Kids Club',
          enabled: true,
          timezone: 'Asia/Taipei',
          onAir: true,
          manuallyOffAir: false,
        },
      ],
    })
    channels.getNow.mockResolvedValue(null)
    const app = new Hono().route('/', createChannelController({ channels }))

    const list = await app.request('/api/v1/channels')
    expect(list.status).toBe(200)
    const payload = (await list.json()) as {
      channels: Array<{ id: string }>
    }
    expect(payload.channels[0]?.id).toBe('kids-club')

    const missing = await app.request('/api/v1/channels/missing/now')
    expect(missing.status).toBe(404)
  })

  test('validates guide horizon before querying the schedule', async () => {
    const channels = mock<ChannelService>()
    const app = new Hono().route('/', createChannelController({ channels }))

    for (const query of ['hours=0', 'hours=25', 'hours=2.5', 'hours=oops']) {
      const response = await app.request(
        `/api/v1/channels/kids-club/guide?${query}`
      )
      expect(response.status).toBe(400)
    }
    expect(channels.getGuide).not.toHaveBeenCalled()
  })

  test('publishes one stable channel HLS URL independently of the current item', async () => {
    const channels = mock<ChannelService>()
    const presentationCalls: Array<{ channelId: string; at: Date }> = []
    channels.getNow.mockResolvedValue({
      channelId: 'kids-club',
      serverTime: '2026-08-24T12:00:00.000Z',
      serverTimeMs: 1787572800000,
      timezone: 'UTC',
      timelineRevision: 'revision-1',
      program: null,
      next: null,
    })
    const app = new Hono().route(
      '/',
      createChannelController({
        channels,
        branding: {
          presentation: async (channelId, at) => {
            if (!at) throw new Error('Expected the response server time')
            presentationCalls.push({ channelId, at })
            return { enabled: true, logoUrl: '/channels/kids-club/logo' }
          },
        },
      })
    )

    const response = await app.request('/api/v1/channels/kids-club/now')
    const payload = (await response.json()) as {
      liveStream: { mode: string; url: string }
      branding: { enabled: boolean; logoUrl?: string }
    }

    expect(payload.liveStream).toEqual({
      mode: 'hls',
      url: '/api/v1/channels/kids-club/live/index.m3u8',
    })
    expect(payload.branding).toEqual({
      enabled: true,
      logoUrl: '/channels/kids-club/logo',
    })
    expect(presentationCalls).toEqual([
      {
        channelId: 'kids-club',
        at: new Date(1787572800000),
      },
    ])
  })

  test('validates and creates channels through the guarded admin surface', async () => {
    const channels = mock<ChannelService>()
    channels.create.mockImplementation((channel) => channel)
    const app = new Hono().route('/', createChannelController({ channels }))
    const input = {
      id: 'cartoon-classics',
      name: 'Cartoon Classics',
      enabled: true,
      timezone: 'America/New_York',
      slots: [
        {
          days: ['sat'],
          start: '08:00',
          end: '10:00',
          groups: ['comfort'],
        },
      ],
    }

    const response = await app.request('/api/admin/v1/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    expect(response.status).toBe(201)
    expect(channels.create).toHaveBeenCalledWith(input)

    const invalid = await app.request('/api/admin/v1/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, timezone: 'not-a-timezone' }),
    })
    expect(invalid.status).toBe(400)
  })

  test('accepts numeric collection IDs in the station preview JSON API', async () => {
    const channels = mock<ChannelService>()
    channels.previewAutomatedStationBuild.mockResolvedValue({
      collections: [],
      collectionCount: 0,
      eligibleFiles: 0,
    })
    const app = new Hono().route('/', createChannelController({ channels }))

    const response = await app.request(
      '/api/admin/v1/channels/auto-build/preview',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'custom-station',
          name: 'Custom Station',
          timezone: 'UTC',
          preset: 'custom',
          airtime: 'evening',
          collectionIds: [42],
          marathon: { enabled: true, frequency: 10, episodeCount: 5 },
        }),
      }
    )

    expect(response.status).toBe(200)
    expect(channels.previewAutomatedStationBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        collectionIds: [42],
        preset: 'custom',
        airtime: 'evening',
        marathon: { enabled: true, frequency: 10, episodeCount: 5 },
      })
    )
  })

  test('creates an all-day station directly from the browser builder', async () => {
    const channels = mock<ChannelService>()
    const app = new Hono().route('/', createChannelController({ channels }))
    const body = new URLSearchParams({
      action: 'create',
      id: 'all-shows',
      name: 'All Shows',
      timezone: 'Asia/Taipei',
      preset: 'all-approved-tv',
      airtime: 'all-day',
      marathonEnabled: 'true',
      marathonFrequency: '12',
      marathonEpisodeCount: '4',
    })

    const response = await app.request('/channels/auto-build', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/channels?changed=generated')
    expect(channels.createAutomatedStation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'all-shows',
        preset: 'all-approved-tv',
        airtime: 'all-day',
        marathon: { enabled: true, frequency: 12, episodeCount: 4 },
      })
    )
  })

  test('applies a confirmed Auto setup preset to an existing channel', async () => {
    const channels = mock<ChannelService>()
    const changes: Array<{ id: string; mode: string }> = []
    channels.updateAutomatedStation.mockResolvedValue({
      channel: {
        id: 'kids-club',
        name: 'Kids Club',
        enabled: true,
        timezone: 'Asia/Taipei',
        slots: [],
      },
      collections: [],
      collectionCount: 1,
      eligibleFiles: 12,
    })
    channels.list.mockReturnValue({
      serverTime: new Date(0).toISOString(),
      serverTimeMs: 0,
      channels: [
        {
          id: 'kids-club',
          name: 'Kids Club',
          enabled: true,
          timezone: 'Asia/Taipei',
          onAir: true,
          manuallyOffAir: false,
        },
      ],
    })
    const app = new Hono().route(
      '/',
      createChannelController({
        channels,
        onChannelChanged: (id, mode) => {
          changes.push({ id, mode })
        },
      })
    )
    const body = new URLSearchParams({
      action: 'update',
      targetChannelId: 'kids-club',
      confirmReplace: 'yes',
      id: 'kids-club',
      name: 'Kids Club',
      timezone: 'Asia/Taipei',
      preset: 'family-animation',
      airtime: 'all-day',
    })

    const response = await app.request('/channels/auto-build', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/channels?changed=updated')
    expect(channels.updateAutomatedStation).toHaveBeenCalledWith(
      'kids-club',
      expect.objectContaining({
        id: 'kids-club',
        preset: 'family-animation',
        airtime: 'all-day',
      })
    )
    expect(changes).toEqual([{ id: 'kids-club', mode: 'restart' }])
  })

  test('deactivates the stream immediately when a channel is taken off air', async () => {
    const channels = mock<ChannelService>()
    const changes: Array<{ id: string; mode: string }> = []
    channels.setOnAir.mockReturnValue(true)
    channels.list.mockReturnValue({
      serverTime: new Date(0).toISOString(),
      serverTimeMs: 0,
      channels: [
        {
          id: 'kids-club',
          name: 'Kids Club',
          enabled: true,
          timezone: 'UTC',
          onAir: false,
          manuallyOffAir: true,
        },
      ],
    })
    const app = new Hono().route(
      '/',
      createChannelController({
        channels,
        onChannelChanged: (id, mode) => {
          changes.push({ id, mode })
        },
      })
    )

    const response = await app.request(
      '/api/admin/v1/channels/kids-club/off-air',
      { method: 'POST' }
    )

    expect(response.status).toBe(200)
    expect(changes).toEqual([{ id: 'kids-club', mode: 'deactivate' }])
  })

  test('uploads channel branding and restarts only the edited channel', async () => {
    const channels = mock<ChannelService>()
    const logos = mock<ChannelLogoStore>()
    const restarted: string[] = []
    channels.update.mockReturnValue({
      id: 'kids-club',
      name: 'Kids Club',
      enabled: true,
      timezone: 'UTC',
      slots: [
        { days: ['mon'], start: '06:00', end: '08:00', groups: ['kids'] },
      ],
      branding: {
        mode: 'custom',
        opacity: 204,
        position: 8,
        x: 20,
        y: 20,
        sizePercent: 14,
      },
    })
    const app = new Hono().route(
      '/',
      createChannelController({
        channels,
        logos,
        onBrandingUpdated: async (id) => {
          restarted.push(id)
        },
      })
    )
    const body = new FormData()
    body.set('id', 'kids-club')
    body.set('name', 'Kids Club')
    body.set('timezone', 'UTC')
    body.set('enabled', 'on')
    body.set('slots', 'mon | 06:00-08:00 | kids')
    body.set('brandingMode', 'custom')
    body.set('brandingBurnIn', 'true')
    body.set('brandingOpacity', '204')
    body.set('brandingPosition', '8')
    body.set('brandingX', '20')
    body.set('brandingY', '20')
    body.set('brandingSizePercent', '14')
    body.set('marathonEnabled', 'true')
    body.set('marathonFrequency', '8')
    body.set('marathonEpisodeCount', '3')
    body.set(
      'brandingLogo',
      new File(
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
        'kids.png',
        { type: 'image/png' }
      )
    )

    const response = await app.request('/channels/kids-club', {
      method: 'POST',
      body,
    })

    expect(response.status).toBe(303)
    expect(logos.save).toHaveBeenCalledWith('kids-club', expect.any(File))
    expect(channels.update).toHaveBeenCalledWith(
      'kids-club',
      expect.objectContaining({
        branding: expect.objectContaining({
          mode: 'custom',
          burnIn: true,
          position: 8,
        }),
        marathon: { enabled: true, frequency: 8, episodeCount: 3 },
      })
    )
    expect(restarted).toEqual(['kids-club'])
  })

  test('saves the dedicated branding modal without replacing schedule settings', async () => {
    const channels = mock<ChannelService>()
    const logos = mock<ChannelLogoStore>()
    const existing = {
      id: 'kids-club',
      name: 'Kids Club',
      enabled: true,
      timezone: 'UTC',
      slots: [
        { days: ['mon' as const], start: '06:00', end: '08:00', groups: ['kids'] },
      ],
    }
    channels.administrationSnapshot.mockReturnValue({
      channels: [existing],
      manuallyOffAir: [],
      programmingGroups: ['kids'],
      configurationError: null,
    })
    channels.update.mockImplementation((_id, channel) => channel)
    const restarted: string[] = []
    const app = new Hono().route(
      '/',
      createChannelController({
        channels,
        logos,
        onBrandingUpdated: (id) => {
          restarted.push(id)
        },
      })
    )
    const body = new FormData()
    body.set('brandingMode', 'custom')
    body.set('brandingOpacity', '180')
    body.set('brandingPosition', '8')
    body.set('brandingX', '16')
    body.set('brandingY', '20')
    body.set('brandingSizePercent', '15')
    body.set(
      'brandingLogo',
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'kids.png', {
        type: 'image/png',
      })
    )

    const response = await app.request('/channels/kids-club/branding', {
      method: 'POST',
      body,
    })

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(
      '/channels?changed=updated&edit=kids-club#editor'
    )
    expect(logos.save).toHaveBeenCalledWith('kids-club', expect.any(File))
    expect(channels.update).toHaveBeenCalledWith(
      'kids-club',
      expect.objectContaining({
        slots: existing.slots,
        branding: expect.objectContaining({
          mode: 'custom',
          opacity: 180,
          position: 8,
        }),
      })
    )
    expect(restarted).toEqual([])
  })

  test('keeps channel administration available when automation catalog loading fails', async () => {
    const channels = mock<ChannelService>()
    channels.administrationSnapshot.mockReturnValue({
      channels: [],
      manuallyOffAir: [],
      programmingGroups: [],
      configurationError: null,
    })
    channels.stationAutomationCatalog.mockRejectedValue(
      new Error('database busy')
    )
    const app = new Hono().route('/', createChannelController({ channels }))

    const response = await app.request('/channels')

    expect(response.status).toBe(200)
    expect(await response.text()).toContain(
      'Station automation catalog unavailable: database busy'
    )
  })

  test('parses the human-editable schedule format', () => {
    expect(
      parseChannelSlots(
        'mon,tue,wed | 06:30-08:30 | comfort,learning\nsat | 08:00-10:00 | adventure | custom:nick'
      )
    ).toEqual([
      {
        days: ['mon', 'tue', 'wed'],
        start: '06:30',
        end: '08:30',
        groups: ['comfort', 'learning'],
      },
      {
        days: ['sat'],
        start: '08:00',
        end: '10:00',
        groups: ['adventure'],
        branding: { mode: 'custom', logoId: 'nick' },
      },
    ])
  })
})
