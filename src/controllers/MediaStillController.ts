import { Hono } from 'hono'
import type { MediaDeliveryService } from '../services/MediaDeliveryService'
import type { MediaStillService } from '../services/MediaStillService'

export function createMediaStillController(deps: { media: MediaDeliveryService; stills: MediaStillService }) {
  const controller = new Hono()
  controller.get('/api/v1/media/:id/still', async c => {
    const raw = c.req.param('id')
    const id = Number(raw)
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(id)) return c.json({ error: 'Invalid media ID' },400)
    // Apply the same root containment and playback eligibility checks as streaming.
    const media = await deps.media.resolve(id)
    if (!media) return c.json({ error: 'Media is not available' },404)
    const still = await deps.stills.request(media)
    if (!still) {
      c.header('Cache-Control','no-store')
      c.header('Retry-After','5')
      return c.json({ status: 'pending', message: 'Still not available yet' },202)
    }
    const headers = new Headers({ 'Content-Type':'image/jpeg', 'Cache-Control':'private, max-age=300', 'ETag':still.etag, 'X-Content-Type-Options':'nosniff' })
    if (c.req.header('If-None-Match') === still.etag) return new Response(null,{ status:304,headers })
    return new Response(Bun.file(still.path),{ headers })
  })
  return controller
}
