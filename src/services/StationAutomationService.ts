import type { IMediaRepository } from '../repositories/IMediaRepository'
import type { LibraryKind, MediaCollection } from '../types'
import type { ChannelScheduleSlot } from '../config/library'

export type StationPresetId =
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

export interface StationAutomationCatalog {
  readonly collections: readonly StationCollectionOption[]
  readonly genres: readonly StationFacet[]
  readonly networks: readonly StationFacet[]
  readonly studios: readonly StationFacet[]
  readonly presets: readonly StationPresetSummary[]
  readonly truncated: boolean
}

export interface StationSelectionRequest {
  readonly preset: StationPresetId
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

const PAGE_SIZE = 250
const MAX_COLLECTIONS = 5_000

const NICK_NETWORKS = new Set([
  'nickelodeon',
  'nick at nite',
  'nicktoons',
])
const NICK_JR_NETWORKS = new Set(['nick jr', 'nick jr.'])
const NICK_STUDIO_TERMS = ['nickelodeon']
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
const NICK_TITLES = new Set(
  [
    'aaahh real monsters',
    'avatar the last airbender',
    'catdog',
    'danny phantom',
    'hey arnold',
    'invader zim',
    'rockos modern life',
    'rocket power',
    'rugrats',
    'spongebob squarepants',
    'teenage mutant ninja turtles',
    'the fairly oddparents',
    'the legend of korra',
    'the loud house',
    'the wild thornberrys',
  ].map(normalizeTitle)
)
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
  const preset = presetDefinitions.find((item) => item.id === request.preset)
  if (!preset && request.preset !== 'custom') {
    throw new Error('Choose a valid station preset')
  }

  const ids = boundedIds(request.collectionIds ?? [])
  const genres = normalizedSet(request.genres ?? [], 'genres')
  const networks = normalizedSet(request.networks ?? [], 'networks')
  const studios = normalizedSet(request.studios ?? [], 'studios')
  const hasCustomCriteria =
    ids.size > 0 || genres.size > 0 || networks.size > 0 || studios.size > 0
  if (request.preset === 'custom' && !hasCustomCriteria) {
    throw new Error('Choose at least one collection, genre, network, or studio')
  }

  return catalog.collections.filter((collection) => {
    const presetMatch =
      request.preset !== 'custom' &&
      preset !== undefined &&
      preset.matches(collection)
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
  if (
    collection.studios.some((studio) =>
      NICK_STUDIO_TERMS.some((term) => normalize(studio).includes(term))
    )
  ) {
    return true
  }
  return NICK_TITLES.has(normalizeTitle(collection.displayTitle))
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
    eligibleFiles: collection.scheduleEligibleCount,
  }
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
  if (values.length > 1_000) throw new Error('Too many collections selected')
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
