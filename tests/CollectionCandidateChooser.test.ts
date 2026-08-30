import { describe, expect, test } from 'bun:test'
import { renderCollectionDetail } from '../src/templates/collectionLibrary'

/** The real case: TMDB returns three "Aladdin" records all dated 1992. */
const aladdin = [
  {
    externalId: '812',
    title: 'Aladdin',
    year: 1992,
    confidence: 1,
    scoreLabel: 'Title and year match exactly',
    tiedWith: 2,
    overview:
      'Princess Jasmine grows tired of palace life, and an ancient lamp changes the fortunes of a street urchin named Aladdin.',
    posterUrl: 'https://image.tmdb.org/t/p/w92/aladdin-disney.jpg',
    referenceUrl: 'https://www.themoviedb.org/movie/812',
    confirmAction: '/library/collections/384/metadata-match',
  },
  {
    externalId: '357528',
    title: 'Aladdin',
    year: 1992,
    confidence: 1,
    scoreLabel: 'Title and year match exactly',
    tiedWith: 2,
    overview: 'An animated retelling produced for the direct-to-video market.',
    posterUrl: 'https://image.tmdb.org/t/p/w92/aladdin-other.jpg',
    referenceUrl: 'https://www.themoviedb.org/movie/357528',
    confirmAction: '/library/collections/384/metadata-match',
  },
  {
    externalId: '343693',
    title: 'Aladdin',
    year: 1992,
    confidence: 1,
    scoreLabel: 'Title and year match exactly',
    tiedWith: 2,
    confirmAction: '/library/collections/384/metadata-match',
  },
]

function detail(candidates: unknown[]): string {
  return renderCollectionDetail({
    id: 384,
    title: 'Aladdin',
    libraryKind: 'movie',
    year: 1992,
    fileCount: 1,
    backHref: '/library/movies',
    metadata: {
      status: 'ambiguous',
      provider: 'tmdb',
      certification: null,
      reason: 'More than one plausible title was found.',
    },
    decision: {
      policyDecision: 'review',
      parentOverride: null,
      effectiveDecision: 'review',
      policyReason: 'Metadata ambiguous',
      effectiveReason: 'Using the kids-7 policy result.',
    },
    technical: {
      status: 'available',
      reason: 'Files are technically ready.',
      availableFiles: 1,
      totalFiles: 1,
    },
    metadataCandidates: candidates,
  } as never)
}

describe('choosing between candidates that share a title and a year', () => {
  test('shows the id, so identical rows can be told apart at all', () => {
    const html = detail(aladdin)

    for (const id of ['812', '357528', '343693']) {
      expect(html).toContain(`TMDB ${id}`)
    }
  })

  test('shows the summary, which is what actually distinguishes them', () => {
    const html = detail(aladdin)

    expect(html).toContain('Princess Jasmine grows tired of palace life')
    expect(html).toContain('direct-to-video market')
  })

  test('links out so the record can be checked before confirming', () => {
    const html = detail(aladdin)

    expect(html).toContain('https://www.themoviedb.org/movie/812')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  test('shows the poster when there is one', () => {
    const html = detail(aladdin)

    expect(html).toContain('aladdin-disney.jpg')
    expect(html).toContain('collection-candidate-poster')
  })

  test('keeps the row intact when a candidate has no extra detail', () => {
    // The third candidate carries neither overview nor poster; it must still
    // render a confirmable row rather than collapsing the list.
    const html = detail(aladdin)

    expect(html).toContain('collection-candidate-poster--empty')
    expect(html.match(/name="externalId"/gu)?.length).toBe(3)
  })

  test('still confirms the right id', () => {
    const html = detail(aladdin)

    expect(html).toContain('value="812"')
    expect(html).toContain('/library/collections/384/metadata-match')
  })
})

describe('what the score is allowed to claim', () => {
  test('never calls a tied score a confidence in this record', () => {
    // Three different films each labelled "100% match confidence" reads as a
    // promise about each of them that the number was never making.
    const html = detail(aladdin)

    expect(html).not.toContain('match confidence')
    expect(html).toContain('Title and year match exactly')
  })

  test('says a candidate cannot be separated from the others', () => {
    const html = detail(aladdin)

    expect(html).toContain('ties with 2 others')
  })

  test('explains the number above the list', () => {
    const html = detail(aladdin)

    expect(html).toContain('not a judgement that a record is the right one')
  })
})
