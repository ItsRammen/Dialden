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
  | 'abc3-2009-2016'
  | 'abc-me-2016-2024'
  | 'abc-family-au-2024-2026'
  | 'abc-kids-au-2009-2026'
  | 'cbbc-2002-2026'
  | 'cbeebies-2002-2026'
  | 'pbs-kids-1994-2026'
  | 'classic-cartoons-1955-1999'

export type StationNetworkId =
  | 'cartoon-network'
  | 'nickelodeon'
  | 'nick-jr'
  | 'disney-channel'
  | 'disney-junior'
  | 'toon-disney'
  | 'jetix'
  | 'toonami'
  | 'abc3-abc-me'
  | 'abc-family-au'
  | 'abc-kids-au'
  | 'cbbc'
  | 'cbeebies'
  | 'pbs-kids'

export type EraStationNetworkId = StationNetworkId | 'classic-cartoons'

export const NETWORK_COPY_CURRENT_YEAR = 2026

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
  /** Years this title was carried by this specific network. */
  readonly airStartYear?: number
  readonly airEndYear?: number
  readonly airWindowSource?: 'documented' | 'inferred'
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
  /** Stable network identity shared by all historical recipes for a station. */
  readonly networkId: EraStationNetworkId
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
  readonly airStartYear?: number
  readonly airEndYear?: number
  readonly eligibilityReason?:
    | 'curated-network-lineup'
    | 'documented-network-lineup'
    | 'exact-network-metadata'
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

export interface NetworkCopyProfile {
  readonly id: StationNetworkId
  readonly name: string
  readonly description: string
  /** Keeps preschool, school-age, and explicitly adult identities distinct in the builder. */
  readonly audience: 'preschool' | 'school-age' | 'after-hours'
  readonly availableStartYear: number
  readonly availableEndYear: number
  readonly defaultStartYear: number
  readonly defaultEndYear: number
  /** Exact normalized network labels accepted from metadata. */
  readonly networkTerms: readonly string[]
  readonly templateIds: readonly EraStationTemplateId[]
  readonly blocks: readonly EraStationBlockTemplate[]
  readonly suggestions: readonly EraStationContentSuggestion[]
  readonly moviePolicy: EraStationMoviePolicy
  readonly marathonDefaults: EraStationMarathonDefaults
}

export interface NetworkCopySelection {
  readonly startYear: number
  readonly endYear: number
  /** When supplied, including an empty array, this is an exclusive allow-list. */
  readonly selectedCollectionIds?: readonly number[]
}

export interface NetworkCopyAnalysis<
  TCollection extends EraStationLibraryCollection = EraStationLibraryCollection,
> extends EraStationTemplateAnalysis<TCollection> {
  readonly profile: NetworkCopyProfile
  readonly startYear: number
  readonly endYear: number
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

const ABC_SCHOOL_AGE_BLOCKS: readonly EraStationBlockTemplate[] = [
  block('closed-overnight', 'Off air overnight', '00:00', '06:00', ['off-air'], [30], 'random'),
  block('morning', 'Hosted morning', '06:00', '08:30', ['animation', 'comedy', 'family'], [15, 30], 'random'),
  block('curious', 'Curious and factual', '08:30', '13:00', ['educational', 'factual', 'nature'], [15, 30], 'sequential'),
  block('catch-up', 'Catch-up stacks', '13:00', '15:30', ['comedy', 'repeats'], [30], 'season-sequential'),
  block('after-school', 'After school', '15:30', '17:00', ['animation', 'comedy', 'adventure'], [15, 30], 'random'),
  block('australian', 'New and Australian', '17:00', '18:30', ['australian', 'premiere', 'factual'], [30], 'season-sequential'),
  block('family', 'Family co-viewing', '18:30', '19:30', ['family', 'comedy', 'drama'], [30, 60], 'season-sequential'),
  block('older-kids', 'Older-kid opt-in', '19:30', '21:00', ['older-kids', 'family'], [30], 'season-sequential'),
  block('closed-late', 'Off air late', '21:00', '24:00', ['off-air'], [30], 'random'),
]

const ABC_FAMILY_BLOCKS: readonly EraStationBlockTemplate[] = [
  block('overnight', 'On-demand overnight', '00:00', '06:00', ['repeats', 'family'], [30], 'random'),
  block('education', 'Education morning', '06:00', '11:00', ['educational', 'factual'], [15, 30], 'sequential'),
  block('daytime', 'School-age daytime', '11:00', '15:30', ['comedy', 'factual', 'family'], [30], 'random'),
  block('after-school', 'After school', '15:30', '19:30', ['animation', 'comedy', 'adventure'], [15, 30], 'random'),
  block('family', 'ABC Family co-viewing', '19:30', '22:00', ['family', 'comedy', 'nature'], [30, 60], 'season-sequential'),
  block('late', 'Family encore', '22:00', '24:00', ['family', 'repeats'], [30], 'random'),
]

const ABC_KIDS_BLOCKS: readonly EraStationBlockTemplate[] = [
  block('closed-overnight', 'Off air overnight', '00:00', '05:00', ['off-air'], [15, 30], 'random'),
  block('wake-up', 'Wake-up favourites', '05:00', '09:00', ['preschool', 'music', 'comedy'], [7, 15, 30], 'random'),
  block('learn-play', 'Learn and play', '09:00', '12:00', ['educational', 'interactive', 'preschool'], [7, 15, 30], 'sequential'),
  block('quiet-time', 'Quiet-time stories', '12:00', '15:00', ['calm', 'family', 'preschool'], [7, 15, 30], 'random'),
  block('afternoon', 'Afternoon adventures', '15:00', '17:30', ['adventure', 'comedy', 'preschool'], [7, 15, 30], 'random'),
  block('bedtime', 'Bedtime wind-down', '17:30', '19:30', ['calm', 'music', 'family'], [7, 15, 30], 'sequential'),
  block('closed-late', 'Off air late', '19:30', '24:00', ['off-air'], [15, 30], 'random'),
]

const CBBC_BLOCKS: readonly EraStationBlockTemplate[] = [
  block('closed-overnight', 'Off air overnight', '00:00', '07:00', ['off-air'], [30], 'random'),
  block('morning', 'Morning comedy', '07:00', '09:00', ['comedy', 'animation'], [15, 30], 'random'),
  block('school-day', 'Factual and catch-up', '09:00', '15:30', ['educational', 'factual', 'repeats'], [15, 30], 'sequential'),
  block('after-school', 'After school', '15:30', '18:00', ['comedy', 'adventure', 'animation'], [15, 30], 'random'),
  block('family', 'Family finish', '18:00', '19:00', ['family', 'drama', 'factual'], [30], 'season-sequential'),
  block('closed-late', 'Off air late', '19:00', '24:00', ['off-air'], [30], 'random'),
]

const CBEEBIES_BLOCKS: readonly EraStationBlockTemplate[] = [
  block('closed-overnight', 'Off air overnight', '00:00', '06:00', ['off-air'], [15, 30], 'random'),
  block('wake-up', 'Wake up', '06:00', '09:00', ['preschool', 'music'], [7, 15, 30], 'random'),
  block('discover', 'Discover and do', '09:00', '12:00', ['educational', 'creative'], [7, 15, 30], 'sequential'),
  block('quiet-time', 'Quiet-time stories', '12:00', '15:00', ['calm', 'stories'], [7, 15, 30], 'random'),
  block('afternoon', 'Afternoon play', '15:00', '17:00', ['preschool', 'adventure'], [7, 15, 30], 'random'),
  block('bedtime', 'Bedtime Hour', '17:00', '19:00', ['calm', 'stories', 'music'], [7, 15, 30], 'sequential'),
  block('closed-late', 'Off air late', '19:00', '24:00', ['off-air'], [15, 30], 'random'),
]

const PBS_KIDS_BLOCKS: readonly EraStationBlockTemplate[] = [
  block('overnight', 'Overnight favourites', '00:00', '06:00', ['repeats', 'calm'], [15, 30], 'random'),
  block('early-learning', 'Early learning', '06:00', '10:00', ['literacy', 'maths', 'preschool'], [15, 30], 'sequential'),
  block('explore', 'Explore and discover', '10:00', '14:00', ['science', 'nature', 'educational'], [15, 30], 'season-sequential'),
  block('afternoon', 'Afternoon stories', '14:00', '17:00', ['family', 'social-emotional'], [15, 30], 'random'),
  block('after-school', 'After-school problem solving', '17:00', '20:00', ['science', 'adventure', 'problem-solving'], [30], 'season-sequential'),
  block('family', 'Family wind-down', '20:00', '24:00', ['family', 'calm', 'repeats'], [15, 30], 'random'),
]

export const ERA_STATION_TEMPLATES: readonly EraStationTemplate[] = [
  template({
    id: 'cartoon-network-1997-2004',
    networkId: 'cartoon-network',
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
    networkId: 'cartoon-network',
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
    networkId: 'nickelodeon',
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
    networkId: 'nickelodeon',
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
    networkId: 'nick-jr',
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
    networkId: 'disney-channel',
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
    networkId: 'disney-channel',
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
    networkId: 'disney-junior',
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
      showRun('The Book of Pooh', 2001, 2003, ['preschool', 'calm'], ['morning', 'bedtime']),
      showRun('Higglytown Heroes', 2004, 2008, ['preschool', 'educational'], ['morning', 'daytime']),
      showRun('Johnny and the Sprites', 2005, 2009, ['preschool', 'music'], ['morning', 'afternoon']),
      showRun('Special Agent Oso', 2009, 2012, ['preschool', 'educational'], ['morning', 'daytime']),
      showRun('Jungle Junction', 2009, 2012, ['preschool', 'educational'], ['morning', 'daytime']),
    ],
    moviePolicy: { enabled: false, preferredBlockIds: [], cadence: 'none', note: 'Use occasional family specials rather than a routine feature-film block.' },
    marathonDefaults: { enabled: true, cadence: 'special-events', modes: ['show', 'category', 'playlist'], note: 'Prefer short themed stacks; routine all-day preschool marathons create excessive repetition.' },
  }),
  template({
    id: 'toon-disney-1998-2008',
    networkId: 'toon-disney',
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
    networkId: 'jetix',
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
    networkId: 'toonami',
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
    id: 'abc3-2009-2016',
    networkId: 'abc3-abc-me',
    name: 'ABC3 Best Of · 2009–2016',
    networkFamily: 'ABC3',
    description: 'An age-seven-focused ABC3 blend of Australian stories, factual discovery, light comedy, hosted mornings, and after-school premieres.',
    providerTerms: ['abc3'],
    excludedTitleAliases: ['Bluey'],
    blocks: ABC_SCHOOL_AGE_BLOCKS,
    suggestions: [
      showCarriage('My Place', 2009, 2009, 2011, ['australian', 'history', 'family'], ['curious', 'family'], 'story-order'),
      showCarriage('Prank Patrol', 2009, 2009, 2013, ['australian', 'comedy'], ['after-school', 'australian']),
      showCarriage('Good Game: Spawn Point', 2010, 2010, 2016, ['australian', 'games', 'factual'], ['curious', 'australian'], 'sequential', ['Good Game SP']),
      showCarriage('Dance Academy', 2010, 2010, 2013, ['australian', 'family', 'drama'], ['australian', 'family'], 'story-order'),
      showCarriage('Bushwhacked!', 2012, 2012, 2016, ['australian', 'nature', 'factual'], ['curious', 'australian'], 'season-sequential', ['Bushwhacked']),
      showCarriage('Little Lunch', 2015, 2015, 2016, ['australian', 'comedy', 'age-7'], ['after-school', 'australian', 'family'], 'season-sequential'),
      showCarriage('The Deep', 2015, 2015, 2016, ['animation', 'adventure', 'family'], ['after-school', 'family'], 'story-order'),
      showCarriage('Shaun the Sheep', 2007, 2009, 2016, ['animation', 'comedy', 'family'], ['morning', 'catch-up']),
      showCarriage('Mortified', 2006, 2009, 2016, ['australian', 'comedy', 'family'], ['after-school', 'family'], 'season-sequential'),
      showCarriage('Round the Twist', 1990, 2009, 2016, ['australian', 'comedy', 'fantasy'], ['catch-up', 'family'], 'season-sequential'),
    ],
    moviePolicy: {
      enabled: false,
      preferredBlockIds: [],
      cadence: 'none',
      note: 'The age-seven Best Of stays series-led; add a specifically documented family special manually.',
    },
    marathonDefaults: {
      enabled: true,
      cadence: 'special-events',
      modes: ['show', 'category', 'playlist'],
      note: 'Use a bounded weekend boxed set or a longer school-holiday stack, matching documented ABC3 practice.',
    },
  }),
  template({
    id: 'abc-me-2016-2024',
    networkId: 'abc3-abc-me',
    name: 'ABC ME Best Of · 2016–2024',
    networkFamily: 'ABC ME',
    description: 'An age-seven-focused digital-first ABC ME blend of Australian comedy, factual discovery, animation, and family co-viewing.',
    providerTerms: ['abc me'],
    excludedTitleAliases: ['Bluey'],
    blocks: ABC_SCHOOL_AGE_BLOCKS,
    suggestions: [
      showCarriage('Little Lunch', 2015, 2016, 2017, ['australian', 'comedy', 'age-7'], ['after-school', 'australian', 'family'], 'season-sequential'),
      showCarriage('Hardball', 2019, 2019, 2024, ['australian', 'comedy', 'sport', 'age-7'], ['after-school', 'australian', 'family'], 'story-order'),
      showCarriage('The InBESTigators', 2019, 2019, 2024, ['australian', 'mystery', 'comedy', 'age-7'], ['after-school', 'australian', 'family'], 'story-order', ['Inbestigators']),
      showCarriage('Good Game: Spawn Point', 2010, 2016, 2022, ['australian', 'games', 'factual'], ['curious', 'australian'], 'sequential', ['Good Game SP']),
      showCarriage('Bushwhacked!', 2012, 2016, 2017, ['australian', 'nature', 'factual'], ['curious', 'australian'], 'season-sequential', ['Bushwhacked']),
      showCarriage('The Deep', 2015, 2016, 2020, ['animation', 'adventure', 'family'], ['after-school', 'family'], 'story-order'),
      showCarriage('Operation Ouch!', 2012, 2016, 2024, ['science', 'factual', 'health'], ['curious', 'australian'], 'season-sequential', ['Operation Ouch']),
      showCarriage('Danger Mouse', 2015, 2016, 2020, ['animation', 'comedy', 'adventure'], ['morning', 'after-school'], 'season-sequential'),
      showCarriage('Arthur', 1996, 2016, 2018, ['animation', 'family', 'social-emotional'], ['morning', 'catch-up'], 'season-sequential'),
      showCarriage('Shaun the Sheep', 2007, 2016, 2021, ['animation', 'comedy', 'family'], ['morning', 'catch-up']),
      showCarriage('Mustangs FC', 2017, 2017, 2020, ['australian', 'family', 'sport'], ['australian', 'family'], 'story-order'),
      showCarriage('The Strange Chores', 2019, 2019, 2024, ['australian', 'animation', 'comedy'], ['after-school', 'australian'], 'story-order'),
      showCarriage('Spongo, Fuzz & Jalapeña', 2019, 2019, 2021, ['australian', 'animation', 'comedy'], ['after-school', 'australian'], 'season-sequential', ['Spongo Fuzz and Jalapena']),
      movieCarriage('A Close Shave', 1995, 2021, 2021, ['animation', 'family', 'seasonal'], ['family'], ['Wallace & Gromit: A Close Shave']),
      movieCarriage('A Shaun the Sheep Movie: Farmageddon', 2019, 2021, 2021, ['animation', 'family', 'seasonal'], ['family'], ['Shaun the Sheep: Farmageddon']),
    ],
    moviePolicy: {
      enabled: true,
      preferredBlockIds: ['family'],
      cadence: 'occasional',
      note: 'Use only documented seasonal or event films; ABC ME did not operate a routine weekly movie franchise.',
    },
    marathonDefaults: {
      enabled: true,
      cadence: 'special-events',
      modes: ['show', 'category', 'playlist'],
      note: 'Use weekend, launch-event, or school-holiday stacks and return to the ordinary rotation afterward.',
    },
  }),
  template({
    id: 'abc-family-au-2024-2026',
    networkId: 'abc-family-au',
    name: 'ABC Family / ABC iview · 2024–current',
    networkFamily: 'ABC Family / ABC iview',
    description: 'Current Australian school-age and family co-viewing drawn from the dedicated ABC iview children’s streams and ABC Family window.',
    providerTerms: ['abc family australia', 'abc iview'],
    blocks: ABC_FAMILY_BLOCKS,
    suggestions: [
      showCarriage('Little Lunch', 2015, 2024, 2026, ['australian', 'comedy', 'age-7'], ['daytime', 'after-school', 'family'], 'season-sequential'),
      showCarriage('Hardball', 2019, 2024, 2026, ['australian', 'comedy', 'sport', 'age-7'], ['after-school', 'family'], 'story-order'),
      showCarriage('The InBESTigators', 2019, 2024, 2026, ['australian', 'mystery', 'comedy', 'age-7'], ['after-school', 'family'], 'story-order', ['Inbestigators']),
      showCarriage('Hard Quiz Kids', 2024, 2024, 2026, ['australian', 'quiz', 'family'], ['education', 'family']),
      showCarriage('Style It Out', 2024, 2024, 2025, ['creative', 'family'], ['daytime', 'family'], 'season-sequential'),
      showCarriage('Deadly Mission Shark', 2023, 2024, 2025, ['nature', 'factual', 'family'], ['education', 'family'], 'season-sequential'),
      showCarriage('Expedition with Steve Backshall', 2019, 2024, 2025, ['nature', 'adventure', 'family'], ['education', 'family'], 'season-sequential'),
      showCarriage('Good Game: Spawn Point', 2010, 2025, 2026, ['australian', 'games', 'factual'], ['education', 'after-school'], 'sequential', ['Good Game SP']),
      showCarriage('Space Nova', 2021, 2025, 2026, ['australian', 'animation', 'science-fiction'], ['after-school', 'family'], 'story-order'),
      showCarriage('Behind the News', 1968, 2024, 2026, ['australian', 'news', 'educational'], ['education'], 'sequential', ['BTN']),
    ],
    moviePolicy: {
      enabled: false,
      preferredBlockIds: [],
      cadence: 'none',
      note: 'The strict catalog includes no film without a title-specific current ABC Family carriage record.',
    },
    marathonDefaults: {
      enabled: true,
      cadence: 'special-events',
      modes: ['show', 'category', 'playlist'],
      note: 'Use a short family event stack rather than treating the on-demand catalog as one continuous marathon.',
    },
  }),
  template({
    id: 'abc-kids-au-2009-2026',
    networkId: 'abc-kids-au',
    name: 'ABC Kids Australia · 2009–current',
    networkFamily: 'ABC Kids Australia',
    description: 'Australian preschool learning, imaginative play, gentle comedy, and a calm early-evening wind-down.',
    providerTerms: ['abc kids'],
    blocks: ABC_KIDS_BLOCKS,
    suggestions: [
      showCarriage('Play School', 1966, 2009, 2026, ['australian', 'preschool', 'creative'], ['wake-up', 'learn-play'], 'sequential'),
      showCarriage('Giggle and Hoot', 2009, 2009, 2019, ['australian', 'preschool', 'music'], ['wake-up', 'bedtime']),
      showCarriage('dirtgirlworld', 2009, 2009, 2017, ['australian', 'preschool', 'nature'], ['learn-play', 'afternoon'], 'season-sequential', ['Dirtgirlworld']),
      showCarriage('Peppa Pig', 2004, 2009, 2026, ['preschool', 'comedy', 'family'], ['wake-up', 'quiet-time']),
      showCarriage('Octonauts', 2010, 2010, 2026, ['preschool', 'science', 'adventure'], ['learn-play', 'afternoon'], 'season-sequential'),
      showCarriage('Hey Duggee', 2014, 2015, 2026, ['preschool', 'comedy', 'social-emotional'], ['wake-up', 'afternoon']),
      showCarriage('Numberblocks', 2017, 2017, 2026, ['preschool', 'maths', 'educational'], ['learn-play'], 'season-sequential'),
      showCarriage('Bluey', 2018, 2018, 2026, ['australian', 'preschool', 'family', 'comedy'], ['wake-up', 'afternoon', 'bedtime'], 'season-sequential'),
      showCarriage('Kiri and Lou', 2019, 2019, 2026, ['preschool', 'music', 'social-emotional'], ['quiet-time', 'bedtime'], 'season-sequential'),
      showCarriage('Kangaroo Beach', 2021, 2021, 2026, ['australian', 'preschool', 'water-safety'], ['learn-play', 'afternoon'], 'season-sequential'),
      showCarriage('Beep and Mort', 2022, 2022, 2026, ['australian', 'preschool', 'family'], ['quiet-time', 'bedtime'], 'season-sequential'),
      showCarriage('Ginger and the Vegesaurs', 2022, 2022, 2026, ['australian', 'preschool', 'comedy'], ['wake-up', 'afternoon']),
      showCarriage('Gardening Australia Junior', 2023, 2023, 2026, ['australian', 'nature', 'educational'], ['learn-play', 'afternoon'], 'sequential'),
    ],
    moviePolicy: {
      enabled: false,
      preferredBlockIds: [],
      cadence: 'none',
      note: 'Keep the preschool service episode-led and add longer specials only by explicit parent choice.',
    },
    marathonDefaults: {
      enabled: true,
      cadence: 'special-events',
      modes: ['show', 'category', 'playlist'],
      note: 'Prefer short themed stacks so the preschool rotation stays varied.',
    },
  }),
  template({
    id: 'cbbc-2002-2026',
    networkId: 'cbbc',
    name: 'CBBC · 2002–current',
    networkFamily: 'CBBC',
    description: 'British school-age comedy, factual discovery, drama, news, and an energetic after-school window.',
    providerTerms: ['cbbc'],
    blocks: CBBC_BLOCKS,
    suggestions: [
      showCarriage('Blue Peter', 1958, 2002, 2026, ['factual', 'creative', 'family'], ['school-day', 'family'], 'sequential'),
      showCarriage('Newsround', 1972, 2002, 2026, ['news', 'educational'], ['school-day', 'family'], 'sequential'),
      showCarriage('The Story of Tracy Beaker', 2002, 2002, 2006, ['comedy', 'drama', 'family'], ['after-school', 'family'], 'story-order'),
      showCarriage('Shaun the Sheep', 2007, 2007, 2026, ['animation', 'comedy', 'family'], ['morning', 'after-school']),
      showCarriage('Horrible Histories', 2009, 2009, 2026, ['history', 'comedy', 'educational'], ['school-day', 'after-school'], 'season-sequential'),
      showCarriage('Deadly 60', 2009, 2009, 2026, ['nature', 'factual', 'adventure'], ['school-day', 'family'], 'season-sequential'),
      showCarriage('Wolfblood', 2012, 2012, 2017, ['drama', 'fantasy', 'older-kids'], ['after-school', 'family'], 'story-order'),
      showCarriage('Operation Ouch!', 2012, 2012, 2026, ['science', 'factual', 'health'], ['school-day', 'after-school'], 'season-sequential', ['Operation Ouch']),
      showCarriage('The Dumping Ground', 2013, 2013, 2026, ['drama', 'family'], ['after-school', 'family'], 'story-order'),
      showCarriage('Odd Squad', 2014, 2015, 2026, ['comedy', 'maths', 'mystery'], ['school-day', 'after-school'], 'story-order'),
      showCarriage('Danger Mouse', 2015, 2015, 2024, ['animation', 'comedy', 'adventure'], ['morning', 'after-school'], 'season-sequential'),
      showCarriage('Hetty Feather', 2015, 2015, 2020, ['drama', 'history', 'family'], ['after-school', 'family'], 'story-order'),
      showCarriage('The Worst Witch', 2017, 2017, 2020, ['drama', 'fantasy', 'family'], ['after-school', 'family'], 'story-order'),
      showCarriage('Dennis & Gnasher: Unleashed!', 2017, 2017, 2021, ['animation', 'comedy'], ['morning', 'after-school'], 'season-sequential', ['Dennis and Gnasher Unleashed']),
    ],
    moviePolicy: {
      enabled: false,
      preferredBlockIds: [],
      cadence: 'none',
      note: 'This strict CBBC catalog stays series-led; add a documented film or special explicitly.',
    },
    marathonDefaults: {
      enabled: true,
      cadence: 'special-events',
      modes: ['show', 'category', 'playlist'],
      note: 'Use occasional franchise, holiday, or anniversary stacks around the ordinary after-school schedule.',
    },
  }),
  template({
    id: 'cbeebies-2002-2026',
    networkId: 'cbeebies',
    name: 'CBeebies · 2002–current',
    networkFamily: 'CBeebies',
    description: 'British preschool learning, music, imaginative play, gentle stories, and the familiar Bedtime Hour wind-down.',
    providerTerms: ['cbeebies'],
    blocks: CBEEBIES_BLOCKS,
    suggestions: [
      showCarriage('Teletubbies', 1997, 2002, 2026, ['preschool', 'music', 'movement'], ['wake-up', 'quiet-time']),
      showCarriage('Tweenies', 1999, 2002, 2016, ['preschool', 'music', 'creative'], ['wake-up', 'discover']),
      showCarriage('Balamory', 2002, 2002, 2010, ['preschool', 'community', 'music'], ['discover', 'quiet-time'], 'season-sequential'),
      showCarriage('Something Special', 2003, 2003, 2026, ['preschool', 'inclusive', 'educational'], ['discover', 'afternoon'], 'season-sequential'),
      showCarriage('Big Cook Little Cook', 2004, 2004, 2026, ['preschool', 'food', 'creative'], ['discover'], 'season-sequential'),
      showCarriage('Charlie and Lola', 2005, 2005, 2026, ['preschool', 'family', 'stories'], ['quiet-time', 'bedtime'], 'season-sequential'),
      showCarriage('In the Night Garden', 2007, 2007, 2026, ['preschool', 'calm', 'bedtime'], ['quiet-time', 'bedtime']),
      showCarriage('Octonauts', 2010, 2010, 2026, ['preschool', 'science', 'adventure'], ['discover', 'afternoon'], 'season-sequential'),
      showCarriage('Sarah & Duck', 2013, 2013, 2026, ['preschool', 'calm', 'stories'], ['quiet-time', 'bedtime'], 'season-sequential', ['Sarah and Duck']),
      showCarriage('Hey Duggee', 2014, 2014, 2026, ['preschool', 'comedy', 'social-emotional'], ['wake-up', 'afternoon']),
      showCarriage('Go Jetters', 2015, 2015, 2026, ['preschool', 'geography', 'adventure'], ['discover', 'afternoon'], 'season-sequential'),
      showCarriage('Numberblocks', 2017, 2017, 2026, ['preschool', 'maths', 'educational'], ['discover'], 'season-sequential'),
      showCarriage('Love Monster', 2020, 2020, 2026, ['preschool', 'social-emotional', 'stories'], ['quiet-time', 'bedtime'], 'season-sequential'),
      showCarriage('JoJo & Gran Gran', 2020, 2020, 2026, ['preschool', 'family', 'community'], ['quiet-time', 'bedtime'], 'season-sequential', ['JoJo and Gran Gran']),
      showCarriage('Bluey', 2018, 2021, 2026, ['preschool', 'family', 'comedy'], ['afternoon', 'bedtime'], 'season-sequential'),
      showCarriage('Colourblocks', 2022, 2022, 2026, ['preschool', 'art', 'educational'], ['discover']),
      showCarriage('Yukee', 2024, 2024, 2026, ['preschool', 'music', 'community'], ['wake-up', 'afternoon']),
    ],
    moviePolicy: {
      enabled: false,
      preferredBlockIds: [],
      cadence: 'none',
      note: 'Keep the preschool schedule short-form and episode-led.',
    },
    marathonDefaults: {
      enabled: true,
      cadence: 'special-events',
      modes: ['show', 'category', 'playlist'],
      note: 'Use short themed stacks and retain a varied Bedtime Hour.',
    },
  }),
  template({
    id: 'pbs-kids-1994-2026',
    networkId: 'pbs-kids',
    name: 'PBS KIDS · 1994–current',
    networkFamily: 'PBS KIDS',
    description: 'Public-media learning for preschool and early-elementary viewers, with literacy, maths, science, nature, and social-emotional stories.',
    providerTerms: ['pbs kids'],
    blocks: PBS_KIDS_BLOCKS,
    suggestions: [
      showCarriage("Mister Rogers' Neighborhood", 1968, 1994, 2001, ['family', 'social-emotional', 'calm'], ['early-learning', 'family']),
      showCarriage('Sesame Street', 1969, 1994, 2026, ['literacy', 'maths', 'social-emotional'], ['early-learning', 'afternoon'], 'season-sequential'),
      showCarriage('The Magic School Bus', 1994, 1994, 1998, ['science', 'adventure', 'educational'], ['explore', 'after-school'], 'season-sequential'),
      showCarriage('Wishbone', 1995, 1995, 1998, ['literacy', 'family', 'adventure'], ['explore', 'after-school'], 'story-order'),
      showCarriage('Arthur', 1996, 1996, 2026, ['literacy', 'family', 'social-emotional'], ['afternoon', 'family'], 'season-sequential'),
      showCarriage('Zoboomafoo', 1999, 1999, 2001, ['nature', 'science', 'family'], ['explore', 'afternoon'], 'season-sequential'),
      showCarriage('Cyberchase', 2002, 2002, 2026, ['maths', 'science', 'adventure'], ['explore', 'after-school'], 'story-order'),
      showCarriage('Curious George', 2006, 2006, 2026, ['science', 'problem-solving', 'family'], ['early-learning', 'explore'], 'season-sequential'),
      showCarriage('WordGirl', 2007, 2007, 2022, ['literacy', 'comedy', 'superhero'], ['early-learning', 'after-school'], 'season-sequential'),
      showCarriage('Wild Kratts', 2011, 2011, 2026, ['nature', 'science', 'adventure'], ['explore', 'after-school'], 'season-sequential'),
      showCarriage("Daniel Tiger's Neighborhood", 2012, 2012, 2026, ['preschool', 'social-emotional', 'family'], ['early-learning', 'afternoon'], 'season-sequential'),
      showCarriage('Peg + Cat', 2013, 2013, 2026, ['maths', 'comedy', 'problem-solving'], ['early-learning', 'explore'], 'season-sequential', ['Peg and Cat']),
      showCarriage('Odd Squad', 2014, 2014, 2026, ['maths', 'mystery', 'comedy'], ['explore', 'after-school'], 'story-order'),
      showCarriage('Nature Cat', 2015, 2015, 2026, ['nature', 'science', 'comedy'], ['explore', 'after-school'], 'season-sequential'),
      showCarriage('Molly of Denali', 2019, 2019, 2026, ['literacy', 'community', 'adventure'], ['afternoon', 'after-school'], 'story-order'),
      showCarriage('Xavier Riddle and the Secret Museum', 2019, 2019, 2026, ['history', 'social-emotional', 'adventure'], ['explore', 'after-school'], 'story-order'),
      showCarriage("Alma's Way", 2021, 2021, 2026, ['social-emotional', 'community', 'family'], ['afternoon', 'family'], 'season-sequential'),
      showCarriage('Work It Out Wombats!', 2023, 2023, 2026, ['computational-thinking', 'problem-solving', 'family'], ['explore', 'after-school'], 'season-sequential', ['Work It Out Wombats']),
      showCarriage('Lyla in the Loop', 2024, 2024, 2026, ['problem-solving', 'family', 'comedy'], ['explore', 'after-school'], 'season-sequential'),
    ],
    moviePolicy: {
      enabled: false,
      preferredBlockIds: [],
      cadence: 'none',
      note: 'The strict educational catalog remains series-led; movies require explicit parent curation.',
    },
    marathonDefaults: {
      enabled: true,
      cadence: 'special-events',
      modes: ['show', 'category', 'playlist'],
      note: 'Prefer a bounded curriculum or character event without reducing the everyday learning mix.',
    },
  }),
  template({
    id: 'classic-cartoons-1955-1999',
    networkId: 'classic-cartoons',
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

const CURRENT_NETWORK_SUGGESTIONS: Readonly<
  Partial<Record<StationNetworkId, readonly EraStationContentSuggestion[]>>
> = {
  'cartoon-network': [
    showCarriage('Looney Tunes', 1930, 1992, 2004, ['classic', 'shorts', 'comedy'], ['morning', 'daytime']),
    showCarriage('Tom and Jerry', 1940, 1992, 2016, ['classic', 'shorts', 'comedy'], ['morning', 'daytime']),
    showCarriage('Scooby-Doo, Where Are You!', 1969, 1992, 2004, ['classic', 'mystery'], ['morning', 'daytime']),
    showCarriage('Pokémon', 1997, 2002, 2017, ['anime', 'adventure'], ['morning', 'after-school'], 'season-sequential'),
    showRun('The Grim Adventures of Billy & Mandy', 2003, 2008, ['animation', 'comedy'], ['after-school', 'late']),
    showRun('Megas XLR', 2004, 2005, ['animation', 'action'], ['after-school', 'primetime']),
    showRun("My Gym Partner's a Monkey", 2005, 2008, ['animation', 'comedy'], ['daytime', 'after-school']),
    showRun('Total Drama', 2008, 2014, ['animation', 'comedy'], ['after-school', 'primetime']),
    showRun('Star Wars: The Clone Wars', 2008, 2013, ['animation', 'action'], ['after-school', 'primetime'], 'story-order'),
    showRun('Scooby-Doo! Mystery Incorporated', 2010, 2013, ['animation', 'mystery'], ['daytime', 'primetime'], 'story-order'),
    showRun('Ninjago: Masters of Spinjitzu', 2011, 2022, ['animation', 'action'], ['after-school', 'primetime'], 'story-order', ['LEGO Ninjago: Masters of Spinjitzu']),
    showRun('Adventure Time', 2010, 2018, ['animation', 'fantasy'], ['after-school', 'primetime']),
    showRun('Regular Show', 2010, 2017, ['animation', 'comedy'], ['primetime', 'late']),
    showRun('The Amazing World of Gumball', 2011, 2026, ['animation', 'comedy'], ['daytime', 'primetime']),
    showRun('Steven Universe', 2013, 2019, ['animation', 'fantasy'], ['after-school', 'primetime']),
    showRun('Teen Titans Go!', 2013, 2026, ['animation', 'comedy'], ['daytime', 'primetime']),
    showRun('Clarence', 2014, 2018, ['animation', 'comedy'], ['daytime', 'after-school']),
    showRun('Over the Garden Wall', 2014, 2014, ['animation', 'fantasy'], ['primetime', 'late'], 'story-order'),
    showRun('We Bare Bears', 2015, 2019, ['animation', 'comedy'], ['daytime', 'primetime']),
    showRun("OK K.O.! Let's Be Heroes", 2017, 2019, ['animation', 'action'], ['after-school', 'primetime']),
    showRun('Craig of the Creek', 2018, 2025, ['animation', 'adventure'], ['daytime', 'primetime']),
    showRun('Apple & Onion', 2018, 2021, ['animation', 'comedy'], ['daytime', 'after-school']),
    showRun('Victor and Valentino', 2019, 2022, ['animation', 'adventure'], ['daytime', 'primetime']),
    showRun('We Baby Bears', 2022, 2026, ['animation', 'comedy'], ['morning', 'daytime']),
    showRun('Tiny Toons Looniversity', 2023, 2025, ['animation', 'comedy'], ['daytime', 'primetime']),
    showRun('Iyanu', 2025, 2026, ['animation', 'adventure'], ['after-school', 'primetime'], 'story-order'),
    movie('Regular Show: The Movie', 2015, ['animation', 'special'], ['primetime']),
    movie('Steven Universe: The Movie', 2019, ['animation', 'special'], ['primetime']),
    movie('We Bare Bears: The Movie', 2020, ['animation', 'special'], ['primetime']),
  ],
  nickelodeon: [
    showRun('SpongeBob SquarePants', 1999, 2026, ['animation', 'comedy'], ['daytime', 'primetime']),
    showRun('Teenage Mutant Ninja Turtles', 2012, 2017, ['animation', 'action'], ['after-school', 'primetime'], 'story-order'),
    showRun('Harvey Beaks', 2015, 2017, ['animation', 'comedy'], ['daytime', 'after-school']),
    showRun('The Loud House', 2016, 2026, ['animation', 'comedy'], ['daytime', 'primetime']),
    showRun('The Casagrandes', 2019, 2022, ['animation', 'comedy'], ['daytime', 'primetime']),
    showRun("Kamp Koral: SpongeBob's Under Years", 2021, 2026, ['animation', 'comedy'], ['daytime', 'primetime']),
    showRun('The Patrick Star Show', 2021, 2026, ['animation', 'comedy'], ['daytime', 'primetime']),
    showRun('Big Nate', 2022, 2024, ['animation', 'comedy'], ['after-school', 'primetime']),
    showRun('Rock Paper Scissors', 2024, 2026, ['animation', 'comedy'], ['daytime', 'primetime']),
    showRun('The Fairly OddParents: A New Wish', 2024, 2026, ['animation', 'comedy'], ['daytime', 'primetime']),
    movie('Swindle', 2013, ['live-action', 'comedy'], ['primetime']),
    movie('Jinxed', 2013, ['live-action', 'comedy'], ['primetime']),
  ],
  'nick-jr': [
    showRun('Bubble Guppies', 2011, 2026, ['preschool', 'music'], ['morning', 'afternoon']),
    showRun('PAW Patrol', 2013, 2026, ['preschool', 'teamwork'], ['morning', 'afternoon']),
    showRun('Blaze and the Monster Machines', 2014, 2026, ['preschool', 'educational'], ['morning', 'daytime']),
    showRun("Blue's Clues & You!", 2019, 2024, ['preschool', 'educational'], ['morning', 'daytime']),
    showRun('Santiago of the Seas', 2020, 2023, ['preschool', 'adventure'], ['morning', 'afternoon']),
    showRun("Baby Shark's Big Show!", 2020, 2026, ['preschool', 'music'], ['morning', 'afternoon']),
    showRun('Rubble & Crew', 2023, 2026, ['preschool', 'teamwork'], ['morning', 'daytime']),
    showRun('Dora', 2024, 2026, ['preschool', 'interactive'], ['morning', 'daytime']),
  ],
  'disney-channel': [
    showRun('Liv and Maddie', 2013, 2017, ['live-action', 'comedy'], ['after-school', 'primetime']),
    showRun('Girl Meets World', 2014, 2017, ['live-action', 'comedy'], ['after-school', 'primetime']),
    showRun('K.C. Undercover', 2015, 2018, ['live-action', 'comedy'], ['after-school', 'primetime']),
    showRun("Star vs. the Forces of Evil", 2015, 2019, ['animation', 'fantasy'], ['after-school', 'primetime'], 'story-order'),
    showRun("Raven's Home", 2017, 2023, ['live-action', 'comedy'], ['after-school', 'primetime']),
    showRun('Big City Greens', 2018, 2026, ['animation', 'comedy'], ['daytime', 'primetime']),
    showRun('Amphibia', 2019, 2022, ['animation', 'fantasy'], ['after-school', 'primetime'], 'story-order'),
    showRun('The Owl House', 2020, 2023, ['animation', 'fantasy'], ['after-school', 'primetime'], 'story-order'),
    showRun('The Ghost and Molly McGee', 2021, 2024, ['animation', 'comedy'], ['daytime', 'primetime']),
    showRun('Marvel\'s Moon Girl and Devil Dinosaur', 2023, 2025, ['animation', 'superhero'], ['after-school', 'primetime']),
    showRun('Kiff', 2023, 2026, ['animation', 'comedy'], ['daytime', 'primetime']),
    showRun('Primos', 2024, 2026, ['animation', 'comedy'], ['daytime', 'primetime']),
    movie('Descendants', 2015, ['music', 'family'], ['primetime']),
    movie('Zombies', 2018, ['music', 'family'], ['primetime']),
  ],
  'disney-junior': [
    showRun('Doc McStuffins', 2012, 2020, ['preschool', 'educational'], ['morning', 'daytime']),
    showRun('Sofia the First', 2013, 2018, ['preschool', 'fantasy'], ['morning', 'afternoon']),
    showRun('Miles from Tomorrowland', 2015, 2018, ['preschool', 'science-fiction'], ['morning', 'daytime']),
    showRun('Elena of Avalor', 2016, 2020, ['preschool', 'fantasy'], ['daytime', 'afternoon']),
    showRun('Muppet Babies', 2018, 2022, ['preschool', 'comedy'], ['morning', 'daytime']),
    showRun('Mickey Mouse Funhouse', 2021, 2026, ['preschool', 'comedy'], ['morning', 'daytime']),
    showRun('SuperKitties', 2023, 2026, ['preschool', 'adventure'], ['morning', 'afternoon']),
  ],
}

export const NETWORK_COPY_PROFILES: readonly NetworkCopyProfile[] = [
  networkProfile('cartoon-network', 'Cartoon Network', 'Cartoon Network programming only, including documented acquisitions that aired on the network.', 'school-age', ['cartoon network'], 1992, 1997, NETWORK_COPY_CURRENT_YEAR),
  networkProfile('nickelodeon', 'Nickelodeon', 'Nickelodeon and Nicktoons programming, kept separate from Nick Jr. preschool titles.', 'school-age', ['nickelodeon', 'nicktoons'], 1979, 1991, NETWORK_COPY_CURRENT_YEAR),
  networkProfile('nick-jr', 'Nick Jr.', 'Nick Jr. preschool programming only.', 'preschool', ['nick jr', 'nick jr.'], 1988, 1996, NETWORK_COPY_CURRENT_YEAR),
  networkProfile('disney-channel', 'Disney Channel', 'Disney Channel programming and original movie events only.', 'school-age', ['disney channel'], 1983, 1997, NETWORK_COPY_CURRENT_YEAR),
  networkProfile('disney-junior', 'Playhouse Disney / Disney Junior', 'Playhouse Disney and Disney Junior preschool programming only.', 'preschool', ['playhouse disney', 'disney junior'], 1997, 1997, NETWORK_COPY_CURRENT_YEAR),
  networkProfile('toon-disney', 'Toon Disney', 'Programming documented on Toon Disney during its historical run.', 'school-age', ['toon disney'], 1998, 1998, 2009),
  networkProfile('jetix', 'Jetix', 'Programming documented in the Jetix action block and channel lineup.', 'school-age', ['jetix'], 2004, 2004, 2009),
  networkProfile('toonami', 'Toonami (1997–2008)', 'The original child/family-era Toonami block only. Adult Swim-era programming is deliberately excluded.', 'school-age', ['toonami'], 1997, 1997, 2008),
  networkProfile('abc3-abc-me', 'ABC3 / ABC ME Best Of', 'An Australian public-broadcaster Best Of focused on age-seven-friendly titles documented on ABC3 or ABC ME; Bluey remains in ABC Kids.', 'school-age', ['abc3', 'abc me'], 2009, 2009, 2024),
  networkProfile('abc-family-au', 'ABC Family / ABC iview', 'Current Australian school-age and family co-viewing from ABC Family and the dedicated children’s streams in ABC iview.', 'school-age', ['abc family australia', 'abc iview'], 2024, 2024, NETWORK_COPY_CURRENT_YEAR),
  networkProfile('abc-kids-au', 'ABC Kids Australia', 'ABC Kids preschool programming only, kept separate from ABC3, ABC ME, and the current school-age ABC Family identity.', 'preschool', ['abc kids'], 2009, 2009, NETWORK_COPY_CURRENT_YEAR),
  networkProfile('cbbc', 'CBBC', 'CBBC school-age comedy, drama, news, factual, animation, and documented acquisitions.', 'school-age', ['cbbc'], 2002, 2002, NETWORK_COPY_CURRENT_YEAR),
  networkProfile('cbeebies', 'CBeebies', 'CBeebies preschool learning, stories, music, and bedtime programming only.', 'preschool', ['cbeebies'], 2002, 2002, NETWORK_COPY_CURRENT_YEAR),
  networkProfile('pbs-kids', 'PBS KIDS', 'PBS KIDS public-media learning for preschool and early-elementary viewers.', 'school-age', ['pbs kids'], 1994, 1994, NETWORK_COPY_CURRENT_YEAR),
]

export function getNetworkCopyProfile(id: StationNetworkId): NetworkCopyProfile {
  const profile = NETWORK_COPY_PROFILES.find((candidate) => candidate.id === id)
  if (!profile) throw new Error(`Unknown station network: ${id}`)
  return profile
}

export function isStationNetworkId(value: string): value is StationNetworkId {
  return NETWORK_COPY_PROFILES.some((profile) => profile.id === value)
}

export function getNetworkCopyScheduleTemplate(
  profileOrId: NetworkCopyProfile | StationNetworkId,
  startYear?: number,
  endYear?: number
): EraStationTemplate {
  const profile =
    typeof profileOrId === 'string'
      ? getNetworkCopyProfile(profileOrId)
      : profileOrId
  const selectedStart = startYear ?? profile.defaultStartYear
  const selectedEnd = endYear ?? profile.defaultEndYear
  validateNetworkCopyYears(profile, selectedStart, selectedEnd)
  return profile.templateIds
    .map(getEraStationTemplate)
    .sort((left, right) => {
      const overlap = (candidate: EraStationTemplate) =>
        Math.max(
          0,
          Math.min(candidate.era.endYear, selectedEnd) -
            Math.max(candidate.era.startYear, selectedStart) +
            1
        )
      return (
        overlap(right) - overlap(left) ||
        Math.abs(right.era.endYear - selectedEnd) -
          Math.abs(left.era.endYear - selectedEnd)
      )
    })[0]!
}

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
 * conservative fallback. Network-copy callers default to historical fidelity;
 * family-mix guests are available only when a separate general-purpose caller
 * opts in explicitly.
 */
export function analyzeEraStationTemplate<
  TCollection extends EraStationLibraryCollection,
>(
  templateOrId: EraStationTemplate | EraStationTemplateId,
  collections: readonly TCollection[],
  fidelity: EraStationFidelity = 'historical'
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
    if (collection.libraryKind !== 'tv' && collection.libraryKind !== 'movie') {
      continue
    }
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

/**
 * Analyze a first-class network copy. Unlike broad genre presets this is
 * deliberately fail-closed: a title needs a curated affiliation or matching
 * network metadata, must overlap the requested years, and an explicit title
 * selection can only narrow that set.
 */
export function analyzeNetworkCopyProfile<
  TCollection extends EraStationLibraryCollection,
>(
  profileOrId: NetworkCopyProfile | StationNetworkId,
  collections: readonly TCollection[],
  selection?: Partial<NetworkCopySelection>
): NetworkCopyAnalysis<TCollection> {
  const profile =
    typeof profileOrId === 'string'
      ? getNetworkCopyProfile(profileOrId)
      : profileOrId
  const startYear = selection?.startYear ?? profile.defaultStartYear
  const endYear = selection?.endYear ?? profile.defaultEndYear
  validateNetworkCopyYears(profile, startYear, endYear)
  const selectedIds =
    selection?.selectedCollectionIds === undefined
      ? null
      : new Set(selection.selectedCollectionIds)
  const suggestions = profile.suggestions.filter((suggestion) =>
    suggestionOverlapsYears(suggestion, startYear, endYear)
  )
  const suggestionsByAlias = suggestionAliasLists(suggestions)
  const knownAffiliations = knownTitleNetworkAffiliations()
  const matches: EraStationLibraryMatch<TCollection>[] = []
  const ownedSuggestions = new Set<EraStationContentSuggestion>()

  for (const collection of collections) {
    if (collection.libraryKind !== 'tv' && collection.libraryKind !== 'movie') {
      continue
    }
    const normalizedTitle = normalizeTitle(collection.displayTitle)
    const curated = (suggestionsByAlias.get(normalizedTitle) ?? []).find(
      (suggestion) =>
        suggestion.libraryKind === collection.libraryKind &&
        (!Number.isInteger(collection.firstAirYear) ||
          (collection.firstAirYear! >= suggestion.firstYear &&
            collection.firstAirYear! <=
              (suggestion.lastYear ?? suggestion.firstYear)))
    )
    if (curated) ownedSuggestions.add(curated)
    if (selectedIds && !selectedIds.has(collection.id)) continue

    const titleAffiliations = knownAffiliations.get(normalizedTitle)
    if (titleAffiliations && !titleAffiliations.has(profile.id)) continue
    const networkMatched = matchesExactNetwork(
      collection.networks,
      profile.networkTerms
    )
    const metadataEligible =
      networkMatched && parentNetworkMetadataIsSufficient(profile.id)
    if (!curated && !metadataEligible) continue
    if (collection.libraryKind === 'movie' && !curated) continue
    if (
      !curated &&
      (!Number.isInteger(collection.firstAirYear) ||
        collection.firstAirYear! < startYear ||
        collection.firstAirYear! > endYear)
    ) {
      continue
    }

    const reasons: EraStationMatchReason[] = []
    let score = 0
    if (curated) {
      reasons.push('curated-title')
      score += 100
      if (curated.libraryKind === 'movie') reasons.push('movie')
    }
    if (metadataEligible) {
      reasons.push('network')
      score += 60
    }
    reasons.push('era')
    score += 20
    matches.push({
      collection,
      score,
      reasons,
      airStartYear:
        curated?.airStartYear ?? curated?.firstYear ?? collection.firstAirYear!,
      airEndYear:
        curated?.airEndYear ??
        curated?.airStartYear ??
        curated?.firstYear ??
        collection.firstAirYear!,
      eligibilityReason: curated
        ? curated.airWindowSource === 'documented'
          ? 'documented-network-lineup'
          : 'curated-network-lineup'
        : 'exact-network-metadata',
      blockIds: curated?.blockIds ?? networkFallbackBlocks(profile),
      tags: curated?.tags ?? inferredTags(collection),
      weight: curated?.weight ?? 5,
      playbackOrder:
        curated?.playbackOrder ??
        profile.blocks.find((block) => block.id === 'primetime')
          ?.defaultPlaybackOrder ??
        profile.blocks[0]?.defaultPlaybackOrder ??
        'random',
    })
  }

  matches.sort(
    (left, right) =>
      right.score - left.score ||
      compareText(left.collection.displayTitle, right.collection.displayTitle)
  )
  const missingSuggestions = suggestions
    .filter((suggestion) => !ownedSuggestions.has(suggestion))
    .sort(
      (left, right) =>
        right.weight - left.weight || compareText(left.title, right.title)
    )
  const template = getNetworkCopyScheduleTemplate(profile, startYear, endYear)
  return {
    profile,
    template,
    startYear,
    endYear,
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

export function validateNetworkCopyProfiles(
  profiles: readonly NetworkCopyProfile[]
): void {
  const ids = new Set<StationNetworkId>()
  for (const profile of profiles) {
    if (ids.has(profile.id)) {
      throw new Error(`Duplicate network-copy profile ID: ${profile.id}`)
    }
    ids.add(profile.id)
    if (
      !Number.isInteger(profile.availableStartYear) ||
      !Number.isInteger(profile.availableEndYear) ||
      profile.availableStartYear > profile.defaultStartYear ||
      profile.defaultStartYear > profile.defaultEndYear ||
      profile.defaultEndYear > profile.availableEndYear
    ) {
      throw new Error(`Network-copy profile ${profile.id} has invalid years`)
    }
    if (
      profile.templateIds.length === 0 ||
      profile.templateIds.some(
        (templateId) => getEraStationTemplate(templateId).networkId !== profile.id
      )
    ) {
      throw new Error(`Network-copy profile ${profile.id} has invalid templates`)
    }
    const blockIds = new Set(profile.blocks.map((blockValue) => blockValue.id))
    const aliases = new Map<string, EraStationContentSuggestion>()
    for (const suggestion of profile.suggestions) {
      const airStartYear = suggestion.airStartYear ?? suggestion.firstYear
      const airEndYear =
        suggestion.airEndYear ?? suggestion.airStartYear ?? suggestion.firstYear
      if (
        airStartYear < profile.availableStartYear ||
        airEndYear > profile.availableEndYear ||
        airStartYear > airEndYear ||
        suggestion.blockIds.some((blockId) => !blockIds.has(blockId))
      ) {
        throw new Error(
          `Network-copy profile ${profile.id} has an invalid suggestion`
        )
      }
      for (const alias of [suggestion.title, ...(suggestion.aliases ?? [])]) {
        const normalized = normalizeTitle(alias)
        const prior = aliases.get(normalized)
        if (prior && prior !== suggestion) {
          throw new Error(
            `Network-copy profile ${profile.id} has an ambiguous suggestion alias`
          )
        }
        aliases.set(normalized, suggestion)
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

function movieCarriage(
  title: string,
  firstYear: number,
  airStartYear: number,
  airEndYear: number,
  tags: readonly string[],
  blockIds: readonly string[],
  aliases?: readonly string[]
): EraStationContentSuggestion {
  return {
    ...movie(title, firstYear, tags, blockIds, aliases),
    airStartYear,
    airEndYear,
    airWindowSource: 'documented',
  }
}

function showRun(
  title: string,
  firstYear: number,
  lastYear: number,
  tags: readonly string[],
  blockIds: readonly string[],
  playbackOrder: EraPlaybackOrder = 'random',
  aliases?: readonly string[]
): EraStationContentSuggestion {
  return {
    ...show(title, firstYear, tags, blockIds, playbackOrder, aliases),
    lastYear,
    airStartYear: firstYear,
    airEndYear: lastYear,
    airWindowSource: 'documented',
  }
}

function showCarriage(
  title: string,
  firstYear: number,
  airStartYear: number,
  airEndYear: number,
  tags: readonly string[],
  blockIds: readonly string[],
  playbackOrder: EraPlaybackOrder = 'random',
  aliases?: readonly string[]
): EraStationContentSuggestion {
  return {
    ...show(title, firstYear, tags, blockIds, playbackOrder, aliases),
    airStartYear,
    airEndYear,
    airWindowSource: 'documented',
  }
}

function networkProfile(
  id: StationNetworkId,
  name: string,
  description: string,
  audience: NetworkCopyProfile['audience'],
  networkTerms: readonly string[],
  availableStartYear: number,
  defaultStartYear: number,
  availableEndYear: number
): NetworkCopyProfile {
  const templates = ERA_STATION_TEMPLATES.filter(
    (candidate) => candidate.networkId === id
  )
  if (templates.length === 0) {
    throw new Error(`Network ${id} has no scheduling template`)
  }
  const historical = templates.flatMap((candidate) =>
    candidate.suggestions.map((suggestion) => ({
      ...suggestion,
      airStartYear:
        suggestion.airStartYear ??
        Math.max(suggestion.firstYear, availableStartYear),
      airEndYear:
        suggestion.airEndYear ??
        Math.max(suggestion.firstYear, candidate.era.endYear),
      airWindowSource: suggestion.airWindowSource ?? 'inferred',
    }))
  )
  const suggestions = mergeNetworkSuggestions([
    ...historical,
    ...(CURRENT_NETWORK_SUGGESTIONS[id] ?? []),
  ])
  const templateValue = templates[templates.length - 1]!
  return {
    id,
    name,
    description,
    audience,
    availableStartYear,
    availableEndYear,
    defaultStartYear,
    defaultEndYear: availableEndYear,
    networkTerms,
    templateIds: templates.map((candidate) => candidate.id),
    blocks: templateValue.blocks,
    suggestions,
    moviePolicy: templateValue.moviePolicy,
    marathonDefaults: templateValue.marathonDefaults,
  }
}

function mergeNetworkSuggestions(
  suggestions: readonly EraStationContentSuggestion[]
): readonly EraStationContentSuggestion[] {
  const values = new Map<string, EraStationContentSuggestion>()
  for (const suggestion of suggestions) {
    const key = `${suggestion.libraryKind}:${normalizeTitle(suggestion.title)}`
    const prior = values.get(key)
    if (!prior) {
      values.set(key, suggestion)
      continue
    }
    values.set(key, {
      ...prior,
      firstYear: Math.min(prior.firstYear, suggestion.firstYear),
      lastYear: Math.max(
        prior.lastYear ?? prior.firstYear,
        suggestion.lastYear ?? suggestion.firstYear
      ),
      airStartYear: Math.min(
        prior.airStartYear ?? prior.firstYear,
        suggestion.airStartYear ?? suggestion.firstYear
      ),
      airEndYear: Math.max(
        prior.airEndYear ?? prior.lastYear ?? prior.firstYear,
        suggestion.airEndYear ?? suggestion.lastYear ?? suggestion.firstYear
      ),
      airWindowSource:
        prior.airWindowSource === 'documented' &&
        suggestion.airWindowSource === 'documented'
          ? 'documented'
          : 'inferred',
      aliases: [
        ...new Set([...(prior.aliases ?? []), ...(suggestion.aliases ?? [])]),
      ],
      tags: [...new Set([...prior.tags, ...suggestion.tags])],
      blockIds: [...new Set([...prior.blockIds, ...suggestion.blockIds])],
      weight: Math.max(prior.weight, suggestion.weight),
    })
  }
  return [...values.values()].sort(
    (left, right) =>
      left.firstYear - right.firstYear || compareText(left.title, right.title)
  )
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
    showRun("Eureeka's Castle", 1989, 1995, ['preschool', 'puppetry'], ['morning', 'daytime']),
    showRun("Gullah Gullah Island", 1994, 1998, ['preschool', 'music'], ['morning', 'daytime']),
    showRun("Allegra's Window", 1994, 1996, ['preschool', 'music'], ['morning', 'daytime']),
    showRun('Little Bear', 1995, 2003, ['preschool', 'calm'], ['daytime', 'bedtime']),
    show("Blue's Clues", 1996, ['preschool', 'educational'], ['morning', 'daytime'], 'sequential', ['Blues Clues']),
    show('Dora the Explorer', 2000, ['preschool', 'interactive'], ['morning', 'daytime']),
    show('Franklin', 1997, ['preschool', 'calm'], ['daytime', 'bedtime'], 'season-sequential'),
    show('Little Bill', 1999, ['preschool', 'calm'], ['daytime', 'bedtime']),
    show('Oswald', 2001, ['preschool', 'calm'], ['daytime', 'bedtime']),
    show('Max & Ruby', 2002, ['preschool', 'calm'], ['daytime', 'bedtime'], 'random', ['Max and Ruby']),
    show('The Backyardigans', 2004, ['preschool', 'music'], ['morning', 'afternoon']),
    showRun('LazyTown', 2004, 2014, ['preschool', 'movement'], ['morning', 'afternoon']),
    show('Wonder Pets!', 2006, ['preschool', 'music'], ['morning', 'afternoon'], 'random', ['Wonder Pets']),
    show('Ni Hao, Kai-Lan', 2007, ['preschool', 'educational'], ['morning', 'daytime'], 'random', ['Ni Hao Kai Lan']),
    showRun('The Fresh Beat Band', 2009, 2013, ['preschool', 'music'], ['morning', 'afternoon']),
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

function matchesExactNetwork(
  values: readonly string[],
  networkTerms: readonly string[]
): boolean {
  const terms = new Set(networkTerms.map(normalizeTitle))
  return values.some((value) => terms.has(normalizeTitle(value)))
}

function parentNetworkMetadataIsSufficient(id: StationNetworkId): boolean {
  // TMDB often records preschool block programmes only under their parent
  // linear network. Those labels cannot distinguish Nick from Nick Jr. or
  // Disney Channel from Playhouse/Disney Junior. Australian ABC labels are
  // similarly easy to collapse across ABC Kids, ABC3/ME, iview, and ABC
  // Family. These profiles therefore require a curated title affiliation.
  return ![
    'nickelodeon',
    'disney-channel',
    'abc3-abc-me',
    'abc-family-au',
    'abc-kids-au',
  ].includes(id)
}

function suggestionAliasLists(
  suggestions: readonly EraStationContentSuggestion[]
): Map<string, EraStationContentSuggestion[]> {
  const values = new Map<string, EraStationContentSuggestion[]>()
  for (const suggestion of suggestions) {
    for (const alias of [suggestion.title, ...(suggestion.aliases ?? [])]) {
      const key = normalizeTitle(alias)
      values.set(key, [...(values.get(key) ?? []), suggestion])
    }
  }
  return values
}

function knownTitleNetworkAffiliations(): Map<string, Set<StationNetworkId>> {
  const affiliations = new Map<string, Set<StationNetworkId>>()
  for (const profile of NETWORK_COPY_PROFILES) {
    for (const suggestion of profile.suggestions) {
      for (const alias of [suggestion.title, ...(suggestion.aliases ?? [])]) {
        const key = normalizeTitle(alias)
        const networkIds = affiliations.get(key) ?? new Set<StationNetworkId>()
        networkIds.add(profile.id)
        affiliations.set(key, networkIds)
      }
    }
  }
  return affiliations
}

function suggestionOverlapsYears(
  suggestion: EraStationContentSuggestion,
  startYear: number,
  endYear: number
): boolean {
  const airStartYear = suggestion.airStartYear ?? suggestion.firstYear
  const airEndYear =
    suggestion.airEndYear ?? suggestion.airStartYear ?? suggestion.firstYear
  return airStartYear <= endYear && airEndYear >= startYear
}

function validateNetworkCopyYears(
  profile: NetworkCopyProfile,
  startYear: number,
  endYear: number
): void {
  if (
    !Number.isInteger(startYear) ||
    !Number.isInteger(endYear) ||
    startYear < profile.availableStartYear ||
    endYear > profile.availableEndYear ||
    startYear > endYear
  ) {
    throw new Error(
      `${profile.name} years must be from ${profile.availableStartYear} to ${profile.availableEndYear}`
    )
  }
}

function networkFallbackBlocks(
  profile: NetworkCopyProfile
): readonly string[] {
  const playableBlocks = profile.blocks.filter(isPlayableTemplateBlock)
  const preferred = [
    'daytime',
    'after-school',
    'afternoon',
    'primetime',
    'morning',
    'toonami',
  ]
    .filter((id) => playableBlocks.some((candidate) => candidate.id === id))
    .slice(0, 2)
  return preferred.length > 0
    ? preferred
    : playableBlocks[0]
      ? [playableBlocks[0].id]
      : []
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
  const playableBlocks = value.blocks.filter(isPlayableTemplateBlock)
  const preferred = [
    'daytime',
    'after-school',
    'afternoon',
    'primetime',
    'morning',
    'toonami',
  ]
    .filter((id) => playableBlocks.some((candidate) => candidate.id === id))
    .slice(0, 2)
  return preferred.length > 0
    ? preferred
    : playableBlocks[0]
      ? [playableBlocks[0].id]
      : []
}

function isPlayableTemplateBlock(block: EraStationBlockTemplate): boolean {
  return !block.tags.some((tag) => normalizeTitle(tag) === 'off air')
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
validateNetworkCopyProfiles(NETWORK_COPY_PROFILES)
