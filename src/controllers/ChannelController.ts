import { Hono } from 'hono'
import {
  validateLibraryChannels,
  type ChannelScheduleSlot,
  type LibraryChannelPolicy,
} from '../config/library'
import type { ChannelService } from '../services/ChannelService'
import { renderChannelAdministration } from '../templates/channelAdministration'

interface ChannelControllerDeps {
  channels: ChannelService
}

/** Schedule API, same-origin channel administration, and browser editor. */
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

  controller.get('/api/admin/v1/channels', (c) =>
    c.json(channels.administrationSnapshot())
  )

  controller.post('/api/admin/v1/channels', async (c) => {
    try {
      const channel = channels.create(await readJsonChannel(c.req.raw))
      return c.json({ channel }, 201)
    } catch (error) {
      return c.json({ error: safeMessage(error) }, 400)
    }
  })

  controller.put('/api/admin/v1/channels/:id', async (c) => {
    try {
      const channel = channels.update(
        c.req.param('id'),
        await readJsonChannel(c.req.raw)
      )
      return channel
        ? c.json({ channel })
        : c.json({ error: 'Channel not found' }, 404)
    } catch (error) {
      return c.json({ error: safeMessage(error) }, 400)
    }
  })

  controller.delete('/api/admin/v1/channels/:id', (c) => {
    try {
      return channels.delete(c.req.param('id'))
        ? c.json({ deleted: true })
        : c.json({ error: 'Channel not found' }, 404)
    } catch (error) {
      return c.json({ error: safeMessage(error) }, 500)
    }
  })

  controller.post('/api/admin/v1/channels/:id/enabled', async (c) => {
    try {
      const value = (await c.req.json()) as { enabled?: unknown }
      if (typeof value.enabled !== 'boolean') {
        return c.json({ error: 'enabled must be a boolean' }, 400)
      }
      return channels.setEnabled(c.req.param('id'), value.enabled)
        ? c.json({ channelId: c.req.param('id'), enabled: value.enabled })
        : c.json({ error: 'Channel not found' }, 404)
    } catch (error) {
      return c.json({ error: safeMessage(error) }, 400)
    }
  })

  controller.post('/api/admin/v1/channels/:id/on-air', (c) => {
    try {
      return channels.setOnAir(c.req.param('id'), true)
        ? c.json({ channelId: c.req.param('id'), onAir: true })
        : c.json({ error: 'Channel not found' }, 404)
    } catch (error) {
      return c.json({ error: safeMessage(error) }, 500)
    }
  })

  controller.post('/api/admin/v1/channels/:id/off-air', (c) => {
    try {
      return channels.setOnAir(c.req.param('id'), false)
        ? c.json({ channelId: c.req.param('id'), onAir: false })
        : c.json({ error: 'Channel not found' }, 404)
    } catch (error) {
      return c.json({ error: safeMessage(error) }, 500)
    }
  })

  controller.get('/channels', (c) => {
    const changed = c.req.query('changed')
    return c.html(
      renderChannelAdministration(channels.administrationSnapshot(), {
        editId: c.req.query('edit'),
        changed:
          changed === 'created' || changed === 'updated' || changed === 'deleted'
            ? changed
            : undefined,
      })
    )
  })

  controller.post('/channels', async (c) => {
    try {
      channels.create(await readFormChannel(c.req.raw))
      return c.redirect('/channels?changed=created', 303)
    } catch (error) {
      return c.html(
        renderChannelAdministration(channels.administrationSnapshot(), {
          error: safeMessage(error),
        }),
        400
      )
    }
  })

  controller.post('/channels/:id', async (c) => {
    try {
      const id = c.req.param('id')
      const channel = channels.update(id, await readFormChannel(c.req.raw))
      if (!channel) return c.text('Channel not found', 404)
      return c.redirect('/channels?changed=updated', 303)
    } catch (error) {
      return c.html(
        renderChannelAdministration(channels.administrationSnapshot(), {
          editId: c.req.param('id'),
          error: safeMessage(error),
        }),
        400
      )
    }
  })

  controller.post('/channels/:id/enabled', async (c) => {
    try {
      const body = await c.req.parseBody()
      const enabled = textValue(body.enabled) === 'true'
      return channels.setEnabled(c.req.param('id'), enabled)
        ? c.redirect('/channels?changed=updated', 303)
        : c.text('Channel not found', 404)
    } catch (error) {
      return c.text(safeMessage(error), 500)
    }
  })

  controller.post('/channels/:id/delete', (c) => {
    try {
      return channels.delete(c.req.param('id'))
        ? c.redirect('/channels?changed=deleted', 303)
        : c.text('Channel not found', 404)
    } catch (error) {
      return c.text(safeMessage(error), 500)
    }
  })

  controller.post('/channels/:id/on-air', (c) => {
    try {
      return channels.setOnAir(c.req.param('id'), true)
        ? c.redirect('/', 303)
        : c.text('Channel not found', 404)
    } catch (error) {
      return c.text(safeMessage(error), 500)
    }
  })

  controller.post('/channels/:id/off-air', (c) => {
    try {
      return channels.setOnAir(c.req.param('id'), false)
        ? c.redirect('/', 303)
        : c.text('Channel not found', 404)
    } catch (error) {
      return c.text(safeMessage(error), 500)
    }
  })

  return controller
}

async function readJsonChannel(request: Request): Promise<LibraryChannelPolicy> {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.startsWith('application/json')) {
    throw new Error('Content-Type must be application/json')
  }
  let value: unknown
  try {
    value = await request.json()
  } catch {
    throw new Error('Request body must contain valid JSON')
  }
  return validateLibraryChannels([value])[0] as LibraryChannelPolicy
}

async function readFormChannel(request: Request): Promise<LibraryChannelPolicy> {
  const data = await request.formData()
  const value = {
    id: textValue(data.get('id')),
    name: textValue(data.get('name')),
    timezone: textValue(data.get('timezone')),
    enabled: data.get('enabled') !== null,
    slots: parseChannelSlots(textValue(data.get('slots'))),
  }
  return validateLibraryChannels([value])[0] as LibraryChannelPolicy
}

export function parseChannelSlots(value: string): ChannelScheduleSlot[] {
  if (value.length > 50_000) throw new Error('Schedule text is too long')
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.map((line, index) => {
    const parts = line.split('|').map((part) => part.trim())
    if (parts.length !== 3) {
      throw new Error(`Schedule line ${index + 1} must contain days, time, and groups`)
    }
    const time = /^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/.exec(parts[1] ?? '')
    if (!time) {
      throw new Error(`Schedule line ${index + 1} has an invalid time range`)
    }
    return {
      days: (parts[0] ?? '').split(',').map((day) => day.trim().toLowerCase()),
      start: time[1] as string,
      end: time[2] as string,
      groups: (parts[2] ?? '').split(',').map((group) => group.trim()),
    } as ChannelScheduleSlot
  })
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
