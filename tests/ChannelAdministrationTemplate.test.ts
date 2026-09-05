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
    expect(editor).toContain('App menus only')
    expect(editor).not.toContain('brandingBurnIn')
    expect(editor).toContain('name="brandingOpacity" value="204"')
    expect(editor).not.toContain('name="brandingLogo"')
    expect(modal).toContain('id="branding-modal"')
    expect(modal).toContain('action="/channels/kids/branding"')
    expect(modal).toContain('Logo shown in apps')
    expect(modal).toContain('Hide channel logo')
    expect(modal).toContain('Video remains clean')
    expect(modal).not.toContain('brandingBurnIn')
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

    expect(editor).toContain('App menus only')
    expect(editor).not.toContain('brandingBurnIn')
    expect(modal).toContain('App menu preview')
    expect(modal).not.toContain('brandingBurnIn')
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

  test('shows current channel availability and suggestions outside Auto lineup', () => {
    const markup = renderChannelAdministration(
      {
        channels: [
          {
            id: 'nick-classics',
            name: 'Nick Classics',
            enabled: true,
            timezone: 'UTC',
            slots: [],
            automation: {
              preset: 'network-copy',
              airtime: 'all-day',
              networkId: 'nickelodeon',
              eraStartYear: 1995,
              eraEndYear: 1999,
              selectionMode: 'automatic',
            },
          },
        ],
        manuallyOffAir: [],
        programmingGroups: [],
        configurationError: null,
      },
      {
        automation: {
          collections: [
            {
              id: 7,
              rootId: 'tv',
              identityKey: 'catdog',
              collectionTitle: 'CatDog',
              displayTitle: 'CatDog',
              libraryKind: 'tv',
              genres: ['Animation'],
              networks: ['Nickelodeon'],
              studios: [],
              eligibleFiles: 52,
            },
          ],
          genres: [],
          networks: [],
          studios: [],
          presets: [],
          networkProfiles: [
            {
              id: 'nickelodeon',
              name: 'Nickelodeon',
              description: 'Nickelodeon copy',
              audience: 'school-age',
              availableStartYear: 1979,
              availableEndYear: 2026,
              defaultStartYear: 1990,
              defaultEndYear: 1999,
              blocks: [],
              matches: [
                {
                  collectionId: 7,
                  title: 'CatDog',
                  libraryKind: 'tv',
                  firstAirYear: 1998,
                  airStartYear: 1998,
                  airEndYear: 2005,
                  blockIds: [],
                  playbackOrder: 'season-sequential',
                  score: 100,
                  eligibilityReason: 'curated-network-lineup',
                },
              ],
              missingSuggestions: [
                {
                  title: 'Hey Arnold!',
                  libraryKind: 'tv',
                  firstYear: 1996,
                  airStartYear: 1996,
                  airEndYear: 2004,
                  tags: ['animation'],
                },
                {
                  title: 'Modern Nick Show',
                  libraryKind: 'tv',
                  firstYear: 2015,
                  airStartYear: 2015,
                  airEndYear: 2018,
                  tags: ['animation'],
                },
              ],
              matchedShows: 1,
              matchedMovies: 0,
              movieCadence: 'none',
              marathonCadence: 'standard',
            },
          ],
          truncated: false,
        },
      }
    )

    expect(markup).toContain('id="channel-improvements"')
    expect(markup).toContain('Available now <span>1</span>')
    expect(markup).toContain('<strong>CatDog</strong>')
    expect(markup).toContain('52 playable files')
    expect(markup).toContain('Suggested additions <span>1</span>')
    expect(markup).toContain('<strong>Hey Arnold!</strong>')
    expect(markup).not.toContain('<strong>Modern Nick Show</strong>')
  })

  test('renders an explicit custom builder with an honest preview and direct creation action', () => {
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
          preset: 'custom',
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

    expect(markup).toContain('What kind of channel are you building?')
    expect(markup).toContain('Network channel')
    expect(markup).toContain('Custom channel')
    expect(markup).toContain('name="selectionMode" value="explicit"')
    expect(markup).toContain('name="builderMode" value="custom" data-builder-mode checked')
    expect(markup).toContain('Choose from every playable title')
    expect(markup).toContain('Ready to build: 1 collection · 12 schedulable files')
    expect(markup).toContain('Create all-day channel')
    expect(markup).toContain('name="action" value="create"')
    expect(markup).toContain('Preview lineup')
    expect(markup).toContain('name="collectionIds" value="8"')
    expect(markup).toContain('Search catalog')
    expect(markup).toContain('Select all')
    expect(markup).toContain('Clear checks')
    expect(markup).toContain('auto-details-heading')
    expect(markup).toContain('auto-programming-heading')
    expect(markup).toContain('auto-schedule-heading')
    expect(markup).toContain('auto-review-heading')
  })

  test('keeps a legacy era-template Auto channel read-only until replacement is explicitly unlocked', () => {
    const markup = renderChannelAdministration(
      {
        channels: [
          {
            id: 'legacy-cn',
            name: 'Legacy Cartoon Network',
            enabled: true,
            timezone: 'UTC',
            slots: [],
            automation: {
              preset: 'cartoon-network-1997-2004',
              airtime: 'all-day',
            },
          },
        ],
        manuallyOffAir: [],
        programmingGroups: [],
        configurationError: null,
      },
      {
        automationOpen: true,
        automationTargetId: 'legacy-cn',
        automationDraft: {
          id: 'legacy-cn',
          name: 'Legacy Cartoon Network',
          timezone: 'UTC',
          preset: 'cartoon-network-1997-2004',
          airtime: 'all-day',
          collectionIds: [8],
        },
        automation: {
          collections: [
            {
              id: 8,
              rootId: 'tv',
              identityKey: 'dexters-laboratory',
              collectionTitle: "Dexter's Laboratory",
              displayTitle: "Dexter's Laboratory",
              libraryKind: 'tv',
              genres: ['Animation'],
              networks: ['Cartoon Network'],
              studios: [],
              eligibleFiles: 10,
            },
          ],
          genres: [],
          networks: [],
          studios: [],
          presets: [],
          eraTemplates: [
            {
              id: 'cartoon-network-1997-2004',
              name: 'Cartoon Network · 1997–2004',
              networkFamily: 'Cartoon Network',
              description: 'Legacy recipe',
              eraStartYear: 1997,
              eraEndYear: 2004,
              blocks: [],
              matches: [],
              missingSuggestions: [],
              matchedShows: 1,
              matchedMovies: 0,
              movieCadence: 'none',
              marathonCadence: 'none',
            },
          ],
          truncated: false,
        },
      }
    )

    const guardStart = markup.indexOf('data-legacy-era-guard')
    const fieldsStart = markup.indexOf(
      '<fieldset id="legacy-replacement-editor"'
    )
    const fieldsEnd = markup.lastIndexOf('</fieldset>')
    const replacementFields = markup.slice(fieldsStart, fieldsEnd)

    expect(guardStart).toBeGreaterThan(-1)
    expect(markup).toContain('Legacy Auto recipe preserved')
    expect(markup).toContain('<code>Cartoon Network · 1997–2004</code>')
    expect(markup).toContain(
      'data-legacy-preset="cartoon-network-1997-2004"'
    )
    expect(markup).toContain(
      'data-legacy-migration-confirm aria-controls="legacy-replacement-editor" aria-expanded="false"'
    )
    expect(markup).toContain(
      '<fieldset id="legacy-replacement-editor" data-legacy-migration-fields disabled>'
    )
    expect(replacementFields).toContain(
      'name="builderMode" value="custom" data-builder-mode checked'
    )
    expect(replacementFields).toContain(
      'name="action" value="update">Apply lineup changes'
    )
    expect(guardStart).toBeLessThan(fieldsStart)
  })

  test('also protects a saved legacy era recipe when its reconstructed draft is unavailable', () => {
    const markup = renderChannelAdministration(
      {
        channels: [
          {
            id: 'legacy-cn',
            name: 'Legacy Cartoon Network',
            enabled: true,
            timezone: 'UTC',
            slots: [],
            automation: {
              preset: 'cartoon-network-1997-2004',
              airtime: 'all-day',
            },
          },
        ],
        manuallyOffAir: [],
        programmingGroups: [],
        configurationError: null,
      },
      {
        automationOpen: true,
        automationTargetId: 'legacy-cn',
        automation: {
          collections: [],
          genres: [],
          networks: [],
          studios: [],
          presets: [],
          truncated: false,
        },
      }
    )

    expect(markup).toContain('Legacy Auto recipe preserved')
    expect(markup).toContain(
      'data-legacy-preset="cartoon-network-1997-2004"'
    )
    expect(markup).toContain('data-legacy-migration-fields disabled')
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
    expect(markup).toContain('Showing 1 matching title.')
    expect(markup).toContain('name="selectionMode" value="explicit"')
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
    expect(modalMarkup).toContain('Create a channel')
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

    expect(markup).toContain('Edit lineup for Kids Club')
    expect(markup).toContain('name="targetChannelId" value="kids"')
    expect(markup).toContain('name="id" required maxlength="59"')
    expect(markup).toContain('readonly')
    expect(markup).toContain('name="confirmReplace" value="yes" required')
    expect(markup).toContain('name="action" value="update"')
    expect(markup).toContain('Auto lineup')
    expect(markup).toContain('<span aria-current="page">Auto lineup</span>')
    expect(markup).toContain('What kind of channel are you building?')
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
    expect(markup).toContain('1 selected title')
    expect(markup).toContain('name="preset" value="custom" data-builder-preset="custom" checked')
    expect(markup).toContain('name="selectionMode" value="explicit"')
    expect(markup).toContain('name="collectionIds" value="4" checked')
  })

  test('renders strict network-era choices, visual dayparts, and editable owned-title checks', () => {
    const currentYear = new Date().getFullYear()
    const catalog = {
      collections: [
        {
          id: 1,
          rootId: 'tv',
          identityKey: 'dexters-laboratory',
          collectionTitle: "Dexter's Laboratory",
          displayTitle: "Dexter's Laboratory",
          libraryKind: 'tv',
          genres: ['Animation'],
          networks: ['Cartoon Network'],
          studios: [],
          firstAirYear: 1996,
          eligibleFiles: 12,
        },
        {
          id: 2,
          rootId: 'tv',
          identityKey: 'samurai-jack',
          collectionTitle: 'Samurai Jack',
          displayTitle: 'Samurai Jack',
          libraryKind: 'tv',
          genres: ['Animation'],
          networks: ['Cartoon Network'],
          studios: [],
          firstAirYear: 2001,
          eligibleFiles: 8,
        },
        {
          id: 3,
          rootId: 'tv',
          identityKey: 'bluey',
          collectionTitle: 'Bluey',
          displayTitle: 'Bluey',
          libraryKind: 'tv',
          genres: ['Family'],
          networks: ['ABC Kids'],
          studios: [],
          firstAirYear: 2018,
          eligibleFiles: 10,
        },
        {
          id: 4,
          rootId: 'tv',
          identityKey: 'current-cn-show',
          collectionTitle: 'Current CN Show',
          displayTitle: 'Current CN Show',
          libraryKind: 'tv',
          genres: ['Animation'],
          networks: ['Cartoon Network'],
          studios: [],
          firstAirYear: 2020,
          eligibleFiles: 4,
        },
      ],
      genres: [],
      networks: [],
      studios: [],
      presets: [],
      networkProfiles: [
        {
          id: 'cartoon-network',
          name: 'Cartoon Network',
          description: 'Comedy, action, and primetime from one documented network.',
          audience: 'school-age',
          availableStartYear: 1997,
          availableEndYear: currentYear,
          defaultStartYear: 1999,
          defaultEndYear: 2004,
          blocks: [
            { id: 'morning', name: 'Morning', start: '06:00', end: '09:00' },
            { id: 'primetime', name: 'Primetime', start: '19:00', end: '22:00' },
          ],
          matches: [
            {
              collectionId: 1,
              title: "Dexter's Laboratory",
              libraryKind: 'tv',
              firstAirYear: 1996,
              airStartYear: 1997,
              airEndYear: 2003,
              blockIds: ['morning'],
              playbackOrder: 'random',
              score: 100,
              eligibilityReason: 'documented-network-lineup',
            },
            {
              collectionId: 2,
              title: 'Samurai Jack',
              libraryKind: 'tv',
              firstAirYear: 2001,
              airStartYear: 2001,
              airEndYear: 2008,
              blockIds: ['primetime'],
              playbackOrder: 'season-sequential',
              score: 95,
              eligibilityReason: 'curated-network-lineup',
            },
            {
              collectionId: 4,
              title: 'Current CN Show',
              libraryKind: 'tv',
              firstAirYear: 2020,
              airStartYear: 2020,
              airEndYear: currentYear,
              blockIds: ['primetime'],
              playbackOrder: 'random',
              score: 90,
              eligibilityReason: 'exact-network-metadata',
            },
          ],
          missingSuggestions: [
            {
              title: 'Legacy Network Cartoon',
              libraryKind: 'tv',
              firstYear: 1980,
              lastYear: 1982,
              airStartYear: 1999,
              airEndYear: 2002,
              tags: ['comedy'],
            },
            {
              title: 'Later Network Acquisition',
              libraryKind: 'tv',
              firstYear: 2001,
              lastYear: 2004,
              airStartYear: 2010,
              airEndYear: 2012,
              tags: ['action'],
            },
          ],
          matchedShows: 3,
          matchedMovies: 0,
          movieCadence: 'weekly',
          marathonCadence: 'monthly',
        },
      ],
      familyMixSuggestions: [
        { title: 'Bluey', firstYear: 2018, tags: ['family'], available: true },
      ],
      truncated: false,
    } as const
    const snapshot = {
      channels: [
        {
          id: 'cn-mix',
          name: 'Cartoon Mix',
          enabled: true,
          timezone: 'UTC',
          slots: [],
        },
      ],
      manuallyOffAir: [],
      programmingGroups: [],
      configurationError: null,
    }
    const markup = renderChannelAdministration(snapshot, {
      automationOpen: true,
      automationTargetId: 'cn-mix',
      automationDraft: {
        id: 'cn-mix',
        name: 'Cartoon Mix',
        timezone: 'UTC',
        preset: 'network-copy',
        networkId: 'cartoon-network',
        eraStartYear: 1999,
        eraEndYear: 2004,
        collectionIds: [1],
        unavailableCollectionRefs: [
          {
            rootId: 'tv',
            libraryKind: 'tv',
            identityKey: 'temporarily-offline-show',
          },
        ],
      },
      automation: catalog,
    })
    const networkStart = markup.indexOf('data-network-panel="cartoon-network"')
    const networkEnd = markup.indexOf('</fieldset>', networkStart)
    const networkPanel = markup.slice(networkStart, networkEnd)
    const samuraiTitle = networkPanel.indexOf('<strong>Samurai Jack</strong>')
    const samuraiStart = networkPanel.lastIndexOf('<label', samuraiTitle)
    const samuraiEnd = networkPanel.indexOf('</label>', samuraiTitle)
    const samuraiRow = networkPanel.slice(samuraiStart, samuraiEnd)
    const currentTitle = networkPanel.indexOf('<strong>Current CN Show</strong>')
    const currentStart = networkPanel.lastIndexOf('<label', currentTitle)
    const currentEnd = networkPanel.indexOf('</label>', currentTitle)
    const currentRow = networkPanel.slice(currentStart, currentEnd)
    const legacyTitle = networkPanel.indexOf('<strong>Legacy Network Cartoon</strong>')
    const legacyStart = networkPanel.lastIndexOf('<article', legacyTitle)
    const legacyEnd = networkPanel.indexOf('</article>', legacyTitle)
    const legacySuggestion = networkPanel.slice(legacyStart, legacyEnd)
    const laterTitle = networkPanel.indexOf('<strong>Later Network Acquisition</strong>')
    const laterStart = networkPanel.lastIndexOf('<article', laterTitle)
    const laterEnd = networkPanel.indexOf('</article>', laterTitle)
    const laterSuggestion = networkPanel.slice(laterStart, laterEnd)

    expect(markup).toContain('name="builderMode" value="network" data-builder-mode checked')
    expect(markup).toContain('name="preset" value="network-copy" data-builder-preset="network" checked')
    expect(markup).toContain('name="networkId"')
    expect(markup).toContain('name="eraStartYear"')
    expect(markup).toContain('name="eraEndYear"')
    expect(markup).toContain(`${currentYear} (Current)`)
    expect(markup).toContain(
      'name="selectionMode" value="explicit" data-lineup-mode checked'
    )
    expect(markup).toContain('1 saved title currently unavailable')
    expect(markup).toContain('<code>temporarily-offline-show</code>')
    expect(markup).toContain(
      'same network, era, and hand-picked mode'
    )
    expect(markup).toContain('Period-inspired personal channel—not an official feed.')
    expect(markup).toContain('Cross-network and family-mix guest titles are not added.')
    expect(markup).toContain('data-handoff-panel')
    expect(markup).toContain('Cartoon Network sign-off')
    expect(markup).toContain('Parent locked')
    expect(markup).toContain('No adult programmes are selected or played')
    expect(markup).toContain('name="handoffStart" value="21:00" min="17:00" max="23:59"')
    expect(markup).toContain('name="handoffEnd" value="06:00" min="00:00" max="10:00"')
    expect(networkPanel).toContain('Eligible titles you own')
    expect(networkPanel).toContain('name="collectionIds" value="1" checked')
    expect(samuraiRow).not.toContain('checked')
    expect(networkPanel).toContain('data-air-start-year="2020"')
    expect(networkPanel).toContain('data-air-end-year="' + currentYear + '"')
    expect(currentRow).toContain('hidden')
    expect(currentRow).toContain('disabled')
    expect(networkPanel).toContain('Documented network lineup')
    expect(networkPanel).toContain('Exact network metadata')
    expect(networkPanel).toContain('Curated network lineup')
    expect(networkPanel).not.toContain('Bluey')
    expect(networkPanel).not.toContain('Modern family guests')
    expect(networkPanel).toContain('Network acquisition suggestions')
    expect(legacySuggestion).not.toContain('hidden')
    expect(legacySuggestion).toContain('carried 1999–2002 · produced 1980–1982')
    expect(laterSuggestion).toContain('hidden')
    expect(networkPanel).toContain('ToastTV never downloads, streams, or links to media')
    expect(networkPanel).toContain('Dayparts and week at a glance')
    expect(networkPanel).toContain('role="table"')
    expect(networkPanel).toContain('06:00–09:00')

    const freshMarkup = renderChannelAdministration(
      { ...snapshot, channels: [] },
      {
        automationOpen: true,
        automationDraft: {
          id: 'new-cn',
          name: 'New CN',
          timezone: 'UTC',
          preset: 'network-copy',
          networkId: 'cartoon-network',
          eraStartYear: 1999,
          eraEndYear: 2004,
        },
        automation: catalog,
      }
    )
    expect(freshMarkup).toContain('name="collectionIds" value="1" checked')
    expect(freshMarkup).toContain('name="collectionIds" value="2" checked')

    const automaticMarkup = renderChannelAdministration(snapshot, {
      automationOpen: true,
      automationTargetId: 'cn-mix',
      automationDraft: {
        id: 'cn-mix',
        name: 'Cartoon Mix',
        timezone: 'UTC',
        preset: 'network-copy',
        networkId: 'cartoon-network',
        eraStartYear: 1999,
        eraEndYear: 2004,
        selectionMode: 'automatic',
        handoff: {
          identity: 'adult-swim',
          mode: 'locked-off-air',
          start: '21:00',
          end: '06:00',
        },
      },
      automation: catalog,
    })
    const automaticModeStart = automaticMarkup.indexOf(
      '<fieldset class="channel-lineup-mode">'
    )
    const automaticModeEnd = automaticMarkup.indexOf(
      '</fieldset>',
      automaticModeStart
    )
    const automaticMode = automaticMarkup.slice(
      automaticModeStart,
      automaticModeEnd
    )
    const automaticPanelStart = automaticMarkup.indexOf(
      'data-network-panel="cartoon-network"'
    )
    const automaticPanelEnd = automaticMarkup.indexOf(
      '</fieldset>',
      automaticPanelStart
    )
    const automaticPanel = automaticMarkup.slice(
      automaticPanelStart,
      automaticPanelEnd
    )
    expect(automaticMode).toContain(
      'name="selectionMode" value="automatic" data-lineup-mode checked'
    )
    expect(automaticMode).toContain('Follow eligible lineup automatically')
    expect(automaticMode).toContain(
      'recalculates this strict lineup during library refreshes'
    )
    expect(automaticMarkup).toContain('Automatic lineup loaded:')
    expect(automaticPanel).toContain('data-selection-mode="automatic"')
    expect(automaticPanel).toContain(
      'name="collectionIds" value="1" checked disabled'
    )
    expect(automaticPanel).toContain('data-select-visible data-explicit-action hidden disabled')
    expect(automaticMarkup).toContain(
      'name="handoffEnabled" value="true" data-handoff-toggle checked'
    )
    expect(automaticMarkup).toContain(
      'name="handoffStart" value="21:00"'
    )
    expect(automaticMarkup).toContain(
      'name="handoffEnd" value="06:00"'
    )

    const emptyExplicitMarkup = renderChannelAdministration(snapshot, {
      automationOpen: true,
      automationTargetId: 'cn-mix',
      automationDraft: {
        id: 'cn-mix',
        name: 'Cartoon Mix',
        timezone: 'UTC',
        preset: 'network-copy',
        networkId: 'cartoon-network',
        eraStartYear: 1999,
        eraEndYear: 2004,
        selectionMode: 'explicit',
        collectionIds: [],
      },
      automation: catalog,
      error: 'Choose at least one show for this copied network',
    })
    expect(emptyExplicitMarkup).toContain(
      'role="alert">Choose at least one show for this copied network'
    )
    expect(emptyExplicitMarkup).toContain(
      'Choose at least one title. An empty hand-picked lineup cannot be saved.'
    )
    expect(emptyExplicitMarkup).not.toContain(
      'name="collectionIds" value="1" checked'
    )
  })
})
