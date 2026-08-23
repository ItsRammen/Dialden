import { describe, expect, test } from 'bun:test'
import {
  renderCollectionDetail,
  renderCollectionLibraryContent,
  renderCollectionReview,
} from '../src/templates/collectionLibrary'
import type {
  CollectionCardViewModel,
  CollectionLibraryViewModel,
} from '../src/templates/collectionLibrary'

function collection(
  overrides: Partial<CollectionCardViewModel> = {}
): CollectionCardViewModel {
  return {
    id: 42,
    href: '/library/collections/42',
    title: 'Bluey',
    year: 2018,
    kind: 'tv',
    posterUrl: '/artwork/collections/42/poster.webp',
    seasonCount: 3,
    episodeCount: 154,
    fileCount: 154,
    metadata: {
      status: 'matched',
      providerName: 'TMDB',
      matchedTitle: 'Bluey',
      externalId: 82728,
      certification: 'TV-Y',
      certificationRegion: 'US',
      reason: 'High-confidence title and year match.',
    },
    decision: {
      policyDecision: 'allow',
      policyReason: 'TV-Y is allowed by the Kids 7 policy.',
      parentOverride: null,
      effectiveDecision: 'allow',
      effectiveReason: 'Automatically approved by Kids 7 policy.',
    },
    technical: {
      status: 'available',
      reason: 'The library root is online and all indexed files are ready.',
      availableFiles: 154,
      totalFiles: 154,
      failedFiles: 0,
    },
    actions: {
      approveAction: '/api/admin/v1/library/collections/42/approve',
      blockAction: '/api/admin/v1/library/collections/42/block',
      resetAction: '/api/admin/v1/library/collections/42/reset-policy',
      changeMatchHref: '/library/collections/42/metadata',
      csrfToken: 'token-42',
    },
    ...overrides,
  }
}

function library(
  overrides: Partial<CollectionLibraryViewModel> = {}
): CollectionLibraryViewModel {
  return {
    activeView: 'tv',
    summary: {
      tvCollections: 83,
      tvEpisodes: 3821,
      movieCollections: 612,
      interludes: 32,
      reviewCollections: 14,
    },
    heading: 'TV shows',
    collections: [collection()],
    ...overrides,
  }
}

describe('collection library template', () => {
  test('renders collection-first summary, explicit decision states, actions, and Advanced files link', () => {
    const markup = renderCollectionLibraryContent(library())

    expect(markup).toContain('83')
    expect(markup).toContain('3,821 episodes')
    expect(markup).toContain('612')
    expect(markup).toContain('Needs review')
    expect(markup).toContain('Bluey')
    expect(markup).toContain('3 seasons')
    expect(markup).toContain('154 episodes')
    expect(markup).toContain('Status</dt><dd>Matched')
    expect(markup).toContain('Certification</dt><dd>TV-Y (US)')
    expect(markup).toContain('Policy result</dt><dd>Allow')
    expect(markup).toContain('Parent override</dt><dd>None — using policy')
    expect(markup).toContain('Effective decision</dt><dd><strong>Allow')
    expect(markup).toContain('Technical availability')
    expect(markup).toContain('Parent approve')
    expect(markup).toContain('Parent block')
    expect(markup).toContain('Use policy')
    expect(markup).toContain('Change metadata match')
    expect(markup).toContain('href="/library/files">Advanced files</a>')
    expect(markup).not.toMatch(/on(?:click|change|submit)=/i)
    expect(markup).not.toContain('<script')
  })

  test('renders detail seasons and review queues without hiding uncertainty', () => {
    const uncertain = collection({
      title: 'The Office',
      metadata: {
        status: 'ambiguous',
        providerName: 'TMDB',
        certification: undefined,
        reason: 'Multiple likely matches require confirmation.',
      },
      decision: {
        policyDecision: 'review',
        policyReason: 'No reliable certification is available.',
        parentOverride: null,
        effectiveDecision: 'review',
        effectiveReason: 'This collection cannot be scheduled until reviewed.',
      },
      technical: {
        status: 'probe_pending',
        reason: 'Media details are still being scanned.',
        availableFiles: 0,
        totalFiles: 14,
      },
    })

    const detail = renderCollectionDetail({
      ...uncertain,
      overview: 'A workplace comedy.',
      genres: ['Comedy'],
      seasons: [
        { label: 'Season 1', episodeCount: 6, href: '/library/collections/42/seasons/1' },
        { label: 'Season 2', episodeCount: 22, href: '/library/collections/42/seasons/2' },
      ],
    })
    expect(detail).toContain('Ambiguous match')
    expect(detail).toContain('No rating available')
    expect(detail).toContain('Needs review')
    expect(detail).toContain('Media scan pending')
    expect(detail).toContain('Season 1')
    expect(detail).toContain('6 episodes')
    expect(detail).toContain('Advanced media details')

    const review = renderCollectionReview({
      totalCollections: 1,
      metadataCollections: 1,
      approvalCollections: 1,
      collections: [uncertain],
    })
    expect(review).toContain('Needs review (1)')
    expect(review).toContain('Approval 1')
    expect(review).toContain('Metadata 1')
    expect(review).toContain('Multiple likely matches require confirmation.')
  })

  test('explains legacy-root indexing instead of presenting an unexplained empty library', () => {
    const markup = renderCollectionLibraryContent(
      library({
        activeView: 'summary',
        summary: {
          tvCollections: 0,
          tvEpisodes: 0,
          movieCollections: 0,
          interludes: 0,
          reviewCollections: 0,
          totalFiles: 20_976,
        },
        collections: [],
      })
    )

    expect(markup).toContain('20,976 files were indexed')
    expect(markup).toContain('TOASTTV_TV_MEDIA')
    expect(markup).toContain('TOASTTV_MOVIE_MEDIA')
    expect(markup).toContain('/media/tv')
    expect(markup).toContain('/media/movies')
  })

  test('escapes provider and filesystem-derived values and drops unsafe URLs', () => {
    const hostile = '<svg onload=alert(1)>'
    const markup = renderCollectionLibraryContent(
      library({
        heading: hostile,
        description: hostile,
        collections: [
          collection({
            title: hostile,
            href: 'javascript:alert(1)',
            posterUrl: '//evil.example/poster.jpg',
            metadata: {
              status: 'error',
              providerName: hostile,
              matchedTitle: hostile,
              certification: hostile,
              reason: hostile,
            },
            decision: {
              policyDecision: 'block',
              policyReason: hostile,
              parentOverride: 'block',
              effectiveDecision: 'block',
              effectiveReason: hostile,
            },
            technical: {
              status: 'probe_failed',
              reason: hostile,
              availableFiles: 0,
              totalFiles: 1,
              failedFiles: 1,
            },
            actions: {
              approveAction: 'javascript:alert(1)',
              changeMatchHref: '//evil.example/match',
              csrfToken: hostile,
            },
          }),
        ],
      })
    )

    expect(markup).not.toContain(hostile)
    expect(markup).not.toContain('javascript:')
    expect(markup).not.toContain('//evil.example')
    expect(markup).toContain('&lt;svg onload=alert(1)&gt;')
  })
})
