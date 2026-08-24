import { describe, expect, test } from 'bun:test'
import {
  analyzeEraStationTemplate,
  analyzeNetworkCopyProfile,
  ERA_STATION_TEMPLATES,
  isStationNetworkId,
  NETWORK_COPY_PROFILES,
  getEraStationTemplate,
  getNetworkCopyProfile,
  validateEraStationTemplates,
  validateNetworkCopyProfiles,
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
    expect(() => validateNetworkCopyProfiles(NETWORK_COPY_PROFILES)).not.toThrow()
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

  test('keeps family guests out of network copies unless a general mix opts in', () => {
    const library = [
      collection(1, 'Bluey', {
        networks: ['ABC Kids'],
        firstAirYear: 2018,
      }),
    ]

    const historical = analyzeEraStationTemplate(
      'cartoon-network-1997-2004',
      library
    )
    const familyMix = analyzeEraStationTemplate(
      'cartoon-network-1997-2004',
      library,
      'family-mix'
    )

    expect(familyMix.matches[0]).toMatchObject({
      collection: { displayTitle: 'Bluey' },
      reasons: expect.arrayContaining(['family-guest']),
      blockIds: expect.arrayContaining(['morning', 'daytime']),
    })
    expect(historical.matches).toHaveLength(0)
  })

  test('strict Cartoon Network copies exclude titles affiliated with other networks', () => {
    const analysis = analyzeNetworkCopyProfile(
      'cartoon-network',
      [
        collection(1, "Dexter's Laboratory", {
          networks: ['Cartoon Network'],
          firstAirYear: 1996,
        }),
        collection(2, 'Bluey', {
          networks: ['ABC Kids'],
          studios: ['Cartoon Network Studios'],
          firstAirYear: 2018,
        }),
        collection(3, 'Kim Possible', {
          networks: ['Disney Channel'],
          firstAirYear: 2002,
        }),
        collection(4, 'My Little Pony: Friendship Is Magic', {
          networks: ['Discovery Family'],
          firstAirYear: 2010,
        }),
        collection(5, 'Craig of the Creek', {
          networks: ['Cartoon Network'],
          firstAirYear: 2018,
        }),
      ],
      { startYear: 1997, endYear: 2026 }
    )

    expect(analysis.matches.map((match) => match.collection.displayTitle)).toEqual(
      expect.arrayContaining(["Dexter's Laboratory", 'Craig of the Creek'])
    )
    expect(analysis.matches).toHaveLength(2)
    expect(
      analysis.missingSuggestions.map((suggestion) => suggestion.title)
    ).not.toEqual(
      expect.arrayContaining([
        'Bluey',
        'Kim Possible',
        'My Little Pony: Friendship Is Magic',
      ])
    )
  })

  test('uses affiliation windows and an explicit allow-list to narrow a network copy', () => {
    const library = [
      collection(1, 'SpongeBob SquarePants', {
        networks: ['Nickelodeon'],
        firstAirYear: 1999,
      }),
      collection(2, 'The Loud House', {
        networks: ['Nickelodeon'],
        firstAirYear: 2016,
      }),
      collection(3, 'PAW Patrol', {
        networks: ['Nick Jr.'],
        firstAirYear: 2013,
      }),
    ]
    const automatic = analyzeNetworkCopyProfile('nickelodeon', library, {
      startYear: 2016,
      endYear: 2020,
    })
    expect(automatic.matches.map((match) => match.collection.displayTitle)).toEqual([
      'SpongeBob SquarePants',
      'The Loud House',
    ])
    expect(automatic.matches[0]).toMatchObject({
      airStartYear: 1999,
      airEndYear: 2026,
      eligibilityReason: 'curated-network-lineup',
    })

    const explicit = analyzeNetworkCopyProfile('nickelodeon', library, {
      startYear: 2016,
      endYear: 2020,
      selectedCollectionIds: [2],
    })
    expect(explicit.matches.map((match) => match.collection.id)).toEqual([2])
  })

  test('uses network carriage years for documented acquisitions', () => {
    const pokemon = collection(1, 'Pokémon', {
      networks: ['TV Tokyo'],
      firstAirYear: 1997,
    })
    const duringCarriage = analyzeNetworkCopyProfile(
      'cartoon-network',
      [pokemon],
      { startYear: 2005, endYear: 2010 }
    )
    expect(duringCarriage.matches[0]).toMatchObject({
      collection: { displayTitle: 'Pokémon' },
      airStartYear: 2002,
      airEndYear: 2017,
      eligibilityReason: 'documented-network-lineup',
    })
    expect(
      analyzeNetworkCopyProfile('cartoon-network', [pokemon], {
        startYear: 2018,
        endYear: 2020,
      }).matches
    ).toHaveLength(0)
  })

  test('keeps Nickelodeon, Nick Jr., and Disney lineups in their own network boundaries', () => {
    const library = [
      collection(1, 'The Loud House', {
        networks: ['Nickelodeon'],
        firstAirYear: 2016,
      }),
      collection(2, 'PAW Patrol', {
        networks: ['Nick Jr.'],
        firstAirYear: 2013,
      }),
      collection(3, 'Kim Possible', {
        networks: ['Disney Channel'],
        firstAirYear: 2002,
      }),
      collection(4, 'Bluey', {
        networks: ['ABC Kids'],
        firstAirYear: 2018,
      }),
    ]
    expect(
      analyzeNetworkCopyProfile('nickelodeon', library, {
        startYear: 2000,
        endYear: 2026,
      }).matches.map((match) => match.collection.displayTitle)
    ).toEqual(['The Loud House'])
    expect(
      analyzeNetworkCopyProfile('nick-jr', library, {
        startYear: 2000,
        endYear: 2026,
      }).matches.map((match) => match.collection.displayTitle)
    ).toEqual(['PAW Patrol'])
    expect(
      analyzeNetworkCopyProfile('disney-channel', library, {
        startYear: 2000,
        endYear: 2026,
      }).matches.map((match) => match.collection.displayTitle)
    ).toEqual(['Kim Possible'])
  })

  test('fails closed for ambiguous parent-network labels and non-program collections', () => {
    const library = [
      collection(1, 'SpongeBob SquarePants', {
        networks: ['Nickelodeon'],
        firstAirYear: 1999,
      }),
      collection(2, 'Gullah Gullah Island', {
        networks: ['Nickelodeon'],
        firstAirYear: 1994,
      }),
      collection(3, 'Uncatalogued Preschool Show', {
        networks: ['Nickelodeon'],
        firstAirYear: 1998,
      }),
      collection(4, 'Kim Possible', {
        networks: ['Disney Channel'],
        firstAirYear: 2002,
      }),
      collection(5, 'The Book of Pooh', {
        networks: ['Disney Channel'],
        firstAirYear: 2001,
      }),
      collection(6, 'Uncatalogued Disney Show', {
        networks: ['Disney Channel'],
        firstAirYear: 2004,
      }),
      collection(7, 'Cartoon Network Bonus Feature', {
        libraryKind: 'other',
        networks: ['Cartoon Network'],
        firstAirYear: 2001,
      }),
    ]

    expect(
      analyzeNetworkCopyProfile('nickelodeon', library, {
        startYear: 1994,
        endYear: 2026,
      }).matches.map((match) => match.collection.displayTitle)
    ).toEqual(['SpongeBob SquarePants'])
    expect(
      analyzeNetworkCopyProfile('nick-jr', library, {
        startYear: 1994,
        endYear: 2026,
      }).matches.map((match) => match.collection.displayTitle)
    ).toEqual(['Gullah Gullah Island'])
    expect(
      analyzeNetworkCopyProfile('disney-channel', library, {
        startYear: 1997,
        endYear: 2026,
      }).matches.map((match) => match.collection.displayTitle)
    ).toEqual(['Kim Possible'])
    expect(
      analyzeNetworkCopyProfile('disney-junior', library, {
        startYear: 1997,
        endYear: 2026,
      }).matches.map((match) => match.collection.displayTitle)
    ).toEqual(['The Book of Pooh'])
    expect(
      analyzeNetworkCopyProfile('cartoon-network', library, {
        startYear: 1997,
        endYear: 2026,
      }).matches
    ).toHaveLength(0)
  })

  test('ships strict profiles with bounded current and historical ranges', () => {
    expect(NETWORK_COPY_PROFILES.map((profile) => profile.id)).toEqual(
      expect.arrayContaining([
        'cartoon-network',
        'nickelodeon',
        'nick-jr',
        'disney-channel',
        'abc3-abc-me',
        'abc-family-au',
        'abc-kids-au',
        'cbbc',
        'cbeebies',
        'pbs-kids',
      ])
    )
    expect(
      NETWORK_COPY_PROFILES.find((profile) => profile.id === 'toonami')
    ).toMatchObject({ availableEndYear: 2008 })
    expect(
      NETWORK_COPY_PROFILES.find((profile) => profile.id === 'abc3-abc-me')
    ).toMatchObject({
      audience: 'school-age',
      availableStartYear: 2009,
      availableEndYear: 2024,
    })
    expect(
      NETWORK_COPY_PROFILES.find((profile) => profile.id === 'abc-family-au')
    ).toMatchObject({ audience: 'school-age', availableStartYear: 2024 })
    expect(
      NETWORK_COPY_PROFILES.find((profile) => profile.id === 'abc-kids-au')
    ).toMatchObject({ audience: 'preschool' })
    expect(
      NETWORK_COPY_PROFILES.find((profile) => profile.id === 'cbeebies')
    ).toMatchObject({ audience: 'preschool' })
    expect(
      NETWORK_COPY_PROFILES.find((profile) => profile.id === 'cbbc')
    ).toMatchObject({ audience: 'school-age' })
    expect(
      NETWORK_COPY_PROFILES.find((profile) => profile.id === 'pbs-kids')
    ).toMatchObject({ audience: 'school-age' })
    expect(isStationNetworkId('adult-swim')).toBe(false)
  })

  test('keeps ABC3 and ABC ME Best Of strict, age-focused, and separate from ABC Kids', () => {
    const library = [
      collection(1, 'Little Lunch', {
        networks: ['ABC3'],
        firstAirYear: 2015,
      }),
      collection(2, 'Hardball', {
        networks: ['ABC ME'],
        firstAirYear: 2019,
      }),
      collection(3, 'Bluey', {
        // A wrong broad-provider label must not defeat the curated affiliation.
        networks: ['ABC3'],
        firstAirYear: 2018,
      }),
      collection(4, 'Unknown ABC Programme', {
        networks: ['ABC ME'],
        firstAirYear: 2020,
      }),
    ]

    const bestOf = analyzeNetworkCopyProfile('abc3-abc-me', library, {
      startYear: 2009,
      endYear: 2024,
    })
    expect(bestOf.matches.map((match) => match.collection.displayTitle)).toEqual([
      'Hardball',
      'Little Lunch',
    ])
    expect(bestOf.profile.suggestions.map((suggestion) => suggestion.title)).not.toContain(
      'Bluey'
    )
    expect(bestOf.profile.suggestions.every(
      (suggestion) => suggestion.airWindowSource === 'documented'
    )).toBe(true)

    expect(
      analyzeNetworkCopyProfile('abc-kids-au', library, {
        startYear: 2018,
        endYear: 2026,
      }).matches.map((match) => match.collection.displayTitle)
    ).toEqual(['Bluey'])
    expect(() =>
      analyzeNetworkCopyProfile('abc3-abc-me', library, {
        startYear: 2025,
        endYear: 2025,
      })
    ).toThrow('2009 to 2024')
    expect(() =>
      analyzeNetworkCopyProfile('abc-family-au', library, {
        startYear: 2023,
        endYear: 2024,
      })
    ).toThrow('2024 to 2026')
  })

  test('keeps CBBC, CBeebies, and PBS KIDS title affiliations separate', () => {
    const library = [
      collection(1, 'Horrible Histories', {
        networks: ['CBeebies'],
        firstAirYear: 2009,
      }),
      collection(2, 'Hey Duggee', {
        networks: ['CBBC'],
        firstAirYear: 2014,
      }),
      collection(3, 'Wild Kratts', {
        networks: ['PBS KIDS'],
        firstAirYear: 2011,
      }),
    ]

    expect(
      analyzeNetworkCopyProfile('cbbc', library, {
        startYear: 2002,
        endYear: 2026,
      }).matches.map((match) => match.collection.displayTitle)
    ).toEqual(['Horrible Histories'])
    expect(
      analyzeNetworkCopyProfile('cbeebies', library, {
        startYear: 2002,
        endYear: 2026,
      }).matches.map((match) => match.collection.displayTitle)
    ).toEqual(['Hey Duggee'])
    expect(
      analyzeNetworkCopyProfile('pbs-kids', library, {
        startYear: 1994,
        endYear: 2026,
      }).matches.map((match) => match.collection.displayTitle)
    ).toEqual(['Wild Kratts'])
  })

  test('never chooses an Off air block as network fallback programming', () => {
    const base = getNetworkCopyProfile('cbbc')
    const offAirFirstProfile: typeof base = {
      ...base,
      blocks: [
        {
          id: 'closed',
          name: 'Off air overnight',
          start: '00:00',
          end: '06:00',
          tags: ['off-air'],
          preferredMinutes: [30],
          defaultPlaybackOrder: 'random',
        },
        {
          id: 'learning',
          name: 'Learning',
          start: '06:00',
          end: '24:00',
          tags: ['educational'],
          preferredMinutes: [30],
          defaultPlaybackOrder: 'sequential',
        },
      ],
    }
    const analysis = analyzeNetworkCopyProfile(
      offAirFirstProfile,
      [
        collection(1, 'Unlisted CBBC Programme', {
          networks: ['CBBC'],
          firstAirYear: 2020,
        }),
      ],
      { startYear: 2020, endYear: 2020 }
    )

    expect(analysis.matches[0]?.blockIds).toEqual(['learning'])
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
