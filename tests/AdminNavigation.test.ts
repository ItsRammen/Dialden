import { describe, expect, test } from 'bun:test'
import { renderLayout, renderLibraryNavigation, renderSettingsNavigation, type LibrarySection } from '../src/templates/layout'
import { renderMetadataSettings } from '../src/templates/metadataSettings'

describe('admin navigation', () => {
  test('identifies exactly one active destination across every library page', () => {
    const pages: [LibrarySection, string][] = [
      ['summary', '/library'], ['tv', '/library/tv'], ['movies', '/library/movies'],
      ['bumpers', '/library/bumpers'], ['interludes', '/library/interludes'],
      ['review', '/library/review'], ['files', '/library/files'],
    ]
    for (const [section, path] of pages) {
      const html = renderLibraryNavigation(section)
      expect(html.match(/aria-current="page"/g)).toHaveLength(1)
      expect(html).toContain(`href="${path}" aria-current="page"`)
    }
  })

  test('connects both settings pages with an explicit current page', () => {
    expect(renderSettingsNavigation('server')).toContain('href="/settings" aria-current="page"')
    expect(renderSettingsNavigation('metadata')).toContain('href="/settings/metadata" aria-current="page"')
  })

  test('escapes page titles and allows navigation independent of their wording', () => {
    const html = renderLayout('<Review>', '', { activeSection: 'library' })
    expect(html).toContain('<title>&lt;Review&gt; · Dialden Admin</title>')
    expect(html).toContain('href="/library" aria-current="page"')
  })

  test('returns to maintenance after starting a maintenance operation', () => {
    const html = renderMetadataSettings({ provider: 'tmdb', configured: true, language: 'en-US', preferredRatingRegion: 'US', fallbackRatingRegions: [], requestTimeoutMs: 10000 }, {
      status: 'idle', providerHealth: 'unverified', providerMessage: null, total: 0, processed: 0, matched: 0, needsReview: 0, failed: 0, currentCollectionId: null, startedAt: null, completedAt: null, error: null,
    }, { maintenanceStarted: 'policy' })
    expect(html).toContain('id="tab-maintenance" role="tab" aria-controls="tabpanel-maintenance" aria-selected="true"')
    expect(html).toContain('id="tab-provider" role="tab" aria-controls="tabpanel-provider" aria-selected="false"')
  })
})
