import type { LibraryKind } from '../types'

export type EraStationTemplateId =
  | 'cartoon-network-1997-2004'
  | 'cartoon-network-2005-2012'
  | 'nickelodeon-1994-2004'
  | 'nickelodeon-2005-2012'
  | 'nick-jr-1999-2012'
  | 'disney-channel-1998-2007'
  | 'disney-channel-2008-2012'
  | 'playhouse-disney-1999-2011'
  | 'toon-disney-1998-2008'
  | 'jetix-2004-2009'
  | 'toonami-1997-2008'
  | 'classic-cartoons-1955-1999'

export type EraPlaybackOrder =
  | 'random'
  | 'sequential'
  | 'season-sequential'
  | 'story-order'

export type EraStationFidelity = 'historical' | 'family-mix'

export interface EraStationBlockTemplate {
  readonly id: string
  readonly name: string
  readonly start: string
  readonly end: string
  readonly tags: readonly string[]
  readonly preferredMinutes: readonly number[]
  readonly defaultPlaybackOrder: EraPlaybackOrder
}

export interface EraStationContentSuggestion {
  readonly title: string
  readonly aliases?: readonly string[]
  readonly libraryKind: Extract<LibraryKind, 'tv' | 'movie'>
  readonly firstYear: number
  readonly lastYear?: number
  readonly tags: readonly string[]
  readonly blockIds: readonly string[]
  readonly weight: number
  readonly playbackOrder: EraPlaybackOrder
}

export interface EraStationMoviePolicy {
  readonly enabled: boolean
  readonly preferredBlockIds: readonly string[]
  readonly cadence: 'none' | 'weekly' | 'weekends' | 'occasional'
  readonly note: string
}

export interface EraStationMarathonDefaults {
  readonly enabled: boolean
  readonly cadence: 'weekly' | 'monthly' | 'special-events'
  readonly modes: readonly ('show' | 'category' | 'franchise' | 'playlist')[]
  readonly note: string
}

export interface EraStationInterstitialDefaults {
  readonly enabled: false
  readonly bumpers: false
  readonly promos: false
  readonly commercials: false
  readonly stationIds: false
}

/**
 * A period-inspired programming recipe. It describes scheduling behaviour and
 * catalog signals only; it never points at or bundles copyrighted media.
 */
export interface EraStationTemplate {
  readonly id: EraStationTemplateId
  readonly name: string
  readonly networkFamily: string
  readonly era: {
    readonly startYear: number
    readonly endYear: number
    /** Era is a preference, not a hard exclusion. */
    readonly softPaddingYears: number
  }
  readonly description: string
  readonly providerTerms: readonly string[]
  readonly excludedTitleAliases?: readonly string[]
  readonly blocks: readonly EraStationBlockTemplate[]
  readonly suggestions: readonly EraStationContentSuggestion[]
  readonly moviePolicy: EraStationMoviePolicy
  readonly marathonDefaults: EraStationMarathonDefaults
  /** Interstitial assets are deliberately never required by a template. */
  readonly interstitials: EraStationInterstitialDefaults
}

/** Structural input accepted from StationCollectionOption without coupling. */
export interface EraStationLibraryCollection {
  readonly id: number
  readonly displayTitle: string
  readonly libraryKind: LibraryKind
  readonly genres: readonly string[]
  readonly networks: readonly string[]
  readonly studios: readonly string[]
  readonly firstAirYear?: number | null
}

export type EraStationMatchReason =
  | 'curated-title'
  | 'family-guest'
  | 'network'
  | 'studio'
  | 'era'
  | 'near-era'
  | 'movie'

export interface EraStationLibraryMatch<
  TCollection extends EraStationLibraryCollection = EraStationLibraryCollection,
> {
  readonly collection: TCollection
  readonly score: number
  readonly reasons: readonly EraStationMatchReason[]
  readonly blockIds: readonly string[]
  readonly tags: readonly string[]
  readonly weight: number
  readonly playbackOrder: EraPlaybackOrder
}

export interface EraStationTemplateAnalysis<
  TCollection extends EraStationLibraryCollection = EraStationLibraryCollection,
> {
  readonly template: EraStationTemplate
  readonly matches: readonly EraStationLibraryMatch<TCollection>[]
  readonly missingSuggestions: readonly EraStationContentSuggestion[]
  readonly matchedShows: number
  readonly matchedMovies: number
}

export interface EraStationFamilyMixGuest {
  readonly title: string
  readonly aliases?: readonly string[]
  readonly firstYear: number
  readonly tags: readonly string[]
  readonly audiences: readonly ('preschool' | 'kids' | 'family' | 'action')[]
  readonly playbackOrder: EraPlaybackOrder
}

/**
 * Popular parent-approved guests can use a period-inspired schedule without
 * being represented as historical network originals. These are catalog hints
 * only: ToastTV neither bundles nor locates the media.
 */
export const ERA_STATION_FAMILY_MIX_GUESTS: readonly EraStationFamilyMixGuest[] = [
  familyGuest('Bluey', 2018, ['family', 'comedy', 'preschool'], ['preschool', 'kids', 'family']),
  familyGuest('Numberblocks', 2017, ['educational', 'maths', 'preschool'], ['preschool', 'kids', 'family'], 'season-sequential'),
  familyGuest("Ryan's Mystery Playdate", 2019, ['interactive', 'preschool'], ['preschool', 'kids', 'family']),
  familyGuest('My Little Pony: Friendship Is Magic', 2010, ['animation', 'fantasy', 'family'], ['kids', 'family'], 'season-sequential'),
  familyGuest('PAW Patrol', 2013, ['preschool', 'adventure', 'teamwork'], ['preschool', 'kids', 'family'], 'season-sequential', ['Paw Patrol']),
  familyGuest('Wild Kratts', 2011, ['educational', 'animals', 'adventure'], ['kids', 'family'], 'season-sequential'),
  familyGuest('The Magic School Bus', 1994, ['educational', 'science', 'adventure'], ['kids', 'family'], 'season-sequential'),
]

const EVERYDAY_BLOCKS: readonly EraStationBlockTemplate[] = [
  block('overnight', 'Overnight repeats', '00:00', '06:00', ['repeats'], [30], 'random'),
  block('morning', 'Morning', '06:00', '09:00', ['family', 'comedy'], [15, 30], 'random'),
  block('daytime', 'Daytime', '09:00', '15:30', ['animation', 'comedy'], [30], 'random'),
  block('after-school', 'After school', '15:30', '19:00', ['action', 'comedy'], [30], 'random'),
  block('primetime', 'Primetime', '19:00', '21:00', ['premiere', 'family'], [30, 60], 'random'),
  block('late', 'Late evening', '21:00', '24:00', ['older-kids', 'repeats'], [30], 'random'),
]

const PRESCHOOL_BLOCKS: readonly EraStationBlockTemplate[] = [
  block('overnight', 'Calm overnight repeats', '00:00', '06:00', ['calm', 'preschool'], [15, 30], 'random'),
  block('morning', 'Learning morning', '06:00', '10:00', ['educational', 'music'], [15, 30], 'random'),
  block('daytime', 'Preschool daytime', '10:00', '15:00', ['preschool', 'interactive'], [15, 30], 'random'),
  block('afternoon', 'Afternoon favourites', '15:00', '19:00', ['family', 'preschool'], [15, 30], 'random'),
  block('bedtime', 'Bedtime wind-down', '19:00', '24:00', ['calm', 'music'], [15, 30], 'random'),
]

const ACTION_BLOCKS: readonly EraStationBlockTemplate[] = [
  block('overnight', 'Overnight encore', '00:00', '06:00', ['repeats', 'action'], [30], 'sequential'),
  block('morning', 'Morning action', '06:00', '12:00', ['superhero', 'adventure'], [30], 'sequential'),
  block('daytime', 'Daytime action', '12:00', '17:00', ['action', 'science-fiction'], [30], 'sequential'),
  block('toonami', 'Toonami block', '17:00', '23:00', ['anime', 'serialized'], [30], 'season-sequential'),
  block('late', 'Late encore', '23:00', '24:00', ['anime', 'repeats'], [30], 'season-sequential'),
]

export const ERA_STATION_TEMPLATES: readonly EraStationTemplate[] = [
  template({
    id: 'cartoon-network-1997-2004',
    name: 'Cartoon Network inspired · 1997–2004',
    networkFamily: 'Cartoon Network',
    description: 'Cartoon Cartoons, acquired classics, action blocks, a primetime premiere window, and occasional movies.',
    providerTerms: ['cartoon network', 'cartoon network studios', 'hanna-barbera'],
    blocks: EVERYDAY_BLOCKS,
    suggestions: [
      show("Dexter's Laboratory", 1996, ['classic-cn', 'comedy'], ['daytime', 'primetime']),
      show('Johnny Bravo', 1997, ['classic-cn', 'comedy'], ['daytime', 'late']),
      show('Cow and Chicken', 1997, ['classic-cn', 'comedy'], ['daytime', 'late']),
      show('The Powerpuff Girls', 1998, ['classic-cn', 'action'], ['morning', 'primetime']),
      show('Ed, Edd n Eddy', 1999, ['classic-cn', 'comedy'], ['after-school', 'primetime']),
      show('Courage the Cowardly Dog', 1999, ['classic-cn', 'comedy'], ['after-school', 'late']),
      show('Samurai Jack', 2001, ['action', 'serialized'], ['after-school', 'primetime'], 'sequential'),
      show('Codename: Kids Next Door', 2002, ['action', 'comedy'], ['after-school', 'primetime']),
      show('Teen Titans', 2003, ['action', 'superhero'], ['after-school', 'primetime'], 'season-sequential'),
      movie('The Powerpuff Girls Movie', 2002, ['animation', 'special'], ['primetime']),
    ],
  }),
  template({
    id: 'cartoon-network-2005-2012',
    name: 'Cartoon Network inspired · 2005–2012',
    networkFamily: 'Cartoon Network',
    description: 'Comedy-heavy originals, action series, evening premieres, weekend movies, and event marathons.',
    providerTerms: ['cartoon network', 'cartoon network studios'],
    blocks: EVERYDAY_BLOCKS,
    suggestions: [
      show("Foster's Home for Imaginary Friends", 2004, ['comedy', 'family'], ['daytime', 'primetime']),
      show('Camp Lazlo', 2005, ['comedy'], ['morning', 'daytime']),
      show('Ben 10', 2005, ['action', 'science-fiction'], ['after-school', 'primetime'], 'season-sequential'),
      show('Chowder', 2007, ['comedy'], ['daytime', 'primetime']),
      show('The Marvelous Misadventures of Flapjack', 2008, ['comedy', 'adventure'], ['after-school', 'late']),
      show('Adventure Time', 2010, ['comedy', 'fantasy'], ['after-school', 'primetime']),
      show('Regular Show', 2010, ['comedy', 'older-kids'], ['primetime', 'late']),
      show('Generator Rex', 2010, ['action', 'science-fiction'], ['after-school', 'primetime'], 'season-sequential'),
      show('The Amazing World of Gumball', 2011, ['comedy', 'family'], ['daytime', 'primetime']),
      movie('Ben 10: Secret of the Omnitrix', 2007, ['animation', 'special'], ['primetime']),
    ],
  }),
  template({
    id: 'nickelodeon-1994-2004',
    name: 'Nickelodeon inspired · 1994–2004',
    networkFamily: 'Nickelodeon',
    description: 'Nicktoons, live-action comedy, after-school favourites, weekend specials, and movie events.',
    providerTerms: ['nickelodeon', 'nickelodeon animation studio', 'nickelodeon productions'],
    excludedTitleAliases: nickJrAliases(),
    blocks: EVERYDAY_BLOCKS,
    suggestions: [
      show('Rugrats', 1991, ['nicktoons', 'comedy'], ['morning', 'daytime']),
      show('Rocko\'s Modern Life', 1993, ['nicktoons', 'comedy'], ['daytime', 'late']),
      show('All That', 1994, ['live-action', 'sketch-comedy'], ['after-school', 'primetime']),
      show('Hey Arnold!', 1996, ['nicktoons', 'comedy'], ['daytime', 'after-school']),
      show('Kenan & Kel', 1996, ['live-action', 'comedy'], ['after-school', 'primetime']),
      show('The Angry Beavers', 1997, ['nicktoons', 'comedy'], ['daytime', 'late']),
      show('CatDog', 1998, ['nicktoons', 'comedy'], ['daytime', 'after-school']),
      show('The Wild Thornberrys', 1998, ['nicktoons', 'adventure'], ['morning', 'daytime']),
      show('SpongeBob SquarePants', 1999, ['nicktoons', 'comedy'], ['daytime', 'primetime']),
      show('Rocket Power', 1999, ['nicktoons', 'sports'], ['after-school', 'primetime']),
      show('The Fairly OddParents', 2001, ['nicktoons', 'comedy'], ['daytime', 'primetime']),
      show('Danny Phantom', 2004, ['nicktoons', 'action'], ['after-school', 'primetime'], 'season-sequential'),
      movie('Good Burger', 1997, ['live-action', 'comedy'], ['primetime']),
      movie('The Rugrats Movie', 1998, ['animation', 'family'], ['primetime']),
    ],
  }),
  template({
    id: 'nickelodeon-2005-2012',
    name: 'Nickelodeon inspired · 2005–2012',
    networkFamily: 'Nickelodeon',
    description: 'Nicktoons plus a strong live-action after-school and primetime identity, with movie and marathon events.',
    providerTerms: ['nickelodeon', 'nickelodeon animation studio', 'nickelodeon productions'],
    excludedTitleAliases: nickJrAliases(),
    blocks: EVERYDAY_BLOCKS,
    suggestions: [
      show('SpongeBob SquarePants', 1999, ['nicktoons', 'comedy'], ['daytime', 'primetime']),
      show('The Fairly OddParents', 2001, ['nicktoons', 'comedy'], ['daytime', 'primetime']),
      show('Drake & Josh', 2004, ['live-action', 'comedy'], ['after-school', 'primetime']),
      show('Avatar: The Last Airbender', 2005, ['animation', 'serialized'], ['after-school', 'primetime'], 'story-order'),
      show('iCarly', 2007, ['live-action', 'comedy'], ['after-school', 'primetime']),
      show('The Penguins of Madagascar', 2008, ['nicktoons', 'comedy'], ['daytime', 'primetime']),
      show('Big Time Rush', 2009, ['live-action', 'music'], ['after-school', 'primetime']),
      show('Victorious', 2010, ['live-action', 'comedy'], ['after-school', 'primetime']),
      show('The Legend of Korra', 2012, ['animation', 'serialized'], ['primetime', 'late'], 'story-order'),
      movie('Rags', 2012, ['live-action', 'music'], ['primetime']),
    ],
  }),
  template({
    id: 'nick-jr-1999-2012',
    name: 'Nick Jr. inspired · 1999–2012',
    networkFamily: 'Nick Jr.',
    description: 'Preschool learning, calmer storytelling, music, interactive programmes, and a bedtime wind-down.',
    providerTerms: ['nick jr', 'nick jr.'],
    blocks: PRESCHOOL_BLOCKS,
    suggestions: nickJrSuggestions(),
    moviePolicy: {
      enabled: false,
      preferredBlockIds: [],
      cadence: 'none',
      note: 'Keep the core preschool schedule show-led; add specials manually when appropriate.',
    },
    marathonDefaults: {
      enabled: true,
      cadence: 'special-events',
      modes: ['show', 'category', 'playlist'],
      note: 'Use an occasional themed or single-show event without crowding out the weekly preschool rotation.',
    },
  }),
  template({
    id: 'disney-channel-1998-2007',
    name: 'Disney Channel inspired · 1998–2007',
    networkFamily: 'Disney Channel',
    description: 'Animation in the morning, sitcoms after school, family primetime, and recurring original-movie nights.',
    providerTerms: ['disney channel', 'disney television animation'],
    blocks: EVERYDAY_BLOCKS,
    suggestions: [
      show('Recess', 1997, ['animation', 'comedy'], ['morning', 'daytime']),
      show('The Famous Jett Jackson', 1998, ['live-action', 'adventure'], ['after-school']),
      show('Even Stevens', 2000, ['live-action', 'comedy'], ['after-school', 'primetime']),
      show('Lizzie McGuire', 2001, ['live-action', 'comedy'], ['after-school', 'primetime']),
      show('Kim Possible', 2002, ['animation', 'action'], ['morning', 'after-school'], 'season-sequential'),
      show("That's So Raven", 2003, ['live-action', 'comedy'], ['after-school', 'primetime']),
      show('Lilo & Stitch: The Series', 2003, ['animation', 'comedy'], ['morning', 'daytime']),
      show('The Suite Life of Zack & Cody', 2005, ['live-action', 'comedy'], ['after-school', 'primetime']),
      show('Hannah Montana', 2006, ['live-action', 'music'], ['after-school', 'primetime']),
      movie('Halloweentown', 1998, ['seasonal', 'family'], ['primetime']),
      movie('The Cheetah Girls', 2003, ['music', 'family'], ['primetime']),
      movie('High School Musical', 2006, ['music', 'family'], ['primetime']),
    ],
  }),
  template({
    id: 'disney-channel-2008-2012',
    name: 'Disney Channel inspired · 2008–2012',
    networkFamily: 'Disney Channel',
    description: 'Animation, after-school sitcoms, music-driven events, family primetime, and scheduled movie nights.',
    providerTerms: ['disney channel', 'disney television animation'],
    blocks: EVERYDAY_BLOCKS,
    suggestions: [
      show('Phineas and Ferb', 2007, ['animation', 'comedy'], ['morning', 'daytime']),
      show('Wizards of Waverly Place', 2007, ['live-action', 'comedy'], ['after-school', 'primetime']),
      show('The Suite Life on Deck', 2008, ['live-action', 'comedy'], ['after-school', 'primetime']),
      show('Sonny with a Chance', 2009, ['live-action', 'comedy'], ['after-school']),
      show('Good Luck Charlie', 2010, ['live-action', 'family'], ['after-school', 'primetime']),
      show('Shake It Up', 2010, ['live-action', 'music'], ['after-school', 'primetime']),
      show('Jessie', 2011, ['live-action', 'comedy'], ['after-school', 'primetime']),
      show('Austin & Ally', 2011, ['live-action', 'music'], ['after-school', 'primetime']),
      show('Gravity Falls', 2012, ['animation', 'serialized'], ['after-school', 'primetime'], 'story-order'),
      movie('Camp Rock', 2008, ['music', 'family'], ['primetime']),
      movie('Lemonade Mouth', 2011, ['music', 'family'], ['primetime']),
    ],
  }),
  template({
    id: 'playhouse-disney-1999-2011',
    name: 'Playhouse Disney inspired · 1999–2011',
    networkFamily: 'Playhouse Disney',
    description: 'Learning-focused preschool mornings, music and participation, calmer stories, and gentle family repeats.',
    providerTerms: ['playhouse disney', 'disney junior'],
    blocks: PRESCHOOL_BLOCKS,
    suggestions: [
      show('Bear in the Big Blue House', 1997, ['preschool', 'music', 'calm'], ['morning', 'bedtime']),
      show('Rolie Polie Olie', 1998, ['preschool', 'family'], ['morning', 'daytime']),
      show('PB&J Otter', 1998, ['preschool', 'music'], ['morning', 'afternoon']),
      show('Out of the Box', 1998, ['preschool', 'creative', 'music'], ['morning', 'daytime']),
      show('Stanley', 2001, ['preschool', 'educational'], ['daytime', 'afternoon']),
      show("JoJo's Circus", 2003, ['preschool', 'movement'], ['morning', 'afternoon']),
      show('Little Einsteins', 2005, ['preschool', 'music', 'educational'], ['morning', 'daytime'], 'season-sequential'),
      show('Mickey Mouse Clubhouse', 2006, ['preschool', 'interactive'], ['morning', 'daytime']),
      show('Handy Manny', 2006, ['preschool', 'educational'], ['daytime', 'afternoon']),
      show('Imagination Movers', 2008, ['preschool', 'music'], ['morning', 'afternoon']),
    ],
    moviePolicy: { enabled: false, preferredBlockIds: [], cadence: 'none', note: 'Use occasional family specials rather than a routine feature-film block.' },
    marathonDefaults: { enabled: true, cadence: 'special-events', modes: ['show', 'category', 'playlist'], note: 'Prefer short themed stacks; routine all-day preschool marathons create excessive repetition.' },
  }),
  template({
    id: 'toon-disney-1998-2008',
    name: 'Toon Disney inspired · 1998–2008',
    networkFamily: 'Toon Disney',
    description: 'A broad Disney animation library with action blocks, classic repeats, and animated movie events.',
    providerTerms: ['toon disney', 'disney television animation'],
    blocks: EVERYDAY_BLOCKS,
    suggestions: [
      show('DuckTales', 1987, ['classic-disney', 'adventure'], ['morning', 'daytime']),
      show('Chip \'n Dale: Rescue Rangers', 1989, ['classic-disney', 'adventure'], ['morning', 'daytime']),
      show('Darkwing Duck', 1991, ['classic-disney', 'action'], ['daytime', 'after-school']),
      show('Goof Troop', 1992, ['classic-disney', 'comedy'], ['morning', 'daytime']),
      show('Gargoyles', 1994, ['action', 'serialized'], ['after-school', 'late'], 'story-order'),
      show('Timon & Pumbaa', 1995, ['animation', 'comedy'], ['morning', 'daytime']),
      show('The Weekenders', 2000, ['animation', 'comedy'], ['daytime', 'after-school']),
      show('House of Mouse', 2001, ['animation', 'comedy'], ['morning', 'primetime']),
      show('Kim Possible', 2002, ['animation', 'action'], ['after-school', 'primetime'], 'season-sequential'),
      movie("Mickey's Once Upon a Christmas", 1999, ['seasonal', 'animation'], ['primetime']),
    ],
  }),
  template({
    id: 'jetix-2004-2009',
    name: 'Jetix inspired · 2004–2009',
    networkFamily: 'Jetix',
    description: 'After-school and evening action, superhero teams, serialized adventure, and occasional action movies.',
    providerTerms: ['jetix'],
    blocks: ACTION_BLOCKS,
    suggestions: [
      show('Power Rangers Dino Thunder', 2004, ['action', 'superhero', 'serialized'], ['daytime', 'toonami'], 'story-order'),
      show('Digimon', 1999, ['anime', 'adventure', 'serialized'], ['morning', 'toonami'], 'story-order'),
      show('Super Robot Monkey Team Hyperforce Go!', 2004, ['action', 'science-fiction'], ['daytime', 'toonami'], 'season-sequential'),
      show('W.I.T.C.H.', 2004, ['action', 'fantasy', 'serialized'], ['daytime', 'toonami'], 'story-order'),
      show('Dragon Booster', 2004, ['action', 'fantasy', 'serialized'], ['daytime', 'toonami'], 'story-order'),
      show('Get Ed', 2005, ['action', 'science-fiction'], ['daytime', 'toonami'], 'season-sequential'),
      show('Yin Yang Yo!', 2006, ['action', 'comedy'], ['morning', 'daytime']),
      show('Pucca', 2006, ['action', 'comedy'], ['morning', 'daytime']),
      show('Jackie Chan Adventures', 2000, ['action', 'comedy', 'serialized'], ['daytime', 'toonami'], 'season-sequential'),
      show('Totally Spies!', 2001, ['action', 'comedy'], ['daytime', 'toonami'], 'season-sequential'),
    ],
  }),
  template({
    id: 'toonami-1997-2008',
    name: 'Toonami / action inspired · 1997–2008',
    networkFamily: 'Toonami',
    description: 'Serialized anime, superhero animation, science fiction, and action programming with sequential progress.',
    providerTerms: ['cartoon network', 'toonami'],
    blocks: ACTION_BLOCKS,
    suggestions: [
      show('Dragon Ball Z', 1989, ['anime', 'serialized'], ['toonami'], 'story-order'),
      show('Sailor Moon', 1992, ['anime', 'serialized'], ['toonami'], 'story-order'),
      show('Mobile Suit Gundam Wing', 1995, ['anime', 'science-fiction'], ['toonami'], 'story-order'),
      show('Tenchi Muyo!', 1995, ['anime', 'science-fiction'], ['toonami'], 'story-order'),
      show('Pokémon', 1997, ['anime', 'adventure'], ['morning', 'daytime'], 'season-sequential'),
      show('Yu Yu Hakusho', 1992, ['anime', 'serialized'], ['toonami'], 'story-order'),
      show('Samurai Jack', 2001, ['action', 'serialized'], ['daytime', 'toonami'], 'sequential'),
      show('Justice League', 2001, ['superhero', 'action'], ['morning', 'daytime'], 'season-sequential'),
      show('Naruto', 2002, ['anime', 'serialized'], ['toonami'], 'story-order'),
      show('Teen Titans', 2003, ['superhero', 'action'], ['daytime', 'toonami'], 'season-sequential'),
      movie('Dragon Ball Z: Dead Zone', 1989, ['anime', 'special'], ['toonami']),
    ],
  }),
  template({
    id: 'classic-cartoons-1955-1999',
    name: 'Classic cartoons inspired · 1955–1999',
    networkFamily: 'Classic animation',
    description: 'Theatrical shorts, Hanna-Barbera favourites, mystery/adventure cartoons, family primetime, and weekend movies.',
    providerTerms: ['hanna-barbera', 'warner bros animation', 'warner bros. animation', 'metro-goldwyn-mayer'],
    blocks: EVERYDAY_BLOCKS,
    suggestions: [
      show('Looney Tunes', 1930, ['classic', 'shorts', 'comedy'], ['morning', 'daytime']),
      show('Tom and Jerry', 1940, ['classic', 'shorts', 'comedy'], ['morning', 'daytime']),
      show('The Flintstones', 1960, ['classic', 'comedy', 'family'], ['daytime', 'primetime']),
      show('The Jetsons', 1962, ['classic', 'comedy', 'science-fiction'], ['daytime', 'primetime']),
      show('Scooby-Doo, Where Are You!', 1969, ['classic', 'mystery', 'comedy'], ['morning', 'after-school']),
      show('The Yogi Bear Show', 1961, ['classic', 'comedy'], ['morning', 'daytime'], 'random', ['Yogi Bear']),
      show('Jonny Quest', 1964, ['classic', 'action', 'adventure'], ['after-school', 'primetime'], 'season-sequential'),
      show('Popeye the Sailor', 1960, ['classic', 'shorts', 'comedy'], ['morning', 'daytime']),
      movie('Scooby-Doo on Zombie Island', 1998, ['animation', 'mystery', 'family'], ['primetime']),
    ],
  }),
]

export function getEraStationTemplate(
  id: EraStationTemplateId
): EraStationTemplate {
  const value = ERA_STATION_TEMPLATES.find((template) => template.id === id)
  if (!value) throw new Error(`Unknown era station template: ${id}`)
  return value
}

/**
 * Match the current library and return the curated titles that are still
 * absent. Curated title hits are authoritative; provider/era matching is a
 * conservative fallback. Era contributes to score but never rejects a known
 * title, which keeps long-running shows useful across adjacent periods.
 */
export function analyzeEraStationTemplate<
  TCollection extends EraStationLibraryCollection,
>(
  templateOrId: EraStationTemplate | EraStationTemplateId,
  collections: readonly TCollection[],
  fidelity: EraStationFidelity = 'family-mix'
): EraStationTemplateAnalysis<TCollection> {
  const selectedTemplate =
    typeof templateOrId === 'string'
      ? getEraStationTemplate(templateOrId)
      : templateOrId
  const suggestionByAlias = suggestionAliases(selectedTemplate.suggestions)
  const familyGuestByAlias = familyGuestAliases(ERA_STATION_FAMILY_MIX_GUESTS)
  const exclusions = new Set(
    (selectedTemplate.excludedTitleAliases ?? []).map(normalizeTitle)
  )
  const matches: EraStationLibraryMatch<TCollection>[] = []
  const ownedSuggestions = new Set<EraStationContentSuggestion>()

  for (const collection of collections) {
    const normalizedTitle = normalizeTitle(collection.displayTitle)
    const curated = suggestionByAlias.get(normalizedTitle)
    const familyGuest =
      fidelity === 'family-mix'
        ? familyGuestByAlias.get(normalizedTitle)
        : undefined
    const eligibleFamilyGuest =
      familyGuest && familyGuestEligible(selectedTemplate, familyGuest)
        ? familyGuest
        : undefined
    if (curated && collection.libraryKind === curated.libraryKind) {
      ownedSuggestions.add(curated)
    }
    if (exclusions.has(normalizedTitle) && !curated) {
      continue
    }

    const reasons: EraStationMatchReason[] = []
    let score = 0
    if (curated && collection.libraryKind === curated.libraryKind) {
      reasons.push('curated-title')
      score += 100
      if (curated.libraryKind === 'movie') reasons.push('movie')
    } else if (eligibleFamilyGuest && collection.libraryKind === 'tv') {
      reasons.push('family-guest')
      score += 50
    } else if (collection.libraryKind === 'tv') {
      if (matchesProvider(collection.networks, selectedTemplate.providerTerms)) {
        reasons.push('network')
        score += 60
      }
      if (matchesProvider(collection.studios, selectedTemplate.providerTerms)) {
        reasons.push('studio')
        score += 45
      }
    }

    const eraReason = eraMatchReason(collection.firstAirYear, selectedTemplate)
    if (eraReason === 'era') {
      reasons.push(eraReason)
      score += 20
    } else if (eraReason === 'near-era') {
      reasons.push(eraReason)
      score += 8
    } else if (collection.firstAirYear == null) {
      score += 5
    } else if (!curated && !eligibleFamilyGuest) {
      score -= 30
    }

    const providerMatched = reasons.includes('network') || reasons.includes('studio')
    if (
      !curated &&
      !eligibleFamilyGuest &&
      (!providerMatched || score < 55)
    ) {
      continue
    }
    if (collection.libraryKind === 'movie' && !curated) continue

    matches.push({
      collection,
      score,
      reasons,
      blockIds:
        curated?.blockIds ??
        (eligibleFamilyGuest
          ? familyGuestBlocks(selectedTemplate, eligibleFamilyGuest)
          : providerFallbackBlocks(selectedTemplate)),
      tags: curated?.tags ?? eligibleFamilyGuest?.tags ?? inferredTags(collection),
      weight: curated?.weight ?? (eligibleFamilyGuest ? 6 : 5),
      playbackOrder:
        curated?.playbackOrder ??
        eligibleFamilyGuest?.playbackOrder ??
        defaultPlaybackOrder(selectedTemplate),
    })
  }

  matches.sort(
    (left, right) =>
      right.score - left.score || compareText(left.collection.displayTitle, right.collection.displayTitle)
  )
  const missingSuggestions = selectedTemplate.suggestions
    .filter((suggestion) => !ownedSuggestions.has(suggestion))
    .sort(
      (left, right) =>
        right.weight - left.weight || compareText(left.title, right.title)
    )
  return {
    template: selectedTemplate,
    matches,
    missingSuggestions,
    matchedShows: matches.filter((match) => match.collection.libraryKind === 'tv').length,
    matchedMovies: matches.filter((match) => match.collection.libraryKind === 'movie').length,
  }
}

/** Validate built-ins and future user-supplied catalogs before persistence. */
export function validateEraStationTemplates(
  templates: readonly EraStationTemplate[]
): void {
  const ids = new Set<string>()
  for (const value of templates) {
    if (ids.has(value.id)) throw new Error(`Duplicate era template ID: ${value.id}`)
    ids.add(value.id)
    if (
      !Number.isInteger(value.era.startYear) ||
      !Number.isInteger(value.era.endYear) ||
      !Number.isInteger(value.era.softPaddingYears) ||
      value.era.startYear > value.era.endYear ||
      value.era.softPaddingYears < 0
    ) {
      throw new Error(`Era template ${value.id} has an invalid era`)
    }
    const blockIds = new Set<string>()
    const ranges: Array<{ start: number; end: number }> = []
    for (const valueBlock of value.blocks) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(valueBlock.id) || blockIds.has(valueBlock.id)) {
        throw new Error(`Era template ${value.id} has an invalid block ID`)
      }
      blockIds.add(valueBlock.id)
      const start = scheduleMinutes(valueBlock.start)
      const end = scheduleMinutes(valueBlock.end, true)
      if (end <= start) throw new Error(`Era template ${value.id} has an invalid block range`)
      if (ranges.some((range) => start < range.end && range.start < end)) {
        throw new Error(`Era template ${value.id} has overlapping blocks`)
      }
      ranges.push({ start, end })
    }
    if (
      value.moviePolicy.preferredBlockIds.some(
        (blockId) => !blockIds.has(blockId)
      )
    ) {
      throw new Error(`Era template ${value.id} movie policy references an unknown block`)
    }
    const aliases = new Set<string>()
    for (const suggestion of value.suggestions) {
      if (suggestion.firstYear < 1900 || suggestion.weight < 1 || suggestion.weight > 10) {
        throw new Error(`Era template ${value.id} has an invalid suggestion`)
      }
      if (suggestion.blockIds.some((blockId) => !blockIds.has(blockId))) {
        throw new Error(`Era template ${value.id} suggestion references an unknown block`)
      }
      const suggestionAliases = new Set(
        [suggestion.title, ...(suggestion.aliases ?? [])].map(normalizeTitle)
      )
      for (const normalized of suggestionAliases) {
        if (!normalized || aliases.has(normalized)) {
          throw new Error(`Era template ${value.id} has a duplicate suggestion alias`)
        }
        aliases.add(normalized)
      }
    }
  }
}

function template(
  input: Omit<
    EraStationTemplate,
    'era' | 'moviePolicy' | 'marathonDefaults' | 'interstitials'
  > & {
    readonly era?: EraStationTemplate['era']
    readonly moviePolicy?: EraStationMoviePolicy
    readonly marathonDefaults?: EraStationMarathonDefaults
  }
): EraStationTemplate {
  const years = /-(\d{4})-(\d{4})$/.exec(input.id)
  const defaultMovieBlock =
    input.blocks.find((value) => value.id === 'primetime')?.id ??
    input.blocks.find((value) => value.id === 'toonami')?.id ??
    input.blocks[input.blocks.length - 1]?.id
  return {
    ...input,
    era: input.era ?? {
      startYear: Number(years?.[1]),
      endYear: Number(years?.[2]),
      softPaddingYears: 4,
    },
    moviePolicy: input.moviePolicy ?? {
      enabled: true,
      preferredBlockIds: defaultMovieBlock ? [defaultMovieBlock] : [],
      cadence: 'weekly',
      note: 'Treat movies as scheduled events in the preferred block instead of mixing them randomly into episode rotation.',
    },
    marathonDefaults: input.marathonDefaults ?? {
      enabled: true,
      cadence: 'monthly',
      modes: ['show', 'category', 'franchise', 'playlist'],
      note: 'Generate a bounded event override, then return to the ordinary station rotation.',
    },
    interstitials: {
      enabled: false,
      bumpers: false,
      promos: false,
      commercials: false,
      stationIds: false,
    },
  }
}

function block(
  id: string,
  name: string,
  start: string,
  end: string,
  tags: readonly string[],
  preferredMinutes: readonly number[],
  defaultPlaybackOrder: EraPlaybackOrder
): EraStationBlockTemplate {
  return { id, name, start, end, tags, preferredMinutes, defaultPlaybackOrder }
}

function show(
  title: string,
  firstYear: number,
  tags: readonly string[],
  blockIds: readonly string[],
  playbackOrder: EraPlaybackOrder = 'random',
  aliases?: readonly string[]
): EraStationContentSuggestion {
  return {
    title,
    ...(aliases ? { aliases } : {}),
    libraryKind: 'tv',
    firstYear,
    tags,
    blockIds,
    weight: 8,
    playbackOrder,
  }
}

function movie(
  title: string,
  firstYear: number,
  tags: readonly string[],
  blockIds: readonly string[],
  aliases?: readonly string[]
): EraStationContentSuggestion {
  return {
    title,
    ...(aliases ? { aliases } : {}),
    libraryKind: 'movie',
    firstYear,
    tags,
    blockIds,
    weight: 6,
    playbackOrder: 'random',
  }
}

function familyGuest(
  title: string,
  firstYear: number,
  tags: readonly string[],
  audiences: EraStationFamilyMixGuest['audiences'],
  playbackOrder: EraPlaybackOrder = 'random',
  aliases?: readonly string[]
): EraStationFamilyMixGuest {
  return {
    title,
    ...(aliases ? { aliases } : {}),
    firstYear,
    tags,
    audiences,
    playbackOrder,
  }
}

function nickJrSuggestions(): readonly EraStationContentSuggestion[] {
  return [
    show("Blue's Clues", 1996, ['preschool', 'educational'], ['morning', 'daytime'], 'sequential', ['Blues Clues']),
    show('Dora the Explorer', 2000, ['preschool', 'interactive'], ['morning', 'daytime']),
    show('Franklin', 1997, ['preschool', 'calm'], ['daytime', 'bedtime'], 'season-sequential'),
    show('Little Bill', 1999, ['preschool', 'calm'], ['daytime', 'bedtime']),
    show('Oswald', 2001, ['preschool', 'calm'], ['daytime', 'bedtime']),
    show('Max & Ruby', 2002, ['preschool', 'calm'], ['daytime', 'bedtime'], 'random', ['Max and Ruby']),
    show('The Backyardigans', 2004, ['preschool', 'music'], ['morning', 'afternoon']),
    show('Wonder Pets!', 2006, ['preschool', 'music'], ['morning', 'afternoon'], 'random', ['Wonder Pets']),
    show('Ni Hao, Kai-Lan', 2007, ['preschool', 'educational'], ['morning', 'daytime'], 'random', ['Ni Hao Kai Lan']),
    show('Team Umizoomi', 2010, ['preschool', 'educational'], ['morning', 'daytime']),
    show('Bubble Guppies', 2011, ['preschool', 'music'], ['morning', 'afternoon']),
    show('PAW Patrol', 2013, ['preschool', 'teamwork'], ['morning', 'afternoon']),
    show('Blaze and the Monster Machines', 2014, ['preschool', 'educational'], ['morning', 'daytime']),
    show('Shimmer and Shine', 2015, ['preschool', 'fantasy'], ['daytime', 'afternoon']),
    show("Ryan's Mystery Playdate", 2019, ['preschool', 'interactive'], ['daytime', 'afternoon'], 'random', ['Ryans Mystery Playdate']),
  ]
}

function nickJrAliases(): readonly string[] {
  return nickJrSuggestions().flatMap((suggestion) => [
    suggestion.title,
    ...(suggestion.aliases ?? []),
  ])
}

function suggestionAliases(
  suggestions: readonly EraStationContentSuggestion[]
): Map<string, EraStationContentSuggestion> {
  const values = new Map<string, EraStationContentSuggestion>()
  for (const suggestion of suggestions) {
    for (const alias of [suggestion.title, ...(suggestion.aliases ?? [])]) {
      values.set(normalizeTitle(alias), suggestion)
    }
  }
  return values
}

function familyGuestAliases(
  suggestions: readonly EraStationFamilyMixGuest[]
): Map<string, EraStationFamilyMixGuest> {
  const values = new Map<string, EraStationFamilyMixGuest>()
  for (const suggestion of suggestions) {
    for (const alias of [suggestion.title, ...(suggestion.aliases ?? [])]) {
      values.set(normalizeTitle(alias), suggestion)
    }
  }
  return values
}

function familyGuestEligible(
  template: EraStationTemplate,
  guest: EraStationFamilyMixGuest
): boolean {
  const family = normalizeTitle(template.networkFamily)
  if (family.includes('toonami')) return guest.audiences.includes('action')
  if (family.includes('nick jr')) return guest.audiences.includes('preschool')
  return guest.audiences.includes('kids') || guest.audiences.includes('family')
}

function familyGuestBlocks(
  template: EraStationTemplate,
  guest: EraStationFamilyMixGuest
): readonly string[] {
  const preferred = guest.audiences.includes('preschool')
    ? ['morning', 'daytime', 'afternoon', 'bedtime']
    : guest.audiences.includes('action')
      ? ['after-school', 'daytime', 'toonami', 'primetime']
      : ['morning', 'daytime', 'after-school', 'primetime', 'afternoon']
  const matches = preferred
    .filter((id) => template.blocks.some((block) => block.id === id))
    .slice(0, 3)
  return matches.length > 0 ? matches : providerFallbackBlocks(template)
}

function matchesProvider(
  values: readonly string[],
  providerTerms: readonly string[]
): boolean {
  return values.some((rawValue) => {
    const value = normalizeTitle(rawValue)
    return providerTerms.some((term) => value.includes(normalizeTitle(term)))
  })
}

function eraMatchReason(
  year: number | null | undefined,
  value: EraStationTemplate
): 'era' | 'near-era' | null {
  if (!Number.isInteger(year)) return null
  if (year! >= value.era.startYear && year! <= value.era.endYear) return 'era'
  return year! >= value.era.startYear - value.era.softPaddingYears &&
    year! <= value.era.endYear + value.era.softPaddingYears
    ? 'near-era'
    : null
}

function providerFallbackBlocks(value: EraStationTemplate): readonly string[] {
  const preferred = [
    'daytime',
    'after-school',
    'afternoon',
    'primetime',
    'morning',
    'toonami',
  ]
    .filter((id) => value.blocks.some((candidate) => candidate.id === id))
    .slice(0, 2)
  return preferred.length > 0
    ? preferred
    : value.blocks[0]
      ? [value.blocks[0].id]
      : []
}

function inferredTags(collection: EraStationLibraryCollection): readonly string[] {
  return [...new Set(collection.genres.map((genre) => normalizeTitle(genre)).filter(Boolean))]
}

function defaultPlaybackOrder(value: EraStationTemplate): EraPlaybackOrder {
  return value.blocks.find((candidate) => candidate.id === 'primetime')
    ?.defaultPlaybackOrder ?? value.blocks[0]?.defaultPlaybackOrder ?? 'random'
}

function normalizeTitle(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLocaleLowerCase('en-US')
}

function scheduleMinutes(value: string, allowDayEnd = false): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) throw new Error(`Invalid template schedule time: ${value}`)
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (minute > 59 || hour > 24 || (hour === 24 && (!allowDayEnd || minute !== 0))) {
    throw new Error(`Invalid template schedule time: ${value}`)
  }
  return hour * 60 + minute
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'en-US', { sensitivity: 'base' })
}

validateEraStationTemplates(ERA_STATION_TEMPLATES)
