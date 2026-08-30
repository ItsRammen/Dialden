import { describe, expect, test } from 'bun:test'
import { metadataReason } from '../src/controllers/CollectionLibraryPageController'
import type { MediaCollection, MetadataCandidateRecord } from '../src/types'

function candidate(
  overrides: Partial<MetadataCandidateRecord> = {}
): MetadataCandidateRecord {
  return {
    provider: 'tmdb',
    externalId: '1631',
    mediaType: 'movie',
    title: 'A Real Young Girl',
    originalTitle: 'Une vraie jeune fille',
    year: 2001,
    confidence: 0.55,
    ...overrides,
  }
}

function collection(overrides: Partial<MediaCollection> = {}): MediaCollection {
  return {
    parsedTitle: 'A Real Young Girl',
    year: 1976,
    metadataStatus: 'ambiguous',
    ratingStatus: 'missing',
    metadataCandidates: [],
    ...overrides,
  } as MediaCollection
}

describe('why a collection is still waiting', () => {
  test('says the years disagree when a single candidate is the reason', () => {
    // The real case: TMDB 1631 is shelved-then-released, so its primary year
    // is 2001 while the file says 1976. The page used to claim more than one
    // plausible title while showing exactly one.
    const reason = metadataReason(
      collection({ metadataCandidates: [candidate()] })
    )

    expect(reason).toContain('2001')
    expect(reason).toContain('1976')
    expect(reason).not.toContain('More than one')
  })

  test('still reports a genuine multi-candidate case as such', () => {
    const reason = metadataReason(
      collection({
        metadataCandidates: [
          candidate({ externalId: '1' }),
          candidate({ externalId: '2' }),
        ],
      })
    )

    expect(reason).toBe('More than one plausible title was found.')
  })

  test('does not blame the year when the years agree', () => {
    const reason = metadataReason(
      collection({ metadataCandidates: [candidate({ year: 1976 })] })
    )

    expect(reason).toContain('not confidently enough')
    expect(reason).not.toContain('1976')
  })

  test('copes with a candidate carrying no year at all', () => {
    const reason = metadataReason(
      collection({ metadataCandidates: [candidate({ year: undefined })] })
    )

    expect(reason).toContain('not confidently enough')
  })

  test('copes with a collection carrying no year', () => {
    const reason = metadataReason(
      collection({ year: null, metadataCandidates: [candidate()] })
    )

    expect(reason).toContain('not confidently enough')
  })

  test('leaves the other statuses alone', () => {
    expect(metadataReason(collection({ metadataStatus: 'unmatched' }))).toBe(
      'No reliable title match was found.'
    )
    expect(metadataReason(collection({ metadataStatus: 'pending' }))).toBe(
      'Waiting for background matching.'
    )
  })
})
