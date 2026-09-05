import { Hono } from 'hono'
import {
  validateLibraryChannels,
  type ChannelAutomationHandoffPolicy,
  type ChannelMarathonPolicy,
  type ChannelScheduleSlot,
  type LibraryChannelPolicy,
} from '../config/library'
import type {
  ChannelNowResult,
  ChannelService,
} from '../services/ChannelService'
import type { ChannelLogoStore } from '../services/ChannelLogoStore'
import type { ChannelTimelineResolverService } from '../services/ChannelTimelineResolverService'
import type { StationBuildRequest } from '../services/ChannelService'
import type {
  ChannelLineupSuggestion,
  ChannelLineupSuggestionService,
} from '../services/ChannelLineupSuggestionService'
/* Keep parsing tied to the catalog so new era recipes work in every endpoint. */
import {
  isStationPresetId,
  type StationAirtimeId,
  type StationPresetId,
} from '../services/StationAutomationService'
import {
  isStationNetworkId,
  type StationNetworkId,
} from '../services/EraStationTemplateService'
import { renderChannelAdministration } from '../templates/channelAdministration'

interface ChannelControllerDeps {
  channels: ChannelService
  logos?: ChannelLogoStore
  branding?: Pick<ChannelTimelineResolverService, 'presentation'>
  onChannelChanged?: (
    channelId: string,
    mode: 'restart' | 'deactivate'
  ) => Promise<void> | void
  /** Legacy alias retained for callers that only invalidate branding edits. */
  onBrandingUpdated?: (channelId: string) => Promise<void> | void
  suggestChannelLineup?: ChannelLineupSuggestionService['suggestChannelLineup']
}

/** Schedule API, same-origin channel administration, and browser editor. */
export function createChannelController({
  channels,
  logos,
  branding,
  onChannelChanged,
  onBrandingUpdated,
  suggestChannelLineup,
}: ChannelControllerDeps) {
  const controller = new Hono()
  const notifyChannelChanged = async (channelId: string) => {
    if (onChannelChanged) {
      const runnable = channels
        .list()
        .channels.some(
          (channel) =>
            channel.id === channelId && channel.enabled && channel.onAir
        )
      await onChannelChanged(channelId, runnable ? 'restart' : 'deactivate')
    } else {
      await onBrandingUpdated?.(channelId)
    }
  }

  const decorateSchedule = async (result: ChannelNowResult) => {
    let presentation
    try {
      presentation = await branding?.presentation(
        result.channelId,
        new Date(result.serverTimeMs)
      )
    } catch (error) {
      console.warn(
        `Channel ${result.channelId} branding could not be resolved: ${safeMessage(error)}`
      )
    }
    return {
      ...result,
      ...(presentation ? { branding: presentation } : {}),
      liveStream: {
        mode: 'hls' as const,
        url: `/api/v1/channels/${encodeURIComponent(result.channelId)}/live/index.m3u8`,
      },
    }
  }

  controller.get('/api/v1/channels', (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(channels.list())
  })

  controller.get('/api/v1/channels/schedule', async (c) => {
    c.header('Cache-Control', 'no-store')
    const snapshot = await channels.getLineupSchedule()
    return c.json({
      ...snapshot,
      schedules: await Promise.all(
        snapshot.schedules.map((result) => decorateSchedule(result))
      ),
    })
  })

  controller.get('/api/v1/channels/:id/now', async (c) => {
    c.header('Cache-Control', 'no-store')
    const channelId = c.req.param('id')
    const result = await channels.getNow(channelId)
    return result
      ? c.json(await decorateSchedule(result))
      : c.json({ error: 'Channel not found' }, 404)
  })

  controller.get('/api/v1/channels/:id/guide', async (c) => {
    c.header('Cache-Control', 'no-store')
    const value = c.req.query('hours')
    if (value !== undefined && !/^\d+$/.test(value)) {
      return c.json({ error: 'hours must be a whole number from 1 to 168' }, 400)
    }
    const hours = value === undefined ? 8 : Number(value)
    if (hours < 1 || hours > 168) {
      return c.json({ error: 'hours must be a whole number from 1 to 168' }, 400)
    }

    let from: Date | undefined
    const rawFrom = c.req.query('from')
    if (rawFrom !== undefined) {
      // Accepts epoch milliseconds or an ISO-8601 instant.
      const parsed = /^\d+$/.test(rawFrom)
        ? new Date(Number(rawFrom))
        : new Date(rawFrom)
      if (Number.isNaN(parsed.getTime())) {
        return c.json({ error: 'from must be an ISO-8601 instant or epoch milliseconds' }, 400)
      }
      from = parsed
    }

    const rawCalendar = c.req.query('calendar')
    if (rawCalendar !== undefined && rawCalendar !== '0' && rawCalendar !== '1') {
      return c.json({ error: 'calendar must be 0 or 1' }, 400)
    }

    const result = await channels.getGuide(c.req.param('id'), hours, {
      from,
      ...(rawCalendar === '1' ? { calendarDays: true } : {}),
    })
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
      await notifyChannelChanged(id)
      return c.json({ channel })
    } catch (error) {
      return c.json({ error: safeMessage(error) }, 400)
    }
  })

  controller.delete('/api/admin/v1/channels/:id', async (c) => {
    try {
      const id = c.req.param('id')
      if (!channels.delete(id)) return c.json({ error: 'Channel not found' }, 404)
      logos?.remove(id)
      await notifyChannelChanged(id)
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
      const id = c.req.param('id')
      if (!channels.setEnabled(id, value.enabled)) {
        return c.json({ error: 'Channel not found' }, 404)
      }
      await notifyChannelChanged(id)
      return c.json({ channelId: id, enabled: value.enabled })
    } catch (error) {
      return c.json({ error: safeMessage(error) }, 400)
    }
  })

  controller.post('/api/admin/v1/channels/:id/on-air', async (c) => {
    try {
      const id = c.req.param('id')
      if (!channels.setOnAir(id, true)) {
        return c.json({ error: 'Channel not found' }, 404)
      }
      await notifyChannelChanged(id)
      return c.json({ channelId: id, onAir: true })
    } catch (error) {
      return c.json({ error: safeMessage(error) }, 500)
    }
  })

  controller.post('/api/admin/v1/channels/:id/off-air', async (c) => {
    try {
      const id = c.req.param('id')
      if (!channels.setOnAir(id, false)) {
        return c.json({ error: 'Channel not found' }, 404)
      }
      await notifyChannelChanged(id)
      return c.json({ channelId: id, onAir: false })
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
        brandingId: c.req.query('branding'),
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
    let automationSuggestion: ChannelLineupSuggestion | undefined
    let automationSuggestionGoal = ''
    try {
      const data = await c.req.formData()
      automationSearch = readCatalogSearch(textValue(data.get('catalogSearch')))
      automationTargetId = textValue(data.get('targetChannelId')) || undefined
      request = readFormStationRequest(data)
      const action = textValue(data.get('action'))
      automationSuggestionGoal = textValue(data.get('suggestionGoal')).slice(0, 500)
      if (action === 'ai-suggest') {
        if (!suggestChannelLineup) {
          throw new Error('AI channel suggestions are not available')
        }
        if (!automationSuggestionGoal) {
          throw new Error('Describe the channel you want the AI to suggest')
        }
        const catalog = await channels.stationAutomationCatalog()
        const candidates = catalog.collections
          .filter((collection) => collection.libraryKind === 'tv')
          .slice(0, 300)
        automationSuggestion = await suggestChannelLineup({
          goal: automationSuggestionGoal,
          collections: candidates,
        })
        request = {
          ...request,
          id: request.id || channelIdFromName(automationSuggestion.name),
          name: request.name || automationSuggestion.name,
          preset: 'custom',
          selectionMode: 'explicit',
          collectionIds: [...automationSuggestion.collectionIds],
          genres: [],
          networks: [],
          studios: [],
        }
        return c.html(
          renderChannelAdministration(channels.administrationSnapshot(), {
            ...(await automationSurface(channels)),
            automationDraft: request,
            automationSuggestion,
            automationSuggestionGoal,
            automationOpen: true,
            automationTargetId,
          })
        )
      }
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
            'Confirm that Auto setup may replace this channel’s current schedule, automated library selection, and marathon pattern.'
          )
        }
        const result = await channels.updateAutomatedStation(
          automationTargetId,
          request
        )
        if (!result) return c.text('Channel not found', 404)
        await notifyChannelChanged(automationTargetId)
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
          automationSuggestion,
          automationSuggestionGoal,
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
      const existing = channels
        .administrationSnapshot()
        ?.channels.find((channel) => channel.id === id)
      const channel = channels.update(
        id,
        input.marathon === undefined && existing?.marathon
          ? { ...input, marathon: existing.marathon }
          : input
      )
      if (!channel) return c.text('Channel not found', 404)
      await notifyChannelChanged(id)
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

  controller.get('/channels/:id/logo', (c) => {
    try {
      const id = c.req.param('id')
      const variant = textValue(c.req.query('variant')) || undefined
      if (!logos?.has(id, variant)) return c.text('Channel logo not found', 404)
      return new Response(Bun.file(logos.path(id, variant)), {
        headers: {
          'content-type': 'image/png',
          'cache-control': 'private, no-cache',
          'x-content-type-options': 'nosniff',
        },
      })
    } catch (error) {
      return c.text(safeMessage(error), 400)
    }
  })

  controller.post('/channels/:id/branding', async (c) => {
    const id = c.req.param('id')
    try {
      const existing = channels
        .administrationSnapshot()
        .channels.find((channel) => channel.id === id)
      if (!existing) return c.text('Channel not found', 404)
      const data = await c.req.raw.formData()
      const branding = readBrandingPolicy(data)
      const candidate = validateLibraryChannels([
        { ...existing, branding },
      ])[0] as LibraryChannelPolicy
      const logo = data.get('brandingLogo')
      if (logo instanceof File && logo.size > 0) {
        if (!logos) throw new Error('Channel logo storage is unavailable')
        await logos.save(id, logo)
      }
      if (logos) {
        const scheduledLogos = readScheduledLogos(data)
        for (const scheduled of scheduledLogos) {
          await logos.save(id, scheduled.file, scheduled.id)
        }
      }
      const updated = channels.update(id, candidate)
      if (!updated) return c.text('Channel not found', 404)
      return c.redirect(
        `/channels?changed=updated&edit=${encodeURIComponent(id)}#editor`,
        303
      )
    } catch (error) {
      return c.html(
        renderChannelAdministration(channels.administrationSnapshot(), {
          ...(await automationSurface(channels)),
          brandingId: id,
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
      const id = c.req.param('id')
      if (!channels.setEnabled(id, enabled)) {
        return c.text('Channel not found', 404)
      }
      await notifyChannelChanged(id)
      return c.redirect('/channels?changed=updated', 303)
    } catch (error) {
      return c.text(safeMessage(error), 500)
    }
  })

  controller.post('/channels/:id/delete', async (c) => {
    try {
      const id = c.req.param('id')
      if (!channels.delete(id)) return c.text('Channel not found', 404)
      logos?.remove(id)
      await notifyChannelChanged(id)
      return c.redirect('/channels?changed=deleted', 303)
    } catch (error) {
      return c.text(safeMessage(error), 500)
    }
  })

  controller.post('/channels/:id/on-air', async (c) => {
    try {
      const id = c.req.param('id')
      if (!channels.setOnAir(id, true)) return c.text('Channel not found', 404)
      await notifyChannelChanged(id)
      return c.redirect('/', 303)
    } catch (error) {
      return c.text(safeMessage(error), 500)
    }
  })

  controller.post('/channels/:id/off-air', async (c) => {
    try {
      const id = c.req.param('id')
      if (!channels.setOnAir(id, false)) return c.text('Channel not found', 404)
      await notifyChannelChanged(id)
      return c.redirect('/', 303)
    } catch (error) {
      return c.text(safeMessage(error), 500)
    }
  })

  return controller
}

function channelIdFromName(value: string): string {
  const id = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 59)
  return id || 'ai-suggested-channel'
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
    networkId: candidate.networkId,
    eraStartYear: candidate.eraStartYear,
    eraEndYear: candidate.eraEndYear,
    selectionMode: candidate.selectionMode,
    airtime: candidate.airtime,
    collectionIds: candidate.collectionIds,
    genres: candidate.genres,
    networks: candidate.networks,
    studios: candidate.studios,
    marathon: candidate.marathon,
    handoff: candidate.handoff,
  })
}

function readFormStationRequest(data: FormData): StationBuildRequest {
  const selectionMode = data.get('selectionMode')
  return normalizeStationRequest({
    id: data.get('id'),
    name: data.get('name'),
    timezone: data.get('timezone'),
    preset: data.get('preset'),
    networkId: data.get('networkId'),
    eraStartYear: data.get('eraStartYear'),
    eraEndYear: data.get('eraEndYear'),
    selectionMode,
    airtime: data.get('airtime'),
    collectionIds:
      textValue(selectionMode) === 'automatic'
        ? undefined
        : data.getAll('collectionIds'),
    genres: data.getAll('genres'),
    networks: data.getAll('networks'),
    studios: data.getAll('studios'),
    marathon: readFormMarathon(data),
    handoff:
      textValue(data.get('handoffEnabled')) === 'true'
        ? {
            identity: 'adult-swim',
            mode: 'locked-off-air',
            start: data.get('handoffStart'),
            end: data.get('handoffEnd'),
          }
        : undefined,
  })
}

function normalizeStationRequest(value: {
  id: unknown
  name: unknown
  timezone: unknown
  preset: unknown
  networkId?: unknown
  eraStartYear?: unknown
  eraEndYear?: unknown
  selectionMode?: unknown
  airtime?: unknown
  collectionIds?: unknown
  genres?: unknown
  networks?: unknown
  studios?: unknown
  marathon?: unknown
  handoff?: unknown
}): StationBuildRequest {
  const preset = textValue(value.preset)
  if (!isStationPreset(preset)) throw new Error('Choose a valid station preset')
  const airtime = textValue(value.airtime) || 'all-day'
  if (!isStationAirtime(airtime)) throw new Error('Choose a valid airtime')
  const networkId = optionalStationNetwork(value.networkId)
  const eraStartYear = optionalEraYear(value.eraStartYear, 'start')
  const eraEndYear = optionalEraYear(value.eraEndYear, 'end')
  const selectionMode = optionalSelectionMode(value.selectionMode)
  if (preset === 'network-copy') {
    if (!networkId) throw new Error('Choose a network to copy')
    if (eraStartYear === undefined || eraEndYear === undefined) {
      throw new Error('Choose the first and last year for the copied network')
    }
    if (eraStartYear > eraEndYear) {
      throw new Error('The first network year cannot be after the last year')
    }
  }
  const collectionIds =
    value.collectionIds === undefined
      ? undefined
      : readArray(value.collectionIds, 'collection IDs').map(parseCollectionId)
  const marathon = normalizeMarathon(value.marathon)
  const handoff = normalizeHandoff(value.handoff)
  if (
    handoff &&
    (preset !== 'network-copy' ||
      networkId !== 'cartoon-network' ||
      airtime !== 'all-day')
  ) {
    throw new Error(
      'The after-hours handoff is available only for an all-day Cartoon Network copy'
    )
  }
  return {
    id: textValue(value.id),
    name: textValue(value.name),
    timezone: textValue(value.timezone),
    preset,
    ...(networkId ? { networkId } : {}),
    ...(eraStartYear === undefined ? {} : { eraStartYear }),
    ...(eraEndYear === undefined ? {} : { eraEndYear }),
    ...(selectionMode ? { selectionMode } : {}),
    airtime,
    ...(collectionIds === undefined ? {} : { collectionIds }),
    genres: readArray(value.genres, 'genres').map(textValue),
    networks: readArray(value.networks, 'networks').map(textValue),
    studios: readArray(value.studios, 'studios').map(textValue),
    ...(marathon ? { marathon } : {}),
    ...(handoff ? { handoff } : {}),
  }
}

function normalizeHandoff(
  input: unknown
): ChannelAutomationHandoffPolicy | undefined {
  if (input === undefined || input === null || input === '') return undefined
  if (!input || typeof input !== 'object') {
    throw new Error('After-hours handoff settings are invalid')
  }
  const value = input as Record<string, unknown>
  if (value.identity !== 'adult-swim' || value.mode !== 'locked-off-air') {
    throw new Error('Choose a valid after-hours handoff')
  }
  const start = textValue(value.start)
  const end = textValue(value.end)
  const minutes = (candidate: string): number => {
    const match = /^(\d{2}):(\d{2})$/.exec(candidate)
    if (!match) return -1
    const hour = Number(match[1])
    const minute = Number(match[2])
    return hour <= 23 && minute <= 59 ? hour * 60 + minute : -1
  }
  const startMinutes = minutes(start)
  const endMinutes = minutes(end)
  if (
    startMinutes < 17 * 60 ||
    endMinutes < 0 ||
    endMinutes > 10 * 60 ||
    startMinutes <= endMinutes
  ) {
    throw new Error(
      'After-hours handoff must start between 17:00 and 23:59 and return between 00:00 and 10:00'
    )
  }
  return {
    identity: 'adult-swim',
    mode: 'locked-off-air',
    start,
    end,
  }
}

function optionalSelectionMode(
  value: unknown
): 'automatic' | 'explicit' | undefined {
  const candidate = textValue(value)
  if (!candidate) return undefined
  if (candidate !== 'automatic' && candidate !== 'explicit') {
    throw new Error('Choose a valid lineup selection mode')
  }
  return candidate
}

function optionalStationNetwork(value: unknown): StationNetworkId | undefined {
  const candidate = textValue(value)
  if (!candidate) return undefined
  if (!isStationNetworkId(candidate)) throw new Error('Choose a valid network')
  return candidate
}

function optionalEraYear(
  value: unknown,
  boundary: 'start' | 'end'
): number | undefined {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 1900 && value <= 2100) {
      return value
    }
    throw new Error(`Choose a valid ${boundary} year`)
  }
  const candidate = textValue(value)
  if (!candidate) return undefined
  if (!/^\d{4}$/.test(candidate)) {
    throw new Error(`Choose a valid ${boundary} year`)
  }
  const year = Number(candidate)
  if (!Number.isSafeInteger(year) || year < 1900 || year > 2100) {
    throw new Error(`Choose a valid ${boundary} year`)
  }
  return year
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
  return isStationPresetId(value)
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
  const marathon = readFormMarathon(data)
  const value = {
    id: textValue(data.get('id')),
    name: textValue(data.get('name')),
    timezone: textValue(data.get('timezone')),
    enabled: data.get('enabled') !== null,
    slots: parseChannelSlots(textValue(data.get('slots'))),
    branding: readBrandingPolicy(data),
    ...(marathon ? { marathon } : {}),
  }
  const logo = data.get('brandingLogo')
  const scheduledLogos = readScheduledLogos(data)
  return {
    channel: validateLibraryChannels([value])[0] as LibraryChannelPolicy,
    ...(logo instanceof File && logo.size > 0 ? { logo } : {}),
    scheduledLogos,
  }
}

interface ChannelFormData {
  get(name: string): unknown
  getAll(name: string): readonly unknown[]
}

function readBrandingPolicy(data: ChannelFormData): NonNullable<LibraryChannelPolicy['branding']> {
  return {
    mode: (textValue(data.get('brandingMode')) || 'inherit') as 'inherit' | 'custom' | 'off',
    opacity: integerValue(data.get('brandingOpacity'), 210),
    position: integerValue(data.get('brandingPosition'), 2) as 0 | 2 | 6 | 8,
    x: integerValue(data.get('brandingX'), 24),
    y: integerValue(data.get('brandingY'), 24),
    sizePercent: integerValue(data.get('brandingSizePercent'), 12),
  }
}

function readFormMarathon(data: ChannelFormData): ChannelMarathonPolicy | undefined {
  const frequencyValue = data.get('marathonFrequency')
  const episodeCountValue = data.get('marathonEpisodeCount')
  if (frequencyValue == null && episodeCountValue == null) return undefined
  return normalizeMarathon({
    enabled: textValue(data.get('marathonEnabled')) === 'true',
    frequency: integerValue(frequencyValue, Number.NaN),
    episodeCount: integerValue(episodeCountValue, Number.NaN),
  })
}

function normalizeMarathon(value: unknown): ChannelMarathonPolicy | undefined {
  if (value === undefined || value === null) return undefined
  if (!value || typeof value !== 'object') {
    throw new Error('Marathon settings must be an object')
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate.enabled !== 'boolean') {
    throw new Error('Marathon enabled must be a boolean')
  }
  if (
    !Number.isInteger(candidate.frequency) ||
    (candidate.frequency as number) < 2 ||
    (candidate.frequency as number) > 100
  ) {
    throw new Error('Marathon frequency must be a whole number from 2 to 100')
  }
  if (
    !Number.isInteger(candidate.episodeCount) ||
    (candidate.episodeCount as number) < 2 ||
    (candidate.episodeCount as number) > 20
  ) {
    throw new Error('Marathon episode count must be a whole number from 2 to 20')
  }
  return {
    enabled: candidate.enabled,
    frequency: candidate.frequency as number,
    episodeCount: candidate.episodeCount as number,
  }
}

function readScheduledLogos(
  data: ChannelFormData
): Array<{ id: string; file: File }> {
  const scheduledLogos: Array<{ id: string; file: File }> = []
  for (const value of data.getAll('brandingVariantLogos')) {
    if (!(value instanceof File) || value.size <= 0) continue
    const file = value
    scheduledLogos.push({ id: scheduledLogoId(value.name), file })
  }
  const duplicate = scheduledLogos.find(
    (item, index) => scheduledLogos.findIndex((candidate) => candidate.id === item.id) !== index
  )
  if (duplicate) throw new Error(`More than one scheduled logo uses ID ${duplicate.id}`)
  return scheduledLogos
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
