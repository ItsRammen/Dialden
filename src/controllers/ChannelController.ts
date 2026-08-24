import { Hono } from 'hono'
import {
  validateLibraryChannels,
  type ChannelScheduleSlot,
  type LibraryChannelPolicy,
} from '../config/library'
import type { ChannelService } from '../services/ChannelService'
import type { ChannelLogoStore } from '../services/ChannelLogoStore'
import type { StationBuildRequest } from '../services/ChannelService'
import type {
  StationAirtimeId,
  StationPresetId,
} from '../services/StationAutomationService'
import { renderChannelAdministration } from '../templates/channelAdministration'

interface ChannelControllerDeps {
  channels: ChannelService
  logos?: ChannelLogoStore
  onBrandingUpdated?: (channelId: string) => Promise<void> | void
}

/** Schedule API, same-origin channel administration, and browser editor. */
export function createChannelController({
  channels,
  logos,
  onBrandingUpdated,
}: ChannelControllerDeps) {
  const controller = new Hono()

  controller.get('/api/v1/channels', (c) => c.json(channels.list()))

  controller.get('/api/v1/channels/:id/now', async (c) => {
    const channelId = c.req.param('id')
    const result = await channels.getNow(channelId)
    return result
      ? c.json({
          ...result,
          liveStream: {
            mode: 'hls' as const,
            url: `/api/v1/channels/${encodeURIComponent(channelId)}/live/index.m3u8`,
          },
        })
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

  controller.post('/api/admin/v1/channels/auto-build/preview', async (c) => {
    try {
      const request = await readJsonStationRequest(c.req.raw)
      return c.json({
        preview: await channels.previewAutomatedStationBuild(request),
      })
    } catch (error) {
      return c.json({ error: safeMessage(error) }, 400)
    }
  })

  controller.post('/api/admin/v1/channels/auto-build', async (c) => {
    try {
      const request = await readJsonStationRequest(c.req.raw)
      return c.json(
        { result: await channels.createAutomatedStation(request) },
        201
      )
    } catch (error) {
      return c.json({ error: safeMessage(error) }, 400)
    }
  })

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
      const id = c.req.param('id')
      const channel = channels.update(
        id,
        await readJsonChannel(c.req.raw)
      )
      if (!channel) return c.json({ error: 'Channel not found' }, 404)
      await onBrandingUpdated?.(id)
      return c.json({ channel })
    } catch (error) {
      return c.json({ error: safeMessage(error) }, 400)
    }
  })

  controller.delete('/api/admin/v1/channels/:id', (c) => {
    try {
      const id = c.req.param('id')
      if (!channels.delete(id)) return c.json({ error: 'Channel not found' }, 404)
      logos?.remove(id)
      return c.json({ deleted: true })
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

  controller.get('/channels', async (c) => {
    const changed = c.req.query('changed')
    const builder = textValue(c.req.query('builder'))
    const automationTargetId =
      builder && builder !== 'create' ? builder : undefined
    let automationDraft: StationBuildRequest | undefined
    if (automationTargetId) {
      try {
        automationDraft = await channels.stationAutomationDraft(
          automationTargetId
        )
      } catch {
        // The catalog surface below reports catalog failures without taking
        // the rest of channel administration offline.
      }
    }
    return c.html(
      renderChannelAdministration(channels.administrationSnapshot(), {
        ...(await automationSurface(channels)),
        editId: c.req.query('edit'),
        newChannel: c.req.query('new') === 'manual',
        automationTargetId,
        automationDraft,
        automationOpen: builder === 'create' || Boolean(builder),
        automationSearch: readCatalogSearch(c.req.query('catalogSearch')),
        channelLogoIds: channelLogoIds(channels, logos),
        channelLogoVariants: channelLogoVariants(channels, logos),
        changed:
          changed === 'created' ||
          changed === 'updated' ||
          changed === 'deleted' ||
          changed === 'generated'
            ? changed
            : undefined,
      })
    )
  })

  controller.post('/channels/auto-build', async (c) => {
    let request: StationBuildRequest | undefined
    let automationSearch = ''
    let automationTargetId: string | undefined
    try {
      const data = await c.req.formData()
      automationSearch = readCatalogSearch(textValue(data.get('catalogSearch')))
      automationTargetId = textValue(data.get('targetChannelId')) || undefined
      request = readFormStationRequest(data)
      const action = textValue(data.get('action'))
      if (action === 'search' || action === 'clear-search') {
        if (action === 'clear-search') automationSearch = ''
        return c.html(
          renderChannelAdministration(channels.administrationSnapshot(), {
            ...(await automationSurface(channels)),
            automationDraft: request,
            automationSearch,
            automationOpen: true,
            automationTargetId,
          })
        )
      }
      if (action === 'create') {
        await channels.createAutomatedStation(request)
        return c.redirect('/channels?changed=generated', 303)
      }
      if (action === 'update') {
        if (!automationTargetId) throw new Error('Choose a channel to update')
        if (textValue(data.get('confirmReplace')) !== 'yes') {
          throw new Error(
            'Confirm that Auto setup may replace this channel’s current schedule and automated library selection.'
          )
        }
        const result = await channels.updateAutomatedStation(
          automationTargetId,
          request
        )
        if (!result) return c.text('Channel not found', 404)
        return c.redirect('/channels?changed=updated', 303)
      }
      const preview = automationTargetId
        ? await channels.previewAutomatedStationUpdate(
            automationTargetId,
            request
          )
        : await channels.previewAutomatedStationBuild(request)
      return c.html(
        renderChannelAdministration(channels.administrationSnapshot(), {
          ...(await automationSurface(channels)),
          automationDraft: request,
          automationPreview: preview,
          automationSearch,
          automationOpen: true,
          automationTargetId,
        })
      )
    } catch (error) {
      return c.html(
        renderChannelAdministration(channels.administrationSnapshot(), {
          ...(await automationSurface(channels)),
          automationDraft: request,
          automationSearch,
          automationOpen: true,
          automationTargetId,
          error: safeMessage(error),
        }),
        400
      )
    }
  })

  controller.post('/channels', async (c) => {
    try {
      const { channel } = await readFormChannel(c.req.raw)
      channels.create(channel)
      return c.redirect('/channels?changed=created', 303)
    } catch (error) {
      return c.html(
        renderChannelAdministration(channels.administrationSnapshot(), {
          ...(await automationSurface(channels)),
          newChannel: true,
          error: safeMessage(error),
        }),
        400
      )
    }
  })

  controller.post('/channels/:id', async (c) => {
    try {
      const id = c.req.param('id')
      const { channel: input, logo, scheduledLogos } = await readFormChannel(c.req.raw)
      if (logo && logos) await logos.save(id, logo)
      if (logos) {
        for (const scheduled of scheduledLogos) {
          await logos.save(id, scheduled.file, scheduled.id)
        }
      }
      const channel = channels.update(id, input)
      if (!channel) return c.text('Channel not found', 404)
      await onBrandingUpdated?.(id)
      return c.redirect('/channels?changed=updated', 303)
    } catch (error) {
      return c.html(
        renderChannelAdministration(channels.administrationSnapshot(), {
          ...(await automationSurface(channels)),
          editId: c.req.param('id'),
          channelLogoIds: channelLogoIds(channels, logos),
          channelLogoVariants: channelLogoVariants(channels, logos),
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
      const id = c.req.param('id')
      if (!channels.delete(id)) return c.text('Channel not found', 404)
      logos?.remove(id)
      return c.redirect('/channels?changed=deleted', 303)
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

async function readJsonStationRequest(
  request: Request
): Promise<StationBuildRequest> {
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
  if (!value || typeof value !== 'object') {
    throw new Error('Station request must be an object')
  }
  const candidate = value as Record<string, unknown>
  return normalizeStationRequest({
    id: candidate.id,
    name: candidate.name,
    timezone: candidate.timezone,
    preset: candidate.preset,
    airtime: candidate.airtime,
    collectionIds: candidate.collectionIds,
    genres: candidate.genres,
    networks: candidate.networks,
    studios: candidate.studios,
  })
}

function readFormStationRequest(data: FormData): StationBuildRequest {
  return normalizeStationRequest({
    id: data.get('id'),
    name: data.get('name'),
    timezone: data.get('timezone'),
    preset: data.get('preset'),
    airtime: data.get('airtime'),
    collectionIds: data.getAll('collectionIds'),
    genres: data.getAll('genres'),
    networks: data.getAll('networks'),
    studios: data.getAll('studios'),
  })
}

function normalizeStationRequest(value: {
  id: unknown
  name: unknown
  timezone: unknown
  preset: unknown
  airtime?: unknown
  collectionIds?: unknown
  genres?: unknown
  networks?: unknown
  studios?: unknown
}): StationBuildRequest {
  const preset = textValue(value.preset)
  if (!isStationPreset(preset)) throw new Error('Choose a valid station preset')
  const airtime = textValue(value.airtime) || 'all-day'
  if (!isStationAirtime(airtime)) throw new Error('Choose a valid airtime')
  return {
    id: textValue(value.id),
    name: textValue(value.name),
    timezone: textValue(value.timezone),
    preset,
    airtime,
    collectionIds: readArray(value.collectionIds, 'collection IDs').map(
      parseCollectionId
    ),
    genres: readArray(value.genres, 'genres').map(textValue),
    networks: readArray(value.networks, 'networks').map(textValue),
    studios: readArray(value.studios, 'studios').map(textValue),
  }
}

function parseCollectionId(value: unknown): number {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value > 0) return value
    throw new Error('Collection selection is invalid')
  }
  const text = textValue(value)
  if (!/^[1-9]\d*$/.test(text)) {
    throw new Error('Collection selection is invalid')
  }
  const id = Number(text)
  if (!Number.isSafeInteger(id)) {
    throw new Error('Collection selection is invalid')
  }
  return id
}

function readArray(value: unknown, label: string): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 1_000) {
    throw new Error(`Selected ${label} are invalid`)
  }
  return value
}

function isStationPreset(value: string): value is StationPresetId {
  return [
    'all-approved-tv',
    'family-animation',
    'nature-documentaries',
    'nickelodeon-style',
    'nick-jr-style',
    'movie-night',
    'custom',
  ].includes(value)
}

function isStationAirtime(value: string): value is StationAirtimeId {
  return ['all-day', 'school-day', 'evening', 'weekend-mornings'].includes(
    value
  )
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

async function readFormChannel(
  request: Request
): Promise<{
  channel: LibraryChannelPolicy
  logo?: File
  scheduledLogos: Array<{ id: string; file: File }>
}> {
  const data = await request.formData()
  const value = {
    id: textValue(data.get('id')),
    name: textValue(data.get('name')),
    timezone: textValue(data.get('timezone')),
    enabled: data.get('enabled') !== null,
    slots: parseChannelSlots(textValue(data.get('slots'))),
    branding: {
      mode: textValue(data.get('brandingMode')) || 'inherit',
      opacity: integerValue(data.get('brandingOpacity'), 210),
      position: integerValue(data.get('brandingPosition'), 2),
      x: integerValue(data.get('brandingX'), 24),
      y: integerValue(data.get('brandingY'), 24),
      sizePercent: integerValue(data.get('brandingSizePercent'), 12),
    },
  }
  const logo = data.get('brandingLogo')
  const scheduledLogos: Array<{ id: string; file: File }> = []
  for (const value of data.getAll('brandingVariantLogos')) {
    if (typeof value === 'string' || value.size <= 0) continue
    const file = value as unknown as File
    scheduledLogos.push({ id: scheduledLogoId(value.name), file })
  }
  const duplicate = scheduledLogos.find(
    (item, index) => scheduledLogos.findIndex((candidate) => candidate.id === item.id) !== index
  )
  if (duplicate) throw new Error(`More than one scheduled logo uses ID ${duplicate.id}`)
  return {
    channel: validateLibraryChannels([value])[0] as LibraryChannelPolicy,
    ...(logo instanceof File && logo.size > 0 ? { logo } : {}),
    scheduledLogos,
  }
}

function scheduledLogoId(filename: string): string {
  const stem = filename.replace(/\.png$/i, '')
  const id = stem
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    throw new Error('Scheduled logo filenames must contain letters or numbers')
  }
  return id
}

function integerValue(value: unknown, fallback: number): number {
  const text = textValue(value)
  return /^-?\d+$/.test(text) ? Number(text) : fallback
}

function channelLogoIds(
  channels: ChannelService,
  logos?: ChannelLogoStore
): string[] {
  if (!logos) return []
  return channels
    .administrationSnapshot()
    .channels.filter((channel) => logos.has(channel.id))
    .map((channel) => channel.id)
}

function channelLogoVariants(
  channels: ChannelService,
  logos?: ChannelLogoStore
): Record<string, string[]> {
  if (!logos) return {}
  return Object.fromEntries(
    channels
      .administrationSnapshot()
      .channels.map((channel) => [channel.id, logos.variants(channel.id)])
  )
}

export function parseChannelSlots(value: string): ChannelScheduleSlot[] {
  if (value.length > 50_000) throw new Error('Schedule text is too long')
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.map((line, index) => {
    const parts = line.split('|').map((part) => part.trim())
    if (parts.length !== 3 && parts.length !== 4) {
      throw new Error(`Schedule line ${index + 1} must contain days, time, groups, and optional branding`)
    }
    const time = /^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/.exec(parts[1] ?? '')
    if (!time) {
      throw new Error(`Schedule line ${index + 1} has an invalid time range`)
    }
    const branding = parseSlotBranding(parts[3] ?? 'channel', index)
    return {
      days: (parts[0] ?? '').split(',').map((day) => day.trim().toLowerCase()),
      start: time[1] as string,
      end: time[2] as string,
      groups: (parts[2] ?? '').split(',').map((group) => group.trim()),
      ...(branding.mode === 'channel' ? {} : { branding }),
    } as ChannelScheduleSlot
  })
}

function parseSlotBranding(
  value: string,
  index: number
): NonNullable<ChannelScheduleSlot['branding']> {
  if (value === 'channel' || value === 'inherit' || value === 'off') {
    return { mode: value }
  }
  const custom = /^custom:([a-z0-9][a-z0-9_-]{0,63})$/i.exec(value)
  if (custom) return { mode: 'custom', logoId: custom[1] }
  throw new Error(`Schedule line ${index + 1} has invalid branding; use channel, inherit, off, or custom:logo-id`)
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readCatalogSearch(value: unknown): string {
  return textValue(value).slice(0, 100)
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function automationSurface(channels: ChannelService): Promise<{
  automation?: Awaited<ReturnType<ChannelService['stationAutomationCatalog']>>
  error?: string
}> {
  try {
    return { automation: await channels.stationAutomationCatalog() }
  } catch (error) {
    return {
      error: `Station automation catalog unavailable: ${safeMessage(error)}`,
    }
  }
}
