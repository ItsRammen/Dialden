import { expect, test } from 'bun:test'
import { programMetadata } from '../src/services/ProgramMetadata'
import type { MediaItem } from '../src/types'
const item = (fields: Partial<MediaItem>) => fields as MediaItem

test('uses labelled collection fallback, omits unresolved ratings and invalid dates', () => {
  expect(programMetadata(item({ libraryKind: 'tv', episodeOverview: '  ', collectionOverview: ' A show. ', collectionCertification: 'PG', collectionRatingStatus: 'conflict', episodeAirDate: 'unknown' })))
    .toEqual({ overview: 'A show.', overviewScope: 'show' })
  expect(programMetadata(item({ libraryKind: 'movie', collectionOverview: 'Movie.', episodeOverview: 'Stale episode' })))
    .toEqual({ overview: 'Movie.', overviewScope: 'movie' })
})
test('does not expose file paths, invent metadata or expose station asset descriptions', () => {
  expect(programMetadata(item({ filename: 'private.mkv', path: '/private/file.mkv' }))).toEqual({})
  expect(programMetadata(item({ isInterlude: true, episodeOverview: 'Private asset' }))).toBeUndefined()
  expect(programMetadata(item({ collectionOverview: 'x'.repeat(2000) }))?.overview?.length).toBe(1200)
})
