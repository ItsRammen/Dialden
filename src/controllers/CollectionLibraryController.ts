import { Hono, type Context } from 'hono'
import type { PublicMetadataConfig } from '../config/metadata'
import type { CollectionLibraryService } from '../services/CollectionLibraryService'
import type { MediaIndexer } from '../services/MediaIndexer'
import type { MetadataEnrichmentService } from '../services/metadata/MetadataEnrichmentService'
import type {
  LibraryKind,
  MediaItem,
  OverrideDecision,
  PolicyDecision,
} from '../types'

interface CollectionLibraryControllerDeps {
  readonly library: CollectionLibraryService
  readonly indexer: Pick<MediaIndexer, 'getScanState' | 'scanAll'>
  readonly metadata: Pick<
    MetadataEnrichmentService,
    'getState' | 'runPending' | 'confirmMatch' | 'retryCollection' | 'testConnection'
  > & {
    /** Optional only for compatibility with isolated controller tests. */
    getPublicConfig?: () => PublicMetadataConfig
  }
  readonly metadataConfig?: PublicMetadataConfig
  readonly refreshSchedules?: () => Promise<void>
}

export function createCollectionLibraryController(
  deps: CollectionLibraryControllerDeps
) {
  const controller = new Hono()

  controller.get('/api/v1/library/summary', async (c) =>
    c.json(await deps.library.getSummary())
  )

  controller.get('/api/v1/library/tv', async (c) =>
    c.json({ collections: await listCollections(c, deps.library, 'tv') })
  )

  controller.get('/api/v1/library/movies', async (c) =>
    c.json({ collections: await listCollections(c, deps.library, 'movie') })
  )

  controller.get('/api/v1/library/interludes', async (c) => {
    const files = await deps.library.getInterludes()
    return c.json({
      files: files.map((item) => ({
        id: item.id,
        filename: item.filename,
        relativePath: item.relativePath ?? item.filename,
        mediaType: item.mediaType,
        durationSeconds: item.durationSeconds,
        compatibility: item.compatibility,
        warning: item.warning,
        rootAvailable: item.rootAvailable === true,
        playbackEnabled: item.playbackEnabled === true,
      })),
    })
  })

  controller.get('/api/v1/library/review', async (c) => {
    const limit = parseBoundedInteger(c.req.query('limit'), 100, 1, 250)
    const offset = parseBoundedInteger(c.req.query('offset'), 0, 0, 100_000)
    const collections = await deps.library.getReviewQueue({
      search: c.req.query('search'),
      limit,
      offset,
    })
    return c.json({ collections })
  })

  controller.get('/api/v1/library/collections/:id', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'Invalid collection ID' }, 400)
    const detail = await deps.library.getDetail(id)
    if (!detail) return c.json({ error: 'Collection not found' }, 404)
    return c.json({
      collection: detail.collection,
      seasons: detail.seasons.map((season) => ({
        seasonNumber: season.seasonNumber,
        episodes: season.episodes.map(toPublicFile),
      })),
      files: detail.files.map(toPublicFile),
    })
  })

  controller.get('/api/v1/library/scan', (c) =>
    c.json(deps.indexer.getScanState())
  )

  controller.get('/api/v1/library/metadata', (c) =>
    c.json({
      config: currentMetadataConfig(deps),
      state: deps.metadata.getState(),
    })
  )

  controller.post('/api/admin/v1/library/scan', (c) => {
    // Scan state/SSE carries the failure; consume the detached rejection so an
    // unavailable mount cannot become a process-level unhandled rejection.
    void deps.indexer.scanAll().catch(() => {})
    return c.json({ accepted: true, state: deps.indexer.getScanState() }, 202)
  })

  controller.post('/api/admin/v1/library/metadata/refresh', (c) => {
    void deps.metadata.runPending()
    return c.json({ accepted: true, state: deps.metadata.getState() }, 202)
  })

  controller.post('/api/admin/v1/library/metadata/test', async (c) => {
    if (!currentMetadataConfig(deps).configured) {
      return c.json({ ok: false, error: 'TMDB is not configured' }, 409)
    }
    try {
      await deps.metadata.testConnection()
      return c.json({ ok: true })
    } catch (error) {
      return c.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : 'Connection failed',
        },
        502
      )
    }
  })

  controller.post('/api/admin/v1/library/collections/:id/approve', (c) =>
    updateOverride(c, deps, 'allow')
  )
  controller.post('/api/admin/v1/library/collections/:id/block', (c) =>
    updateOverride(c, deps, 'block')
  )
  controller.post('/api/admin/v1/library/collections/:id/reset-policy', (c) =>
    updateOverride(c, deps, null)
  )

  controller.post(
    '/api/admin/v1/library/collections/:id/metadata-match',
    async (c) => {
      const id = parseId(c.req.param('id'))
      if (id === null) return c.json({ error: 'Invalid collection ID' }, 400)
      const body = await readJson(c)
      const externalId = body?.['externalId']
      if (
        typeof externalId !== 'string' ||
        !/^[1-9]\d*$/.test(externalId) ||
        !Number.isSafeInteger(Number(externalId))
      ) {
        return c.json({ error: 'externalId must be a positive numeric string' }, 400)
      }
      try {
        const collection = await deps.metadata.confirmMatch(id, externalId)
        if (!collection) return c.json({ error: 'Collection not found' }, 404)
        await deps.refreshSchedules?.()
        return c.json({ collection })
      } catch (error) {
        return c.json(
          {
            error:
              error instanceof Error ? error.message : 'Metadata match failed',
          },
          502
        )
      }
    }
  )

  controller.post(
    '/api/admin/v1/library/collections/:id/metadata-retry',
    async (c) => {
      const id = parseId(c.req.param('id'))
      if (id === null) return c.json({ error: 'Invalid collection ID' }, 400)
      try {
        const collection = await deps.metadata.retryCollection(id)
        if (!collection) return c.json({ error: 'Collection not found' }, 404)
        await deps.refreshSchedules?.()
        return c.json({ collection })
      } catch (error) {
        return c.json(
          {
            error:
              error instanceof Error ? error.message : 'Metadata retry failed',
          },
          502
        )
      }
    }
  )

  controller.post('/api/admin/v1/library/collections/bulk-override', async (c) => {
    const body = await readJson(c)
    const rawIds = body?.['ids']
    const action = body?.['action']
    if (
      !Array.isArray(rawIds) ||
      !rawIds.every((id) => Number.isSafeInteger(id) && Number(id) > 0) ||
      !['allow', 'block', 'policy'].includes(String(action))
    ) {
      return c.json({ error: 'ids and a valid action are required' }, 400)
    }
    const decision: OverrideDecision =
      action === 'policy' ? null : action === 'allow' ? 'allow' : 'block'
    try {
      const result = await deps.library.setOverrides(
        rawIds.map(Number),
        decision
      )
      await deps.refreshSchedules?.()
      return c.json(result)
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Bulk update failed' },
        400
      )
    }
  })

  return controller
}

function currentMetadataConfig(
  deps: Pick<CollectionLibraryControllerDeps, 'metadata' | 'metadataConfig'>
): PublicMetadataConfig {
  const config = deps.metadata.getPublicConfig?.() ?? deps.metadataConfig
  if (!config) throw new Error('Metadata configuration is unavailable')
  return config
}

async function listCollections(
  c: { req: { query: (name: string) => string | undefined } },
  library: CollectionLibraryService,
  kind: LibraryKind
) {
  const decision = parseDecision(c.req.query('status'))
  return library.list({
    kind,
    ...(decision ? { effectiveDecision: decision } : {}),
    search: c.req.query('search'),
    limit: parseBoundedInteger(c.req.query('limit'), 100, 1, 250),
    offset: parseBoundedInteger(c.req.query('offset'), 0, 0, 100_000),
  })
}

async function updateOverride(
  c: Context,
  deps: CollectionLibraryControllerDeps,
  decision: OverrideDecision
) {
  const id = parseId(c.req.param('id'))
  if (id === null) return c.json({ error: 'Invalid collection ID' }, 400)
  if (!(await deps.library.setOverride(id, decision))) {
    return c.json({ error: 'Collection not found' }, 404)
  }
  await deps.refreshSchedules?.()
  const detail = await deps.library.getDetail(id)
  return c.json({ collection: detail?.collection ?? null })
}

function toPublicFile(item: MediaItem) {
  return {
    id: item.id,
    filename: item.filename,
    relativePath: item.relativePath ?? item.filename,
    durationSeconds: item.durationSeconds,
    mediaType: item.mediaType,
    seasonNumber: item.seasonNumber ?? null,
    episodeNumber: item.episodeNumber ?? null,
    episodeTitle: item.episodeTitle ?? null,
    episodeMetadataTitle: item.episodeMetadataTitle ?? null,
    episodeOverview: item.episodeOverview ?? null,
    episodeAirDate: item.episodeAirDate ?? null,
    episodeStillPath: item.episodeStillPath ?? null,
    codec: item.codec,
    width: item.width,
    height: item.height,
    compatibility: item.compatibility,
    warning: item.warning,
    rootAvailable: item.rootAvailable === true,
    playbackEnabled: item.playbackEnabled === true,
  }
}

function parseId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function parseDecision(value: string | undefined): PolicyDecision | null {
  return value === 'allow' || value === 'review' || value === 'block'
    ? value
    : null
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined || !/^\d+$/.test(value)) return fallback
  return Math.max(minimum, Math.min(maximum, Number(value)))
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const value = await c.req.json()
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
