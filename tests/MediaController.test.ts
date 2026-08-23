import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock, type MockProxy } from 'jest-mock-extended'
import { Hono } from 'hono'
import {
  createMediaController,
  parseByteRange,
  rangeForRepresentation,
} from '../src/controllers/MediaController'
import type { MediaDeliveryService } from '../src/services/MediaDeliveryService'

let fixtureDirectory: string
let filePath: string

beforeAll(() => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), 'toasttv-media-controller-'))
  filePath = join(fixtureDirectory, 'range-video.mp4')
  writeFileSync(filePath, '0123456789')
})

afterAll(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true })
})

describe('parseByteRange', () => {
  test('parses fixed, open-ended, and suffix byte ranges', () => {
    expect(parseByteRange('bytes=2-5', 10)).toEqual({
      kind: 'range',
      start: 2,
      end: 5,
    })
    expect(parseByteRange('bytes=6-', 10)).toEqual({
      kind: 'range',
      start: 6,
      end: 9,
    })
    expect(parseByteRange('bytes=-3', 10)).toEqual({
      kind: 'range',
      start: 7,
      end: 9,
    })
    expect(parseByteRange('bytes=-99', 10)).toEqual({
      kind: 'range',
      start: 0,
      end: 9,
    })
  })

  test('clamps an end, ignores malformed ranges, and rejects unsatisfiable ranges', () => {
    expect(parseByteRange('bytes=8-99', 10)).toEqual({
      kind: 'range',
      start: 8,
      end: 9,
    })
    expect(parseByteRange('Bytes=2-5', 10)).toEqual({
      kind: 'range',
      start: 2,
      end: 5,
    })
    for (const value of ['bytes=10-', 'bytes=-0']) {
      expect(parseByteRange(value, 10)).toEqual({ kind: 'unsatisfiable' })
    }
    for (const value of [
      'bytes=',
      'items=0-1',
      'bytes=0-1,4-5',
      'bytes=7-3',
      'bytes=a-b',
    ]) {
      expect(parseByteRange(value, 10)).toEqual({ kind: 'none' })
    }
    expect(parseByteRange(undefined, 10)).toEqual({ kind: 'none' })
  })

  test('honors If-Range only when it matches the current Last-Modified value', () => {
    const modified = new Date('2026-08-23T12:00:00.000Z')
    expect(rangeForRepresentation('bytes=2-5', undefined, modified)).toBe('bytes=2-5')
    expect(
      rangeForRepresentation('bytes=2-5', 'Sun, 23 Aug 2026 12:00:00 GMT', modified)
    ).toBe('bytes=2-5')
    expect(
      rangeForRepresentation('bytes=2-5', 'Sun, 23 Aug 2026 11:59:00 GMT', modified)
    ).toBeUndefined()
    expect(rangeForRepresentation('bytes=2-5', '"stale-etag"', modified)).toBeUndefined()
  })
})

describe('MediaController', () => {
  let media: MockProxy<MediaDeliveryService>
  let app: Hono

  beforeEach(() => {
    media = mock<MediaDeliveryService>()
    media.resolve.mockResolvedValue({
      path: filePath,
      size: 10,
      mimeType: 'video/mp4',
      lastModified: new Date('2026-08-23T12:00:00.000Z'),
    })
    app = new Hono().route('/', createMediaController({ media }))
  })

  test('serves a complete file with media and cache-safety headers', async () => {
    const response = await app.request('/api/v1/media/7/stream')

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('0123456789')
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    expect(response.headers.get('Content-Length')).toBe('10')
    expect(response.headers.get('Content-Type')).toBe('video/mp4')
    expect(response.headers.get('Last-Modified')).toBe(
      'Sun, 23 Aug 2026 12:00:00 GMT'
    )
    expect(response.headers.get('Cache-Control')).toBe(
      'private, max-age=0, must-revalidate'
    )
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  test('handles HEAD without reading a body', async () => {
    const response = await app.request('/api/v1/media/7/stream', {
      method: 'HEAD',
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Length')).toBe('10')
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    expect(await response.text()).toBe('')
  })

  test.each([
    ['bytes=2-5', '2345', 'bytes 2-5/10', '4'],
    ['bytes=6-', '6789', 'bytes 6-9/10', '4'],
    ['bytes=-3', '789', 'bytes 7-9/10', '3'],
    ['bytes=8-99', '89', 'bytes 8-9/10', '2'],
  ])(
    'serves one %s range with a 206 response',
    async (range, body, contentRange, contentLength) => {
      const response = await app.request('/api/v1/media/7/stream', {
        headers: { Range: range },
      })

      expect(response.status).toBe(206)
      expect(await response.text()).toBe(body)
      expect(response.headers.get('Content-Range')).toBe(contentRange)
      expect(response.headers.get('Content-Length')).toBe(contentLength)
    }
  )

  test.each(['bytes=10-', 'bytes=-0'])(
    'returns 416 for unsatisfiable Range %s',
    async (range) => {
      const response = await app.request('/api/v1/media/7/stream', {
        headers: { Range: range },
      })

      expect(response.status).toBe(416)
      expect(response.headers.get('Content-Range')).toBe('bytes */10')
      expect(response.headers.get('Content-Length')).toBe('0')
      expect(await response.text()).toBe('')
    }
  )

  test.each(['bytes=', 'items=0-1', 'bytes=0-1,4-5', 'bytes=7-3'])(
    'ignores unsupported or malformed Range %s',
    async (range) => {
      const response = await app.request('/api/v1/media/7/stream', {
        headers: { Range: range },
      })

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Length')).toBe('10')
      expect(await response.text()).toBe('0123456789')
    }
  )

  test('falls back to a full response for stale If-Range and honors a current one', async () => {
    const stale = await app.request('/api/v1/media/7/stream', {
      headers: {
        Range: 'bytes=2-5',
        'If-Range': 'Sun, 23 Aug 2026 11:59:00 GMT',
      },
    })
    expect(stale.status).toBe(200)
    expect(await stale.text()).toBe('0123456789')

    const current = await app.request('/api/v1/media/7/stream', {
      headers: {
        Range: 'bytes=2-5',
        'If-Range': 'Sun, 23 Aug 2026 12:00:00 GMT',
      },
    })
    expect(current.status).toBe(206)
    expect(await current.text()).toBe('2345')
  })

  test.each(['0', '-1', '1.5', 'abc', '01', '999999999999999999999999'])(
    'returns 400 for invalid media ID %s',
    async (id) => {
      const response = await app.request(`/api/v1/media/${id}/stream`)

      expect(response.status).toBe(400)
      expect(media.resolve).not.toHaveBeenCalled()
    }
  )

  test('returns 404 without exposing paths when media cannot be resolved', async () => {
    media.resolve.mockResolvedValue(null)

    const response = await app.request('/api/v1/media/7/stream')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Media is not available' })
  })
})
