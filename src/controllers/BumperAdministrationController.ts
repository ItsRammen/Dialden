import { Hono, type Context } from 'hono'
import type { CollectionLibraryService } from '../services/CollectionLibraryService'
import type { BumperAdministrationService } from '../services/BumperAdministrationService'
import {
  renderBumperAdministration,
  type BumperAdminFilter,
} from '../templates/bumperAdministration'
import type {
  StationAssetConfiguration,
  StationAssetKind,
} from '../services/StationAssetService'

interface BumperAdministrationControllerDeps {
  readonly bumpers: BumperAdministrationService
  readonly library: CollectionLibraryService
  readonly writable: boolean
  readonly refreshSchedules?: () => Promise<void>
  readonly updateAvailable?: () => boolean | undefined
}

const FILTERS: readonly BumperAdminFilter[] = [
  'all',
  'attention',
  'recognized',
  'invalid',
  'legacy',
]
const KINDS: readonly StationAssetKind[] = [
  'bumper-more',
  'bumper-up-next',
  'bumper-now-next',
  'ident-general',
  'filler-general',
  'standby-loop',
]
const MAX_BUMPER_UPLOAD_BYTES = 512 * 1024 * 1024

export function createBumperAdministrationController(
  deps: BumperAdministrationControllerDeps
): Hono {
  const controller = new Hono()

  controller.get('/library/bumpers', (c) => renderPage(c, deps))

  controller.post('/library/bumpers/scan', async (c) => {
    try {
      await deps.bumpers.scan(true)
      await deps.refreshSchedules?.()
      return c.redirect('/library/bumpers?notice=scan', 303)
    } catch (error) {
      return renderPage(c, deps, {
        kind: 'warning',
        message: errorMessage(error, 'Bumper scan failed'),
      }, 500)
    }
  })

  controller.post('/library/bumpers/:id/configure', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.text('Invalid media ID', 400)
    const body = await c.req.parseBody()
    try {
      const configuration = parseConfiguration(body)
      const preview = await deps.bumpers.preview(id, configuration)
      if (String(body['mode'] ?? '') === 'preview') {
        return renderPage(c, deps, undefined, 200, {
          id,
          filename: preview.filename,
        })
      }
      const playback = parsePlayback(body['playback'])
      await deps.bumpers.configure(
        id,
        configuration,
        playback
      )
      await deps.refreshSchedules?.()
      return c.redirect('/library/bumpers?notice=saved', 303)
    } catch (error) {
      return renderPage(c, deps, {
        kind: 'warning',
        message: errorMessage(error, 'Bumper configuration failed'),
      }, 400)
    }
  })

  controller.post('/library/bumpers/upload', async (c) => {
    if (!deps.writable) return c.text('The Station Assets library is read-only', 403)
    const body = await c.req.parseBody()
    try {
      const file = body['file']
      if (!(file instanceof File)) throw new Error('Choose a bumper video to upload')
      if (file.size > MAX_BUMPER_UPLOAD_BYTES) {
        throw new Error('Bumper uploads are limited to 512 MB')
      }
      await deps.bumpers.upload(
        file.name,
        new Uint8Array(await file.arrayBuffer()),
        parseConfiguration(body),
        parsePlayback(body['playback'])
      )
      await deps.refreshSchedules?.()
      return c.redirect('/library/bumpers?notice=uploaded', 303)
    } catch (error) {
      return renderPage(c, deps, {
        kind: 'warning',
        message: errorMessage(error, 'Bumper upload failed'),
      }, 400)
    }
  })

  controller.post('/library/bumpers/generate', async (c) => {
    if (!deps.writable) return c.text('The Station Assets library is read-only', 403)
    const body = await c.req.parseBody()
    try {
      await deps.bumpers.generate(
        parseConfiguration(body),
        {
          background: String(body['background'] ?? '#0b1220'),
          foreground: String(body['foreground'] ?? '#ffffff'),
          accent: String(body['accent'] ?? '#4f8cff'),
        },
        parsePlayback(body['playback'])
      )
      await deps.refreshSchedules?.()
      return c.redirect('/library/bumpers?notice=generated', 303)
    } catch (error) {
      return renderPage(c, deps, {
        kind: 'warning',
        message: errorMessage(error, 'Bumper generation failed'),
      }, 400)
    }
  })

  return controller
}

async function renderPage(
  c: Context,
  deps: BumperAdministrationControllerDeps,
  notice?: { kind: 'success' | 'warning'; message: string },
  status: 200 | 400 | 500 = 200,
  preview?: { id: number; filename: string }
) {
  const [scan, collections] = await Promise.all([
    deps.bumpers.scan(),
    deps.library.list({ kind: 'tv', presentOnly: true, limit: 2000 }),
  ])
  const requestedFilter = c.req.query('filter') as BumperAdminFilter | undefined
  const filter = requestedFilter && FILTERS.includes(requestedFilter)
    ? requestedFilter
    : 'all'
  const queryNotice = c.req.query('notice')
  const resolvedNotice = notice ?? (queryNotice === 'saved'
    ? { kind: 'success' as const, message: 'Bumper renamed and configured.' }
    : queryNotice === 'scan'
      ? { kind: 'success' as const, message: `Scan complete: ${scan.items.length} bumper assets found.` }
      : queryNotice === 'uploaded'
        ? { kind: 'success' as const, message: 'Bumper uploaded, named, marked, and indexed.' }
        : queryNotice === 'generated'
          ? { kind: 'success' as const, message: 'Bumper rendered, named, marked, and indexed.' }
      : undefined)
  const shows = [...new Set(collections.map((collection) => {
    const title = collection.metadataTitle ?? collection.parsedTitle
    const year = collection.metadataYear ?? collection.year
    return year && !title.includes(String(year)) ? `${title} (${year})` : title
  }))].sort((left, right) => left.localeCompare(right, 'en-US'))
  return c.html(renderBumperAdministration({
    scan,
    filter,
    shows,
    writable: deps.writable,
    ...(preview ? { preview } : {}),
    ...(resolvedNotice ? { notice: resolvedNotice } : {}),
    updateAvailable: deps.updateAvailable?.(),
  }), status)
}

function parseConfiguration(
  body: Record<string, string | File | (string | File)[]>
): StationAssetConfiguration {
  const kind = String(body['kind'] ?? '') as StationAssetKind
  if (!KINDS.includes(kind)) throw new Error('Choose a valid asset type')
  return {
    station: String(body['station'] ?? ''),
    kind,
    show: String(body['show'] ?? ''),
    now: String(body['now'] ?? ''),
    next: String(body['next'] ?? ''),
    targetSeconds: Number(body['targetSeconds']),
    variant: Number(body['variant']),
  }
}

function parseId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function parsePlayback(value: unknown): 'allow' | 'block' | 'policy' {
  const playback = String(value ?? 'allow')
  if (!['allow', 'block', 'policy'].includes(playback)) {
    throw new Error('Choose a valid playback setting')
  }
  return playback as 'allow' | 'block' | 'policy'
}
