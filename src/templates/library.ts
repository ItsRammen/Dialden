/**
 * Library Template
 *
 * Media library with grid/list views, filtering, search, and file management.
 * Uses pure HTMX for all interactions - no page reloads or inline JS.
 */

import type { MediaItem, MediaType } from '../types'
import type { AppConfig } from '../repositories/ConfigRepository'
import { renderLayout } from './layout'
import { escapeHtml, formatTime } from './utils'

export interface LibraryProps {
  media: MediaItem[]
  config?: AppConfig
  mediaDirectory: string
  mediaWritable?: boolean
  view: 'list' | 'grid'
  filter: 'all' | 'approved' | 'blocked' | 'videos' | 'interludes'
  search: string
}

/**
 * Full library page with layout wrapper.
 * Used for initial page load.
 */
export function renderLibrary(props: LibraryProps): string {
  return renderLayout('Library', renderLibraryContent(props))
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
  } = props
  const safeSearch = escapeHtml(search)
  const encodedSearch = encodeURIComponent(search)
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
      '📺',
      videos,
      view,
      config,
      mediaWritable
    )
  } else if (filter === 'interludes') {
    mediaContent = renderMediaSection(
      'Interludes',
      '🎬',
      interludes,
      view,
      config,
      mediaWritable
    )
  } else {
    mediaContent = renderMediaSection(
      filter === 'approved' ? 'Kids 7 Approved' : 'Not Scheduled',
      filter === 'approved' ? '✅' : '🔒',
      filteredMedia,
      view,
      config,
      mediaWritable
    )
  }

  return `
    <div class="library" id="library-content">
      <h1>Media Library (${filteredMedia.length})</h1>
      
      <!-- Toolbar -->
      <div class="library-toolbar">
        <div class="search-box">
          <input type="text" 
                 id="search-input"
                 name="search"
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
              ? `<button type="button" class="search-clear" 
                              hx-get="/partials/library?view=${view}&filter=${filter}" 
                              hx-target="#library-content" 
                              hx-swap="outerHTML">×</button>`
              : ''
          }
        </div>
        
        <div class="filter-buttons"
             hx-boost="true"
             hx-target="#library-content"
             hx-swap="outerHTML"
             hx-push-url="false">
          <a href="/partials/library?view=${view}&filter=all&search=${encodedSearch}" class="btn btn-small ${filter === 'all' ? 'active' : ''}">All Media</a>
          <a href="/partials/library?view=${view}&filter=approved&search=${encodedSearch}" class="btn btn-small ${filter === 'approved' ? 'active' : ''}">✅ Kids 7</a>
          <a href="/partials/library?view=${view}&filter=blocked&search=${encodedSearch}" class="btn btn-small ${filter === 'blocked' ? 'active' : ''}">🔒 Not Scheduled</a>
          <a href="/partials/library?view=${view}&filter=videos&search=${encodedSearch}" class="btn btn-small ${filter === 'videos' ? 'active' : ''}">📺 Videos</a>
          <a href="/partials/library?view=${view}&filter=interludes&search=${encodedSearch}" class="btn btn-small ${filter === 'interludes' ? 'active' : ''}">🎬 Interludes</a>
        </div>
        
        <div class="view-buttons"
             hx-boost="true"
             hx-target="#library-content"
             hx-swap="outerHTML"
             hx-push-url="false">
          <a href="/partials/library?view=list&filter=${filter}&search=${encodedSearch}" class="btn btn-small ${view === 'list' ? 'active' : ''}" title="List view">☰</a>
          <a href="/partials/library?view=grid&filter=${filter}&search=${encodedSearch}" class="btn btn-small ${view === 'grid' ? 'active' : ''}" title="Grid view">⊞</a>
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
          <span class="dropzone-icon">📂</span>
          <span class="dropzone-text">Drop video files here</span>
          <span class="dropzone-or">or</span>
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
      </div>`
          : `<div class="dropzone">
        <div class="dropzone-content">
          <span class="dropzone-icon">🔒</span>
          <span class="dropzone-text">Media is mounted read-only</span>
          <span class="dropzone-or">Add files on the Docker host, then rescan.</span>
        </div>
      </div>`
      }

      <div id="media-container">
        ${
          filteredMedia.length === 0
            ? `<div class="empty-state">
               <span class="empty-icon">📺</span>
               <p>No videos yet</p>
               <p class="empty-hint">${mediaWritable ? 'Drop files above or add to' : 'Add files on the host mount for'} <code>${safeMediaDirectory}</code></p>
             </div>`
            : mediaContent
        }
      </div>
    </div>
  `
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
  return `
    <select class="type-select"
            name="mode"
            aria-label="Playback eligibility for ${escapeHtml(item.filename)}"
            hx-post="/api/playback-eligibility/${item.id}"
            hx-trigger="change"
            hx-target="#toast-container"
            hx-swap="innerHTML">
      <option value="policy" ${mode === 'policy' ? 'selected' : ''}>Use collection decision</option>
      <option value="allow" ${mode === 'allow' ? 'selected' : ''}>Parent approve</option>
      <option value="block" ${mode === 'block' ? 'selected' : ''}>Never schedule</option>
    </select>
  `
}

function renderDeleteButton(item: MediaItem): string {
  return `
    <button class="btn btn-danger btn-small"
            hx-delete="/api/media/${item.id}"
            hx-target="#media-${item.id}"
            hx-swap="outerHTML"
            hx-confirm="Delete ${escapeHtml(item.filename)}?">
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
  items: MediaItem[],
  view: 'list' | 'grid',
  config?: AppConfig,
  mediaWritable = true
): string {
  return `
    <section class="media-section">
      <h2>${icon} ${title} (${items.length})</h2>
      <div class="${view === 'grid' ? 'media-grid' : 'media-list'}">
        ${items.length === 0 ? '<p class="empty-list">No files matching filter</p>' : items.map((item) => renderMediaItem(item, view, config, mediaWritable)).join('')}
      </div>
    </section>
  `
}
