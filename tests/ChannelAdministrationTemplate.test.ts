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
    expect(modalMarkup).toContain('Create an automatic station')
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
    expect(markup).toContain('Edit lineup')
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
})
