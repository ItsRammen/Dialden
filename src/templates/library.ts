/**
 * Library Template
 *
 * Media library with grid/list views, filtering, search, and file management.
 * Uses pure HTMX for all interactions - no page reloads or inline JS.
 */

import type { MediaFileListFilter, MediaItem, MediaType } from '../types'
import type { AppConfig } from '../repositories/ConfigRepository'
import { renderLayout, renderLibraryNavigation } from './layout'
import { escapeHtml, formatTime } from './utils'

export interface LibraryProps {
  media: readonly MediaItem[]
  config?: AppConfig
  mediaDirectory: string
  mediaWritable?: boolean
  view: 'list' | 'grid'
  filter: MediaFileListFilter
  search: string
  /** Current one-based page. Optional for small direct template consumers. */
  page?: number
  pageSize?: number
  /** Total rows matching the database query, not only this page. */
  totalCount?: number
}

interface LibraryNavigationState {
  readonly view: 'list' | 'grid'
  readonly filter: MediaFileListFilter
  readonly search: string
  readonly page: number
}

function libraryHref(
  base: '/library/files' | '/partials/library',
  state: LibraryNavigationState
): string {
  return `${base}?view=${state.view}&filter=${state.filter}&search=${encodeURIComponent(state.search)}&page=${state.page}`
}

function renderLibraryLink(
  label: string,
  state: LibraryNavigationState,
  className: string,
  title?: string
): string {
  const href = escapeHtml(libraryHref('/library/files', state))
  const partial = escapeHtml(libraryHref('/partials/library', state))
  return `<a href="${href}"
             hx-get="${partial}"
             hx-target="#library-content"
             hx-swap="outerHTML"
             hx-push-url="${href}"
             class="${escapeHtml(className)}"${title ? ` title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"` : ''}>${label}</a>`
}

/**
 * Full library page with layout wrapper.
 * Used for initial page load.
 */
export function renderLibrary(props: LibraryProps): string {
  return renderLayout('File diagnostics · Library', renderLibraryContent(props))
}

/**
 * Library content partial without layout.
 * Used for htmx partial updates (search, filter changes).
 */
export function renderLibraryContent(props: LibraryProps): string {
  const {
    media,
    config,
    mediaDirectory,
    mediaWritable = true,
    view,
    filter,
    search,
    page = 1,
    pageSize = 100,
    totalCount,
  } = props
  const safeSearch = escapeHtml(search)
  const safeMediaDirectory = escapeHtml(mediaDirectory)

  // Apply filter
  let filteredMedia = media
  if (filter === 'videos') {
    filteredMedia = media.filter((m) => !m.isInterlude)
  } else if (filter === 'interludes') {
    filteredMedia = media.filter((m) => m.isInterlude)
  } else if (filter === 'approved') {
    filteredMedia = media.filter((m) => m.playbackEnabled === true)
  } else if (filter === 'blocked') {
    filteredMedia = media.filter((m) => m.playbackEnabled === false)
  } else if (filter === 'errors') {
    filteredMedia = media.filter(
      (m) => m.durationSeconds <= 0 || m.warning !== null
    )
  }

  // Apply search
  if (search) {
    const searchLower = search.toLowerCase()
    filteredMedia = filteredMedia.filter(
      (m) =>
        m.filename.toLowerCase().includes(searchLower) ||
        (m.collectionTitle ?? '').toLowerCase().includes(searchLower)
    )
  }

  // Sort special items (intro, outro, offair) to top
  if (config) {
    const specialIds = new Set(
      [
        config.session.introVideoId,
        config.session.outroVideoId,
        config.session.offAirAssetId,
      ].filter((id): id is number => id !== null)
    )

    filteredMedia = [...filteredMedia].sort((a, b) => {
      const aSpecial = specialIds.has(a.id)
      const bSpecial = specialIds.has(b.id)
      if (aSpecial && !bSpecial) return -1
      if (!aSpecial && bSpecial) return 1
      return 0
    })
  }

  const videos = filteredMedia.filter((m) => !m.isInterlude)
  const interludes = filteredMedia.filter((m) => m.isInterlude)
  const total = totalCount ?? filteredMedia.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const currentPage = Math.max(1, Math.min(page, pageCount))
  const navigation = { view, filter, search, page: currentPage }
  const refreshHref = escapeHtml(libraryHref('/partials/library', navigation))
  const libraryIsActuallyEmpty =
    filter === 'all' && search.trim() === '' && total === 0

  // Build content based on filter
  let mediaContent = ''
  if (filter === 'all') {
    mediaContent = `
      <div class="${view === 'grid' ? 'media-grid' : 'media-list'}">
        ${filteredMedia.length === 0 ? '<p class="empty-list">No media files</p>' : filteredMedia.map((item) => renderMediaItem(item, view, config, mediaWritable)).join('')}
      </div>
    `
  } else if (filter === 'videos') {
    mediaContent = renderMediaSection(
      'Videos',
      '',
      videos,
      view,
      config,
      mediaWritable,
      total
    )
  } else if (filter === 'interludes') {
    mediaContent = renderMediaSection(
      'Station assets',
      '',
      interludes,
      view,
      config,
      mediaWritable,
      total
    )
  } else if (filter === 'errors') {
    mediaContent = renderMediaSection(
      'Technical failures',
      '',
      filteredMedia,
      view,
      config,
      mediaWritable,
      total
    )
  } else {
    mediaContent = renderMediaSection(
      filter === 'approved' ? 'Playable files' : 'Not Scheduled',
      '',
      filteredMedia,
      view,
      config,
      mediaWritable,
      total
    )
  }

  return `
    <div class="library" id="library-content"
         hx-get="${refreshHref}"
         hx-trigger="libraryEligibilityChanged from:body"
         hx-target="this"
         hx-swap="outerHTML">
      <div class="library-page-heading">
        <div><p class="library-eyebrow">File diagnostics</p><h1>Indexed files</h1></div>
        <span class="library-count">${total.toLocaleString('en-US')} records</span>
      </div>
      
      ${renderLibraryNavigation('files')}
      <!-- Toolbar -->
      <div class="library-toolbar">
        <div class="search-box">
          <input type="text" 
                 id="search-input"
                 name="search"
                 aria-label="Search indexed files"
                 placeholder="Search..." 
                 value="${safeSearch}"
                 autocomplete="off"
                 hx-get="/partials/library"
                 hx-trigger="input changed delay:300ms"
                 hx-target="#library-content"
                 hx-swap="outerHTML"
                 hx-include="[name='view'],[name='filter']">
          <input type="hidden" name="view" value="${view}">
          <input type="hidden" name="filter" value="${filter}">
          ${
            search
              ? `<button type="button" class="search-clear" aria-label="Clear file search"
                              hx-get="${escapeHtml(libraryHref('/partials/library', { ...navigation, search: '', page: 1 }))}"
                              hx-target="#library-content" 
                              hx-swap="outerHTML"
                              hx-push-url="${escapeHtml(libraryHref('/library/files', { ...navigation, search: '', page: 1 }))}">×</button>`
              : ''
          }
        </div>
        
        <div class="filter-buttons">
          ${renderLibraryLink('All Media', { ...navigation, filter: 'all', page: 1 }, `btn btn-small ${filter === 'all' ? 'active' : ''}`)}
          ${renderLibraryLink('Playable', { ...navigation, filter: 'approved', page: 1 }, `btn btn-small ${filter === 'approved' ? 'active' : ''}`)}
          ${renderLibraryLink('Not scheduled', { ...navigation, filter: 'blocked', page: 1 }, `btn btn-small ${filter === 'blocked' ? 'active' : ''}`)}
          ${renderLibraryLink('File errors', { ...navigation, filter: 'errors', page: 1 }, `btn btn-small library-filter-errors ${filter === 'errors' ? 'active' : ''}`)}
          ${renderLibraryLink('Videos', { ...navigation, filter: 'videos', page: 1 }, `btn btn-small ${filter === 'videos' ? 'active' : ''}`)}
          ${renderLibraryLink('Station assets', { ...navigation, filter: 'interludes', page: 1 }, `btn btn-small ${filter === 'interludes' ? 'active' : ''}`)}
        </div>
        
        <div class="view-buttons">
          ${renderLibraryLink('☰', { ...navigation, view: 'list' }, `btn btn-small ${view === 'list' ? 'active' : ''}`, 'List view')}
          ${renderLibraryLink('⊞', { ...navigation, view: 'grid' }, `btn btn-small ${view === 'grid' ? 'active' : ''}`, 'Grid view')}
        </div>
      </div>
      
      ${
        mediaWritable
          ? `<!-- Upload Dropzone -->
      <div class="dropzone"
           hx-post="/api/upload"
           hx-target="#library-content"
           hx-swap="outerHTML"
           hx-encoding="multipart/form-data"
           hx-trigger="drop"
           ondragover="event.preventDefault(); this.classList.add('dragover')"
           ondragleave="this.classList.remove('dragover')"
           ondrop="this.classList.remove('dragover')">
        <div class="dropzone-content">
          <span class="dropzone-text"><strong>Add files</strong><small>Drop compatible media here or choose files.</small></span>
          <label class="btn btn-primary">
            Choose Files
            <input type="file"
                   name="files"
                   multiple
                   accept="video/*"
                   style="display: none"
                   hx-trigger="change"
                   hx-post="/api/upload"
                   hx-target="#library-content"
                   hx-swap="outerHTML"
                   hx-encoding="multipart/form-data">
          </label>
        </div>
        <input type="hidden" name="view" value="${view}">
        <input type="hidden" name="filter" value="${filter}">
        <input type="hidden" name="search" value="${safeSearch}">
        <input type="hidden" name="page" value="${currentPage}">
      </div>`
          : `<div class="dropzone dropzone-readonly">
        <div class="dropzone-content">
          <span class="dropzone-readonly-copy"><strong>Media is mounted read-only</strong><small>Add files on the Docker host, then rescan.</small></span>
        </div>
      </div>`
      }

      <div id="media-container">
        ${
          libraryIsActuallyEmpty
            ? `<div class="empty-state">
               <p><strong>No media indexed yet</strong></p>
               <p class="empty-hint">${mediaWritable ? 'Drop files above or add to' : 'Add files on the host mount for'} <code>${safeMediaDirectory}</code></p>
             </div>`
            : mediaContent
        }
      </div>
      ${renderMediaPagination(navigation, total, pageSize)}
    </div>
  `
}

function renderMediaPagination(
  state: LibraryNavigationState,
  total: number,
  pageSize: number
): string {
  if (total <= 0) return ''
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const start = (state.page - 1) * pageSize + 1
  const end = Math.min(total, state.page * pageSize)
  const previous =
    state.page > 1
      ? renderLibraryLink(
          '← Previous',
          { ...state, page: state.page - 1 },
          'btn btn-small',
          'Previous page'
        )
      : '<span></span>'
  const next =
    state.page < pageCount
      ? renderLibraryLink(
          'Next →',
          { ...state, page: state.page + 1 },
          'btn btn-small',
          'Next page'
        )
      : '<span></span>'

  return `<nav class="library-pagination" aria-label="Advanced files pages">
    ${previous}
    <span>Showing ${start}–${end} of ${total} files · Page ${state.page} of ${pageCount}</span>
    ${next}
  </nav>`
}

/**
 * Render a single media item.
 * Exported for OOB swap updates.
 */
export function renderMediaItem(
  item: MediaItem,
  view: 'list' | 'grid',
  config?: AppConfig,
  mediaWritable = true
): string {
  const status = getDateStatus(item)
  const thumbnailUrl = `/thumbnails/${item.id}.jpg`

  // Determine effective media type for UI
  let displayType = item.mediaType
  if (config) {
    if (config.session.introVideoId === item.id) displayType = 'intro'
    else if (config.session.outroVideoId === item.id) displayType = 'outro'
    else if (config.session.offAirAssetId === item.id) displayType = 'offair'
  }

  // Get CSS class for special item types
  const getItemClass = (type: MediaType): string => {
    switch (type) {
      case 'interlude':
        return 'interlude'
      case 'intro':
        return 'intro'
      case 'outro':
        return 'outro'
      case 'offair':
        return 'offair'
      default:
        return ''
    }
  }
  const itemClass = getItemClass(displayType)

  // Compatibility badge for hardware issues
  const getCompatibilityBadge = (): string => {
    if (item.compatibility === 'incompatible') {
      return '<span class="compat-badge compat-incompatible" title="Cannot play on this device">❌</span>'
    }
    if (item.compatibility === 'marginal') {
      return '<span class="compat-badge compat-marginal" title="May stutter or drop frames">⚠️</span>'
    }
    return ''
  }
  const compatBadge = getCompatibilityBadge()
  const safeFilename = escapeHtml(item.filename)
  const safeCollection = escapeHtml(item.collectionTitle ?? '')
  const eligibilityBadge = renderEligibilityBadge(item)
  const technicalIssue = renderTechnicalIssue(item)

  if (view === 'grid') {
    return `
      <div class="media-card ${itemClass ? `${itemClass}-card` : ''}" id="media-${item.id}">
        <div class="media-card-thumb" style="background-image: url('${thumbnailUrl}')">
          <span class="media-card-duration">${formatTime(item.durationSeconds)}</span>
          ${status ? `<span class="status-pill ${status.class}">${status.label}</span>` : ''}
          ${compatBadge}
          ${eligibilityBadge}
          <span class="media-type-badge" id="badge-${item.id}">${MEDIA_TYPE_ICONS[displayType]}</span>
        </div>
        <div class="media-card-info">
          <span class="media-card-name">${safeFilename}</span>
          ${safeCollection && safeCollection !== safeFilename ? `<span class="media-collection-name">${safeCollection}</span>` : ''}
        </div>
        ${technicalIssue}
        <div class="media-card-actions">
          ${renderTypeSelect(item, displayType)}
          ${renderEligibilitySelect(item)}
          ${mediaWritable ? renderDeleteButton(item) : ''}
        </div>
      </div>
    `
  }

  return `
    <div class="media-item ${itemClass ? `${itemClass}-item` : ''}" id="media-${item.id}">
      <div class="media-item-main">
        <div class="media-thumb" style="background-image: url('${thumbnailUrl}')"></div>
        <span class="media-icon" id="badge-${item.id}">${MEDIA_TYPE_ICONS[displayType]}</span>
        <span class="media-name">${safeFilename}</span>
        ${safeCollection && safeCollection !== safeFilename ? `<span class="media-collection-name">${safeCollection}</span>` : ''}
        ${compatBadge}
        ${eligibilityBadge}
        ${status ? `<span class="status-pill ${status.class}">${status.label}</span>` : ''}
        <span class="media-duration">${formatTime(item.durationSeconds)}</span>
        ${renderTypeSelect(item, displayType)}
        ${renderEligibilitySelect(item)}
        ${mediaWritable ? renderDeleteButton(item) : ''}
      </div>
      ${technicalIssue}
      ${renderDatePicker(item, displayType)}
    </div>
  `
}

import { isSeasonalActive } from '../utils/date'

// ... existing imports

function getDateStatus(
  item: MediaItem
): { label: string; class: string } | null {
  if (!item.isInterlude) return null

  if (!item.dateStart && !item.dateEnd)
    return { label: 'Always', class: 'active' }

  if (item.dateStart && item.dateEnd) {
    if (isSeasonalActive(item.dateStart, item.dateEnd)) {
      return { label: 'Active', class: 'active' }
    }
    return { label: 'Inactive', class: 'expired' } // Renamed from Expired
  }

  return { label: 'Partial', class: 'scheduled' }
}

const MEDIA_TYPE_ICONS: Record<MediaType, string> = {
  video: '📺',
  interlude: '🎬',
  intro: '🌅',
  outro: '👋',
  offair: '🌙',
}

function renderTypeSelect(item: MediaItem, displayType: MediaType): string {
  return `
    <select class="type-select" 
            id="select-${item.id}"
            name="type"
            autocomplete="off"
            hx-post="/api/update-type/${item.id}"
            hx-trigger="change"
            hx-target="#toast-container"
            hx-swap="innerHTML">
      <option value="video" ${displayType === 'video' ? 'selected' : ''}>📺 Video</option>
      <option value="interlude" ${displayType === 'interlude' ? 'selected' : ''}>🎬 Interlude</option>
      <option value="intro" ${displayType === 'intro' ? 'selected' : ''}>🌅 Intro</option>
      <option value="outro" ${displayType === 'outro' ? 'selected' : ''}>👋 Outro</option>
      <option value="offair" ${displayType === 'offair' ? 'selected' : ''}>🌙 Off-Air</option>
    </select>
  `
}

function renderTechnicalIssue(item: MediaItem): string {
  if (item.durationSeconds > 0 && item.warning === null) return ''
  const detail = item.warning?.trim()
    ? item.warning
    : 'The media probe did not return a valid duration.'
  return `<div class="media-technical-issue" role="note">
    <strong>Technical failure</strong>
    <span>${escapeHtml(detail)}</span>
    <code title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</code>
  </div>`
}

function renderEligibilityBadge(item: MediaItem): string {
  const effective = item.playbackEnabled === true
  return `<span id="eligibility-${item.id}" class="status-pill ${effective ? 'active' : 'expired'}">${effective ? 'Playable' : 'Not scheduled'}</span>`
}

function renderEligibilitySelect(item: MediaItem): string {
  const mode =
    item.playbackOverride === null || item.playbackOverride === undefined
      ? 'policy'
      : item.playbackOverride
        ? 'allow'
        : 'block'
  const collectionDecision =
    item.policyEnabled === true
      ? 'allows scheduling'
      : 'does not allow scheduling'
  return `
    <select class="type-select"
            name="mode"
            aria-label="Playback eligibility for ${escapeHtml(item.filename)}"
            title="Remove the per-file override and follow this collection's current decision"
            hx-post="/api/playback-eligibility/${item.id}"
            hx-trigger="change"
            hx-target="#toast-container"
            hx-swap="innerHTML">
      <option value="policy" ${mode === 'policy' ? 'selected' : ''}>Use collection decision — ${collectionDecision}</option>
      <option value="allow" ${mode === 'allow' ? 'selected' : ''}>Parent approve</option>
      <option value="block" ${mode === 'block' ? 'selected' : ''}>Never schedule</option>
    </select>
  `
}

function renderDeleteButton(item: MediaItem): string {
  return `
    <button class="btn btn-danger btn-small"
            aria-label="Remove ${escapeHtml(item.filename)} from the media index"
            title="Remove from the index; the host file is not deleted"
            hx-delete="/api/media/${item.id}"
            hx-target="#media-${item.id}"
            hx-swap="outerHTML"
            hx-confirm="Remove ${escapeHtml(item.filename)} from the index? The host file remains and will return on the next rescan.">
      ✕
    </button>
  `
}

export function renderDatePicker(
  item: MediaItem,
  displayType: MediaType = item.mediaType
): string {
  if (displayType !== 'interlude') return ''

  return `
    <form class="media-item-dates date-picker-container" id="dates-${item.id}"
          hx-post="/api/update-dates/${item.id}"
          hx-trigger="change"
          hx-target="#dates-${item.id}"
          hx-swap="outerHTML">
      <input type="text" 
             class="date-input-compact" 
             name="dateStart"
             value="${escapeHtml(item.dateStart ?? '')}"
             placeholder="MM-DD"
             pattern="\\d{2}-\\d{2}"
             title="Format: MM-DD (e.g. 12-01)">
      <span class="date-separator">→</span>
      <input type="text" 
             class="date-input-compact" 
             name="dateEnd"
             value="${escapeHtml(item.dateEnd ?? '')}"
             placeholder="MM-DD"
             pattern="\\d{2}-\\d{2}"
             title="Format: MM-DD (e.g. 02-28)">
      ${
        item.dateStart || item.dateEnd
          ? `
        <button type="button" class="btn-clear-date"
                hx-post="/api/update-dates/${item.id}"
                hx-vals='{"dateStart": "", "dateEnd": ""}'
                hx-target="#dates-${item.id}"
                hx-swap="outerHTML"
                title="Clear Schedule">
          ✕
        </button>
      `
          : ''
      }
    </form>
  `
}

function renderMediaSection(
  title: string,
  icon: string,
  items: readonly MediaItem[],
  view: 'list' | 'grid',
  config?: AppConfig,
  mediaWritable = true,
  totalCount = items.length
): string {
  return `
    <section class="media-section">
      <h2>${icon} ${title} (${totalCount})</h2>
      <div class="${view === 'grid' ? 'media-grid' : 'media-list'}">
        ${items.length === 0 ? '<p class="empty-list">No files matching filter</p>' : items.map((item) => renderMediaItem(item, view, config, mediaWritable)).join('')}
      </div>
    </section>
  `
}
