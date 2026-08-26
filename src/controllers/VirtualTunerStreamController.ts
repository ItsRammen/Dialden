import { Hono } from 'hono'
import type { VirtualTunerService } from '../services/VirtualTunerService'
import {
  VirtualTunerSessionNotFoundError,
  VirtualTunerUnavailableError,
} from '../services/VirtualTunerService'

export const VIRTUAL_TUNER_MANIFEST_ROUTE =
  '/api/v1/tuner-sessions/:sessionId/live/index.m3u8'
export const VIRTUAL_TUNER_SEGMENT_ROUTE =
  '/api/v1/tuner-sessions/:sessionId/live/:segment'

export function createVirtualTunerStreamController(
  tuners: Pick<VirtualTunerService, 'playlist' | 'segmentPath'>
) {
  const controller = new Hono()

  controller.on(['GET', 'HEAD'], VIRTUAL_TUNER_MANIFEST_ROUTE, async (c) => {
    try {
      const playlist = await tuners.playlist(c.req.param('sessionId'))
      return new Response(c.req.method === 'HEAD' ? null : playlist, {
        headers: hlsHeaders('application/vnd.apple.mpegurl', 'no-store'),
      })
    } catch (error) {
      if (error instanceof VirtualTunerSessionNotFoundError) {
        return c.json({ error: error.message }, 404, {
          'Cache-Control': 'no-store',
        })
      }
      return c.json(
        {
          error:
            error instanceof VirtualTunerUnavailableError
              ? error.message
              : 'Virtual tuner stream is unavailable',
        },
        503,
        { 'Retry-After': '1', 'Cache-Control': 'no-store' }
      )
    }
  })

  controller.on(['GET', 'HEAD'], VIRTUAL_TUNER_SEGMENT_ROUTE, async (c) => {
    const path = await tuners.segmentPath(
      c.req.param('sessionId'),
      c.req.param('segment')
    )
    if (!path) {
      return c.json({ error: 'Tuner segment not found' }, 404, {
        'Cache-Control': 'no-store',
      })
    }
    const file = Bun.file(path)
    if (!(await file.exists())) {
      return c.json({ error: 'Tuner segment not found' }, 404, {
        'Cache-Control': 'no-store',
      })
    }
    return new Response(c.req.method === 'HEAD' ? null : file, {
      headers: hlsHeaders('video/mp2t', 'public, max-age=120, immutable'),
    })
  })

  return controller
}

function hlsHeaders(contentType: string, cacheControl: string): Headers {
  return new Headers({
    'Cache-Control': cacheControl,
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
  })
}
