import { Hono } from 'hono'
import type { PublicMetadataConfig } from '../config/metadata'
import type { MetadataEnrichmentService } from '../services/metadata/MetadataEnrichmentService'
import { renderMetadataSettings } from '../templates/metadataSettings'

export function createMetadataSettingsController(
  metadata: Pick<MetadataEnrichmentService, 'getState' | 'testConnection'>,
  config: PublicMetadataConfig
) {
  const controller = new Hono()

  controller.get('/settings/metadata', (c) => {
    const result = c.req.query('test')
    return c.html(
      renderMetadataSettings(
        config,
        metadata.getState(),
        result === 'success' || result === 'failed' ? result : undefined
      )
    )
  })

  controller.post('/settings/metadata/test', async (c) => {
    if (!config.configured) return c.redirect('/settings/metadata?test=failed', 303)
    try {
      await metadata.testConnection()
      return c.redirect('/settings/metadata?test=success', 303)
    } catch {
      return c.redirect('/settings/metadata?test=failed', 303)
    }
  })

  return controller
}
