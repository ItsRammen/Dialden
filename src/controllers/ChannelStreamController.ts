import { join } from 'node:path'
import { Hono } from 'hono'
import type { ChannelService } from '../services/ChannelService'
import type { ContinuousChannelWorkerManager } from '../services/ContinuousChannelWorkerManager'

interface ChannelStreamControllerDeps {
  channels: Pick<ChannelService, 'list'>
  workers: Pick<ContinuousChannelWorkerManager, 'touch' | 'getState'>
  outputRoot: string
}

const SEGMENT_NAME = /^segment-\d{13}\.ts$/

/** Serves the one stable, rolling HLS representation for each channel. */
export function createChannelStreamController({
  channels,
  workers,
  outputRoot,
}: ChannelStreamControllerDeps) {
  const controller = new Hono()

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
      try {
        await workers.touch(channelId, clientId)
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : 'Stream unavailable' },
          400
        )
      }

      const path = join(outputRoot, channelId, 'live', 'index.m3u8')
      const file = await waitForOutput(path)
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

function hasChannel(
  channels: Pick<ChannelService, 'list'>,
  channelId: string
): boolean {
  return channels.list().channels.some((channel) => channel.id === channelId)
}

async function waitForOutput(path: string): Promise<ReturnType<typeof Bun.file> | null> {
  const file = Bun.file(path)
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await file.exists()) return file
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
