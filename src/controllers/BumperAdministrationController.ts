import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
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

  controller.use('/library/bumpers/upload', bodyLimit({
    maxSize: MAX_BUMPER_UPLOAD_BYTES + 1024 * 1024,
    onError: (c) => c.text('Upload batch exceeds the 512 MB limit. Use fewer or smaller clips.', 413),
  }))

  controller.post('/library/bumpers/upload', async (c) => {
    if (!deps.writable) return c.text('The Station Assets library is read-only', 403)
    try {
      const body = await c.req.parseBody({ all: true })
      const selected = body['file']
      const files = Array.isArray(selected) ? selected : [selected]
      if (files.length === 0 || files.some((file) => !(file instanceof File) || !file.name || file.size === 0)) {
        throw new Error('Choose one or more non-empty bumper videos to upload')
      }
      const uploads = files as File[]
      if (uploads.length > 50) throw new Error('Upload up to 50 clips at a time')
      if (uploads.reduce((total, file) => total + file.size, 0) > MAX_BUMPER_UPLOAD_BYTES) {
        throw new Error('Each upload batch is limited to 512 MB total')
      }
      const configuration = parseConfiguration(body)
      const playback = parsePlayback(body['playback'])
      let imported = 0
      const failures: string[] = []
      for (const file of uploads) {
        try {
          await deps.bumpers.upload(file.name, new Uint8Array(await file.arrayBuffer()), configuration, playback)
          imported++
        } catch (error) {
          failures.push(`${file.name}: ${errorMessage(error, 'Import failed')}`)
        }
      }
      if (imported > 0) {
        try { await deps.refreshSchedules?.() } catch {
          failures.push('Clips were saved, but schedules could not refresh. Scan again to retry.')
        }
      }
      return renderPage(c, deps, {
        kind: failures.length ? 'warning' : 'success',
        message: `Imported ${imported} of ${uploads.length} clips.${failures.length ? ' ' + failures.join(' · ') : ' Named, configured, and indexed.'}`,
      }, failures.length ? 400 : 200)
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
  const [scan, collections, directory] = await Promise.all([
    deps.bumpers.scan(),
    deps.library.list({ kind: 'tv', presentOnly: true, limit: 2000 }),
    deps.bumpers.directoryStatus(),
  ])
  const requestedFilter = c.req.query('filter') as BumperAdminFilter | undefined
  const filter = requestedFilter && FILTERS.includes(requestedFilter)
    ? requestedFilter
    : 'all'
  const queryNotice = c.req.query('notice')
  const resolvedNotice = notice ?? (queryNotice === 'saved'
    ? { kind: 'success' as const, message: 'Bumper renamed and configured.' }
    : queryNotice === 'scan'
      ? { kind: directory.state === 'ready' ? 'success' as const : 'warning' as const, message: directory.state === 'ready' ? `Scan complete: ${scan.items.length} indexed assets. Check any unavailable-file warnings below.` : `Scan finished, but the asset folder is ${directory.state}. ${directory.message}` }
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
    writable: deps.writable && directory.writable,
    directory,
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
