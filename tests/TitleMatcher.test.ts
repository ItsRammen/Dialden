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

  test('matches a unique exact title with a one-year regional release drift', () => {
    const result = matchMetadata(parseCollectionTitle('A Close Shave (1995)'), [
      candidate('1', 'A Close Shave', 1996),
      candidate('2', 'The Digital Special Effects in "A Close Shave"', 1995),
    ])

    expect(result.status).toBe('matched')
    expect(result.candidate?.externalId).toBe('1')
    expect(result.confidence).toBe(0.98)
  })

  test('prefers an exact-year title over an adjacent-year title', () => {
    const result = matchMetadata(parseCollectionTitle('Shared Title (2020)'), [
      candidate('1', 'Shared Title', 2020),
      candidate('2', 'Shared Title', 2021),
    ])

    expect(result.status).toBe('matched')
    expect(result.candidate?.externalId).toBe('1')
  })

  test('requires review when adjacent-year exact titles are not unique', () => {
    const result = matchMetadata(parseCollectionTitle('Shared Title (2020)'), [
      candidate('1', 'Shared Title', 2019),
      candidate('2', 'Shared Title', 2021),
    ])

    expect(result.status).toBe('ambiguous')
    expect(result.candidate).toBeNull()
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

describe('number words and digits', () => {
  test('folds a spelled-out number to its digit', () => {
    // The case from the library: 45% match confidence on an obvious pair.
    expect(normalizeTitle('A Tale of Mari & 3 Puppies')).toBe(
      normalizeTitle('A Tale of Mari and Three Puppies')
    )
  })

  test('handles the common stylisations', () => {
    expect(normalizeTitle("Ocean's Eleven")).toBe(normalizeTitle("Ocean's 11"))
    expect(normalizeTitle('Toy Story 3')).toBe(normalizeTitle('Toy Story Three'))
    expect(normalizeTitle('The Magnificent Seven')).toBe(
      normalizeTitle('The Magnificent 7')
    )
  })

  test('leaves ordinals alone', () => {
    /* Folding "sixth" to "6" would break this pair, because "6th" survives
       punctuation stripping intact and could never fold back to meet it. */
    expect(normalizeTitle('The Sixth Sense')).not.toBe(
      normalizeTitle('The 6th Sense')
    )
    expect(normalizeTitle('The Sixth Sense')).toBe(
      normalizeTitle('the sixth sense')
    )
  })

  test('only folds whole words', () => {
    expect(normalizeTitle('Onegin')).toBe('onegin')
    expect(normalizeTitle('Tennessee')).toBe('tennessee')
    expect(normalizeTitle('Threesome')).toBe('threesome')
  })

  test('lifts an obvious pair over the plausibility floor', () => {
    const parsed = parseCollectionTitle('A Tale of Mari & 3 Puppies (2007)')
    const result = matchMetadata(parsed, [
      candidate('111', 'A Tale of Mari and Three Puppies', 2019),
    ])

    // A twelve-year gap still needs a person or the assistant to confirm,
    // but it is no longer reported as having no reliable match at all.
    expect(result.status).toBe('ambiguous')
    expect(result.candidates[0]?.score ?? 0).toBeGreaterThan(0.45)
  })

  test('matches outright once the year agrees', () => {
    const parsed = parseCollectionTitle('A Tale of Mari & 3 Puppies (2007)')
    const result = matchMetadata(parsed, [
      candidate('111', 'A Tale of Mari and Three Puppies', 2007),
    ])

    expect(result.status).toBe('matched')
    expect(result.candidate?.externalId).toBe('111')
  })
})
