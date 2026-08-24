import { describe, expect, test } from 'bun:test'
import { renderChannelAdministration } from '../src/templates/channelAdministration'

describe('channel administration template', () => {
  test('renders editable schedules and escapes persisted display values', () => {
    const markup = renderChannelAdministration(
      {
        channels: [
          {
            id: 'kids',
            name: '<script>Kids</script>',
            enabled: true,
            timezone: 'UTC',
            slots: [
              {
                days: ['mon', 'tue'],
                start: '06:30',
                end: '08:30',
                groups: ['comfort', 'learning'],
              },
            ],
          },
        ],
        manuallyOffAir: ['kids'],
        programmingGroups: ['comfort', 'learning'],
        configurationError: null,
      },
      { editId: 'kids' }
    )

    expect(markup).toContain('Manually off air')
    expect(markup).toContain('mon,tue | 06:30-08:30 | comfort,learning')
    expect(markup).toContain('data-schedule-editor')
    expect(markup).toContain('data-calendar-day="mon"')
    expect(markup).toContain('data-slot-day checked')
    expect(markup).toContain('data-slot-group checked')
    expect(markup).toContain('/js/channels.js')
    expect(markup).toContain('action="/channels/kids"')
    expect(markup).toContain('&lt;script&gt;Kids&lt;/script&gt;')
    expect(markup).not.toContain('<script>Kids</script>')
  })

  test('opens channel branding in its own preview modal while preserving editor values', () => {
    const snapshot = {
      channels: [
        {
          id: 'kids',
          name: 'Kids Club',
          enabled: true,
          timezone: 'UTC',
          slots: [],
          branding: {
            mode: 'custom' as const,
            burnIn: true,
            opacity: 204,
            position: 8 as const,
            x: 20,
            y: 18,
            sizePercent: 14,
          },
        },
      ],
      manuallyOffAir: [],
      programmingGroups: [],
      configurationError: null,
    }
    const editor = renderChannelAdministration(snapshot, {
      editId: 'kids',
      channelLogoIds: ['kids'],
    })
    const modal = renderChannelAdministration(snapshot, {
      brandingId: 'kids',
      channelLogoIds: ['kids'],
      channelLogoVariants: { kids: ['adult-swim'] },
    })

    expect(editor).toContain('href="/channels?edit=kids&amp;branding=kids#branding-modal"')
    expect(editor).toContain('Apps + burn-in')
    expect(editor).toContain('name="brandingBurnIn" value="true"')
    expect(editor).toContain('name="brandingOpacity" value="204"')
    expect(editor).not.toContain('name="brandingLogo"')
    expect(modal).toContain('id="branding-modal"')
    expect(modal).toContain('action="/channels/kids/branding"')
    expect(modal).toContain('Logo shown in apps')
    expect(modal).toContain('Hide channel logo')
    expect(modal).toContain('name="brandingBurnIn" value="true" data-branding-burn-in checked')
    expect(modal).toContain('viewers cannot hide it in their app')
    expect(modal).toContain('data-logo-preview')
    expect(modal).toContain('src="/channels/kids/logo"')
    expect(modal).toContain('Scheduled logo variants')
    expect(modal).toContain('Switch app artwork by time block')
    expect(modal).not.toContain('data-branding-burn-in-file')
    expect(modal).toContain('<code>adult-swim</code>')
    expect(modal).toContain('Save branding')
  })

  test('defaults channel logos to app-only and preserves the choice through the main editor', () => {
    const snapshot = {
      channels: [
        {
          id: 'news',
          name: 'News',
          enabled: true,
          timezone: 'UTC',
          slots: [],
          branding: {
            mode: 'inherit' as const,
            opacity: 210,
            position: 2 as const,
            x: 24,
            y: 24,
            sizePercent: 12,
          },
        },
      ],
      manuallyOffAir: [],
      programmingGroups: [],
      configurationError: null,
    }
    const editor = renderChannelAdministration(snapshot, { editId: 'news' })
    const modal = renderChannelAdministration(snapshot, { brandingId: 'news' })

    expect(editor).toContain('Apps only')
    expect(editor).toContain('name="brandingBurnIn" value="false"')
    expect(modal).toContain('App-only is recommended')
    expect(modal).toContain('name="brandingBurnIn" value="true" data-branding-burn-in >')
    expect(modal).not.toContain('data-branding-burn-in checked')
    expect(modal).toContain('data-branding-burn-in-options hidden')
    expect(modal).toContain('name="brandingVariantLogos"')
    expect(modal).not.toContain('name="brandingVariantLogos" accept="image/png" multiple disabled')
  })

  test('renders persisted marathon controls in manual and Auto channel editors', () => {
    const snapshot = {
      channels: [
        {
          id: 'nick-jr',
          name: 'Nick Jr. Mix',
          enabled: true,
          timezone: 'UTC',
          slots: [],
          marathon: { enabled: true, frequency: 10, episodeCount: 5 },
        },
      ],
      manuallyOffAir: [],
      programmingGroups: [],
      configurationError: null,
    }
    const manual = renderChannelAdministration(snapshot, { editId: 'nick-jr' })
    const automatic = renderChannelAdministration(snapshot, {
      automationOpen: true,
      automationTargetId: 'nick-jr',
      automationDraft: {
        id: 'nick-jr',
        name: 'Nick Jr. Mix',
        timezone: 'UTC',
        preset: 'custom',
        collectionIds: [4],
        marathon: { enabled: false, frequency: 18, episodeCount: 6 },
      },
      automation: {
        collections: [
          {
            id: 4,
            rootId: 'tv',
            identityKey: 'paw-patrol',
            collectionTitle: 'PAW Patrol',
            displayTitle: 'PAW Patrol',
            libraryKind: 'tv',
            genres: ['Animation'],
            networks: ['Nickelodeon'],
            studios: [],
            eligibleFiles: 10,
          },
        ],
        genres: [],
        networks: [{ name: 'Nickelodeon', collections: 1 }],
        studios: [],
        presets: [],
        truncated: false,
      },
    })

    expect(manual).toContain('Episode marathons')
    expect(manual).toContain('Every 10 programmes · 5 episodes')
    expect(manual).toContain('name="marathonEnabled" value="true" data-marathon-enabled checked')
    expect(manual).toContain('name="marathonFrequency" min="2" max="100" step="1" required value="10"')
    expect(automatic).toContain('name="marathonFrequency" min="2" max="100" step="1" required value="18"')
    expect(automatic).toContain('name="marathonEpisodeCount" min="2" max="20" step="1" required value="6"')
    expect(automatic).not.toContain('data-marathon-enabled checked')
    expect(automatic).toContain('and marathon pattern')
  })

  test('renders an honest auto-build preview with a direct all-day creation action', () => {
    const markup = renderChannelAdministration(
      {
        channels: [],
        manuallyOffAir: [],
        programmingGroups: [],
        configurationError: null,
      },
      {
        automationOpen: true,
        automation: {
          collections: [
            {
              id: 8,
              rootId: 'tv',
              identityKey: 'bluey-2018',
              collectionTitle: 'Bluey (2018)',
              displayTitle: 'Bluey',
              libraryKind: 'tv',
              genres: ['Animation'],
              networks: ['ABC Kids'],
              studios: ['Ludo Studio'],
              eligibleFiles: 12,
            },
          ],
          genres: [{ name: 'Animation', collections: 1 }],
          networks: [{ name: 'ABC Kids', collections: 1 }],
          studios: [{ name: 'Ludo Studio', collections: 1 }],
          presets: [
            {
              id: 'all-approved-tv',
              name: 'All approved shows',
              description: 'Every playable show.',
              matchedCollections: 1,
            },
          ],
          truncated: false,
        },
        automationDraft: {
          id: 'bluey-time',
          name: 'Bluey Time',
          timezone: 'UTC',
          preset: 'all-approved-tv',
        },
        automationPreview: {
          collections: [
            {
              id: 8,
              rootId: 'tv',
              identityKey: 'bluey-2018',
              collectionTitle: 'Bluey (2018)',
              displayTitle: 'Bluey',
              libraryKind: 'tv',
              genres: ['Animation'],
              networks: ['ABC Kids'],
              studios: ['Ludo Studio'],
              eligibleFiles: 12,
            },
          ],
          collectionCount: 1,
          eligibleFiles: 12,
        },
      }
    )

    expect(markup).toContain('Personal library mix—not an official network feed')
    expect(markup).toContain('Ready to build: 1 collection · 12 schedulable files')
    expect(markup).toContain('Create all-day station')
    expect(markup).toContain('name="action" value="create"')
    expect(markup).toContain('Preview lineup')
    expect(markup).toContain('name="networks" value="ABC Kids"')
    expect(markup).toContain('Network and studio checkboxes show TMDB’s exact stored values')
    expect(markup).toContain('auto-details-heading')
    expect(markup).toContain('auto-programming-heading')
    expect(markup).toContain('auto-schedule-heading')
    expect(markup).toContain('auto-review-heading')
    expect(markup).toContain('Fine-tune the library mix')
  })

  test('search exposes a specific collection beyond the bounded initial picker', () => {
    const collections = Array.from({ length: 300 }, (_, index) => ({
      id: index + 1,
      rootId: 'tv',
      identityKey: `show-${index + 1}`,
      collectionTitle:
        index === 299 ? 'Target Show (2026)' : `Catalog Show ${index + 1}`,
      displayTitle: index === 299 ? 'Target Show' : `Catalog Show ${index + 1}`,
      libraryKind: 'tv' as const,
      genres: [],
      networks: index === 299 ? ['Target Network'] : [],
      studios: [],
      eligibleFiles: 1,
    }))
    const markup = renderChannelAdministration(
      {
        channels: [],
        manuallyOffAir: [],
        programmingGroups: [],
        configurationError: null,
      },
      {
        automationOpen: true,
        automation: {
          collections,
          genres: [],
          networks: [{ name: 'Target Network', collections: 1 }],
          studios: [],
          presets: [],
          truncated: false,
        },
        automationDraft: {
          id: '',
          name: '',
          timezone: 'UTC',
          preset: 'custom',
          collectionIds: [1],
        },
        automationSearch: 'Target',
      }
    )

    expect(markup).toContain('name="catalogSearch"')
    expect(markup).toContain('value="Target"')
    expect(markup).toContain('name="collectionIds" value="300"')
    expect(markup).toContain('name="collectionIds" value="1"')
    expect(markup).toContain('name="networks" value="Target Network"')
    expect(markup).toContain('Showing 1 matching collection.')
    expect(markup).toContain('while keeping your checked collections')
  })

  test('keeps creation out of the default page and opens it in a modal', () => {
    const snapshot = {
      channels: [],
      manuallyOffAir: [],
      programmingGroups: [],
      configurationError: null,
    }
    const catalog = {
      collections: [],
      genres: [],
      networks: [],
      studios: [],
      presets: [],
      truncated: false,
    }

    const defaultMarkup = renderChannelAdministration(snapshot, {
      automation: catalog,
    })
    const modalMarkup = renderChannelAdministration(snapshot, {
      automation: catalog,
      automationOpen: true,
    })

    expect(defaultMarkup).toContain('href="/channels?builder=create#station-builder"')
    expect(defaultMarkup).not.toContain('role="dialog"')
    expect(defaultMarkup).not.toContain('id="editor"')
    expect(modalMarkup).toContain('role="dialog"')
    expect(modalMarkup).toContain('data-channel-modal-panel')
    expect(modalMarkup).toContain('tabindex="-1"')
    expect(modalMarkup).toContain('class="channel-modal-backdrop" href="/channels" aria-hidden="true" tabindex="-1"')
    expect(modalMarkup).toContain('Create an automatic station')
    expect(modalMarkup).toContain('aria-label="Station setup sections"')
    expect(modalMarkup).toContain('<span aria-current="page">Auto setup</span>')
    expect(modalMarkup).toContain('href="/channels?new=manual#channel-editor"')
  })

  test('opens manual creation and existing configuration as grouped single modals', () => {
    const snapshot = {
      channels: [
        {
          id: 'kids',
          name: 'Kids Club',
          enabled: true,
          timezone: 'UTC',
          slots: [],
        },
      ],
      manuallyOffAir: [],
      programmingGroups: ['learning'],
      configurationError: null,
    }
    const creation = renderChannelAdministration(snapshot, { newChannel: true })
    const edit = renderChannelAdministration(snapshot, { editId: 'kids' })
    const brandingFromEdit = renderChannelAdministration(snapshot, {
      editId: 'kids',
      brandingId: 'kids',
    })

    expect(creation).toContain('id="channel-editor"')
    expect(creation).toContain('aria-label="Create a station manually"')
    expect(creation).toContain('action="/channels"')
    expect(creation).toContain('<span aria-current="page">Manual setup</span>')
    expect(creation).toContain('href="/channels?builder=create#station-builder"')
    expect(edit).toContain('aria-label="Configure Kids Club"')
    expect(edit).toContain('action="/channels/kids"')
    expect(edit).toContain('station-details-heading')
    expect(edit).toContain('station-branding-heading')
    expect(edit).toContain('station-pattern-heading')
    expect(edit).toContain('station-schedule-heading')
    expect(edit).toContain('Save station')
    expect(edit).toContain('href="/channels?builder=kids#station-builder"')
    expect(edit).toContain('href="/channels?branding=kids#branding-modal"')
    expect((brandingFromEdit.match(/role="dialog"/g) ?? []).length).toBe(1)
    expect(brandingFromEdit).toContain('id="branding-modal"')
    expect(brandingFromEdit).not.toContain('id="channel-editor"')
  })

  test('offers guarded Auto setup for an existing channel', () => {
    const markup = renderChannelAdministration(
      {
        channels: [
          {
            id: 'kids',
            name: 'Kids Club',
            enabled: false,
            timezone: 'UTC',
            slots: [],
          },
        ],
        manuallyOffAir: ['kids'],
        programmingGroups: [],
        configurationError: null,
      },
      {
        automationOpen: true,
        automationTargetId: 'kids',
        automation: {
          collections: [
            {
              id: 1,
              rootId: 'tv',
              identityKey: 'bluey',
              collectionTitle: 'Bluey',
              displayTitle: 'Bluey',
              libraryKind: 'tv',
              genres: ['Animation'],
              networks: [],
              studios: [],
              eligibleFiles: 1,
            },
          ],
          genres: [],
          networks: [],
          studios: [],
          presets: [],
          truncated: false,
        },
      }
    )

    expect(markup).toContain('Auto setup for Kids Club')
    expect(markup).toContain('name="targetChannelId" value="kids"')
    expect(markup).toContain('name="id" required maxlength="59"')
    expect(markup).toContain('readonly')
    expect(markup).toContain('name="confirmReplace" value="yes" required')
    expect(markup).toContain('name="action" value="update"')
    expect(markup).toContain('Auto lineup')
    expect(markup).toContain('<span aria-current="page">Auto lineup</span>')
    expect(markup).toContain('Fine-tune the library mix')
  })

  test('loads an existing generated lineup as editable checked collections', () => {
    const markup = renderChannelAdministration(
      {
        channels: [
          {
            id: 'nick-jr',
            name: 'Nick Jr. Mix',
            enabled: true,
            timezone: 'UTC',
            slots: [],
          },
        ],
        manuallyOffAir: [],
        programmingGroups: [],
        configurationError: null,
      },
      {
        automationOpen: true,
        automationTargetId: 'nick-jr',
        automationDraft: {
          id: 'nick-jr',
          name: 'Nick Jr. Mix',
          timezone: 'UTC',
          preset: 'custom',
          collectionIds: [4],
        },
        automation: {
          collections: [
            {
              id: 4,
              rootId: 'tv',
              identityKey: 'paw-patrol',
              collectionTitle: 'PAW Patrol',
              displayTitle: 'PAW Patrol',
              libraryKind: 'tv',
              genres: ['Animation'],
              networks: ['Nickelodeon'],
              studios: [],
              eligibleFiles: 10,
            },
          ],
          genres: [],
          networks: [],
          studios: [],
          presets: [],
          truncated: false,
        },
      }
    )

    expect(markup).toContain('Current lineup loaded:')
    expect(markup).toContain('1 selected collection')
    expect(markup).toContain('name="preset" value="custom" checked')
    expect(markup).toContain('name="collectionIds" value="4" checked')
  })

  test('shows era dayparts, owned coverage, modern guests, and a media wishlist', () => {
    const markup = renderChannelAdministration(
      {
        channels: [],
        manuallyOffAir: [],
        programmingGroups: [],
        configurationError: null,
      },
      {
        automationOpen: true,
        automationDraft: {
          id: 'cn-mix',
          name: 'Cartoon Mix',
          timezone: 'UTC',
          preset: 'cartoon-network-1997-2004',
          airtime: 'all-day',
        },
        automation: {
          collections: [
            {
              id: 1,
              rootId: 'tv',
              identityKey: 'bluey',
              collectionTitle: 'Bluey',
              displayTitle: 'Bluey',
              libraryKind: 'tv',
              genres: ['Animation', 'Family'],
              networks: ['ABC Kids'],
              studios: ['Ludo Studio'],
              firstAirYear: 2018,
              eligibleFiles: 12,
            },
          ],
          genres: [],
          networks: [],
          studios: [],
          presets: [],
          eraTemplates: [
            {
              id: 'cartoon-network-1997-2004',
              name: 'Cartoon Network inspired · 1997–2004',
              networkFamily: 'Cartoon Network',
              description: 'Classic comedy, action, and primetime.',
              eraStartYear: 1997,
              eraEndYear: 2004,
              blocks: [
                { id: 'morning', name: 'Morning', start: '06:00', end: '09:00' },
                { id: 'daytime', name: 'Daytime', start: '09:00', end: '15:30' },
              ],
              matches: [
                {
                  collectionId: 1,
                  title: 'Bluey',
                  libraryKind: 'tv',
                  blockIds: ['morning', 'daytime'],
                  playbackOrder: 'random',
                  score: 50,
                  relationship: 'family-guest',
                },
              ],
              missingSuggestions: [
                {
                  title: "Dexter's Laboratory",
                  libraryKind: 'tv',
                  firstYear: 1996,
                  tags: ['comedy'],
                },
              ],
              matchedShows: 1,
              matchedMovies: 0,
              movieCadence: 'weekly',
              marathonCadence: 'monthly',
            },
          ],
          familyMixSuggestions: [
            {
              title: 'Bluey',
              firstYear: 2018,
              tags: ['family'],
              available: true,
            },
          ],
          truncated: false,
        },
      }
    )

    expect(markup).toContain('Build a network-era station')
    expect(markup).toContain('Period-inspired, not a historical recording.')
    expect(markup).toContain('name="preset" value="cartoon-network-1997-2004" checked')
    expect(markup).toContain('06:00–09:00')
    expect(markup).toContain('Modern family guests')
    expect(markup).toContain('Bluey')
    expect(markup).toContain("Dexter&#39;s Laboratory")
    expect(markup).toContain('ToastTV never downloads or links to media')
  })
})
