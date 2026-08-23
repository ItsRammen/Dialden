import { describe, expect, test } from 'bun:test'
import { mock } from 'jest-mock-extended'
import { Hono } from 'hono'
import {
  createChannelController,
  parseChannelSlots,
} from '../src/controllers/ChannelController'
import type { ChannelService } from '../src/services/ChannelService'

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

  test('parses the human-editable schedule format', () => {
    expect(
      parseChannelSlots(
        'mon,tue,wed | 06:30-08:30 | comfort,learning\nsat | 08:00-10:00 | adventure'
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
      },
    ])
  })
})
