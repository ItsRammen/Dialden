import type { IMediaRepository } from '../repositories/IMediaRepository'
import type { LibraryKind, MediaCollection } from '../types'
import type { ChannelScheduleSlot } from '../config/library'
import {
  analyzeNetworkCopyProfile,
  analyzeEraStationTemplate,
  ERA_STATION_TEMPLATES,
  getNetworkCopyProfile,
  getNetworkCopyScheduleTemplate,
  getEraStationTemplate,
  isStationNetworkId,
  NETWORK_COPY_PROFILES,
  type EraPlaybackOrder,
  type EraStationTemplateId,
  type StationNetworkId,
} from './EraStationTemplateService'

export type { StationNetworkId } from './EraStationTemplateService'

export type StationPresetId =
  | EraStationTemplateId
  | 'network-copy'
  | 'all-approved-tv'
  | 'family-animation'
  | 'nature-documentaries'
  | 'nickelodeon-style'
  | 'nick-jr-style'
  | 'movie-night'
  | 'custom'

export type StationAirtimeId =
  | 'all-day'
  | 'school-day'
  | 'evening'
  | 'weekend-mornings'

export const STATION_AIRTIME_OPTIONS: ReadonlyArray<{
  id: StationAirtimeId
  name: string
  description: string
}> = [
  {
    id: 'all-day',
    name: 'All day',
    description: 'Every day, 00:00–24:00',
  },
  {
    id: 'school-day',
    name: 'Before + after school',
    description: 'Weekdays, 06:30–08:30 and 15:00–20:00',
  },
  {
    id: 'evening',
    name: 'Evening',
    description: 'Every day, 17:00–21:00',
  },
  {
    id: 'weekend-mornings',
    name: 'Weekend mornings',
    description: 'Saturday + Sunday, 07:00–12:00',
  },
]

export interface StationCollectionOption {
  readonly id: number
  readonly rootId: string
  readonly identityKey: string
  readonly collectionTitle: string
  readonly displayTitle: string
  readonly libraryKind: LibraryKind
  readonly genres: readonly string[]
  readonly networks: readonly string[]
  readonly studios: readonly string[]
  readonly firstAirYear?: number | null
  readonly eligibleFiles: number
}

export interface StationFacet {
  readonly name: string
  readonly collections: number
}

export interface StationPresetSummary {
  readonly id: StationPresetId
  readonly name: string
  readonly description: string
  readonly matchedCollections: number
  readonly unofficial?: boolean
}

export interface StationEraTemplateSuggestionSummary {
  readonly title: string
  readonly libraryKind: Extract<LibraryKind, 'tv' | 'movie'>
  readonly firstYear: number
  readonly tags: readonly string[]
}

export interface StationEraTemplateMatchSummary {
  readonly collectionId: number
  readonly title: string
  readonly libraryKind: LibraryKind
  readonly blockIds: readonly string[]
  readonly playbackOrder: EraPlaybackOrder
  readonly score: number
  readonly relationship: 'historical' | 'family-guest'
}

export interface StationNetworkProfileSummary {
  readonly id: StationNetworkId
  readonly name: string
  readonly description: string
  readonly audience: 'preschool' | 'school-age' | 'after-hours'
  readonly availableStartYear: number
  readonly availableEndYear: number
  readonly defaultStartYear: number
  readonly defaultEndYear: number
  readonly blocks: StationEraTemplateSummary['blocks']
  readonly matches: readonly StationNetworkProfileMatchSummary[]
  readonly missingSuggestions: readonly (StationEraTemplateSuggestionSummary & {
    readonly lastYear?: number
    readonly airStartYear: number
    readonly airEndYear: number
  })[]
  readonly matchedShows: number
  readonly matchedMovies: number
  readonly movieCadence: string
  readonly marathonCadence: string
}

export interface StationNetworkProfileMatchSummary {
  readonly collectionId: number
  readonly title: string
  readonly libraryKind: LibraryKind
  readonly firstAirYear?: number | null
  readonly airStartYear: number
  readonly airEndYear: number
  readonly blockIds: readonly string[]
  readonly playbackOrder: EraPlaybackOrder
  readonly score: number
  readonly eligibilityReason:
    | 'curated-network-lineup'
    | 'documented-network-lineup'
    | 'exact-network-metadata'
}

export interface StationEraTemplateSummary {
  readonly id: EraStationTemplateId
  readonly name: string
  readonly networkFamily: string
  readonly description: string
  readonly eraStartYear: number
  readonly eraEndYear: number
  readonly blocks: readonly {
    readonly id: string
    readonly name: string
    readonly start: string
    readonly end: string
  }[]
  readonly matches: readonly StationEraTemplateMatchSummary[]
  readonly missingSuggestions: readonly StationEraTemplateSuggestionSummary[]
  readonly matchedShows: number
  readonly matchedMovies: number
  readonly movieCadence: string
  readonly marathonCadence: string
}

export interface StationAutomationCatalog {
  readonly collections: readonly StationCollectionOption[]
  readonly genres: readonly StationFacet[]
  readonly networks: readonly StationFacet[]
  readonly studios: readonly StationFacet[]
  readonly presets: readonly StationPresetSummary[]
  /** Period-inspired recipes and their coverage in the current library. */
  readonly eraTemplates?: readonly StationEraTemplateSummary[]
  /** Strict station identities used by the network-copy builder. */
  readonly networkProfiles?: readonly StationNetworkProfileSummary[]
  /** @deprecated General-family ideas are never merged into network copies. */
  readonly familyMixSuggestions?: readonly {
    readonly title: string
    readonly firstYear: number
    readonly tags: readonly string[]
    readonly available: boolean
  }[]
  readonly truncated: boolean
}

export interface StationSelectionRequest {
  readonly preset: StationPresetId
  readonly networkId?: StationNetworkId
  readonly eraStartYear?: number
  readonly eraEndYear?: number
  readonly selectionMode?: 'automatic' | 'explicit'
  readonly collectionIds?: readonly number[]
  readonly genres?: readonly string[]
  readonly networks?: readonly string[]
  readonly studios?: readonly string[]
}

export function stationAirtimeSlots(
  airtime: StationAirtimeId,
  group: string
): ChannelScheduleSlot[] {
  const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri'] as const
  const everyDay = ['sun', ...weekdays, 'sat'] as const
  switch (airtime) {
    case 'all-day':
      return [{ days: everyDay, start: '00:00', end: '24:00', groups: [group] }]
    case 'school-day':
      return [
        { days: weekdays, start: '06:30', end: '08:30', groups: [group] },
        { days: weekdays, start: '15:00', end: '20:00', groups: [group] },
      ]
    case 'evening':
      return [{ days: everyDay, start: '17:00', end: '21:00', groups: [group] }]
    case 'weekend-mornings':
      return [
        {
          days: ['sat', 'sun'],
          start: '07:00',
          end: '12:00',
          groups: [group],
        },
      ]
  }
}

/**
 * Build real dayparts for an era recipe. Reduced-airtime stations deliberately
 * retain the simpler window presets; an all-day era station gets the complete
 * programming personality from its selected template.
 */
export function stationScheduleSlots(
  airtime: StationAirtimeId,
  group: string,
  preset: StationPresetId,
  network?: Pick<
    StationSelectionRequest,
    'networkId' | 'eraStartYear' | 'eraEndYear'
  >
): ChannelScheduleSlot[] {
  if (airtime !== 'all-day') {
    return stationAirtimeSlots(airtime, group)
  }
  const template =
    preset === 'network-copy'
      ? getNetworkCopyScheduleTemplate(
          requireStationNetwork(network?.networkId),
          network?.eraStartYear,
          network?.eraEndYear
        )
      : isEraStationTemplateId(preset)
        ? getEraStationTemplate(preset)
        : null
  if (!template) return stationAirtimeSlots(airtime, group)
  const everyDay = [
    'sun',
    'mon',
    'tue',
    'wed',
    'thu',
    'fri',
    'sat',
  ] as const
  return template.blocks
    .filter(isPlayableTemplateBlock)
    .map((block) => ({
      days: everyDay,
      start: block.start,
      end: block.end,
      groups: [stationTemplateBlockGroup(group, block.id)],
    }))
}

/**
 * Keep the base generated group as an ownership marker while assigning each
 * collection to the template dayparts where it belongs. User-added titles
 * that are outside the curated roster are placed conservatively by media kind
 * and genre instead of leaking into every block.
 */
export function stationCollectionProgrammingGroups(
  preset: StationPresetId,
  collection: StationCollectionOption,
  group: string,
  network?: Pick<
    StationSelectionRequest,
    'networkId' | 'eraStartYear' | 'eraEndYear'
  >
): string[] {
  if (preset !== 'network-copy' && !isEraStationTemplateId(preset)) return [group]
  const networkId =
    preset === 'network-copy'
      ? requireStationNetwork(network?.networkId)
      : undefined
  const template =
    preset === 'network-copy'
      ? getNetworkCopyScheduleTemplate(
          networkId!,
          network?.eraStartYear,
          network?.eraEndYear
        )
      : getEraStationTemplate(preset)
  const match =
    preset === 'network-copy'
      ? analyzeNetworkCopyProfile(networkId!, [collection], {
          startYear: network?.eraStartYear,
          endYear: network?.eraEndYear,
        }).matches[0]
      : analyzeEraStationTemplate(template, [collection]).matches[0]
  if (preset === 'network-copy' && !match) {
    throw new Error(
      'A network-copy collection must belong to the selected network and year range'
    )
  }
  const playableBlocks = template.blocks.filter(isPlayableTemplateBlock)
  const playableBlockIds = new Set(playableBlocks.map((block) => block.id))
  let blockIds = (match?.blockIds ?? []).filter((blockId) =>
    playableBlockIds.has(blockId)
  )
  if (blockIds.length === 0 && collection.libraryKind === 'movie') {
    blockIds = template.moviePolicy.preferredBlockIds.filter((blockId) =>
      playableBlockIds.has(blockId)
    )
  }
  if (blockIds.length === 0) {
    const genres = new Set(collection.genres.map(normalize))
    const ranked = playableBlocks
      .map((block) => ({
        id: block.id,
        score: block.tags.filter((tag) => genres.has(normalize(tag))).length,
      }))
      .sort((left, right) => right.score - left.score)
    const bestScore = ranked[0]?.score ?? 0
    blockIds = bestScore > 0
      ? ranked.filter((item) => item.score === bestScore).map((item) => item.id)
      : playableBlocks
          .filter((block) => ['daytime', 'afternoon', 'primetime'].includes(block.id))
          .slice(0, 2)
          .map((block) => block.id)
  }
  if (blockIds.length === 0 && playableBlocks[0]) {
    blockIds = [playableBlocks[0].id]
  }
  return [
    group,
    ...new Set(blockIds.map((blockId) => stationTemplateBlockGroup(group, blockId))),
  ]
}

export function stationTemplateBlockGroup(
  group: string,
  blockId: string
): string {
  const value = `${group}-${blockId}`
  if (value.length > 64) {
    throw new Error('Generated station template group is too long')
  }
  return value
}

function isPlayableTemplateBlock(block: {
  readonly tags: readonly string[]
}): boolean {
  return !block.tags.some((tag) => normalizeTitle(tag) === 'off air')
}

const PAGE_SIZE = 250
const MAX_COLLECTIONS = 5_000

const NICK_NETWORKS = new Set([
  'nickelodeon',
  'nick at nite',
  'nicktoons',
])
const NICK_JR_NETWORKS = new Set(['nick jr', 'nick jr.'])
const NATURE_DOCUMENTARY_NETWORK_TERMS = [
  'bbc',
  'discovery',
  'national geographic',
  'pbs',
]
const NATURE_DOCUMENTARY_TITLE_TERMS = [
  'animal',
  'blue planet',
  'dinosaurs',
  'dogs in the wild',
  'green planet',
  'nature',
  'ocean',
  'our planet',
  'planet earth',
  'prehistoric planet',
  'wildlife',
]
const NICK_JR_TITLES = new Set(
  [
    'blaze and the monster machines',
    "blue's clues",
    "blue's clues and you",
    'blues clues',
    'blues clues and you',
    'bubble guppies',
    'dora',
    'dora the explorer',
    'max and ruby',
    'ni hao kai lan',
    'paw patrol',
    "ryan's mystery playdate",
    'ryans mystery playdate',
    'shimmer and shine',
    'team umizoomi',
    'the backyardigans',
    'wonder pets',
  ].map(normalizeTitle)
)

export async function loadStationAutomationCatalog(
  repository: Pick<IMediaRepository, 'getCollections'>
): Promise<StationAutomationCatalog> {
  const collections: MediaCollection[] = []
  for (let offset = 0; offset < MAX_COLLECTIONS; offset += PAGE_SIZE) {
    const page = await repository.getCollections({
      presentOnly: true,
      scheduleEligibleOnly: true,
      limit: PAGE_SIZE,
      offset,
    })
    collections.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  const truncated =
    collections.length >= MAX_COLLECTIONS &&
    (
      await repository.getCollections({
        presentOnly: true,
        scheduleEligibleOnly: true,
        limit: 1,
        offset: MAX_COLLECTIONS,
      })
    ).length > 0

  const playable = collections
    .filter(
      (collection) =>
        collection.rootAvailable && collection.scheduleEligibleCount > 0
    )
    .map(toOption)
    .sort((left, right) => compareText(left.displayTitle, right.displayTitle))
  const base = {
    collections: playable,
    genres: facets(playable, (collection) => collection.genres),
    networks: facets(playable, (collection) => collection.networks),
    studios: facets(playable, (collection) => collection.studios),
    truncated,
  }
  return {
    ...base,
    presets: presetDefinitions.map((preset) => ({
      id: preset.id,
      name: preset.name,
      description: preset.description,
      matchedCollections: playable.filter(preset.matches).length,
      ...(preset.unofficial ? { unofficial: true } : {}),
    })),
    eraTemplates: ERA_STATION_TEMPLATES.map((template) => {
      const analysis = analyzeEraStationTemplate(template, playable)
      return {
        id: template.id,
        name: template.name,
        networkFamily: template.networkFamily,
        description: template.description,
        eraStartYear: template.era.startYear,
        eraEndYear: template.era.endYear,
        blocks: template.blocks.map(({ id, name, start, end }) => ({
          id,
          name,
          start,
          end,
        })),
        matches: analysis.matches.map((match) => ({
          collectionId: match.collection.id,
          title: match.collection.displayTitle,
          libraryKind: match.collection.libraryKind,
          blockIds: match.blockIds,
          playbackOrder: match.playbackOrder,
          score: match.score,
          relationship: 'historical' as const,
        })),
        missingSuggestions: analysis.missingSuggestions.map(
          ({ title, libraryKind, firstYear, tags }) => ({
            title,
            libraryKind,
            firstYear,
            tags,
          })
        ),
        matchedShows: analysis.matchedShows,
        matchedMovies: analysis.matchedMovies,
        movieCadence: template.moviePolicy.cadence,
        marathonCadence: template.marathonDefaults.cadence,
      }
    }),
    networkProfiles: NETWORK_COPY_PROFILES.map((profile) => {
      const analysis = analyzeNetworkCopyProfile(profile, playable, {
        startYear: profile.availableStartYear,
        endYear: profile.availableEndYear,
      })
      return {
        id: profile.id,
        name: profile.name,
        description: profile.description,
        audience: profile.audience,
        availableStartYear: profile.availableStartYear,
        availableEndYear: profile.availableEndYear,
        defaultStartYear: profile.defaultStartYear,
        defaultEndYear: profile.defaultEndYear,
        blocks: profile.blocks.map(({ id, name, start, end }) => ({
          id,
          name,
          start,
          end,
        })),
        matches: analysis.matches.map((match) => ({
          collectionId: match.collection.id,
          title: match.collection.displayTitle,
          libraryKind: match.collection.libraryKind,
          firstAirYear: match.collection.firstAirYear,
          airStartYear: match.airStartYear!,
          airEndYear: match.airEndYear!,
          blockIds: match.blockIds,
          playbackOrder: match.playbackOrder,
          score: match.score,
          eligibilityReason: match.eligibilityReason!,
        })),
        missingSuggestions: analysis.missingSuggestions.map(
          ({
            title,
            libraryKind,
            firstYear,
            lastYear,
            airStartYear,
            airEndYear,
            tags,
          }) => ({
            title,
            libraryKind,
            firstYear,
            ...(lastYear === undefined ? {} : { lastYear }),
            airStartYear: airStartYear ?? firstYear,
            airEndYear: airEndYear ?? airStartYear ?? firstYear,
            tags,
          })
        ),
        matchedShows: analysis.matchedShows,
        matchedMovies: analysis.matchedMovies,
        movieCadence: profile.moviePolicy.cadence,
        marathonCadence: profile.marathonDefaults.cadence,
      }
    }),
  }
}

export function selectStationCollections(
  catalog: StationAutomationCatalog,
  request: StationSelectionRequest
): StationCollectionOption[] {
  if (catalog.truncated) {
    throw new Error(
      'Station automation is disabled because the playable catalog exceeds 5,000 collections'
    )
  }
  if (request.preset === 'network-copy') {
    const networkId = requireStationNetwork(request.networkId)
    const profile = getNetworkCopyProfile(networkId)
    if (request.eraStartYear === undefined || request.eraEndYear === undefined) {
      throw new Error('Choose the first and last year for the copied network')
    }
    const startYear = request.eraStartYear
    const endYear = request.eraEndYear
    const eligible = analyzeNetworkCopyProfile(profile, catalog.collections, {
      startYear,
      endYear,
    }).matches.map((match) => match.collection)
    const explicit =
      request.selectionMode === 'explicit' || request.collectionIds !== undefined
    if (
      request.selectionMode === 'automatic' &&
      request.collectionIds !== undefined
    ) {
      throw new Error(
        'Automatic network selection cannot include explicit collection IDs'
      )
    }
    if (request.selectionMode === 'explicit' && request.collectionIds === undefined) {
      throw new Error('Explicit network selection requires collection IDs')
    }
    if (!explicit) return eligible
    const ids = boundedIds(request.collectionIds ?? [])
    if (ids.size === 0) {
      throw new Error('Choose at least one show for this copied network')
    }
    const eligibleIds = new Set(eligible.map((collection) => collection.id))
    const invalidIds = [...ids].filter((id) => !eligibleIds.has(id))
    if (invalidIds.length > 0) {
      throw new Error(
        'Selected collections must belong to the chosen network and year range'
      )
    }
    return eligible.filter((collection) => ids.has(collection.id))
  }
  const preset = presetDefinitions.find((item) => item.id === request.preset)
  const eraTemplate = isEraStationTemplateId(request.preset)
    ? getEraStationTemplate(request.preset)
    : undefined
  if (!preset && !eraTemplate && request.preset !== 'custom') {
    throw new Error('Choose a valid station preset')
  }

  const eraMatches = eraTemplate
    ? new Set(
        analyzeEraStationTemplate(eraTemplate, catalog.collections).matches.map(
          (match) => match.collection.id
        )
      )
    : undefined

  const ids = boundedIds(request.collectionIds ?? [])
  const genres = normalizedSet(request.genres ?? [], 'genres')
  const networks = normalizedSet(request.networks ?? [], 'networks')
  const studios = normalizedSet(request.studios ?? [], 'studios')
  const hasCustomCriteria =
    ids.size > 0 || genres.size > 0 || networks.size > 0 || studios.size > 0
  if (request.preset === 'custom' && !hasCustomCriteria) {
    throw new Error('Choose at least one collection, genre, network, or studio')
  }

  if (eraTemplate) {
    const strictMatches = catalog.collections.filter((collection) =>
      eraMatches?.has(collection.id)
    )
    if (request.collectionIds === undefined) return strictMatches
    const eligibleIds = new Set(strictMatches.map((collection) => collection.id))
    const invalidIds = [...ids].filter((id) => !eligibleIds.has(id))
    if (invalidIds.length > 0) {
      throw new Error('Selected collections must belong to the chosen network preset')
    }
    return strictMatches.filter((collection) => ids.has(collection.id))
  }

  return catalog.collections.filter((collection) => {
    const presetMatch =
      request.preset !== 'custom' &&
      ((preset !== undefined && preset.matches(collection)) ||
        eraMatches?.has(collection.id) === true)
    const customMatch =
      ids.has(collection.id) ||
      collection.genres.some((value) => genres.has(normalize(value))) ||
      collection.networks.some((value) => networks.has(normalize(value))) ||
      collection.studios.some((value) => studios.has(normalize(value)))
    return presetMatch || customMatch
  })
}

interface PresetDefinition {
  readonly id: Exclude<StationPresetId, 'custom'>
  readonly name: string
  readonly description: string
  readonly unofficial?: boolean
  matches(collection: StationCollectionOption): boolean
}

const presetDefinitions: readonly PresetDefinition[] = [
  {
    id: 'all-approved-tv',
    name: 'All playable shows',
    description: 'Every TV collection with at least one parent-allowed, playable file.',
    matches: (collection) => collection.libraryKind === 'tv',
  },
  {
    id: 'family-animation',
    name: 'Family animation',
    description: 'Parent-allowed TV tagged Family or Animation by TMDB.',
    matches: (collection) =>
      collection.libraryKind === 'tv' &&
      collection.genres.some((genre) =>
        ['animation', 'family'].includes(normalize(genre))
      ),
  },
  {
    id: 'nickelodeon-style',
    name: 'Nickelodeon-style mix',
    description:
      'Parent-allowed Nickelodeon and Nicktoons titles, excluding titles identified as Nick Jr. preschool programming.',
    unofficial: true,
    matches: matchesNickelodeonStyle,
  },
  {
    id: 'nick-jr-style',
    name: 'Nick Jr.-style preschool mix',
    description:
      'Parent-allowed preschool titles matched by exact Nick Jr. network metadata or a conservative title list when TMDB reports only Nickelodeon; raw Network facets stay unchanged.',
    unofficial: true,
    matches: matchesNickJrStyle,
  },
  {
    id: 'nature-documentaries',
    name: 'Nature documentaries',
    description:
      'Parent-allowed TMDB documentaries from nature-focused titles or documentary networks; animation is excluded.',
    matches: matchesNatureDocumentary,
  },
  {
    id: 'movie-night',
    name: 'Movie night',
    description: 'Every parent-allowed, technically playable movie collection.',
    matches: (collection) => collection.libraryKind === 'movie',
  },
]

function matchesNickelodeonStyle(collection: StationCollectionOption): boolean {
  if (collection.libraryKind !== 'tv' || matchesNickJrStyle(collection)) {
    return false
  }
  if (
    collection.networks.some((network) => NICK_NETWORKS.has(normalize(network)))
  ) {
    return true
  }
  return false
}

function matchesNickJrStyle(collection: StationCollectionOption): boolean {
  if (collection.libraryKind !== 'tv') return false
  if (
    collection.networks.some((network) =>
      NICK_JR_NETWORKS.has(normalize(network))
    )
  ) {
    return true
  }
  return NICK_JR_TITLES.has(normalizeTitle(collection.displayTitle))
}

function matchesNatureDocumentary(
  collection: StationCollectionOption
): boolean {
  if (
    collection.libraryKind !== 'tv' ||
    !collection.genres.some((genre) => normalize(genre) === 'documentary') ||
    collection.genres.some((genre) => normalize(genre) === 'animation')
  ) {
    return false
  }
  const providers = [...collection.networks, ...collection.studios].map(normalize)
  return (
    providers.some((provider) =>
      NATURE_DOCUMENTARY_NETWORK_TERMS.some((term) => provider.includes(term))
    ) ||
    NATURE_DOCUMENTARY_TITLE_TERMS.some((term) =>
      normalizeTitle(collection.displayTitle).includes(term)
    )
  )
}

function toOption(collection: MediaCollection): StationCollectionOption {
  return {
    id: collection.id,
    rootId: collection.rootId,
    identityKey: collection.identityKey,
    collectionTitle: collection.sourceTitle,
    displayTitle: collection.metadataTitle ?? collection.parsedTitle,
    libraryKind: collection.libraryKind,
    genres: collection.genres,
    networks: collection.networks ?? [],
    studios: collection.studios ?? [],
    firstAirYear: collection.metadataYear ?? collection.year,
    eligibleFiles: collection.scheduleEligibleCount,
  }
}

export function isEraStationTemplateId(
  value: string
): value is EraStationTemplateId {
  return ERA_STATION_TEMPLATES.some((template) => template.id === value)
}

export function isStationPresetId(value: string): value is StationPresetId {
  return (
    value === 'custom' ||
    value === 'network-copy' ||
    presetDefinitions.some((preset) => preset.id === value) ||
    isEraStationTemplateId(value)
  )
}

export function requireStationNetwork(
  value: StationNetworkId | undefined
): StationNetworkId {
  if (!value || !isStationNetworkId(value)) {
    throw new Error('Choose a valid network for a network-copy station')
  }
  return value
}

function facets(
  collections: readonly StationCollectionOption[],
  read: (collection: StationCollectionOption) => readonly string[]
): StationFacet[] {
  const values = new Map<string, { name: string; ids: Set<number> }>()
  for (const collection of collections) {
    for (const raw of read(collection)) {
      const name = raw.trim()
      if (!name) continue
      const key = normalize(name)
      const entry = values.get(key) ?? { name, ids: new Set<number>() }
      entry.ids.add(collection.id)
      values.set(key, entry)
    }
  }
  return [...values.values()]
    .map(({ name, ids }) => ({ name, collections: ids.size }))
    .sort(
      (left, right) =>
        right.collections - left.collections || compareText(left.name, right.name)
    )
}

function boundedIds(values: readonly number[]): Set<number> {
  if (values.length > MAX_COLLECTIONS) {
    throw new Error('Too many collections selected')
  }
  const ids = new Set<number>()
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error('Collection selection is invalid')
    }
    ids.add(value)
  }
  return ids
}

function normalizedSet(values: readonly string[], label: string): Set<string> {
  if (values.length > 250) throw new Error(`Too many ${label} selected`)
  const output = new Set<string>()
  for (const value of values) {
    const clean = typeof value === 'string' ? value.trim() : ''
    if (!clean || clean.length > 200 || /[\r\n\0]/.test(clean)) {
      throw new Error(`Selected ${label} are invalid`)
    }
    output.add(normalize(clean))
  }
  return output
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase('en-US')
}

function normalizeTitle(value: string): string {
  return normalize(value)
    .replace(/\(\d{4}\)/g, ' ')
    .replace(/\b\d{4}\b/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'en-US', { sensitivity: 'base' })
}
