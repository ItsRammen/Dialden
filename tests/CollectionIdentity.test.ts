import { describe, expect, test } from 'bun:test'
import {
  deriveCollectionIdentity,
  parseCollectionTitle,
} from '../src/domain/CollectionIdentity'

describe('CollectionIdentity', () => {
  test('groups Plex-style TV episodes and parses episode tokens', () => {
    const paths = [
      'Bluey (2018)/Season 01/Bluey - S01E01 - Magic Xylophone.mkv',
      'Bluey (2018)/Season 01/Bluey - S01E02 - Hospital.mkv',
      'Bluey (2018)/Season 02/Bluey - S02E01 - Dance Mode.mkv',
    ]
    const identities = paths.map((relativePath) =>
      deriveCollectionIdentity({ libraryKind: 'tv', relativePath })
    )

    expect(new Set(identities.map((item) => item?.identityKey)).size).toBe(1)
    expect(identities[0]).toEqual(
      expect.objectContaining({
        sourceTitle: 'Bluey (2018)',
        title: 'Bluey',
        year: 2018,
        seasonNumber: 1,
        episodeNumber: 1,
        episodeTitle: 'Magic Xylophone',
      })
    )
    expect(new Set(identities.map((item) => item?.seasonNumber))).toEqual(
      new Set([1, 2])
    )
  })

  test('uses a Season directory when the filename has no episode token', () => {
    expect(
      deriveCollectionIdentity({
        libraryKind: 'tv',
        relativePath: 'Bluey/Season 02/Keepy Uppy.mkv',
      })
    ).toEqual(
      expect.objectContaining({
        title: 'Bluey',
        seasonNumber: 2,
        episodeNumber: null,
      })
    )
  })

  test('supports foldered and flat movies', () => {
    const foldered = deriveCollectionIdentity({
      libraryKind: 'movie',
      relativePath: 'Soul (2020)/Soul (2020).mkv',
    })
    const flat = deriveCollectionIdentity({
      libraryKind: 'movie',
      relativePath: 'The Matrix (1999).mkv',
    })

    expect(foldered).toEqual(
      expect.objectContaining({ title: 'Soul', year: 2020 })
    )
    expect(flat).toEqual(
      expect.objectContaining({ title: 'The Matrix', year: 1999 })
    )
  })

  test('groups conventional flat TV filenames conservatively', () => {
    const first = deriveCollectionIdentity({
      libraryKind: 'tv',
      relativePath: 'Bluey (2018) - S01E01 - Magic Xylophone.mkv',
    })
    const second = deriveCollectionIdentity({
      libraryKind: 'tv',
      relativePath: 'Bluey (2018) - S02E03 - Featherwand.mkv',
    })

    expect(first?.identityKey).toBe(second?.identityKey)
    expect(first).toEqual(
      expect.objectContaining({ title: 'Bluey', year: 2018 })
    )
  })

  test('does not reinterpret the numeric title 1923 as a year', () => {
    expect(parseCollectionTitle('1923')).toEqual({ title: '1923', year: null })
    expect(
      deriveCollectionIdentity({
        libraryKind: 'tv',
        relativePath: '1923/Season 01/1923 - S01E01.mkv',
      })
    ).toEqual(expect.objectContaining({ title: '1923', year: null }))
  })

  test('rejects invalid relative paths instead of inventing a collection', () => {
    expect(
      deriveCollectionIdentity({
        libraryKind: 'movie',
        relativePath: '../Soul (2020).mkv',
      })
    ).toBeNull()
    expect(
      deriveCollectionIdentity({ libraryKind: 'movie', relativePath: '' })
    ).toBeNull()
  })
})
