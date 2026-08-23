import { Hono } from 'hono'
import type { ChannelService } from '../services/ChannelService'

interface ChannelControllerDeps {
  channels: ChannelService
}

/** Read-only schedule API for clients such as the future webOS application. */
export function createChannelController({ channels }: ChannelControllerDeps) {
  const controller = new Hono()

  controller.get('/api/v1/channels', (c) => c.json(channels.list()))

  controller.get('/api/v1/channels/:id/now', async (c) => {
    const result = await channels.getNow(c.req.param('id'))
    return result
      ? c.json(result)
      : c.json({ error: 'Channel not found' }, 404)
  })

  controller.get('/api/v1/channels/:id/guide', async (c) => {
    const value = c.req.query('hours')
    if (value !== undefined && !/^\d+$/.test(value)) {
      return c.json({ error: 'hours must be a whole number from 1 to 24' }, 400)
    }
    const hours = value === undefined ? 8 : Number(value)
    if (hours < 1 || hours > 24) {
      return c.json({ error: 'hours must be a whole number from 1 to 24' }, 400)
    }

    const result = await channels.getGuide(c.req.param('id'), hours)
    return result
      ? c.json(result)
      : c.json({ error: 'Channel not found' }, 404)
  })

  return controller
}
