import { Hono } from 'hono'
import type { ArtworkCacheService } from '../services/ArtworkCacheService'

export function createArtworkController(artwork: ArtworkCacheService) {
  const controller = new Hono()

  controller.get('/api/v1/artwork/tmdb/:size/:filename', async (c) => {
    try {
      const result = await artwork.getTmdbArtwork(
        c.req.param('size'),
        c.req.param('filename')
      )
      if (!result) return c.json({ error: 'Artwork not found' }, 404)
      return new Response(result.body, {
        headers: {
          'Content-Type': result.contentType,
          'Cache-Control': 'public, max-age=604800, immutable',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch {
      return c.json({ error: 'Artwork provider unavailable' }, 502)
    }
  })

  return controller
}
