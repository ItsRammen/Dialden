import { join } from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { ChannelService } from '../services/ChannelService'
import type { ContinuousChannelWorkerManager } from '../services/ContinuousChannelWorkerManager'
import type {
  LineupSessionService,
  LineupSessionSnapshotEntry,
} from '../services/LineupSessionService'

interface ChannelStreamControllerDeps {
  channels: Pick<ChannelService, 'list'>
  workers: Pick<ContinuousChannelWorkerManager, 'touch' | 'warm' | 'getState'>
  outputRoot: string
  lineup?: Pick<LineupSessionService, 'open' | 'close' | 'snapshot'>
}

export const CLIENT_CHANNEL_WARM_ROUTE = '/api/client/v1/channels/warm'
export const CLIENT_CHANNEL_STARTUP_ROUTE = '/api/client/v1/channels/startup'
export const CLIENT_CHANNEL_PREPARE_ROUTE =
  '/api/client/v1/channels/:id/prepare'
export const CLIENT_SESSION_ROUTE = '/api/client/v1/session'
export const CLIENT_SESSION_CLOSE_ROUTE = '/api/client/v1/session/close'

const SEGMENT_NAME = /^segment-\d{13}\.ts$/

/** Serves the one stable, rolling HLS representation for each channel. */
export function createChannelStreamController({
  channels,
  workers,
  outputRoot,
  lineup,
}: ChannelStreamControllerDeps) {
  const controller = new Hono()

  controller.use(
    '/api/client/v1/channels/*',
    cors({
      origin: '*',
      allowMethods: ['POST', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
      maxAge: 300,
    })
  )
  controller.use(
    CLIENT_SESSION_ROUTE,
    cors({
      origin: '*',
      allowMethods: ['POST', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
      maxAge: 300,
    })
  )
  controller.use(
    CLIENT_SESSION_CLOSE_ROUTE,
    cors({
      origin: '*',
      allowMethods: ['POST', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
      maxAge: 300,
    })
  )

  controller.post(CLIENT_CHANNEL_STARTUP_ROUTE, async (c) => {
    c.header('Cache-Control', 'no-store')
    const parsed = await parseClientRequest(c)
    if ('response' in parsed) return parsed.response
    const request = parsed.input as {
      clientId?: unknown
      lastChannelId?: unknown
      warmAdjacent?: unknown
    }
    if (
      typeof request.clientId !== 'string' ||
      (request.lastChannelId !== undefined &&
        request.lastChannelId !== null &&
        typeof request.lastChannelId !== 'string')
    ) {
      return c.json({ error: 'Startup requires a clientId' }, 400)
    }
    const available = availableChannels(channels)
    if (available.length === 0) {
      return c.json({ error: 'No channels are currently on air' }, 404)
    }
    const selected =
      available.find((channel) => channel.id === request.lastChannelId) ??
      available[0]!
    const fellBack =
      typeof request.lastChannelId === 'string' &&
      request.lastChannelId !== selected.id
    try {
      const state = await workers.touch(selected.id, request.clientId)
      // Adjacent warming retired: lineup sessions hold every channel hot for
      // session clients, and speculative encoders starved software boxes.
      // The legacy response shape is preserved for sideloaded clients.
      return c.json({
        channel: selected,
        status: state.status === 'error' ? 'unavailable' : 'ready',
        streamUrl: `/api/v1/channels/${encodeURIComponent(selected.id)}/live/index.m3u8`,
        warmed: [],
        serverTimeMs: Date.now(),
        fallbackReason: fellBack
          ? 'The last channel is no longer available; the first on-air channel was selected.'
          : null,
      })
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Channel could not be started' },
        503
      )
    }
  })

  controller.post(CLIENT_SESSION_ROUTE, async (c) => {
    c.header('Cache-Control', 'no-store')
    const parsed = await parseClientRequest(c)
    if ('response' in parsed) return parsed.response
    const request = parsed.input as {
      clientId?: unknown
      lastChannelId?: unknown
      lineup?: unknown
    }
    if (
      typeof request.clientId !== 'string' ||
      (request.lastChannelId !== undefined &&
        request.lastChannelId !== null &&
        typeof request.lastChannelId !== 'string')
    ) {
      return c.json({ error: 'Session requires a clientId' }, 400)
    }
    if (!lineup || request.lineup === false) {
      return c.json({ error: 'Lineup sessions are not available' }, 501)
    }
    const available = availableChannels(channels)
    if (available.length === 0) {
      return c.json({ error: 'No channels are currently on air' }, 404)
    }
    const selected =
      available.find((channel) => channel.id === request.lastChannelId) ??
      available[0]!
    const fellBack =
      typeof request.lastChannelId === 'string' &&
      request.lastChannelId !== selected.id
    try {
      const entry: LineupSessionSnapshotEntry = await lineup.open(
        request.clientId,
        selected.id
      )
      const state = workers.getState(selected.id)
      return c.json({
        channel: selected,
        status: state && state.status === 'error' ? 'unavailable' : 'ready',
        streamUrl: `/api/v1/channels/${encodeURIComponent(selected.id)}/live/index.m3u8`,
        serverTimeMs: Date.now(),
        fallbackReason: fellBack
          ? 'The last channel is no longer available; the first on-air channel was selected.'
          : null,
        lineup: {
          total: entry.channelIds.length,
          ready: entry.ready,
          pending: entry.pending,
        },
      })
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Session could not be opened' },
        503
      )
    }
  })

  controller.post(CLIENT_SESSION_CLOSE_ROUTE, async (c) => {
    c.header('Cache-Control', 'no-store')
    const parsed = await parseClientRequest(c)
    if ('response' in parsed) return parsed.response
    const request = parsed.input as { clientId?: unknown }
    if (typeof request.clientId !== 'string') {
      return c.json({ error: 'Close requires a clientId' }, 400)
    }
    await lineup?.close(request.clientId)
    return c.json({ ok: true, serverTimeMs: Date.now() })
  })

  controller.post(CLIENT_CHANNEL_PREPARE_ROUTE, async (c) => {
    c.header('Cache-Control', 'no-store')
    const parsed = await parseClientRequest(c)
    if ('response' in parsed) return parsed.response
    const request = parsed.input as { clientId?: unknown }
    const channelId = c.req.param('id')
    if (typeof request.clientId !== 'string') {
      return c.json({ error: 'Prepare requires a clientId' }, 400)
    }
    if (!hasChannel(channels, channelId)) {
      return c.json({ error: 'Channel not found' }, 404)
    }
    try {
      const state = await workers.touch(channelId, request.clientId)
      return c.json({
        channelId,
        status: state.status === 'error' ? 'unavailable' : 'ready',
        streamUrl: `/api/v1/channels/${encodeURIComponent(channelId)}/live/index.m3u8`,
        serverTimeMs: Date.now(),
      })
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Channel could not be prepared' },
        503
      )
    }
  })

  controller.post(CLIENT_CHANNEL_WARM_ROUTE, async (c) => {
    c.header('Cache-Control', 'no-store')
    let input: unknown
    try {
      input = await c.req.json()
    } catch {
      return c.json({ error: 'Warm request must be valid JSON' }, 400)
    }
    const request = input as { clientId?: unknown; channelIds?: unknown }
    if (
      typeof request.clientId !== 'string' ||
      !Array.isArray(request.channelIds) ||
      request.channelIds.length > 2 ||
      request.channelIds.some((id) => typeof id !== 'string')
    ) {
      return c.json(
        { error: 'Warm request requires a clientId and at most two channel IDs' },
        400
      )
    }
    const available = new Set(
      channels
        .list()
        .channels.filter((channel) => channel.enabled && channel.onAir)
        .map((channel) => channel.id)
    )
    const channelIds = [
      ...new Set(
        (request.channelIds as string[]).filter((channelId) =>
          available.has(channelId)
        )
      ),
    ]
    try {
      const states = await workers.warm(channelIds, request.clientId)
      return c.json({ warmed: states.map((state) => state.channelId) })
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Channels could not be warmed' },
        400
      )
    }
  })

  controller.on(
    ['GET', 'HEAD'],
    '/api/v1/channels/:id/live/index.m3u8',
    async (c) => {
      const channelId = c.req.param('id')
      if (!hasChannel(channels, channelId)) {
        return c.json({ error: 'Channel not found' }, 404)
      }
      const clientId =
        c.req.query('clientId') ??
        `anonymous-${stableHash(c.req.header('User-Agent') ?? 'hls')}`
      let workerState
      try {
        workerState = await workers.touch(channelId, clientId)
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : 'Stream unavailable' },
          400
        )
      }

      const path = join(outputRoot, channelId, 'live', 'index.m3u8')
      const minimumModifiedAt = workerState.startedAt
        ? Date.parse(workerState.startedAt)
        : 0
      const file = await waitForOutput(
        path,
        minimumModifiedAt,
        () => workers.getState(channelId)?.status === 'error'
      )
      if (!file) {
        const state = workers.getState(channelId)
        return c.json(
          { error: state?.lastError ?? 'Channel stream is starting' },
          503,
          { 'Retry-After': '1', 'Cache-Control': 'no-store' }
        )
      }
      const headers = hlsHeaders('application/vnd.apple.mpegurl', 'no-store')
      return new Response(c.req.method === 'HEAD' ? null : file, { headers })
    }
  )

  controller.on(
    ['GET', 'HEAD'],
    '/api/v1/channels/:id/live/:segment',
    async (c) => {
      const channelId = c.req.param('id')
      const segment = c.req.param('segment')
      if (!hasChannel(channels, channelId)) {
        return c.json({ error: 'Channel not found' }, 404)
      }
      if (!SEGMENT_NAME.test(segment)) {
        return c.json({ error: 'Segment not found' }, 404)
      }
      const file = Bun.file(join(outputRoot, channelId, 'live', segment))
      if (!(await file.exists())) {
        return c.json({ error: 'Segment not found' }, 404)
      }
      const headers = hlsHeaders('video/mp2t', 'public, max-age=120, immutable')
      return new Response(c.req.method === 'HEAD' ? null : file, { headers })
    }
  )

  return controller
}

async function parseClientRequest(c: any): Promise<
  | { input: unknown }
  | { response: Response }
> {
  try {
    return { input: await c.req.json() }
  } catch {
    return {
      response: c.json({ error: 'Request must be valid JSON' }, 400),
    }
  }
}

function availableChannels(channels: Pick<ChannelService, 'list'>) {
  return channels
    .list()
    .channels.filter((channel) => channel.enabled && channel.onAir)
}

function hasChannel(
  channels: Pick<ChannelService, 'list'>,
  channelId: string
): boolean {
  return channels
    .list()
    .channels.some(
      (channel) =>
        channel.id === channelId && channel.enabled && channel.onAir
    )
}

async function waitForOutput(
  path: string,
  minimumModifiedAt: number,
  shouldStop: () => boolean
): Promise<ReturnType<typeof Bun.file> | null> {
  const file = Bun.file(path)
  for (let attempt = 0; attempt < 120; attempt++) {
    if (shouldStop()) return null
    if (
      (await file.exists()) &&
      (!Number.isFinite(minimumModifiedAt) ||
        minimumModifiedAt <= 0 ||
        file.lastModified >= minimumModifiedAt)
    ) {
      return file
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return null
}

function hlsHeaders(contentType: string, cacheControl: string): Headers {
  return new Headers({
    'Cache-Control': cacheControl,
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
  })
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}
