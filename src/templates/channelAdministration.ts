import type {
  ChannelAdministrationSnapshot,
  StationBuildPreview,
  StationBuildRequest,
} from '../services/ChannelService'
import type {
  ChannelMarathonPolicy,
  LibraryChannelPolicy,
} from '../config/library'
import type {
  StationAutomationCatalog,
} from '../services/StationAutomationService'
import type { ChannelLineupSuggestion } from '../services/ChannelLineupSuggestionService'
import {
  isEraStationTemplateId,
  isStationPresetId,
  selectStationCollections,
  STATION_AIRTIME_OPTIONS,
} from '../services/StationAutomationService'
import { renderLayout } from './layout'
import { escapeHtml } from './utils'

interface ChannelAdministrationOptions {
  readonly editId?: string
  readonly brandingId?: string
  readonly newChannel?: boolean
  readonly error?: string
  readonly changed?: 'created' | 'updated' | 'deleted' | 'generated'
  readonly automation?: StationAutomationCatalog
  readonly automationDraft?: StationBuildRequest
  readonly automationPreview?: StationBuildPreview
  readonly automationSearch?: string
  readonly automationOpen?: boolean
  readonly automationTargetId?: string
  readonly automationSuggestion?: ChannelLineupSuggestion
  readonly automationSuggestionGoal?: string
  readonly channelLogoIds?: readonly string[]
  readonly channelLogoVariants?: Readonly<Record<string, readonly string[]>>
}

export function renderChannelAdministration(
  snapshot: ChannelAdministrationSnapshot,
  options: ChannelAdministrationOptions = {}
): string {
  const edit = snapshot.channels.find((channel) => channel.id === options.editId)
  const brandingTarget = snapshot.channels.find(
    (channel) => channel.id === options.brandingId
  )
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
          <p class="channel-admin-eyebrow">Broadcast operations</p>
          <h1>Channel management</h1>
          <p>Manage channel availability, automated lineups, schedules, and app branding.</p>
        </div>
        <div class="channel-admin-hero-actions">
          <a class="channel-admin-link" href="#channel-improvements">Channel improvements</a>
          <a class="channel-admin-link channel-admin-create" href="/channels?builder=create#station-builder">Create station</a>
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
          ? `<p class="channel-admin-alert channel-admin-alert-success">Channel ${escapeHtml(options.changed)} successfully. The new configuration is active.</p>`
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

      ${renderChannelImprovements(snapshot.channels, options.automation)}

      ${
        options.automation && options.automationOpen && !options.brandingId
          ? renderModal(
              'station-builder',
              renderAutomationBuilder(
              options.automation,
              options.automationDraft,
              options.automationPreview,
               options.automationSearch,
               automationTarget,
              options.automationTargetId,
               options.error,
               options.automationSuggestion,
               options.automationSuggestionGoal
               )
            )
          : ''
      }

      ${
        brandingTarget
          ? renderModal(
              'branding-modal',
              renderBrandingEditor(
                brandingTarget,
                new Set(options.channelLogoIds ?? []),
                options.channelLogoVariants?.[brandingTarget.id] ?? []
              ),
              `/channels?edit=${encodeURIComponent(brandingTarget.id)}#editor`,
              `Branding for ${brandingTarget.name}`
            )
          : options.brandingId
            ? renderModal(
                'branding-modal',
                '<section class="channel-branding-dialog"><h2>Channel not found</h2><p>The selected channel no longer exists.</p></section>',
                '/channels',
                'Channel not found'
              )
            : ''
      }

      ${
        (edit || options.newChannel) && !options.brandingId && !options.automationOpen
          ? renderModal(
              'channel-editor',
              renderManualEditor(
                edit,
                groups,
                new Set(options.channelLogoIds ?? []),
                edit ? options.channelLogoVariants?.[edit.id] ?? [] : []
              ),
              '/channels',
              edit ? `Configure ${edit.name}` : 'Create a station manually'
            )
          : ''
      }
    </div>`
  )
}

function renderChannelImprovements(
  channels: readonly LibraryChannelPolicy[],
  catalog?: StationAutomationCatalog
): string {
  const automated = channels.filter((channel) => channel.automation)
  if (!catalog) {
    return `<section class="channel-improvements" id="channel-improvements" aria-labelledby="channel-improvements-title">
      <header class="channel-improvements-heading"><div><p class="channel-admin-eyebrow">Library opportunities</p><h2 id="channel-improvements-title">Channel improvements</h2><p>Current lineups and curated additions will appear here when the playable catalog is available.</p></div></header>
    </section>`
  }
  if (automated.length === 0) {
    return `<section class="channel-improvements" id="channel-improvements" aria-labelledby="channel-improvements-title">
      <header class="channel-improvements-heading"><div><p class="channel-admin-eyebrow">Library opportunities</p><h2 id="channel-improvements-title">Channel improvements</h2><p>Create an Auto channel to see its current playable lineup and curated show suggestions here.</p></div></header>
    </section>`
  }

  const collectionsByReference = new Map(
    catalog.collections.map((collection) => [
      collectionReferenceKey(collection),
      collection,
    ])
  )
  const collectionsById = new Map(
    catalog.collections.map((collection) => [collection.id, collection])
  )
  const profiles = new Map(
    (catalog.networkProfiles ?? []).map((profile) => [profile.id, profile])
  )
  const sortedChannels = [...automated].sort((left, right) =>
    left.name.localeCompare(right.name, 'en', {
      sensitivity: 'base',
      numeric: true,
    })
  )

  return `<section class="channel-improvements" id="channel-improvements" aria-labelledby="channel-improvements-title">
    <header class="channel-improvements-heading">
      <div><p class="channel-admin-eyebrow">Library opportunities</p><h2 id="channel-improvements-title">Channel improvements</h2><p>Channels and titles are sorted alphabetically. Expand a channel to inspect its lineup and curated additions.</p></div>
    </header>
    <div class="channel-improvement-grid">
      ${sortedChannels.map((channel) => {
        const references = channel.automation?.collectionRefs ?? []
        const profile = channel.automation?.networkId
          ? profiles.get(channel.automation.networkId)
          : undefined
        const startYear = channel.automation?.eraStartYear ?? profile?.availableStartYear
        const endYear = channel.automation?.eraEndYear ?? profile?.availableEndYear
        const followsProfile = channel.automation?.selectionMode === 'automatic'
        const profileMatches = followsProfile && profile
          ? profile.matches.filter((match) =>
              startYear === undefined || endYear === undefined
                ? true
                : erasOverlap(
                    match.airStartYear,
                    match.airEndYear,
                    startYear,
                    endYear
                  )
            )
          : []
        const recipePreset = channel.automation?.preset
        const followsRecipe =
          !profile &&
          recipePreset !== undefined &&
          recipePreset !== 'custom' &&
          recipePreset !== 'network-copy' &&
          isStationPresetId(recipePreset) &&
          channel.automation?.selectionMode !== 'explicit'
        const recipeCollections = followsRecipe
          ? selectStationCollections(catalog, { preset: recipePreset })
          : []
        const available = (followsProfile
          ? profileMatches.map((match) => collectionsById.get(match.collectionId))
          : followsRecipe
            ? recipeCollections
            : references.map((reference) =>
                collectionsByReference.get(collectionReferenceKey(reference))
              ))
          .filter((collection): collection is StationAutomationCatalog['collections'][number] => Boolean(collection))
          .sort((left, right) => left.displayTitle.localeCompare(right.displayTitle))
        const unavailableCount = followsProfile || followsRecipe
          ? 0
          : references.length - available.length
        const suggestions = (profile?.missingSuggestions.filter((suggestion) =>
          startYear === undefined || endYear === undefined
            ? true
            : erasOverlap(
                suggestion.airStartYear,
                suggestion.airEndYear,
                startYear,
                endYear
              )
        ) ?? []).sort((left, right) =>
          left.title.localeCompare(right.title, 'en', {
            sensitivity: 'base',
            numeric: true,
          })
        )
        const era = startYear !== undefined && endYear !== undefined
          ? ` · ${startYear}–${endYear}`
          : ''
        return `<details class="channel-improvement-card">
          <summary>
            <span class="channel-improvement-identity"><strong>${escapeHtml(channel.name)}</strong><small>${profile ? `${escapeHtml(profile.name)}${era}` : followsRecipe ? escapeHtml(catalog.presets.find((preset) => preset.id === recipePreset)?.name ?? 'General mix') : 'Hand-picked automated lineup'}</small></span>
            <span class="channel-improvement-counts"><span>${available.length} available</span><span>${suggestions.length} suggested</span>${unavailableCount > 0 ? `<span class="is-warning">${unavailableCount} unavailable</span>` : ''}</span>
          </summary>
          <div class="channel-improvement-body">
            <div class="channel-improvement-actions"><a href="/channels?builder=${encodeURIComponent(channel.id)}#station-builder">Review lineup</a></div>
            <div class="channel-improvement-columns">
            <section aria-labelledby="available-${escapeHtml(channel.id)}">
              <h4 id="available-${escapeHtml(channel.id)}">Available now <span>${available.length}</span></h4>
              ${available.length > 0
                ? `<ul>${available.map((collection) => `<li><strong>${escapeHtml(collection.displayTitle)}</strong><small>${escapeHtml(collection.libraryKind.toUpperCase())} · ${countLabel(collection.eligibleFiles, 'playable file')}</small></li>`).join('')}</ul>`
                : profile
                  ? '<p class="channel-improvement-empty">No channel title is currently playable.</p>'
                  : '<p class="channel-improvement-empty">Open Review lineup to inspect this custom channel’s saved selections.</p>'}
              ${unavailableCount > 0 ? `<p class="channel-improvement-warning">${countLabel(unavailableCount, 'saved title')} temporarily unavailable</p>` : ''}
            </section>
            <section aria-labelledby="suggested-${escapeHtml(channel.id)}">
              <h4 id="suggested-${escapeHtml(channel.id)}">Suggested additions <span>${suggestions.length}</span></h4>
              ${profile
                ? suggestions.length > 0
                  ? `<ul>${suggestions.map((suggestion) => `<li><strong>${escapeHtml(suggestion.title)}</strong><small>${escapeHtml(suggestion.libraryKind.toUpperCase())} · carried ${suggestion.airStartYear}–${suggestion.airEndYear}</small></li>`).join('')}</ul>`
                  : '<p class="channel-improvement-empty">Your library covers every curated title for this era.</p>'
                : followsRecipe
                  ? '<p class="channel-improvement-empty">This recipe already follows every matching approved title in your library.</p>'
                  : '<p class="channel-improvement-empty">Hand-picked channels change only when you review and apply a new selection.</p>'}
            </section>
          </div>
          </div>
        </details>`
      }).join('')}
    </div>
  </section>`
}

function collectionReferenceKey(value: {
  readonly rootId: string
  readonly libraryKind: string
  readonly identityKey: string
}): string {
  return JSON.stringify([value.rootId, value.libraryKind, value.identityKey])
}

function renderManualEditor(
  edit: LibraryChannelPolicy | undefined,
  groups: readonly string[],
  uploadedLogoIds: ReadonlySet<string>,
  scheduledLogoIds: readonly string[]
): string {
  const editorTitle = edit ? escapeHtml(edit.name) : 'Create a station manually'
  return `<section class="channel-admin-editor" id="editor" data-channel-editor>
    <header class="channel-builder-heading">
      <div>
        <p class="channel-admin-eyebrow">${edit ? 'Station configuration' : 'New station'}</p>
        <h2 id="manual-editor-title">${editorTitle}</h2>
        <p>${edit ? 'Update station details, marathons, and the weekly schedule.' : 'Build a station directly from programming groups and time blocks.'}</p>
      </div>
    </header>
    ${renderBuilderNavigation(edit, 'manual')}
    <form method="post" enctype="multipart/form-data" action="${edit ? `/channels/${encodeURIComponent(edit.id)}` : '/channels'}">
      <section class="channel-builder-step" aria-labelledby="station-details-heading">
        ${renderStepHeading(1, 'Station details', 'Name the station, choose its timezone, and control whether TV clients can tune it.', 'station-details-heading')}
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
      </section>
      <section class="channel-builder-step" aria-labelledby="station-branding-heading">
        ${renderStepHeading(2, 'Channel identity', 'Preview the current logo choice or open the dedicated logo editor.', 'station-branding-heading')}
        ${renderBrandingSummary(edit, uploadedLogoIds)}
      </section>
      <section class="channel-builder-step" aria-labelledby="station-pattern-heading">
        ${renderStepHeading(3, 'Programming pattern', 'Optionally add recurring episode marathons to the normal mix.', 'station-pattern-heading')}
        ${renderMarathonSettings(edit?.marathon)}
      </section>
      <section class="channel-builder-step" aria-labelledby="station-schedule-heading">
        ${renderStepHeading(4, 'Weekly schedule', 'Place programming groups into editable time blocks.', 'station-schedule-heading')}
        ${renderScheduleDesigner(edit?.slots ?? [], groups, scheduledLogoIds)}
      </section>
      <details class="channel-admin-groups">
        <summary>Available programming groups</summary>
        ${
          groups.length > 0
            ? `<div>${groups.map((group) => `<code>${escapeHtml(group)}</code>`).join('')}</div>`
            : '<p>No collection programming groups are configured. A channel can be saved, but it will have no eligible programming until collections have group assignments.</p>'
        }
      </details>
      <footer class="channel-builder-footer">
        <a class="channel-admin-link" href="/channels">Cancel</a>
        <button type="submit">${edit ? 'Save station' : 'Create station'}</button>
      </footer>
    </form>
  </section>`
}

function renderBuilderNavigation(
  channel: LibraryChannelPolicy | undefined,
  active: 'auto' | 'manual' | 'branding'
): string {
  const items = channel
    ? [
        ['manual', `/channels?edit=${encodeURIComponent(channel.id)}#channel-editor`, 'Details & schedule'],
        ['auto', `/channels?builder=${encodeURIComponent(channel.id)}#station-builder`, 'Auto lineup'],
        ['branding', `/channels?branding=${encodeURIComponent(channel.id)}#branding-modal`, 'Logo & branding'],
      ] as const
    : [
        ['auto', '/channels?builder=create#station-builder', 'Auto setup'],
        ['manual', '/channels?new=manual#channel-editor', 'Manual setup'],
      ] as const
  return `<nav class="channel-builder-navigation" aria-label="Station setup sections">
    ${items
      .map(([id, href, label]) =>
        id === active
          ? `<span aria-current="page">${escapeHtml(label)}</span>`
          : `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
      )
      .join('')}
  </nav>`
}

function renderStepHeading(
  step: number,
  title: string,
  description: string,
  id: string
): string {
  return `<header class="channel-builder-step-heading">
    <span aria-hidden="true">${step}</span>
    <div><h3 id="${escapeHtml(id)}">${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p></div>
  </header>`
}

function renderBrandingSummary(
  channel: LibraryChannelPolicy | undefined,
  uploadedLogoIds: ReadonlySet<string>
): string {
  const branding = channel?.branding ?? defaultBranding()
  const hasCustomLogo = channel ? uploadedLogoIds.has(channel.id) : false
  const summary =
    branding.mode === 'off'
      ? 'Logo hidden in Dialden apps.'
      : branding.mode === 'inherit'
        ? 'Using the global logo in Dialden app menus.'
        : hasCustomLogo
          ? 'Using this channel’s custom logo in Dialden app menus.'
          : 'Custom app logo selected, but no image has been uploaded yet.'
  const status = branding.mode === 'off' ? 'Hidden' : 'App menus only'
  const image =
    channel && branding.mode === 'custom' && hasCustomLogo
      ? `<img src="/channels/${encodeURIComponent(channel.id)}/logo" alt="Current ${escapeHtml(channel.name)} logo">`
      : branding.mode === 'off' && channel && hasCustomLogo
        ? `<img class="is-hidden" src="/channels/${encodeURIComponent(channel.id)}/logo" alt="Stored ${escapeHtml(channel.name)} logo, currently hidden">`
        : `<div class="channel-branding-summary-placeholder" aria-hidden="true">${branding.mode === 'inherit' ? 'Global' : branding.mode === 'off' ? 'Off' : 'TV'}</div>`
  return `<section class="channel-branding-summary">
    ${brandingHiddenFields(branding)}
    <div>
      <p class="channel-admin-eyebrow">Channel identity</p>
      <div class="channel-branding-summary-title"><h3>Channel logo</h3><span>${status}</span></div>
      <p>${summary}</p>
    </div>
    ${image}
    ${channel ? `<a class="channel-branding-button" href="/channels?edit=${encodeURIComponent(channel.id)}&amp;branding=${encodeURIComponent(channel.id)}#branding-modal">${hasCustomLogo ? 'Edit logo' : 'Add logo'}</a>` : '<small>Create the channel before uploading its logo.</small>'}
  </section>`
}

function renderBrandingEditor(
  channel: LibraryChannelPolicy,
  uploadedLogoIds: ReadonlySet<string>,
  scheduledLogoIds: readonly string[]
): string {
  const branding = channel.branding ?? defaultBranding()
  const hasCustomLogo = uploadedLogoIds.has(channel.id)
  const logoUrl = `/channels/${encodeURIComponent(channel.id)}/logo`
  return `<section class="channel-branding-dialog" data-branding-editor>
    <header>
      <div><p class="channel-admin-eyebrow">Channel identity</p><h2>${escapeHtml(channel.name)} logo</h2></div>
      <p>Choose the logo shown by Dialden clients when the channel menu or programme information is open. Video remains clean.</p>
    </header>
    ${renderBuilderNavigation(channel, 'branding')}
    <form method="post" enctype="multipart/form-data" action="/channels/${encodeURIComponent(channel.id)}/branding">
    <div class="channel-branding-section-heading">
      <strong>Logo shown in apps</strong>
      <small>This controls channel artwork in Dialden clients.</small>
    </div>
    <div class="channel-branding-modes">
      ${brandingMode('inherit', 'Global logo', 'Show the logo configured in Settings.', branding.mode)}
      ${brandingMode('custom', 'Custom channel logo', 'Show a separate transparent PNG for this channel.', branding.mode)}
      ${brandingMode('off', 'Hide channel logo', 'Do not show a logo for this channel in apps.', branding.mode)}
    </div>
    <div class="channel-branding-workspace" data-branding-custom>
      <div class="channel-logo-preview" data-logo-screen data-position="2" data-burn-in="false">
        <div class="channel-logo-preview-safe-area">
          ${hasCustomLogo ? `<img src="${logoUrl}" alt="Current logo preview" data-logo-preview>` : '<img alt="Selected logo preview" data-logo-preview hidden>'}
          <span data-logo-placeholder ${hasCustomLogo ? 'hidden' : ''}>Choose a transparent PNG to preview it here</span>
        </div>
        <small data-logo-preview-caption>App menu preview · video remains clean</small>
      </div>
      <div class="channel-branding-fields">
        <label>Custom app logo <input type="file" name="brandingLogo" accept="image/png" data-logo-file><small>Transparent PNG, up to 5 MB. Selecting a file updates the preview before saving.</small></label>
      </div>
    </div>
    <div class="channel-branding-schedule-assets">
      <label>Scheduled logo variants (PNG, up to 5 MB each)
        <input type="file" name="brandingVariantLogos" accept="image/png" multiple>
        <small>Switch app artwork by time block—for example, Kids by day and Adult Swim at night. The filename becomes its ID: <code>adult-swim.png</code> becomes <code>adult-swim</code>.</small>
      </label>
      <p>${scheduledLogoIds.length > 0 ? `Available IDs: ${scheduledLogoIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(' ')}` : 'No scheduled logo variants uploaded yet.'}</p>
    </div>
    <footer><a href="/channels?edit=${encodeURIComponent(channel.id)}#editor">Cancel</a><button type="submit">Save branding</button></footer>
    </form>
  </section>`
}

function defaultBranding(): NonNullable<LibraryChannelPolicy['branding']> {
  return {
    mode: 'inherit',
    opacity: 210,
    position: 2,
    x: 24,
    y: 24,
    sizePercent: 12,
  }
}

function brandingHiddenFields(
  branding: NonNullable<LibraryChannelPolicy['branding']>
): string {
  return `<input type="hidden" name="brandingMode" value="${branding.mode}">
    <input type="hidden" name="brandingOpacity" value="${branding.opacity}">
    <input type="hidden" name="brandingPosition" value="${branding.position}">
    <input type="hidden" name="brandingX" value="${branding.x}">
    <input type="hidden" name="brandingY" value="${branding.y}">
    <input type="hidden" name="brandingSizePercent" value="${branding.sizePercent}">`
}

function brandingMode(
  value: 'inherit' | 'custom' | 'off',
  title: string,
  description: string,
  selected: string
): string {
  return `<label><input type="radio" name="brandingMode" value="${value}" ${selected === value ? 'checked' : ''}><span><strong>${title}</strong><small>${description}</small></span></label>`
}

type NetworkProfile = NonNullable<
  StationAutomationCatalog['networkProfiles']
>[number]

type UnavailableCollectionRef = NonNullable<
  StationBuildRequest['unavailableCollectionRefs']
>[number]

function renderAutomationBuilder(
  catalog: StationAutomationCatalog,
  draft?: StationBuildRequest,
  preview?: StationBuildPreview,
  catalogSearch = '',
  target?: LibraryChannelPolicy,
  requestedTargetId?: string,
  error?: string,
  suggestion?: ChannelLineupSuggestion,
  suggestionGoal = ''
): string {
  if (requestedTargetId && !target) {
    return `<section class="channel-auto" id="auto-builder"><h2>Channel not found</h2><p>The selected channel no longer exists.</p></section>`
  }

  const profiles = (catalog.networkProfiles ?? []).filter(
    (profile) => profile.audience !== 'after-hours'
  )
  const requestedProfile = profiles.find(
    (profile) => profile.id === draft?.networkId
  )
  const selectedProfile = requestedProfile ?? profiles[0]
  const draftPreset = draft?.preset
  const networkMode =
    profiles.length > 0 &&
    (draft
      ? draft.preset === 'network-copy' || draft.networkId !== undefined
      : true)
  const mixMode = Boolean(
    draftPreset &&
      draftPreset !== 'network-copy' &&
      draftPreset !== 'custom' &&
      !isEraStationTemplateId(draftPreset)
  )
  const customMode = !networkMode && !mixMode
  const selectedMixPreset =
    catalog.presets.find((preset) => preset.id === draftPreset) ??
    catalog.presets.find((preset) => preset.id === 'public-kids-mix') ??
    catalog.presets[0]
  const selectedIds = new Set(draft?.collectionIds ?? [])
  const hasExplicitSelection = draft?.collectionIds !== undefined
  const selectedLineupMode =
    draft?.selectionMode === 'automatic' ? 'automatic' : 'explicit'
  const unavailableCollectionRefs = draft?.unavailableCollectionRefs ?? []
  const selectedAirtime = draft?.airtime ?? 'all-day'
  const savedPreset = draft?.preset ?? target?.automation?.preset
  const legacyEraPreset =
    savedPreset && isEraStationTemplateId(savedPreset) ? savedPreset : undefined
  const legacyEraName =
    catalog.eraTemplates?.find((template) => template.id === legacyEraPreset)
      ?.name ?? legacyEraPreset
  const timezone =
    draft?.timezone ??
    target?.timezone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone
  const selectedStartYear = selectedProfile
    ? clampYear(
        draft?.eraStartYear ?? selectedProfile.defaultStartYear,
        selectedProfile.availableStartYear,
        selectedProfile.availableEndYear
      )
    : new Date().getFullYear()
  const selectedEndYear = selectedProfile
    ? clampYear(
        draft?.eraEndYear ?? selectedProfile.defaultEndYear,
        selectedStartYear,
        selectedProfile.availableEndYear
      )
    : new Date().getFullYear()
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

  return `<section class="channel-auto" id="auto-builder" data-auto-builder>
    <header class="channel-auto-header">
      <div>
        <p class="channel-admin-eyebrow">Channel builder</p>
        <h2>${target ? `Edit lineup for ${escapeHtml(target.name)}` : 'Create a channel'}</h2>
        <p>${target ? 'Choose a network-era lineup or a custom collection. Your existing content choices are loaded and can be changed.' : 'Start with one focused network and era, or build a custom channel from any playable titles you own.'}</p>
      </div>
      <span class="channel-auto-count">${countLabel(catalog.collections.length, 'playable title')}</span>
    </header>
    ${renderBuilderNavigation(target, 'auto')}
    ${error ? `<p class="channel-admin-alert channel-admin-alert-error channel-builder-error" role="alert">${escapeHtml(error)}</p>` : ''}
    ${
      catalog.truncated
        ? `<div class="channel-auto-empty">
            <strong>The playable catalog is too large for safe automation.</strong>
            <p>Dialden found more than 5,000 playable collections. Reduce or block unused collections before building a channel.</p>
          </div>`
          : `<form method="post" action="/channels/auto-build" class="channel-auto-form">
            ${target ? `<input type="hidden" name="targetChannelId" value="${escapeHtml(target.id)}">` : ''}
            ${renderLegacyEraMigrationGuard(legacyEraPreset, legacyEraName)}
            <fieldset id="legacy-replacement-editor" data-legacy-migration-fields ${legacyEraPreset ? 'disabled' : ''}>
              <legend class="channel-visually-hidden">Replacement channel builder</legend>
            <section class="channel-builder-step" aria-labelledby="auto-details-heading">
              ${renderStepHeading(1, 'Channel details', 'Choose the stable channel identity and local broadcast timezone.', 'auto-details-heading')}
              <div class="channel-admin-fields">
                <label>Channel ID
                  <input type="text" name="id" required maxlength="59" pattern="[A-Za-z0-9][A-Za-z0-9_-]*" value="${escapeHtml(draft?.id ?? target?.id ?? '')}" ${target ? 'readonly' : ''} placeholder="cartoon-network-2000s">
                  <small>Used by TV clients and cannot be changed after creation.</small>
                </label>
                <label>Display name
                  <input type="text" name="name" required maxlength="100" value="${escapeHtml(draft?.name ?? target?.name ?? '')}" placeholder="Cartoon Network 2000s">
                </label>
                <label>Timezone
                  <input type="text" name="timezone" required maxlength="100" value="${escapeHtml(timezone)}" placeholder="America/New_York">
                </label>
              </div>
            </section>

            <section class="channel-builder-step" aria-labelledby="auto-programming-heading">
              ${renderStepHeading(2, 'Choose channel type and content', 'Network channels stay within one network and era. Custom channels use only the titles you check.', 'auto-programming-heading')}
              <fieldset class="channel-builder-mode">
                <legend>What kind of channel are you building?</legend>
                <div class="channel-builder-mode-grid">
                  <label>
                    <input type="radio" name="builderMode" value="network" data-builder-mode ${networkMode ? 'checked' : ''} ${profiles.length === 0 ? 'disabled' : ''}>
                    <span><strong>Network channel</strong><small>Pick one network and an era. Only strictly eligible titles from that network can be selected.</small></span>
                  </label>
                  <label>
                    <input type="radio" name="builderMode" value="mix" data-builder-mode ${mixMode ? 'checked' : ''} ${catalog.presets.length === 0 ? 'disabled' : ''}>
                    <span><strong>General mix</strong><small>Use an explainable recipe that can combine compatible shows across broadcasters.</small></span>
                  </label>
                  <label>
                    <input type="radio" name="builderMode" value="custom" data-builder-mode ${customMode ? 'checked' : ''}>
                    <span><strong>Custom channel</strong><small>Search the entire playable library and choose every show or movie yourself.</small></span>
                  </label>
                </div>
              </fieldset>
              ${target && networkMode && selectedLineupMode === 'automatic' ? '<p class="channel-auto-loaded" role="status"><strong>Automatic lineup loaded:</strong> It will keep following this network and era as the playable library changes.</p>' : target && hasExplicitSelection ? `<p class="channel-auto-loaded" role="status"><strong>Current lineup loaded:</strong> ${countLabel(selectedIds.size, 'selected title')}. Checks remain editable until you apply the update.</p>` : ''}
              ${renderUnavailableSelections(unavailableCollectionRefs)}
              ${renderNetworkChannelBuilder(
                profiles,
                selectedProfile,
                selectedStartYear,
                selectedEndYear,
                selectedIds,
                hasExplicitSelection,
                catalog,
                catalogSearch,
                networkMode,
                selectedLineupMode
              )}
              ${renderGeneralMixBuilder(
                catalog,
                selectedMixPreset?.id,
                mixMode
              )}
              ${renderCustomChannelBuilder(
                visibleCollections,
                matchingCollections.length,
                catalog.collections.length,
                selectedIds,
                catalogSearch,
                customMode,
                suggestion,
                suggestionGoal
              )}
            </section>

            <section class="channel-builder-step" aria-labelledby="auto-schedule-heading">
              ${renderStepHeading(3, 'Choose airtime and marathons', 'Set when this channel appears and whether it occasionally runs a single-show marathon.', 'auto-schedule-heading')}
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
                <p class="channel-admin-help">All-day network channels use the visual dayparts shown above. Reduced airtimes use the selected window while keeping the same strict content lineup.</p>
              </fieldset>
              ${renderAfterHoursHandoff(
                draft?.handoff ?? target?.automation?.handoff,
                selectedProfile?.id === 'cartoon-network',
                selectedAirtime === 'all-day'
              )}
              ${renderMarathonSettings(draft?.marathon ?? target?.marathon)}
            </section>

            <section class="channel-builder-step channel-builder-review" aria-labelledby="auto-review-heading">
              ${renderStepHeading(4, 'Preview and apply', 'Verify the exact eligible lineup before saving changes.', 'auto-review-heading')}
              ${renderAutomationPreview(preview)}
              ${target ? `<label class="channel-auto-replace"><input type="checkbox" name="confirmReplace" value="yes" required><span><strong>Replace this channel’s current programming setup</strong><small>This replaces its schedule blocks, selected content, and marathon pattern. The channel ID, enabled state, and manual on/off state are preserved.</small></span></label>` : ''}
              <footer class="channel-builder-footer channel-auto-actions">
                ${target ? '' : '<a class="channel-admin-link" href="/channels?new=manual#channel-editor">Build an advanced manual schedule</a>'}
                <button type="submit" name="action" value="preview" formnovalidate class="btn-secondary">Preview lineup</button>
                <button type="submit" name="action" value="${target ? 'update' : 'create'}">${target ? 'Apply lineup changes' : `Create ${escapeHtml(airtimeActionLabel(selectedAirtime))} channel`}</button>
              </footer>
            </section>
            </fieldset>
          </form>`
    }
  </section>`
}

function renderLegacyEraMigrationGuard(
  preset: string | undefined,
  name: string | undefined
): string {
  if (!preset) return ''
  return `<aside class="channel-auto-disclaimer" data-legacy-era-guard data-legacy-preset="${escapeHtml(preset)}" role="note">
    <strong>Legacy Auto recipe preserved</strong>
    <p>This station still uses <code>${escapeHtml(name ?? preset)}</code>. The current builder cannot edit that historical recipe without replacing it, so the replacement fields are read-only.</p>
    <p data-legacy-migration-status role="status">Nothing changes unless you explicitly unlock this editor, choose a new Network or Custom lineup, preview it, and confirm the replacement.</p>
    <button type="button" class="btn-secondary" data-legacy-migration-confirm aria-controls="legacy-replacement-editor" aria-expanded="false">I understand — unlock replacement editor</button>
  </aside>`
}

function renderAfterHoursHandoff(
  handoff: StationBuildRequest['handoff'],
  cartoonNetworkSelected: boolean,
  allDaySelected: boolean
): string {
  const available = cartoonNetworkSelected && allDaySelected
  const enabled = handoff !== undefined
  return `<section class="channel-handoff" data-handoff-panel ${cartoonNetworkSelected ? '' : 'hidden'}>
    <header>
      <div><p class="channel-admin-eyebrow">Optional scheduled identity</p><h3>Cartoon Network sign-off</h3></div>
      <span class="channel-handoff-lock">Parent locked</span>
    </header>
    <label class="channel-handoff-toggle">
      <input type="checkbox" name="handoffEnabled" value="true" data-handoff-toggle ${enabled ? 'checked' : ''} ${available ? '' : 'disabled'}>
      <span><strong>Hand off to an Adult Swim identity overnight</strong><small>At sign-off, Cartoon Network programming stops and the scheduled <code>adult-swim</code> logo variant can appear. The station remains off-air until sign-on.</small></span>
    </label>
    <fieldset data-handoff-fields ${enabled && available ? '' : 'disabled'}>
      <legend>Local handoff times</legend>
      <label>CN signs off <input type="time" name="handoffStart" value="${escapeHtml(handoff?.start ?? '21:00')}" min="17:00" max="23:59" required></label>
      <label>CN returns <input type="time" name="handoffEnd" value="${escapeHtml(handoff?.end ?? '06:00')}" min="00:00" max="10:00" required></label>
    </fieldset>
    <p class="channel-handoff-status" data-handoff-status role="status">${
      !available
        ? 'Choose Cartoon Network with All day airtime to use this handoff.'
        : enabled
          ? 'Locked handoff active. No adult programmes are selected or played.'
          : 'Off — Cartoon Network keeps its ordinary schedule.'
    }</p>
    <aside><strong>Why it is locked:</strong> Adult Swim is a young-adult service. No adult programmes are selected or played; Dialden will not schedule that catalog on a child-focused server without a real PIN/profile gate. This option reproduces the timed sign-off safely.</aside>
  </section>`
}

function renderUnavailableSelections(
  references: readonly UnavailableCollectionRef[]
): string {
  if (references.length === 0) return ''
  return `<aside class="channel-unavailable-selections" role="note">
    <div><strong>${countLabel(references.length, 'saved title')} currently unavailable</strong><p>These saved library references are not playable now, so they cannot appear as checkboxes. Dialden keeps them when you apply the same network, era, and hand-picked mode; changing any of those rebuilds eligibility and may remove them.</p></div>
    <ul>${references.map((reference) => `<li><code>${escapeHtml(reference.identityKey)}</code><small>${escapeHtml(reference.libraryKind)} · ${escapeHtml(reference.rootId)}</small></li>`).join('')}</ul>
  </aside>`
}

function renderNetworkChannelBuilder(
  profiles: readonly NetworkProfile[],
  selectedProfile: NetworkProfile | undefined,
  selectedStartYear: number,
  selectedEndYear: number,
  selectedIds: ReadonlySet<number>,
  hasExplicitSelection: boolean,
  catalog: StationAutomationCatalog,
  catalogSearch: string,
  active: boolean,
  lineupMode: 'automatic' | 'explicit'
): string {
  if (profiles.length === 0 || !selectedProfile) {
    return `<section class="channel-builder-mode-panel channel-network-builder" data-builder-mode-panel="network" ${active ? '' : 'hidden'}>
      <input type="radio" name="preset" value="network-copy" data-builder-preset="network" ${active ? 'checked' : ''} hidden>
      <p class="channel-auto-empty">No strict network profiles are available. Choose Custom channel instead.</p>
    </section>`
  }
  return `<section class="channel-builder-mode-panel channel-network-builder" data-builder-mode-panel="network" data-explicit-selection="${hasExplicitSelection}" ${active ? '' : 'hidden'}>
    <input type="radio" name="preset" value="network-copy" data-builder-preset="network" ${active ? 'checked' : ''} hidden>
    <fieldset data-builder-mode-fields ${active ? '' : 'disabled'}>
      <legend class="channel-visually-hidden">Network channel settings</legend>
      <div class="channel-network-controls">
        <label>Network
          <select name="networkId" required data-network-select>
            ${renderNetworkProfileOptions(profiles, selectedProfile.id)}
          </select>
          <small>School-age and preschool identities stay separate. Only verified titles from the selected service are offered.</small>
        </label>
        <label>Era starts
          <select name="eraStartYear" required data-era-start>
            ${renderYearOptions(
              selectedProfile.availableStartYear,
              selectedProfile.availableEndYear,
              selectedStartYear
            )}
          </select>
        </label>
        <label>Era ends
          <select name="eraEndYear" required data-era-end>
            ${renderYearOptions(
              selectedStartYear,
              selectedProfile.availableEndYear,
              selectedEndYear,
              true
            )}
          </select>
        </label>
      </div>
      <p class="channel-auto-disclaimer"><strong>Period-inspired personal channel—not an official feed.</strong> Network and era act as strict eligibility boundaries. Cross-network and family-mix guest titles are not added.</p>
      ${renderLineupMode(lineupMode)}
      <div class="channel-network-profile-stack" aria-live="polite">
        ${profiles.map((profile) =>
          renderNetworkProfile(
            profile,
            profile.id === selectedProfile.id,
            profile.id === selectedProfile.id ? selectedStartYear : profile.defaultStartYear,
            profile.id === selectedProfile.id ? selectedEndYear : profile.defaultEndYear,
            selectedIds,
            hasExplicitSelection,
            catalog,
            catalogSearch,
            active,
            lineupMode
          )
        ).join('')}
      </div>
    </fieldset>
  </section>`
}

function renderNetworkProfileOptions(
  profiles: readonly NetworkProfile[],
  selectedId: NetworkProfile['id']
): string {
  const groups: ReadonlyArray<{
    audience: NetworkProfile['audience']
    label: string
  }> = [
    { audience: 'school-age', label: 'School-age & family channels' },
    { audience: 'preschool', label: 'Preschool & younger-family channels' },
  ]
  return groups
    .map(({ audience, label }) => {
      const options = profiles.filter((profile) => profile.audience === audience)
      if (options.length === 0) return ''
      return `<optgroup label="${escapeHtml(label)}">${options
        .map(
          (profile) =>
            `<option value="${escapeHtml(profile.id)}" ${profile.id === selectedId ? 'selected' : ''}>${escapeHtml(profile.name)}</option>`
        )
        .join('')}</optgroup>`
    })
    .join('')
}

function renderLineupMode(mode: 'automatic' | 'explicit'): string {
  return `<fieldset class="channel-lineup-mode">
    <legend>How should this lineup stay up to date?</legend>
    <div class="channel-lineup-mode-grid">
      <label>
        <input type="radio" name="selectionMode" value="automatic" data-lineup-mode ${mode === 'automatic' ? 'checked' : ''}>
        <span><strong>Follow eligible lineup automatically</strong><small>Keep following this network and era as eligible titles appear or disappear from your playable library.</small></span>
      </label>
      <label>
        <input type="radio" name="selectionMode" value="explicit" data-lineup-mode ${mode === 'explicit' ? 'checked' : ''}>
        <span><strong>Hand-picked lineup</strong><small>Include only the titles you check below. New eligible titles are not added automatically.</small></span>
      </label>
    </div>
    <p class="channel-lineup-mode-status ${mode === 'explicit' ? 'is-explicit' : ''}" data-lineup-mode-status role="status">${mode === 'automatic' ? 'Dialden recalculates this strict lineup during library refreshes using the selected network and era.' : 'Choose at least one title. An empty hand-picked lineup cannot be saved.'}</p>
  </fieldset>`
}

function renderNetworkProfile(
  profile: NetworkProfile,
  selected: boolean,
  startYear: number,
  endYear: number,
  selectedIds: ReadonlySet<number>,
  hasExplicitSelection: boolean,
  catalog: StationAutomationCatalog,
  catalogSearch: string,
  modeActive: boolean,
  lineupMode: 'automatic' | 'explicit'
): string {
  const collections = new Map(
    catalog.collections.map((collection) => [collection.id, collection])
  )
  const eligibleMatches = profile.matches.filter((match) =>
    erasOverlap(match.airStartYear, match.airEndYear, startYear, endYear)
  )
  const selectedCount = eligibleMatches.filter((match) =>
    hasExplicitSelection ? selectedIds.has(match.collectionId) : true
  ).length
  return `<fieldset class="channel-network-profile" data-network-panel="${escapeHtml(profile.id)}" data-min-year="${profile.availableStartYear}" data-max-year="${profile.availableEndYear}" data-default-start="${profile.defaultStartYear}" data-default-end="${profile.defaultEndYear}" data-selection-mode="${lineupMode}" ${selected ? '' : 'hidden'} ${modeActive && selected ? '' : 'disabled'}>
    <legend class="channel-visually-hidden">${escapeHtml(profile.name)} content</legend>
    <header class="channel-network-profile-header">
      <div><p class="channel-admin-eyebrow">${escapeHtml(profile.name)} · ${escapeHtml(profileAudienceLabel(profile.audience))}</p><h3>${escapeHtml(profile.description)}</h3></div>
      <span>${countLabel(profile.matchedShows, 'owned show')} · ${countLabel(profile.matchedMovies, 'owned movie')}</span>
    </header>
    ${renderNetworkIdentityNotice(profile)}
    ${renderNetworkWeek(profile)}
    <section class="channel-network-library" aria-labelledby="owned-${escapeHtml(profile.id)}">
      <header><div><h4 id="owned-${escapeHtml(profile.id)}">Eligible titles you own</h4><p data-picker-description>${lineupMode === 'automatic' ? 'These titles currently match. Dialden follows the strict network and era rules as your playable library changes.' : 'Every checked title is included; unchecked titles stay out.'}</p></div><strong data-selection-count aria-live="polite">${lineupMode === 'automatic' ? `${eligibleMatches.length} eligible automatically` : `${selectedCount} of ${eligibleMatches.length} selected`}</strong></header>
      ${renderTitlePickerToolbar(`network-${profile.id}`, catalogSearch, lineupMode === 'automatic')}
      <div class="channel-title-grid" data-title-list>
        ${profile.matches.map((match) => {
          const collection = collections.get(match.collectionId)
          const eligible = erasOverlap(
            match.airStartYear,
            match.airEndYear,
            startYear,
            endYear
          )
          const checked = hasExplicitSelection
            ? selectedIds.has(match.collectionId)
            : true
          const searchText = normalize(
            `${match.title} ${match.libraryKind} ${match.firstAirYear ?? ''} ${eligibilityReasonLabel(match.eligibilityReason)}`
          )
          const firstAirLabel = match.firstAirYear
            ? ` · first aired ${match.firstAirYear}`
            : ''
          return `<label data-title-row data-air-start-year="${match.airStartYear}" data-air-end-year="${match.airEndYear}" data-search-text="${escapeHtml(searchText)}" ${eligible ? '' : 'hidden'}>
            <input type="checkbox" name="collectionIds" value="${match.collectionId}" ${checked ? 'checked' : ''} ${modeActive && selected && eligible && lineupMode === 'explicit' ? '' : 'disabled'}>
            <span><strong>${escapeHtml(match.title)}</strong><small>${escapeHtml(match.libraryKind.toUpperCase())} · ${match.airStartYear}–${match.airEndYear}${firstAirLabel} · ${escapeHtml(eligibilityReasonLabel(match.eligibilityReason))} · ${escapeHtml(match.playbackOrder)}${collection ? ` · ${countLabel(collection.eligibleFiles, 'playable file')}` : ''}</small></span>
          </label>`
        }).join('') || '<p class="channel-title-empty">No owned title is strictly eligible for this network.</p>'}
      </div>
      <p class="channel-title-empty" data-title-filter-empty hidden>No eligible owned title matches this search.</p>
    </section>
    <section class="channel-network-wishlist" aria-labelledby="wishlist-${escapeHtml(profile.id)}">
      <header><div><h4 id="wishlist-${escapeHtml(profile.id)}">Network acquisition suggestions</h4><p>Wishlist only—Dialden never downloads, streams, or links to media.</p></div></header>
      <div class="channel-wishlist-grid">
        ${profile.missingSuggestions.map((suggestion) => {
          const visible = erasOverlap(
            suggestion.airStartYear,
            suggestion.airEndYear,
            startYear,
            endYear
          )
          return `<article data-network-suggestion data-air-start-year="${suggestion.airStartYear}" data-air-end-year="${suggestion.airEndYear}" ${visible ? '' : 'hidden'}><strong>${escapeHtml(suggestion.title)}</strong><small>${escapeHtml(suggestion.libraryKind.toUpperCase())} · carried ${suggestion.airStartYear}–${suggestion.airEndYear} · produced ${suggestion.firstYear}${suggestion.lastYear && suggestion.lastYear !== suggestion.firstYear ? `–${suggestion.lastYear}` : ''}</small></article>`
        }).join('') || '<p>There are no missing network titles in this profile.</p>'}
      </div>
      <p class="channel-title-empty" data-suggestion-empty hidden>No acquisition suggestion overlaps this era.</p>
    </section>
  </fieldset>`
}

function profileAudienceLabel(
  audience: NetworkProfile['audience']
): string {
  return audience === 'preschool'
    ? 'Preschool / younger family'
    : audience === 'after-hours'
      ? 'After-hours'
      : 'School age / family'
}

function renderNetworkIdentityNotice(profile: NetworkProfile): string {
  if (profile.id === 'abc3-abc-me') {
    return '<p class="channel-network-identity-note"><strong>Historical boundary:</strong> ABC3 became ABC ME in 2016 and the ABC ME brand ended in 2024. This age-seven Best Of never pulls generic ABC titles; Bluey remains under ABC Kids Australia.</p>'
  }
  if (profile.id === 'abc-family-au') {
    return '<p class="channel-network-identity-note"><strong>Current Australian profile:</strong> This follows ABC Family and children’s ABC iview delivery from 2024. General or adult ABC Entertains programming is excluded.</p>'
  }
  return ''
}

function renderCustomChannelBuilder(
  collections: StationAutomationCatalog['collections'],
  matchingCount: number,
  totalCount: number,
  selectedIds: ReadonlySet<number>,
  catalogSearch: string,
  active: boolean,
  suggestion?: ChannelLineupSuggestion,
  suggestionGoal = ''
): string {
  const selectedCount = collections.filter((collection) =>
    selectedIds.has(collection.id)
  ).length
  return `<section class="channel-builder-mode-panel channel-custom-builder" data-builder-mode-panel="custom" ${active ? '' : 'hidden'}>
    <input type="radio" name="preset" value="custom" data-builder-preset="custom" ${active ? 'checked' : ''} hidden>
    <fieldset data-builder-mode-fields ${active ? '' : 'disabled'}>
      <legend class="channel-visually-hidden">Custom channel settings</legend>
      <input type="hidden" name="selectionMode" value="explicit">
      <header class="channel-custom-header"><div><h3>Choose from every playable title</h3><p>No network identity is implied. Only checked titles are scheduled.</p></div><strong data-selection-count aria-live="polite">${countLabel(selectedCount, 'selected title')}</strong></header>
      <aside class="channel-auto-disclaimer">
        <strong>AI suggested draft</strong>
        <p>Describe a channel and the configured review assistant will choose only from approved, playable TV metadata. It cannot approve, download, create, or silently update media.</p>
        <label>Channel idea
          <textarea name="suggestionGoal" maxlength="500" rows="3" placeholder="A calm public-media kids channel mixing PBS, CBC, CBBC, and CBeebies shows">${escapeHtml(suggestionGoal)}</textarea>
        </label>
        <button type="submit" name="action" value="ai-suggest" formnovalidate class="btn-secondary">Suggest a hand-picked lineup</button>
        ${suggestion ? `<p role="status"><strong>${escapeHtml(suggestion.name)}:</strong> ${escapeHtml(suggestion.rationale)} Review the ${countLabel(suggestion.collectionIds.length, 'checked title')} below, then preview before saving.</p>` : ''}
      </aside>
      ${renderTitlePickerToolbar('custom', catalogSearch)}
      <div class="channel-title-grid channel-title-grid-custom" data-title-list>
        ${collections.map((collection) => `<label data-title-row data-search-text="${escapeHtml(collectionSearchText(collection))}">
          <input type="checkbox" name="collectionIds" value="${collection.id}" ${selectedIds.has(collection.id) ? 'checked' : ''} ${active ? '' : 'disabled'}>
          <span><strong>${escapeHtml(collection.displayTitle)}</strong><small>${escapeHtml(collection.libraryKind.toUpperCase())} · ${countLabel(collection.eligibleFiles, 'playable file')}${collection.networks.length > 0 ? ` · ${escapeHtml(collection.networks.join(', '))}` : ''}</small></span>
        </label>`).join('') || '<p class="channel-title-empty">No playable titles are available yet.</p>'}
      </div>
      <p class="channel-title-empty" data-title-filter-empty hidden>No playable title matches this search.</p>
      ${matchingCount === 0 && catalogSearch ? '<p class="channel-admin-help">No collection matches this catalog search. Clear it to browse the catalog.</p>' : ''}
      ${matchingCount > 250 ? `<p class="channel-admin-help">Showing the first 250 of ${matchingCount} matching titles. Refine the search to reach the rest.</p>` : normalize(catalogSearch) ? `<p class="channel-admin-help">Showing ${countLabel(matchingCount, 'matching title')}.</p>` : totalCount > 250 ? '<p class="channel-admin-help">Showing the first 250 playable titles. Search by title, network, studio, or genre to reach the rest.</p>' : ''}
    </fieldset>
  </section>`
}

function renderGeneralMixBuilder(
  catalog: StationAutomationCatalog,
  selectedPreset: StationAutomationCatalog['presets'][number]['id'] | undefined,
  active: boolean
): string {
  return `<section class="channel-builder-mode-panel channel-mix-builder" data-builder-mode-panel="mix" ${active ? '' : 'hidden'}>
    <fieldset data-builder-mode-fields ${active ? '' : 'disabled'}>
      <legend>Choose a general channel recipe</legend>
      <input type="hidden" name="selectionMode" value="automatic">
      <div class="channel-auto-airtime-grid">
        ${catalog.presets.map((preset) => `<label class="channel-auto-airtime">
          <input type="radio" name="preset" value="${escapeHtml(preset.id)}" ${preset.id === selectedPreset ? 'checked' : ''}>
          <span><strong>${escapeHtml(preset.name)}</strong><small>${escapeHtml(preset.description)} ${countLabel(preset.matchedCollections, 'matching title')}${preset.unofficial ? ' · Unofficial personal mix' : ''}</small></span>
        </label>`).join('')}
      </div>
      <p class="channel-auto-disclaimer"><strong>Recipe-based personal channel.</strong> Dialden uses approved TMDB metadata and refreshes this lineup deterministically when your playable library changes. It does not claim to reproduce any broadcaster feed.</p>
    </fieldset>
  </section>`
}

function renderTitlePickerToolbar(
  id: string,
  search: string,
  automatic = false
): string {
  return `<div class="channel-title-toolbar" data-title-picker>
    <label for="title-search-${escapeHtml(id)}">Search titles
      <input id="title-search-${escapeHtml(id)}" type="search" name="catalogSearch" maxlength="100" value="${escapeHtml(search)}" placeholder="Type a title…" data-title-search>
    </label>
    <div class="channel-title-toolbar-actions">
      <button type="submit" name="action" value="search" formnovalidate class="btn-secondary">Search catalog</button>
      ${search ? '<button type="submit" name="action" value="clear-search" formnovalidate class="channel-auto-clear">Clear search</button>' : ''}
      <button type="button" class="btn-secondary" data-select-visible data-explicit-action ${automatic ? 'hidden disabled' : ''}>Select all</button>
      <button type="button" class="btn-secondary" data-clear-visible data-explicit-action ${automatic ? 'hidden disabled' : ''}>Clear checks</button>
    </div>
  </div>`
}

function renderNetworkWeek(profile: NetworkProfile): string {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  return `<section class="channel-network-plan" aria-labelledby="plan-${escapeHtml(profile.id)}">
    <header><div><h4 id="plan-${escapeHtml(profile.id)}">Dayparts and week at a glance</h4><p>The all-day schedule repeats this network profile across the week.</p></div></header>
    <div class="channel-network-dayparts" aria-label="Daily dayparts">
      ${profile.blocks.map((block) => `<span><b>${escapeHtml(block.start)}–${escapeHtml(block.end)}</b><small>${escapeHtml(block.name)}</small></span>`).join('')}
    </div>
    <div class="channel-network-week" role="table" aria-label="${escapeHtml(profile.name)} weekly daypart summary">
      <div class="channel-network-week-row is-heading" role="row"><strong role="columnheader">Daypart</strong>${days.map((day) => `<span role="columnheader">${day}</span>`).join('')}</div>
      ${profile.blocks.map((block) => `<div class="channel-network-week-row" role="row"><strong role="rowheader"><small>${escapeHtml(block.start)}–${escapeHtml(block.end)}</small>${escapeHtml(block.name)}</strong>${days.map((day) => `<span role="cell" aria-label="${escapeHtml(`${day}, ${block.name}, ${block.start} to ${block.end}`)}"></span>`).join('')}</div>`).join('')}
    </div>
  </section>`
}

function renderYearOptions(
  start: number,
  end: number,
  selected: number,
  labelCurrent = false
): string {
  const currentYear = new Date().getFullYear()
  const options: string[] = []
  for (let year = start; year <= end; year += 1) {
    const label = labelCurrent && year === currentYear ? `${year} (Current)` : String(year)
    options.push(`<option value="${year}" ${year === selected ? 'selected' : ''}>${label}</option>`)
  }
  return options.join('')
}

function clampYear(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function erasOverlap(
  itemStart: number,
  itemEnd: number,
  eraStart: number,
  eraEnd: number
): boolean {
  return itemStart <= eraEnd && itemEnd >= eraStart
}

function eligibilityReasonLabel(
  reason: NetworkProfile['matches'][number]['eligibilityReason']
): string {
  if (reason === 'documented-network-lineup') return 'Documented network lineup'
  if (reason === 'curated-network-lineup') return 'Curated network lineup'
  return 'Exact network metadata'
}

function renderModal(
  id: string,
  content: string,
  closeHref = '/channels',
  label = 'Station setup'
): string {
  return `<div class="channel-modal" id="${escapeHtml(id)}" role="dialog" aria-modal="true" aria-label="${escapeHtml(label)}" data-modal-close-href="${escapeHtml(closeHref)}">
    <a class="channel-modal-backdrop" href="${escapeHtml(closeHref)}" aria-hidden="true" tabindex="-1"></a>
    <div class="channel-modal-panel" tabindex="-1" data-channel-modal-panel>
      <a class="channel-modal-close" href="${escapeHtml(closeHref)}" aria-label="Close ${escapeHtml(label)}" data-modal-close>×</a>
      ${content}
    </div>
  </div>`
}

function renderAutomationPreview(preview?: StationBuildPreview): string {
  if (!preview) return ''
  if (preview.collectionCount === 0 || preview.eligibleFiles === 0) {
    return `<div class="channel-auto-preview channel-auto-preview-empty">
      <strong>Preview: no schedulable matches</strong>
      <p>No checked title is both eligible for this channel and ready to schedule. Check at least one title, or finish its approval, metadata, and media probe first.</p>
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
      <div><dt>Marathons</dt><dd>${escapeHtml(marathonSummary(channel.marathon))}</dd></div>
    </dl>
    <div class="channel-admin-actions">
      <a class="channel-admin-primary" href="/channels?edit=${encodeURIComponent(channel.id)}#channel-editor" aria-label="Configure ${escapeHtml(channel.name)}">Configure</a>
      <a href="/channels?builder=${encodeURIComponent(channel.id)}#station-builder" aria-label="Edit lineup for ${escapeHtml(channel.name)}">Auto lineup</a>
      <a href="/channels?branding=${encodeURIComponent(channel.id)}#branding-modal" aria-label="Edit logo for ${escapeHtml(channel.name)}">Logo</a>
      <form method="post" action="/channels/${encodeURIComponent(channel.id)}/enabled">
        <input type="hidden" name="enabled" value="${channel.enabled ? 'false' : 'true'}">
        <button type="submit">${channel.enabled ? 'Disable' : 'Enable'}</button>
      </form>
      <form method="post" action="/channels/${encodeURIComponent(channel.id)}/delete" onsubmit="return confirm('Delete this channel?')">
        <button class="channel-admin-danger" type="submit" aria-label="Delete ${escapeHtml(channel.name)}">Delete</button>
      </form>
    </div>
  </article>`
}

const DEFAULT_MARATHON: ChannelMarathonPolicy = {
  enabled: false,
  frequency: 12,
  episodeCount: 4,
}

function renderMarathonSettings(policy?: ChannelMarathonPolicy): string {
  const marathon = policy ?? DEFAULT_MARATHON
  return `<section class="channel-marathon" data-marathon-settings data-enabled="${marathon.enabled}">
    <header>
      <div>
        <p class="channel-admin-eyebrow">Programming pattern</p>
        <h3>Episode marathons</h3>
        <p>Occasionally keep one series on air for several consecutive episodes.</p>
      </div>
      <label class="channel-marathon-toggle"><input type="checkbox" name="marathonEnabled" value="true" data-marathon-enabled ${marathon.enabled ? 'checked' : ''}><span><strong>Enable marathon blocks</strong><small data-marathon-status>${marathon.enabled ? 'Automatic marathons are active.' : 'Off — use the normal mixed lineup.'}</small></span></label>
    </header>
    <div class="channel-marathon-fields">
      <label>Start after this many normal programmes
        <input type="number" name="marathonFrequency" min="2" max="100" step="1" required value="${marathon.frequency}">
        <small>Bumpers and episodes already inside a marathon do not count.</small>
      </label>
      <label>Episodes in each marathon
        <input type="number" name="marathonEpisodeCount" min="2" max="20" step="1" required value="${marathon.episodeCount}">
        <small>The end of an airtime block may shorten a marathon.</small>
      </label>
    </div>
    <p class="channel-marathon-note">Only ordered TV episodes are grouped. Movies remain single programmes, and shows without at least two eligible ordered episodes fall back to the normal lineup.</p>
  </section>`
}

function marathonSummary(policy?: ChannelMarathonPolicy): string {
  return policy?.enabled
    ? `Every ${policy.frequency} programmes · ${policy.episodeCount} episodes`
    : 'Off'
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
