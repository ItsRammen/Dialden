import { Hono } from 'hono'
import type {
  MediaDeliveryService,
  ResolvedMediaFile,
} from '../services/MediaDeliveryService'

interface MediaControllerDeps {
  media: MediaDeliveryService
}

export type ByteRangeResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'unsatisfiable' }
  | { readonly kind: 'range'; readonly start: number; readonly end: number }

/** Parse the single byte range supported by HTML media elements. */
export function parseByteRange(
  value: string | undefined,
  size: number
): ByteRangeResult {
  if (value === undefined) return { kind: 'none' }
  if (size <= 0) return { kind: 'unsatisfiable' }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim())
  if (!match || (!match[1] && !match[2])) {
    return { kind: 'none' }
  }

  const startValue = match[1]
  const endValue = match[2]
  if (!startValue) {
    const suffixLength = Number(endValue)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { kind: 'unsatisfiable' }
    }
    return {
      kind: 'range',
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    }
  }

  const start = Number(startValue)
  const requestedEnd = endValue ? Number(endValue) : size - 1
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0
  ) {
    return { kind: 'none' }
  }
  if (start >= size) return { kind: 'unsatisfiable' }
  if (requestedEnd < start) return { kind: 'none' }

  return {
    kind: 'range',
    start,
    end: Math.min(requestedEnd, size - 1),
  }
}

export function createMediaController({ media }: MediaControllerDeps) {
  const controller = new Hono()

  controller.on(['GET', 'HEAD'], '/api/v1/media/:id/stream', async (c) => {
    const rawId = c.req.param('id')
    const mediaId = Number(rawId)
    if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(mediaId)) {
      return c.json({ error: 'Media ID must be a positive whole number' }, 400)
    }

    const file = await media.resolve(mediaId)
    if (!file) return c.json({ error: 'Media is not available' }, 404)

    const headers = responseHeaders(file)
    if (c.req.method === 'HEAD') {
      headers.set('Content-Length', String(file.size))
      return new Response(null, { status: 200, headers })
    }

    const requestedRange = rangeForRepresentation(
      c.req.header('Range'),
      c.req.header('If-Range'),
      file.lastModified
    )
    const range = parseByteRange(requestedRange, file.size)
    if (range.kind === 'unsatisfiable') {
      headers.set('Content-Range', `bytes */${file.size}`)
      headers.set('Content-Length', '0')
      return new Response(null, { status: 416, headers })
    }

    const source = Bun.file(file.path)
    if (range.kind === 'range') {
      const length = range.end - range.start + 1
      headers.set(
        'Content-Range',
        `bytes ${range.start}-${range.end}/${file.size}`
      )
      headers.set('Content-Length', String(length))
      return new Response(source.slice(range.start, range.end + 1), {
        status: 206,
        headers,
      })
    }

    headers.set('Content-Length', String(file.size))
    return new Response(source, { status: 200, headers })
  })

  return controller
}

/**
 * A stale or unrecognised If-Range validator must fall back to a complete
 * representation, never a partial body that a client could join to old bytes.
 */
export function rangeForRepresentation(
  range: string | undefined,
  ifRange: string | undefined,
  lastModified: Date
): string | undefined {
  if (range === undefined || ifRange === undefined) return range
  return ifRange.trim() === lastModified.toUTCString() ? range : undefined
}

function responseHeaders(file: ResolvedMediaFile): Headers {
  return new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=0, must-revalidate',
    'Content-Type': file.mimeType,
    'Last-Modified': file.lastModified.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
  })
}
