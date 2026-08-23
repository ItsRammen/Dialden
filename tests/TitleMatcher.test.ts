import { describe, expect, test } from 'bun:test'
import type { MetadataCandidate } from '../src/metadata/types'
import {
  matchMetadata,
  normalizeTitle,
  parseCollectionTitle,
} from '../src/services/metadata/TitleMatcher'

function candidate(
  externalId: string,
  title: string,
  year?: number,
  override: Partial<MetadataCandidate> = {}
): MetadataCandidate {
  return {
    provider: 'tmdb',
    externalId,
    mediaType: 'tv',
    title,
    year,
    ...override,
  }
}

describe('strict metadata title matching', () => {
  test('parses only a trailing parenthesized year', () => {
    expect(parseCollectionTitle('Bluey (2018)')).toEqual({
      title: 'Bluey',
      normalizedTitle: 'bluey',
      year: 2018,
    })
    expect(parseCollectionTitle('1923')).toEqual({
      title: '1923',
      normalizedTitle: '1923',
    })
  })

  test('can strip a flat movie extension before parsing', () => {
    expect(
      parseCollectionTitle('Soul (2020).mkv', { stripMediaExtension: true })
    ).toEqual({ title: 'Soul', normalizedTitle: 'soul', year: 2020 })
  })

  test('normalizes accents, punctuation, ampersands, and whitespace', () => {
    expect(normalizeTitle("  Pokémon: Let's Go & Learn! ")).toBe(
      'pokemon lets go and learn'
    )
  })

  test('automatically matches one exact title and exact year', () => {
    const result = matchMetadata(parseCollectionTitle('Bluey (2018)'), [
      candidate('1', 'Bluey', 2018),
      candidate('2', 'Bluey Minisodes', 2018),
    ])

    expect(result.status).toBe('matched')
    expect(result.candidate?.externalId).toBe('1')
    expect(result.confidence).toBe(1)
  })

  test('can match an exact original title', () => {
    const result = matchMetadata(parseCollectionTitle('Pokémon (1997)'), [
      candidate('1', 'Pocket Monsters', 1997, { originalTitle: 'Pokemon' }),
    ])

    expect(result.status).toBe('matched')
  })

  test('requires a unique exact result when collection year is absent', () => {
    const result = matchMetadata(parseCollectionTitle('The Office'), [
      candidate('1', 'The Office', 2001),
      candidate('2', 'The Office', 2005),
    ])

    expect(result.status).toBe('ambiguous')
    expect(result.candidate).toBeNull()
  })

  test('does not auto-match an exact title with the wrong year', () => {
    const result = matchMetadata(parseCollectionTitle('The Matrix (1999)'), [
      candidate('1', 'The Matrix', 2021),
    ])

    expect(result.status).toBe('ambiguous')
  })

  test('fuzzy similarity only creates review candidates', () => {
    const result = matchMetadata(parseCollectionTitle('Bluye (2018)'), [
      candidate('1', 'Bluey', 2018),
    ])

    expect(result.status).toBe('ambiguous')
    expect(result.candidate).toBeNull()
  })

  test('returns unmatched when no candidate is plausible', () => {
    const result = matchMetadata(parseCollectionTitle('Bluey (2018)'), [
      candidate('1', 'Completely Different', 1970),
    ])

    expect(result.status).toBe('unmatched')
  })

  test('deduplicates the same provider result before deciding uniqueness', () => {
    const duplicate = candidate('1', 'Bluey', 2018)
    const result = matchMetadata(parseCollectionTitle('Bluey (2018)'), [
      duplicate,
      duplicate,
    ])

    expect(result.status).toBe('matched')
    expect(result.candidates).toHaveLength(1)
  })
})
