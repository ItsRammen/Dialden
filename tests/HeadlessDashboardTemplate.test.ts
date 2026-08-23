import { describe, expect, test } from 'bun:test'
import { renderHeadlessDashboardContent } from '../src/templates/headlessDashboard'
import type { HeadlessDashboardViewModel } from '../src/templates/headlessDashboard'

function dashboard(
  overrides: Partial<HeadlessDashboardViewModel> = {}
): HeadlessDashboardViewModel {
  return {
    server: {
      status: 'online',
      version: '1.0.0',
      uptimeLabel: '2 hours',
    },
    channels: [
      {
        id: 'kids',
        name: 'Kids Club',
        status: 'on_air',
        timezone: 'Asia/Taipei',
        now: {
          title: 'Magic Xylophone',
          collectionTitle: 'Bluey',
          episodeLabel: 'S01E01',
          timeRange: '18:32–18:39',
        },
        next: {
          title: 'Hospital',
          collectionTitle: 'Bluey',
          episodeLabel: 'S01E02',
          timeRange: '18:39–18:46',
        },
        guideHref: '/channels/kids/guide',
      },
    ],
    library: {
      tvCollections: 83,
      episodes: 3821,
      movieCollections: 612,
      interludes: 32,
      approvedCollections: 92,
      reviewCollections: 14,
      blockedCollections: 67,
    },
    scan: {
      status: 'scanning',
      discoveredFiles: 4821,
      processedFiles: 2380,
      indexedFiles: 2378,
      failedFiles: 2,
      currentLocationLabel: 'Bluey/Season 2/S02E14.mkv',
      lastScanLabel: '18 minutes ago',
    },
    metadata: {
      providerName: 'TMDB',
      status: 'connected',
      preferredRegion: 'US',
      matchedCollections: 681,
      pendingCollections: 7,
      reviewCollections: 3,
    },
    warnings: [
      {
        severity: 'warning',
        message: '14 collections need approval',
        href: '/library/review',
        actionLabel: 'Review',
      },
    ],
    ...overrides,
  }
}

describe('headless dashboard template', () => {
  test('renders truthful operational state without inherited device controls or invented metrics', () => {
    const markup = renderHeadlessDashboardContent(dashboard())

    expect(markup).toContain('Server online')
    expect(markup).toContain('Now and next')
    expect(markup).toContain('Magic Xylophone')
    expect(markup).toContain('Hospital')
    expect(markup).toContain('Needs review')
    expect(markup).toContain('Library scan')
    expect(markup).toContain('aria-label="Library scan progress"')
    expect(markup).toContain('value="2380" max="4821"')
    expect(markup).toContain('TMDB')
    expect(markup).toContain('aria-live="polite"')

    expect(markup).not.toMatch(/power\s*(?:on|off)/i)
    expect(markup).not.toMatch(/\bCEC\b/i)
    expect(markup).not.toMatch(/\bMPV\b/i)
    expect(markup).not.toMatch(/local playback/i)
    expect(markup).not.toMatch(/viewers?/i)
    expect(markup).not.toMatch(/generated through/i)
    expect(markup).not.toMatch(/on(?:click|change|submit)=/i)
    expect(markup).not.toContain('<script')
  })

  test('escapes every displayed value and rejects unsafe navigation targets', () => {
    const hostile = '<img src=x onerror=alert(1)>'
    const view = dashboard({
      server: { status: 'degraded', statusMessage: hostile },
      channels: [
        {
          id: 'bad',
          name: hostile,
          status: 'unavailable',
          now: {
            title: hostile,
            timeRange: hostile,
          },
          next: null,
          guideHref: 'javascript:alert(1)',
        },
      ],
      metadata: {
        providerName: hostile,
        status: 'degraded',
        matchedCollections: 0,
        pendingCollections: 1,
        reviewCollections: 1,
        statusMessage: hostile,
      },
      warnings: [
        {
          severity: 'critical',
          message: hostile,
          href: '//evil.example/path',
        },
      ],
    })

    const markup = renderHeadlessDashboardContent(view)
    expect(markup).not.toContain(hostile)
    expect(markup).not.toContain('javascript:')
    expect(markup).not.toContain('//evil.example')
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  test('does not present go-on-air as a fix for an empty schedule', () => {
    const markup = renderHeadlessDashboardContent(
      dashboard({
        channels: [
          {
            id: 'empty',
            name: 'Empty Channel',
            status: 'no_program',
            now: null,
            next: null,
            guideHref: '/api/v1/channels/empty/guide',
            manageHref: '/channels?edit=empty#editor',
          },
        ],
      })
    )

    expect(markup).toContain('No programming')
    expect(markup).toContain('Configure')
    expect(markup).not.toContain('Go on air')
    expect(markup).not.toContain('Resume schedule')
  })
})
