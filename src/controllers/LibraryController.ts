/**
 * Library Controller
 *
 * Handles media library pages and API endpoints.
 */

import { Hono } from 'hono'
import { html } from 'hono/html'
import type { MediaService } from '../services/MediaService'
import type { ConfigService } from '../services/ConfigService'
import type { PlaylistEngine } from '../services/PlaylistEngine'
import type { PlaybackService } from '../services/PlaybackService'
import { renderLibrary, renderLibraryContent } from '../templates/library'
import type { MediaType } from '../types'
import { isAbsolute, posix, relative, resolve } from 'node:path'
import { lstatSync } from 'node:fs'

interface LibraryControllerDeps {
  config: ConfigService
  media: MediaService
  playlist: PlaylistEngine
  playback?: Pick<PlaybackService, 'reconcilePrequeue'>
  mediaWritable?: boolean
}

export function createLibraryController(deps: LibraryControllerDeps) {
  const { config, media, playlist, playback, mediaWritable = true } = deps
  const controller = new Hono()

  // Helper to parse library query params
  type LibraryFilter =
    | 'all'
    | 'approved'
    | 'blocked'
    | 'videos'
    | 'interludes'
  const parseView = (value: unknown): 'list' | 'grid' =>
    value === 'grid' ? 'grid' : 'list'
  const parseFilter = (value: unknown): LibraryFilter =>
    ['all', 'approved', 'blocked', 'videos', 'interludes'].includes(
      String(value)
    )
      ? (value as LibraryFilter)
      : 'approved'
  const getLibraryParams = (c: {
    req: { query: (k: string) => string | undefined }
  }) => ({
    view: parseView(c.req.query('view')),
    filter: parseFilter(c.req.query('filter')),
    search: c.req.query('search') ?? '',
  })

  // --- Pages ---

  controller.get('/library', async (c) => {
    const allMedia = await media.getAll()
    const appConfig = await config.get()
    const { view, filter, search } = getLibraryParams(c)

    // Generate thumbnails in background (non-blocking)
    void media.generateThumbnails()

    return c.html(
      renderLibrary({
        media: allMedia,
        config: appConfig,
        mediaDirectory: media.getMediaDirectory(),
        mediaWritable,
        view,
        filter,
        search,
      })
    )
  })

  // --- Partials ---

  controller.get('/partials/library', async (c) => {
    const allMedia = await media.getAll()
    const appConfig = await config.get()
    const { view, filter, search } = getLibraryParams(c)
    void media.generateThumbnails()
    return c.html(
      renderLibraryContent({
        media: allMedia,
        config: appConfig,
        mediaDirectory: media.getMediaDirectory(),
        mediaWritable,
        view,
        filter,
        search,
      })
    )
  })

  // --- API Endpoints ---

  // Rescan media - returns updated library content (or just toast if from settings)
  controller.post('/api/rescan', async (c) => {
    const count = await media.rescan()
    await playlist.refreshCache() // Update playlist with new media
    await playback?.reconcilePrequeue()
    const body = await c.req.parseBody()

    // If no view param, called from Settings - just return toast
    if (!body['view']) {
      return c.html(`<div class="toast success">Scanned ${count} files</div>`)
    }

    const allMedia = await media.getAll()
    const appConfig = await config.get()
    const view = parseView(body['view'])
    const filter = parseFilter(body['filter'])
    const search = (body['search'] as string) ?? ''

    void media.generateThumbnails()

    // Return library content with OOB toast
    return c.html(`
      ${renderLibraryContent({
        media: allMedia,
        config: appConfig,
        mediaDirectory: media.getMediaDirectory(),
        mediaWritable,
        view,
        filter,
        search,
      })}
      <div id="toast-container" hx-swap-oob="innerHTML">
        <div class="toast success">Scanned ${count} files</div>
      </div>
    `)
  })

  // File upload - returns updated library content
  controller.post('/api/upload', async (c) => {
    if (!mediaWritable) {
      return c.html(
        html`<div class="toast warning">The media library is mounted read-only</div>`,
        403
      )
    }

    const body = await c.req.parseBody({ all: true })
    const files = body['files']
    const view = parseView(body['view'])
    const filter = parseFilter(body['filter'])
    const search = (body['search'] as string) ?? ''

    if (!files) {
      return c.html(html`<div class="toast warning">No files uploaded</div>`)
    }

    const fileList = Array.isArray(files) ? files : [files]
    const uploadFiles = fileList.filter(
      (file): file is File => file instanceof File
    )

    if (uploadFiles.length === 0) {
      return c.html(
        html`<div class="toast warning">No valid files uploaded</div>`,
        400
      )
    }

    const mediaRoot = resolve(media.getMediaDirectory())
    const destinations = uploadFiles.map((file) => {
      const normalizedName = file.name.replace(/\\/g, '/')
      const safeName = posix.basename(normalizedName)
      const destination = resolve(mediaRoot, safeName)
      const relativeDestination = relative(mediaRoot, destination)
      const isContained =
        safeName !== '' &&
        safeName !== '.' &&
        safeName !== '..' &&
        safeName === normalizedName &&
        !relativeDestination.startsWith('..') &&
        !isAbsolute(relativeDestination)

      let destinationIsSafe = true
      try {
        destinationIsSafe = !lstatSync(destination).isSymbolicLink()
      } catch (error) {
        destinationIsSafe =
          error instanceof Error &&
          'code' in error &&
          (error as NodeJS.ErrnoException).code === 'ENOENT'
      }

      return isContained && destinationIsSafe ? destination : null
    })

    if (destinations.some((destination) => destination === null)) {
      return c.html(
        html`<div class="toast warning">Invalid upload filename</div>`,
        400
      )
    }

    let uploaded = 0

    for (let index = 0; index < uploadFiles.length; index++) {
      const file = uploadFiles[index]
      const destination = destinations[index]
      if (!file || !destination) continue
      const buffer = await file.arrayBuffer()
      await Bun.write(destination, buffer)
      uploaded++
    }

    // Rescan after upload
    await media.rescan()
    const allMedia = await media.getAll()
    const appConfig = await config.get()
    void media.generateThumbnails()

    // Return library content with OOB toast
    return c.html(`
      ${renderLibraryContent({
        media: allMedia,
        config: appConfig,
        mediaDirectory: media.getMediaDirectory(),
        mediaWritable,
        view,
        filter,
        search,
      })}
      <div id="toast-container" hx-swap-oob="innerHTML">
        <div class="toast success">Uploaded ${uploaded} files</div>
      </div>
    `)
  })

  // Delete media - returns empty (htmx swaps outerHTML to remove element)
  controller.delete('/api/media/:id', async (c) => {
    if (!mediaWritable) {
      return c.html(
        html`<div class="toast warning">The media library is mounted read-only</div>`,
        403
      )
    }

    const id = parseInt(c.req.param('id'), 10)
    if (!Number.isNaN(id)) {
      await media.delete(id)
      // Return empty content (item removed) with OOB toast
      return c.html(`
        <div id="toast-container" hx-swap-oob="innerHTML">
          <div class="toast success">Deleted</div>
        </div>
      `)
    }
    return c.html(html`<div class="toast warning">Invalid ID</div>`, 400)
  })

  // Toggle interlude status
  controller.post('/api/toggle-interlude/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const body = await c.req.parseBody()
    const isInterlude = body['interlude'] === 'true'
    if (!Number.isNaN(id)) {
      await media.toggleInterlude(id, isInterlude)
      return c.html(
        html`<div class="toast success">
          ${isInterlude ? 'Marked as interlude' : 'Marked as video'}
        </div>`
      )
    }
    return c.html(html`<div class="toast warning">Invalid ID</div>`)
  })

  // Update media type
  controller.post('/api/update-type/:id', async (c) => {
    const rawId = c.req.param('id')
    const id = /^\d+$/.test(rawId) ? Number(rawId) : Number.NaN
    const body = await c.req.parseBody()
    const rawMediaType = String(body['type'] ?? '')
    const allowedTypes: readonly MediaType[] = [
      'video',
      'interlude',
      'intro',
      'outro',
      'offair',
    ]
    const mediaType = allowedTypes.includes(rawMediaType as MediaType)
      ? (rawMediaType as MediaType)
      : null
    if (Number.isSafeInteger(id) && id > 0 && mediaType) {
      let message = ''

      // Handle Intro/Outro/Off-Air setting logic
      if (mediaType === 'intro') {
        await config.update({ session: { introVideoId: id } })
        message = 'Set as Intro'
      } else if (mediaType === 'outro') {
        await config.update({ session: { outroVideoId: id } })
        message = 'Set as Outro'
      } else if (mediaType === 'offair') {
        await config.update({ session: { offAirAssetId: id } })
        message = 'Set as Off-Air Screen'
      } else {
        // Video/Interlude
        await media.updateType(id, mediaType)

        // If it WAS intro/outro, we might need to clear that config?
        const currentConfig = await config.get()
        if (currentConfig.session.introVideoId === id) {
          await config.update({ session: { introVideoId: null } })
        }
        if (currentConfig.session.outroVideoId === id) {
          await config.update({ session: { outroVideoId: null } })
        }
        if (currentConfig.session.offAirAssetId === id) {
          await config.update({ session: { offAirAssetId: null } })
        }
        message =
          mediaType === 'interlude' ? 'Marked as Interlude' : 'Marked as Video'
      }

      // We need to re-render the badge which OOB swaps
      const typeLabels: Record<MediaType, string> = {
        video: '📺 Video',
        interlude: '🎬 Interlude',
        intro: '🌅 Intro Video',
        outro: '👋 Outro Video',
        offair: '🌙 Off-Air Screen',
      }

      const typeIcons: Record<MediaType, string> = {
        video: '📺',
        interlude: '🎬',
        intro: '🌅',
        outro: '👋',
        offair: '🌙',
      }

      // Determine what to show in badge
      // We know what we just set it to.
      // Ideally we would fetch the fresh state and re-render the badge properly.

      // Since template logic is complex (it checks both ID and Type),
      // let's assume successful update.

      return c.html(`
        <div class="toast success">${message}</div>
        <span id="badge-${id}" class="media-type-badge" hx-swap-oob="true">${typeIcons[mediaType]}</span>
      `)
    }
    return c.html(html`<div class="toast warning">Invalid request</div>`, 400)
  })

  // Update media dates
  controller.post('/api/update-dates/:id', async (c) => {
    const rawId = c.req.param('id')
    const id = /^\d+$/.test(rawId) ? Number(rawId) : Number.NaN
    const body = await c.req.parseBody()
    const dateStart = (body['dateStart'] as string) || null
    const dateEnd = (body['dateEnd'] as string) || null

    const validDate = (value: string | null) => {
      if (value === null) return true
      const match = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(value)
      if (!match) return false
      const month = Number(match[1])
      const day = Number(match[2])
      const maximumDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
      return day <= (maximumDays[month - 1] ?? 0)
    }
    if (!validDate(dateStart) || !validDate(dateEnd)) {
      return c.html(
        html`<div class="toast warning">Dates must use MM-DD format</div>`,
        400
      )
    }

    if (Number.isSafeInteger(id) && id > 0) {
      await media.updateDates(id, dateStart, dateEnd)

      // Get updated item to re-render the date picker form
      const item = await media.getById(id)
      if (item) {
        const { renderDatePicker } = await import('../templates/library')
        return c.html(`
          ${renderDatePicker(item)}
          <div id="toast-container" hx-swap-oob="innerHTML">
            <div class="toast success">Dates updated</div>
          </div>
        `)
      }
    }
    return c.html(html`<div class="toast warning">Invalid ID</div>`, 400)
  })

  controller.post('/api/playback-eligibility/:id', async (c) => {
    const rawId = c.req.param('id')
    const id = /^\d+$/.test(rawId) ? Number(rawId) : Number.NaN
    const body = await c.req.parseBody()
    const mode = body['mode']
    if (
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      !['allow', 'block', 'policy'].includes(String(mode))
    ) {
      return c.html(html`<div class="toast warning">Invalid request</div>`, 400)
    }

    const existing = await media.getById(id)
    if (!existing) {
      return c.html(html`<div class="toast warning">Media not found</div>`, 404)
    }

    const override = mode === 'policy' ? null : mode === 'allow'
    await media.updatePlaybackOverride(id, override)
    if (override === true) {
      // Unapproved catalog entries intentionally skip ffprobe. A newly
      // approved item needs duration/codec metadata before schedule work can
      // safely consume it.
      await media.rescan()
    }
    await playlist.refreshCache()
    await playback?.reconcilePrequeue()
    const item = await media.getById(id)
    if (!item) return c.html(html`<div class="toast warning">Media not found</div>`, 404)

    const effective = item.playbackEnabled !== false
    const source = item.playbackOverride === null ? 'library policy' : 'parent override'
    const pendingMetadata = override === true && !effective
    return c.html(`
      <span id="eligibility-${id}" class="status-pill ${effective ? 'active' : 'expired'}" hx-swap-oob="true">
        ${effective ? 'Kids 7 approved' : 'Not scheduled'}
      </span>
      <div class="toast ${pendingMetadata ? 'warning' : 'success'}">${
        pendingMetadata
          ? 'Parent allow saved; media remains unavailable until its metadata scan succeeds'
          : `Playback eligibility updated (${source})`
      }</div>
    `)
  })

  return controller
}
