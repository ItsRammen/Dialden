import type {
  ChannelAdministrationSnapshot,
  StationBuildPreview,
  StationBuildRequest,
} from '../services/ChannelService'
import type { LibraryChannelPolicy } from '../config/library'
import type {
  StationAutomationCatalog,
  StationFacet,
} from '../services/StationAutomationService'
import { STATION_AIRTIME_OPTIONS } from '../services/StationAutomationService'
import { renderLayout } from './layout'
import { escapeHtml } from './utils'

interface ChannelAdministrationOptions {
  readonly editId?: string
  readonly newChannel?: boolean
  readonly error?: string
  readonly changed?: 'created' | 'updated' | 'deleted' | 'generated'
  readonly automation?: StationAutomationCatalog
  readonly automationDraft?: StationBuildRequest
  readonly automationPreview?: StationBuildPreview
  readonly automationSearch?: string
  readonly automationOpen?: boolean
  readonly automationTargetId?: string
  readonly channelLogoIds?: readonly string[]
  readonly channelLogoVariants?: Readonly<Record<string, readonly string[]>>
}

export function renderChannelAdministration(
  snapshot: ChannelAdministrationSnapshot,
  options: ChannelAdministrationOptions = {}
): string {
  const edit = snapshot.channels.find((channel) => channel.id === options.editId)
  const automationTarget = snapshot.channels.find(
    (channel) => channel.id === options.automationTargetId
  )
  const groups = snapshot.programmingGroups
  const offAir = new Set(snapshot.manuallyOffAir)

  return renderLayout(
    'Channels',
    `<link rel="stylesheet" href="/css/channels.css">
    <script src="/js/channels.js" defer></script>
    <div class="channel-admin">
      <header class="channel-admin-hero">
        <div>
          <p class="channel-admin-eyebrow">Broadcast setup</p>
          <h1>Channels</h1>
          <p>Create schedules from playable collections. Channel settings are saved in appdata and take effect immediately.</p>
        </div>
        <div class="channel-admin-hero-actions">
          <a class="channel-admin-link channel-admin-create" href="/channels?builder=create#station-builder">Create station</a>
          <a class="channel-admin-link" href="/">Back to dashboard</a>
        </div>
      </header>

      ${
        snapshot.configurationError
          ? `<p class="channel-admin-alert channel-admin-alert-error"><strong>Saved configuration was rejected.</strong> ${escapeHtml(snapshot.configurationError)}. No persisted channel was activated.</p>`
          : ''
      }
      ${
        options.error
          ? `<p class="channel-admin-alert channel-admin-alert-error">${escapeHtml(options.error)}</p>`
          : ''
      }
      ${
        options.changed
          ? `<p class="channel-admin-alert channel-admin-alert-success">Channel ${escapeHtml(options.changed)} successfully. The live schedule has been reloaded.</p>`
          : ''
      }

      <section class="channel-admin-grid" aria-label="Configured channels">
        ${
          snapshot.channels.length > 0
            ? snapshot.channels
                .map((channel) => renderChannelCard(channel, offAir.has(channel.id)))
                .join('')
            : '<p class="channel-admin-empty">No channels are configured yet. Create one to start broadcasting.</p>'
        }
      </section>

      ${
        options.automation && options.automationOpen
          ? renderModal(
              'station-builder',
              renderAutomationBuilder(
              options.automation,
              options.automationDraft,
              options.automationPreview,
              options.automationSearch,
              automationTarget,
              options.automationTargetId
              )
            )
          : ''
      }

      ${
        edit || options.newChannel
          ? `${options.newChannel ? '<div class="channel-modal" role="dialog" aria-modal="true" aria-labelledby="manual-editor-title"><a class="channel-modal-backdrop" href="/channels" aria-label="Close station creator"></a><div class="channel-modal-panel"><a class="channel-modal-close" href="/channels" aria-label="Close station creator">×</a>' : ''}<section class="channel-admin-editor" id="editor">
        <header>
          <div>
            <p class="channel-admin-eyebrow">${edit ? 'Edit channel' : 'New channel'}</p>
            <h2 id="manual-editor-title">${edit ? escapeHtml(edit.name) : 'Add a channel manually'}</h2>
          </div>
          <div class="channel-admin-editor-actions">
            ${edit ? `<a href="/channels?builder=${encodeURIComponent(edit.id)}#station-builder">Edit channel lineup</a>` : ''}
            <a href="/channels">Cancel</a>
          </div>
        </header>
        <form method="post" enctype="multipart/form-data" action="${edit ? `/channels/${encodeURIComponent(edit.id)}` : '/channels'}">
          <div class="channel-admin-fields">
            <label>Channel ID
              <input type="text" name="id" required maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9_-]*" value="${escapeHtml(edit?.id ?? '')}" ${edit ? 'readonly' : ''} placeholder="cartoon-classics">
              <small>Stable identifier used by TV clients; it cannot be renamed.</small>
            </label>
            <label>Display name
              <input type="text" name="name" required maxlength="100" value="${escapeHtml(edit?.name ?? '')}" placeholder="Cartoon Classics">
            </label>
            <label>Timezone
              <input type="text" name="timezone" required maxlength="100" value="${escapeHtml(edit?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)}" placeholder="America/New_York">
              <small>Use an IANA timezone such as America/New_York or Asia/Taipei.</small>
            </label>
            <label class="channel-admin-checkbox"><input type="checkbox" name="enabled" ${edit?.enabled === false ? '' : 'checked'}> Enabled and visible to TV clients</label>
          </div>
          ${renderBrandingEditor(edit, new Set(options.channelLogoIds ?? []), edit ? options.channelLogoVariants?.[edit.id] ?? [] : [])}
          ${renderScheduleDesigner(edit?.slots ?? [], groups, edit ? options.channelLogoVariants?.[edit.id] ?? [] : [])}
          <div class="channel-admin-groups">
            <strong>Groups currently assigned by the library policy</strong>
            ${
              groups.length > 0
                ? `<div>${groups.map((group) => `<code>${escapeHtml(group)}</code>`).join('')}</div>`
                : '<p>No collection programming groups are configured. A channel can be saved, but it will have no eligible programming until collections have group assignments.</p>'
            }
          </div>
          <button type="submit">${edit ? 'Save channel' : 'Create channel'}</button>
        </form>
      </section>${options.newChannel ? '</div></div>' : ''}`
          : ''
      }
    </div>`
  )
}

function renderBrandingEditor(
  channel: LibraryChannelPolicy | undefined,
  uploadedLogoIds: ReadonlySet<string>,
  scheduledLogoIds: readonly string[]
): string {
  const branding = channel?.branding ?? {
    mode: 'inherit' as const,
    opacity: 210,
    position: 2 as const,
    x: 24,
    y: 24,
    sizePercent: 12,
  }
  const hasCustomLogo = channel ? uploadedLogoIds.has(channel.id) : false
  return `<fieldset class="channel-branding" data-branding-editor>
    <legend>Channel branding overlay</legend>
    <p class="channel-admin-help">Branding is burned into this channel’s live video feed, so every TV and player sees the same station identity.</p>
    <div class="channel-branding-modes">
      ${brandingMode('inherit', 'Use global branding', 'Use the logo and placement from Settings.', branding.mode)}
      ${brandingMode('custom', 'Custom channel logo', 'Use a separate transparent PNG and channel-specific placement.', branding.mode)}
      ${brandingMode('off', 'No branding', 'Keep this channel feed completely clean.', branding.mode)}
    </div>
    <div class="channel-branding-custom" data-branding-custom>
      <label>Channel logo (PNG, up to 5 MB)
        ${channel ? '<input type="file" name="brandingLogo" accept="image/png">' : ''}
        <small>${hasCustomLogo ? 'A custom logo is uploaded. Choose another file to replace it.' : channel ? 'No custom logo is uploaded yet.' : 'Create the channel first, then edit it to upload its custom logo.'}</small>
      </label>
      <div class="channel-branding-controls">
        <label>Corner
          <select name="brandingPosition">
            ${brandingPosition(0, 'Top left', branding.position)}
            ${brandingPosition(2, 'Top right', branding.position)}
            ${brandingPosition(6, 'Bottom left', branding.position)}
            ${brandingPosition(8, 'Bottom right', branding.position)}
          </select>
        </label>
        <label>Size (%) <input type="number" name="brandingSizePercent" min="5" max="30" value="${branding.sizePercent}"></label>
        <label>Opacity <input type="range" name="brandingOpacity" min="0" max="255" value="${branding.opacity}"></label>
        <label>X offset <input type="number" name="brandingX" min="0" max="500" value="${branding.x}"></label>
        <label>Y offset <input type="number" name="brandingY" min="0" max="500" value="${branding.y}"></label>
      </div>
    </div>
    <div class="channel-branding-schedule-assets">
      <label>Scheduled logo variants (PNG, up to 5 MB each)
        ${channel ? '<input type="file" name="brandingVariantLogos" accept="image/png" multiple>' : ''}
        <small>Upload user-supplied logos for time blocks. The filename becomes its ID—for example, <code>adult-swim.png</code> becomes <code>adult-swim</code>.</small>
      </label>
      <p>${scheduledLogoIds.length > 0 ? `Available IDs: ${scheduledLogoIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(' ')}` : 'No scheduled logo variants uploaded yet.'}</p>
    </div>
  </fieldset>`
}

function brandingMode(
  value: 'inherit' | 'custom' | 'off',
  title: string,
  description: string,
  selected: string
): string {
  return `<label><input type="radio" name="brandingMode" value="${value}" ${selected === value ? 'checked' : ''}><span><strong>${title}</strong><small>${description}</small></span></label>`
}

function brandingPosition(
  value: 0 | 2 | 6 | 8,
  label: string,
  selected: number
): string {
  return `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`
}

function renderAutomationBuilder(
  catalog: StationAutomationCatalog,
  draft?: StationBuildRequest,
  preview?: StationBuildPreview,
  catalogSearch = '',
  target?: LibraryChannelPolicy,
  requestedTargetId?: string
): string {
  if (requestedTargetId && !target) {
    return `<section class="channel-auto" id="auto-builder"><h2>Channel not found</h2><p>The selected channel no longer exists.</p></section>`
  }
  const selectedPreset = draft?.preset ?? 'all-approved-tv'
  const selectedAirtime = draft?.airtime ?? 'all-day'
  const selectedIds = new Set(draft?.collectionIds ?? [])
  const selectedGenres = normalizedSet(draft?.genres ?? [])
  const selectedNetworks = normalizedSet(draft?.networks ?? [])
  const selectedStudios = normalizedSet(draft?.studios ?? [])
  const timezone =
    draft?.timezone ?? target?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const normalizedSearch = normalize(catalogSearch)
  const matchingCollections = normalizedSearch
    ? catalog.collections.filter((collection) =>
        collectionSearchText(collection).includes(normalizedSearch)
      )
    : catalog.collections
  const visibleCollectionIds = new Set(
    matchingCollections.slice(0, 250).map((collection) => collection.id)
  )
  for (const id of selectedIds) visibleCollectionIds.add(id)
  const visibleCollections = catalog.collections.filter((collection) =>
    visibleCollectionIds.has(collection.id)
  )
  const matchingGenres = filterFacets(catalog.genres, normalizedSearch)
  const matchingNetworks = filterFacets(catalog.networks, normalizedSearch)
  const matchingStudios = filterFacets(catalog.studios, normalizedSearch)

  return `<section class="channel-auto" id="auto-builder">
    <header class="channel-auto-header">
      <div>
        <p class="channel-admin-eyebrow">Catalog automation</p>
        <h2>${target ? `Auto setup for ${escapeHtml(target.name)}` : 'Create an automatic station'}</h2>
        <p>${target ? draft ? 'Change this station’s playable shows, preset, metadata facets, and airtime. Its current generated lineup is selected below.' : 'Choose this station’s playable shows, preset, metadata facets, and airtime.' : 'Choose playable shows directly or build a mix from TMDB genres, original networks, and production studios.'}</p>
      </div>
      <span class="channel-auto-count">${countLabel(catalog.collections.length, 'playable collection')}</span>
    </header>
    <p class="channel-auto-disclaimer"><strong>Personal library mix—not an official network feed.</strong> Brand-style presets use your own parent-allowed files and metadata. They do not reproduce, impersonate, or claim affiliation with a broadcaster or its historic schedule.</p>
    ${
      catalog.truncated
        ? `<div class="channel-auto-empty">
            <strong>The playable catalog is too large for safe automation.</strong>
            <p>ToastTV found more than 5,000 playable collections. Reduce or block unused collections before building a station.</p>
          </div>`
        : catalog.collections.length === 0
        ? `<div class="channel-auto-empty">
            <strong>Nothing can be scheduled yet.</strong>
            <p>A collection needs at least one parent-allowed file on an available root with a successful media probe. Finish the library scan/metadata review, approve a collection or file, and return here.</p>
            <a href="/library/review">Open Needs review</a>
          </div>`
        : `<form method="post" action="/channels/auto-build" class="channel-auto-form">
            ${target ? `<input type="hidden" name="targetChannelId" value="${escapeHtml(target.id)}">` : ''}
            <div class="channel-auto-search">
              <label for="catalog-search">Find a show, network, studio, or genre</label>
              <div>
                <input id="catalog-search" type="search" name="catalogSearch" maxlength="100" value="${escapeHtml(catalogSearch)}" placeholder="Bluey, Nickelodeon, Ludo Studio…">
                <button type="submit" name="action" value="search" formnovalidate class="btn-secondary">Search catalog</button>
                ${catalogSearch ? '<button type="submit" name="action" value="clear-search" formnovalidate class="channel-auto-clear">Clear</button>' : ''}
              </div>
              <small>Search narrows the selectors below while keeping your checked collections. Presets always evaluate the full playable catalog.</small>
            </div>
            <div class="channel-admin-fields">
              <label>Station ID
                <input type="text" name="id" required maxlength="59" pattern="[A-Za-z0-9][A-Za-z0-9_-]*" value="${escapeHtml(draft?.id ?? target?.id ?? '')}" ${target ? 'readonly' : ''} placeholder="saturday-cartoons">
                <small>Used by TV clients. The generated group uses the same stable ID.</small>
              </label>
              <label>Display name
                <input type="text" name="name" required maxlength="100" value="${escapeHtml(draft?.name ?? target?.name ?? '')}" placeholder="Saturday Cartoons">
              </label>
              <label>Timezone
                <input type="text" name="timezone" required maxlength="100" value="${escapeHtml(timezone)}" placeholder="America/New_York">
              </label>
            </div>

            <fieldset class="channel-auto-presets">
              <legend>Start with a preset</legend>
              ${target && draft?.preset === 'custom' ? `<p class="channel-admin-help"><strong>Current lineup loaded:</strong> ${countLabel(selectedIds.size, 'selected collection')}. Change the checks below, choose metadata facets, or switch to another preset.</p>` : ''}
              <div class="channel-auto-preset-grid">
                ${catalog.presets
                  .map(
                    (preset) => `<label class="channel-auto-preset">
                      <input type="radio" name="preset" value="${escapeHtml(preset.id)}" ${selectedPreset === preset.id ? 'checked' : ''}>
                      <span><strong>${escapeHtml(preset.name)}</strong><small>${escapeHtml(preset.description)}</small><em>${countLabel(preset.matchedCollections, 'matching collection')}${preset.unofficial ? ' · unofficial style mix' : ''}</em></span>
                    </label>`
                  )
                  .join('')}
                <label class="channel-auto-preset">
                  <input type="radio" name="preset" value="custom" ${selectedPreset === 'custom' ? 'checked' : ''}>
                  <span><strong>Custom mix</strong><small>Use only the facets and individual collections selected below.</small><em>You control every selector</em></span>
                </label>
              </div>
            </fieldset>

            <fieldset class="channel-auto-presets">
              <legend>Choose airtime</legend>
              <div class="channel-auto-airtime-grid">
                ${STATION_AIRTIME_OPTIONS.map(
                  (airtime) => `<label class="channel-auto-airtime">
                    <input type="radio" name="airtime" value="${airtime.id}" ${selectedAirtime === airtime.id ? 'checked' : ''}>
                    <span><strong>${escapeHtml(airtime.name)}</strong><small>${escapeHtml(airtime.description)}</small></span>
                  </label>`
                ).join('')}
              </div>
              <p class="channel-admin-help">These become ordinary editable schedule slots ${target ? 'when Auto setup is applied' : 'after creation'}.</p>
            </fieldset>

            <div class="channel-auto-facets">
              ${renderFacet('Genres', 'genres', matchingGenres, selectedGenres, 50)}
              ${renderFacet('Networks', 'networks', matchingNetworks, selectedNetworks, 75)}
              ${renderFacet('Studios', 'studios', matchingStudios, selectedStudios, 75)}
            </div>
            <p class="channel-admin-help">Facet and show selections are added to a preset. Choose <strong>Custom mix</strong> if they should be the only selectors. Network/studio choices appear after a TMDB metadata refresh stores those fields.${normalizedSearch && matchingGenres.length + matchingNetworks.length + matchingStudios.length === 0 ? ' No matching metadata facets were found.' : ''}</p>

            <details class="channel-auto-collections" ${selectedIds.size > 0 ? 'open' : ''}>
              <summary>Add individual shows or movies</summary>
              <div class="channel-auto-collection-grid">
                ${visibleCollections
                  .map(
                    (collection) => `<label>
                      <input type="checkbox" name="collectionIds" value="${collection.id}" ${selectedIds.has(collection.id) ? 'checked' : ''}>
                      <span><strong>${escapeHtml(collection.displayTitle)}</strong><small>${escapeHtml(collection.libraryKind.toUpperCase())} · ${countLabel(collection.eligibleFiles, 'playable file')}</small></span>
                    </label>`
                  )
                  .join('')}
              </div>
              ${matchingCollections.length === 0 ? '<p class="channel-admin-help">No collection matches this catalog search. Clear it to browse the full catalog.</p>' : ''}
              ${matchingCollections.length > 250 ? `<p class="channel-admin-help">Showing the first 250 of ${matchingCollections.length} matching collections. Refine the catalog search to reach any remaining title.</p>` : normalizedSearch ? `<p class="channel-admin-help">Showing ${countLabel(matchingCollections.length, 'matching collection')}.</p>` : catalog.collections.length > 250 ? '<p class="channel-admin-help">Showing the first 250 collections. Search by title to reach any other collection without loading the entire catalog.</p>' : ''}
            </details>

            ${renderAutomationPreview(preview)}
            ${target ? `<label class="channel-auto-replace"><input type="checkbox" name="confirmReplace" value="yes" required><span><strong>Replace this station’s current programming setup</strong><small>This replaces its schedule blocks and automated library selection. The station ID, enabled state, and manual on/off state are preserved.</small></span></label>` : ''}
            <div class="channel-auto-actions">
              ${target ? '' : '<a class="channel-admin-link" href="/channels?new=manual#editor">Create manually</a>'}
              <button type="submit" name="action" value="preview" formnovalidate class="btn-secondary">Preview lineup</button>
              <button type="submit" name="action" value="${target ? 'update' : 'create'}">${target ? 'Apply Auto setup' : `Create ${escapeHtml(airtimeActionLabel(selectedAirtime))} station`}</button>
            </div>
          </form>
          `
    }
  </section>`
}

function renderModal(id: string, content: string): string {
  return `<div class="channel-modal" id="${escapeHtml(id)}" role="dialog" aria-modal="true" aria-label="Station setup">
    <a class="channel-modal-backdrop" href="/channels" aria-label="Close station setup"></a>
    <div class="channel-modal-panel">
      <a class="channel-modal-close" href="/channels" aria-label="Close station setup">×</a>
      ${content}
    </div>
  </div>`
}

function renderFacet(
  title: string,
  field: string,
  facets: readonly StationFacet[],
  selected: ReadonlySet<string>,
  limit: number
): string {
  return `<details class="channel-auto-facet" ${selected.size > 0 ? 'open' : ''}>
    <summary>${escapeHtml(title)} <span>${facets.length}</span></summary>
    ${
      facets.length > 0
        ? `<div>${facets
            .slice(0, limit)
            .map(
              (facet) => `<label><input type="checkbox" name="${escapeHtml(field)}" value="${escapeHtml(facet.name)}" ${selected.has(normalize(facet.name)) ? 'checked' : ''}><span>${escapeHtml(facet.name)} <small>${facet.collections}</small></span></label>`
            )
            .join('')}</div>${facets.length > limit ? `<small>Showing the ${limit} most common values. Less-common values remain available through the admin API.</small>` : ''}`
        : '<p>No values stored yet.</p>'
    }
  </details>`
}

function renderAutomationPreview(preview?: StationBuildPreview): string {
  if (!preview) return ''
  if (preview.collectionCount === 0 || preview.eligibleFiles === 0) {
    return `<div class="channel-auto-preview channel-auto-preview-empty">
      <strong>Preview: no schedulable matches</strong>
      <p>The current selectors did not match a parent-allowed, available collection with a successfully probed video. Try All playable shows, select a collection directly, or finish approval/metadata/probe work first.</p>
    </div>`
  }
  return `<div class="channel-auto-preview channel-auto-preview-ready">
    <strong>Ready to build: ${countLabel(preview.collectionCount, 'collection')} · ${countLabel(preview.eligibleFiles, 'schedulable file')}</strong>
    <p>${preview.collections
      .slice(0, 12)
      .map((collection) => escapeHtml(collection.displayTitle))
      .join(' · ')}${preview.collectionCount > 12 ? ` · and ${preview.collectionCount - 12} more` : ''}</p>
    <small>The generated station is enabled immediately and receives the selected editable airtime schedule.</small>
  </div>`
}

function normalizedSet(values: readonly string[]): Set<string> {
  return new Set(values.map(normalize))
}

function collectionSearchText(
  collection: StationAutomationCatalog['collections'][number]
): string {
  return normalize(
    [
      collection.displayTitle,
      collection.collectionTitle,
      collection.libraryKind,
      ...collection.genres,
      ...collection.networks,
      ...collection.studios,
    ].join(' ')
  )
}

function filterFacets(
  facets: readonly StationFacet[],
  normalizedSearch: string
): readonly StationFacet[] {
  if (!normalizedSearch) return facets
  return facets.filter((facet) => normalize(facet.name).includes(normalizedSearch))
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase('en-US')
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

function renderChannelCard(
  channel: LibraryChannelPolicy,
  manuallyOffAir: boolean
): string {
  const state = !channel.enabled
    ? 'Disabled'
    : manuallyOffAir
      ? 'Manually off air'
      : 'Enabled'
  return `<article class="channel-admin-card">
    <header>
      <div><h2>${escapeHtml(channel.name)}</h2><code>${escapeHtml(channel.id)}</code></div>
      <span class="channel-admin-state channel-admin-state-${!channel.enabled ? 'disabled' : manuallyOffAir ? 'off' : 'enabled'}">${state}</span>
    </header>
    <dl>
      <div><dt>Timezone</dt><dd>${escapeHtml(channel.timezone)}</dd></div>
      <div><dt>Schedule slots</dt><dd>${channel.slots.length}</dd></div>
    </dl>
    <div class="channel-admin-actions">
      <a href="/channels?edit=${encodeURIComponent(channel.id)}#editor">Edit</a>
      <a href="/channels?builder=${encodeURIComponent(channel.id)}#station-builder">Edit lineup</a>
      <form method="post" action="/channels/${encodeURIComponent(channel.id)}/enabled">
        <input type="hidden" name="enabled" value="${channel.enabled ? 'false' : 'true'}">
        <button type="submit">${channel.enabled ? 'Disable' : 'Enable'}</button>
      </form>
      <form method="post" action="/channels/${encodeURIComponent(channel.id)}/delete" onsubmit="return confirm('Delete this channel?')">
        <button class="channel-admin-danger" type="submit">Delete</button>
      </form>
    </div>
  </article>`
}

function formatSlots(slots: LibraryChannelPolicy['slots']): string {
  return slots
    .map(
      (slot) =>
        `${slot.days.join(',')} | ${slot.start}-${slot.end} | ${slot.groups.join(',')} | ${formatSlotBranding(slot.branding)}`
    )
    .join('\n')
}

const SCHEDULE_DAYS = [
  ['mon', 'Mon'],
  ['tue', 'Tue'],
  ['wed', 'Wed'],
  ['thu', 'Thu'],
  ['fri', 'Fri'],
  ['sat', 'Sat'],
  ['sun', 'Sun'],
] as const

function renderScheduleDesigner(
  slots: LibraryChannelPolicy['slots'],
  configuredGroups: readonly string[],
  scheduledLogoIds: readonly string[]
): string {
  const groups = [...new Set([
    ...configuredGroups,
    ...slots.flatMap((slot) => slot.groups),
  ])].sort((left, right) => left.localeCompare(right))
  return `<section class="channel-schedule" data-schedule-editor>
    <header class="channel-schedule-header">
      <div>
        <h3>Weekly schedule</h3>
        <p>Build time blocks visually. A full-day channel uses every day from 00:00 to 24:00.</p>
      </div>
      <button type="button" class="btn-secondary" data-add-slot>Add time block</button>
    </header>
    <div class="channel-week" data-calendar aria-label="Weekly schedule preview">
      ${SCHEDULE_DAYS.map(([day, label]) => `<section><strong>${label}</strong><div data-calendar-day="${day}">${renderCalendarEntries(slots, day)}</div></section>`).join('')}
    </div>
    ${scheduledLogoIds.length > 0 ? `<datalist id="scheduled-logo-ids">${scheduledLogoIds.map((id) => `<option value="${escapeHtml(id)}"></option>`).join('')}</datalist>` : ''}
    <div class="channel-slot-list" data-slot-list>
      ${slots.map((slot, index) => renderSlotEditor(slot, groups, index)).join('')}
    </div>
    <p class="channel-schedule-empty" data-schedule-empty ${slots.length > 0 ? 'hidden' : ''}>No airtime blocks yet. Add one to put this channel on the guide.</p>
    <details class="channel-schedule-advanced">
      <summary>Advanced schedule text</summary>
      <p>Edit the serialized schedule only when you need an unusual time or group. Saving uses this value.</p>
      <textarea name="slots" rows="7" spellcheck="false" data-schedule-serialized placeholder="mon,tue,wed,thu,fri | 06:30-08:30 | comfort,learning | custom:nick">${escapeHtml(formatSlots(slots))}</textarea>
    </details>
    <template data-slot-template>${renderSlotEditor(undefined, groups, 0)}</template>
  </section>`
}

function renderSlotEditor(
  slot: LibraryChannelPolicy['slots'][number] | undefined,
  groups: readonly string[],
  index: number
): string {
  return `<article class="channel-slot" data-slot>
    <header><strong>Time block <span data-slot-number>${index + 1}</span></strong><button type="button" class="channel-slot-remove" data-remove-slot>Remove</button></header>
    <fieldset class="channel-slot-days"><legend>Days</legend><div>
      ${SCHEDULE_DAYS.map(([day, label]) => `<label><input type="checkbox" value="${day}" data-slot-day ${slot?.days.includes(day) ? 'checked' : ''}><span>${label}</span></label>`).join('')}
    </div></fieldset>
    <div class="channel-slot-time">
      <label>Starts ${renderTimeSelect('start', slot?.start ?? '00:00')}</label>
      <span aria-hidden="true">→</span>
      <label>Ends ${renderTimeSelect('end', slot?.end ?? '24:00')}</label>
    </div>
    <fieldset class="channel-slot-groups"><legend>Programming groups</legend>
      ${groups.length > 0 ? `<div>${groups.map((group) => `<label><input type="checkbox" value="${escapeHtml(group)}" data-slot-group ${slot?.groups.includes(group) ? 'checked' : ''}><span>${escapeHtml(group)}</span></label>`).join('')}</div>` : '<p>No assigned groups are available yet.</p>'}
      <label class="channel-slot-custom">Additional groups <input type="text" data-slot-custom-groups placeholder="Optional, comma-separated"></label>
    </fieldset>
    <fieldset class="channel-slot-branding"><legend>Logo during this block</legend>
      <label>Branding
        <select data-slot-branding-mode>
          ${slotBrandingOption('channel', 'Channel default', slot?.branding?.mode)}
          ${slotBrandingOption('inherit', 'Global logo', slot?.branding?.mode)}
          ${slotBrandingOption('custom', 'Scheduled logo', slot?.branding?.mode)}
          ${slotBrandingOption('off', 'No logo', slot?.branding?.mode)}
        </select>
      </label>
      <label>Scheduled logo ID
        <input type="text" list="scheduled-logo-ids" data-slot-branding-logo value="${escapeHtml(slot?.branding?.logoId ?? '')}" placeholder="nick">
      </label>
    </fieldset>
  </article>`
}

function slotBrandingOption(
  value: 'channel' | 'inherit' | 'custom' | 'off',
  label: string,
  selected: string | undefined
): string {
  return `<option value="${value}" ${(selected ?? 'channel') === value ? 'selected' : ''}>${label}</option>`
}

function formatSlotBranding(
  branding: LibraryChannelPolicy['slots'][number]['branding']
): string {
  if (!branding || branding.mode === 'channel') return 'channel'
  return branding.mode === 'custom' ? `custom:${branding.logoId}` : branding.mode
}

function renderTimeSelect(kind: 'start' | 'end', selected: string): string {
  const values: string[] = []
  const firstMinutes = kind === 'start' ? 0 : 30
  const lastMinutes = kind === 'start' ? 23 * 60 + 30 : 24 * 60
  for (let minutes = firstMinutes; minutes <= lastMinutes; minutes += 30) {
    values.push(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`)
  }
  if (!values.includes(selected)) values.push(selected)
  values.sort()
  return `<select data-slot-${kind}>${values.map((value) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${value}</option>`).join('')}</select>`
}

function renderCalendarEntries(
  slots: LibraryChannelPolicy['slots'],
  day: string
): string {
  return slots
    .filter((slot) => slot.days.includes(day as (typeof SCHEDULE_DAYS)[number][0]))
    .map((slot) => `<span><b>${escapeHtml(slot.start)}–${escapeHtml(slot.end)}</b><small>${escapeHtml(slot.groups.join(', '))}</small></span>`)
    .join('')
}

function airtimeActionLabel(airtime: string): string {
  return airtime === 'all-day' ? 'all-day' : airtime.replaceAll('-', ' ')
}
