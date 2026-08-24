import { describe, expect, test } from 'bun:test'
import {
  analyzeEraStationTemplate,
  ERA_STATION_TEMPLATES,
  getEraStationTemplate,
  validateEraStationTemplates,
  type EraStationLibraryCollection,
} from '../src/services/EraStationTemplateService'

function collection(
  id: number,
  displayTitle: string,
  overrides: Partial<EraStationLibraryCollection> = {}
): EraStationLibraryCollection {
  return {
    id,
    displayTitle,
    libraryKind: 'tv',
    genres: ['Animation'],
    networks: [],
    studios: [],
    firstAirYear: null,
    ...overrides,
  }
}

describe('era station templates', () => {
  test('ships valid, unique recipes with complete non-overlapping day blocks', () => {
    expect(() => validateEraStationTemplates(ERA_STATION_TEMPLATES)).not.toThrow()
    expect(new Set(ERA_STATION_TEMPLATES.map((value) => value.id)).size).toBe(
      ERA_STATION_TEMPLATES.length
    )
    for (const value of ERA_STATION_TEMPLATES) {
      expect(value.interstitials).toEqual({
        enabled: false,
        bumpers: false,
        promos: false,
        commercials: false,
        stationIds: false,
      })
      expect(value.moviePolicy.note.length).toBeGreaterThan(0)
      expect(value.marathonDefaults.note.length).toBeGreaterThan(0)
      const totalMinutes = value.blocks.reduce((total, block) => {
        const [startHour = 0, startMinute = 0] = block.start.split(':').map(Number)
        const [endHour = 0, endMinute = 0] = block.end.split(':').map(Number)
        return total + endHour * 60 + endMinute - (startHour * 60 + startMinute)
      }, 0)
      expect(totalMinutes).toBe(24 * 60)
    }
  })

  test('matches curated aliases and removes owned titles from obtain suggestions', () => {
    const analysis = analyzeEraStationTemplate('nick-jr-1999-2012', [
      collection(1, 'Blues Clues', {
        networks: ['Nickelodeon'],
        firstAirYear: 1996,
      }),
      collection(2, 'SpongeBob SquarePants', {
        networks: ['Nickelodeon'],
        firstAirYear: 1999,
      }),
    ])

    expect(analysis.matches.map((match) => match.collection.displayTitle)).toEqual([
      'Blues Clues',
    ])
    expect(analysis.matches[0]).toMatchObject({
      reasons: expect.arrayContaining(['curated-title', 'near-era']),
      playbackOrder: 'sequential',
      blockIds: ['morning', 'daytime'],
    })
    expect(
      analysis.missingSuggestions.map((suggestion) => suggestion.title)
    ).not.toContain("Blue's Clues")
    expect(analysis.matchedShows).toBe(1)
  })

  test('keeps known Nick Jr. programmes out of a general Nickelodeon provider match', () => {
    const analysis = analyzeEraStationTemplate('nickelodeon-1994-2004', [
      collection(1, "Blue's Clues", {
        networks: ['Nickelodeon'],
        firstAirYear: 1996,
      }),
      collection(2, 'SpongeBob SquarePants', {
        networks: ['Nickelodeon'],
        firstAirYear: 1999,
      }),
      collection(3, 'Unknown Nicktoon', {
        networks: ['Nickelodeon'],
        firstAirYear: 2001,
      }),
    ])

    expect(analysis.matches.map((match) => match.collection.displayTitle)).toEqual([
      'SpongeBob SquarePants',
      'Unknown Nicktoon',
    ])
  })

  test('uses era as a soft score while retaining curated long-running shows', () => {
    const analysis = analyzeEraStationTemplate('nickelodeon-2005-2012', [
      collection(1, 'SpongeBob SquarePants', {
        firstAirYear: 1999,
      }),
      collection(2, 'Unrelated Modern Show', {
        networks: ['Nickelodeon'],
        firstAirYear: 2024,
      }),
      collection(3, 'Provider Show', {
        networks: ['Nickelodeon'],
        firstAirYear: 2009,
      }),
    ])

    expect(analysis.matches.map((match) => match.collection.displayTitle)).toEqual([
      'SpongeBob SquarePants',
      'Provider Show',
    ])
    expect(analysis.matches[0]?.reasons).toContain('curated-title')
    expect(analysis.matches[1]?.reasons).toContain('era')
  })

  test('uses historical scheduling with modern family favourites by default', () => {
    const library = [
      collection(1, 'Bluey', {
        networks: ['ABC Kids'],
        firstAirYear: 2018,
      }),
    ]

    const familyMix = analyzeEraStationTemplate(
      'cartoon-network-1997-2004',
      library
    )
    const historical = analyzeEraStationTemplate(
      'cartoon-network-1997-2004',
      library,
      'historical'
    )

    expect(familyMix.matches[0]).toMatchObject({
      collection: { displayTitle: 'Bluey' },
      reasons: expect.arrayContaining(['family-guest']),
      blockIds: expect.arrayContaining(['morning', 'daytime']),
    })
    expect(historical.matches).toHaveLength(0)
  })

  test('distinguishes matched movies and suggests missing movie-night content', () => {
    const analysis = analyzeEraStationTemplate('disney-channel-1998-2007', [
      collection(1, 'High School Musical', {
        libraryKind: 'movie',
        genres: ['Family', 'Music'],
        firstAirYear: 2006,
      }),
      collection(2, 'Kim Possible', {
        networks: ['Disney Channel'],
        firstAirYear: 2002,
      }),
    ])

    expect(analysis.matchedMovies).toBe(1)
    expect(analysis.matchedShows).toBe(1)
    expect(
      analysis.matches.find((match) => match.collection.id === 1)
    ).toMatchObject({
      reasons: expect.arrayContaining(['curated-title', 'movie']),
      blockIds: ['primetime'],
    })
    expect(
      analysis.missingSuggestions.map((suggestion) => suggestion.title)
    ).toContain('Halloweentown')
  })

  test('rejects duplicate IDs, overlapping blocks, and unknown suggestion blocks', () => {
    const base = getEraStationTemplate('toonami-1997-2008')
    expect(() => validateEraStationTemplates([base, base])).toThrow(
      'Duplicate era template ID'
    )
    expect(() =>
      validateEraStationTemplates([
        {
          ...base,
          blocks: [
            ...base.blocks,
            {
              ...base.blocks[0]!,
              id: 'overlap',
              start: '05:00',
              end: '07:00',
            },
          ],
        },
      ])
    ).toThrow('overlapping blocks')
    expect(() =>
      validateEraStationTemplates([
        {
          ...base,
          suggestions: [
            { ...base.suggestions[0]!, blockIds: ['missing-block'] },
          ],
        },
      ])
    ).toThrow('unknown block')
  })
})
