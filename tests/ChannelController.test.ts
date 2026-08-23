import { describe, expect, test } from 'bun:test'
import { mock } from 'jest-mock-extended'
import { Hono } from 'hono'
import { createChannelController } from '../src/controllers/ChannelController'
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
})
