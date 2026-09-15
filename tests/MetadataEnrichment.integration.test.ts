import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type {
  CertificationLookup,
  MetadataCandidate,
  MetadataProvider,
  MetadataSearchInput,
  ProviderTitleDetails,
  ProviderEpisodeDetails,
} from '../src/metadata/types'
import { MetadataProviderError } from '../src/metadata/types'
import {
  METADATA_CONFIG_SETTING_KEY,
  type MetadataRuntimeConfig,
} from '../src/config/metadata'
import type {
  IMediaRepository,
  MediaItemInput,
} from '../src/repositories/IMediaRepository'
import { MediaRepository } from '../src/repositories/MediaRepository'
import { MetadataEnrichmentService } from '../src/services/metadata/MetadataEnrichmentService'
import type { RatingPolicyProfile } from '../src/policy/PolicyEngine'

const runtimeConfig: MetadataRuntimeConfig = {
  tmdbApiKey: 'server-only-test-key',
  language: 'en-US',
  preferredRatingRegion: 'US',
  fallbackRatingRegions: [],
  requestTimeoutMs: 1_000,
}

interface ProviderScenario {
  readonly configured?: boolean
  readonly candidates?: readonly MetadataCandidate[]
  readonly certification?: string | null
  readonly certificationRegion?: string
  readonly ratingStatus?: CertificationLookup['status']
  readonly searchError?: Error
  readonly connectionError?: Error
  readonly candidatesForSearch?: (
    input: MetadataSearchInput
  ) => readonly MetadataCandidate[]
  readonly detailsForLanguage?: (
    language: string,
    candidate: MetadataCandidate
  ) => ProviderTitleDetails
  readonly episodes?: readonly ProviderEpisodeDetails[]
}

function providerFor(scenario: ProviderScenario): MetadataProvider {
  const candidates = [...(scenario.candidates ?? [])]
  const detailsFor = (
    externalId: string,
    language: string
  ): ProviderTitleDetails => {
    const candidate = candidates.find((item) => item.externalId === externalId)
    if (!candidate) throw new Error(`Unexpected details lookup for ${externalId}`)
    if (scenario.detailsForLanguage) {
      return scenario.detailsForLanguage(language, candidate)
    }
    return {
      ...candidate,
      genres: ['Animation', 'Family'],
      networks: ['ABC Kids'],
      studios: ['Ludo Studio'],
    }
  }
  const rating = (): CertificationLookup => ({
    status: scenario.ratingStatus ?? (scenario.certification ? 'resolved' : 'missing'),
    selected:
      scenario.certification === null || scenario.certification === undefined
        ? null
        : {
            region: scenario.certificationRegion ?? 'US',
            certification: scenario.certification,
          },
    all:
      scenario.certification === null || scenario.certification === undefined
        ? []
        : [
            {
              region: scenario.certificationRegion ?? 'US',
              certification: scenario.certification,
            },
          ],
  })

  return {
    id: 'tmdb',
    configured: scenario.configured ?? true,
    async testConnection() {
      if (scenario.connectionError) throw scenario.connectionError
    },
    async searchMovie(input: MetadataSearchInput) {
      if (scenario.searchError) throw scenario.searchError
      return [...(scenario.candidatesForSearch?.(input) ?? candidates)]
    },
    async searchTV(input: MetadataSearchInput) {
      if (scenario.searchError) throw scenario.searchError
      return [...(scenario.candidatesForSearch?.(input) ?? candidates)]
    },
    async getMovie(externalId: string, input) {
      return detailsFor(externalId, input.language)
    },
    async getTV(externalId: string, input) {
      return detailsFor(externalId, input.language)
    },
    async getTVSeason() {
      return scenario.episodes ?? []
    },
    async getMovieCertification() {
      return rating()
    },
    async getTVContentRating() {
      return rating()
    },
  }
}

function mediaInput(
  collectionId: number,
  title: string,
  filename = `${title} - S01E01.mkv`
): MediaItemInput {
  return {
    path: `/media/tv/${title}/${filename}`,
    filename,
    durationSeconds: 420,
    isInterlude: false,
    mediaType: 'video',
    dateStart: null,
    dateEnd: null,
    codec: 'h264',
    width: 1920,
    height: 1080,
    warning: null,
    mtime: 1,
    compatibility: 'compatible',
    rootId: 'tv',
    relativePath: `${title}/${filename}`,
    libraryKind: 'tv',
    collectionTitle: title,
    collectionId,
    seasonNumber: 1,
    episodeNumber: 1,
    episodeTitle: null,
    policyEnabled: false,
    playbackOverride: null,
    rootAvailable: true,
  }
}

describe('metadata enrichment and policy integration', () => {
  let repository: MediaRepository

  beforeEach(async () => {
    repository = new MediaRepository(':memory:')
    await repository.initialize()
  })

  afterEach(async () => {
    await repository.close()
  })

  for (const scenario of [
    { folder: 'From the World of John Wick Ballerina', year: 2025, file: 'Ballerina (2025).mkv', title: 'Ballerina', match: true },
    { folder: 'Untitled Jurassic World Movie', year: 2025, file: 'Jurassic World Rebirth (2025).mkv', title: 'Jurassic World Rebirth', match: true },
    { folder: 'Cunks Quest for Meaning', year: null, file: 'Cunk on Life (2024).mkv', title: 'Cunk on Life', filmYear: 2024, match: true },
    { folder: 'V+H+S+94', year: 2023, file: 'V+H+S+94 (2021).mkv', title: 'V/H/S/94', filmYear: 2021, match: true },
    { folder: 'Old Working Title', year: 2025, file: 'Actual Film (2025).mkv', title: 'Actual Film', rival: true, shortRival: true, match: true },
    { folder: 'Old Working Title', year: 2025, file: 'Actual Film.mkv', title: 'Actual Film', match: false },
    { folder: 'Old Working Title', year: 2025, file: 'Actual Film (2025).mkv', title: 'Actual Film', runtime: 20, match: false },
    { folder: 'Old Working Title', year: 2025, file: 'Actual Film (2025).mkv', title: 'Actual Film', runtime: 0, match: false },
    { folder: 'Old Working Title', year: 2025, file: 'Actual Film (2025).mkv', title: 'Actual Film', rival: true, match: false },
    { folder: 'Old Working Title', year: 2025, file: 'Actual Film (2025).mkv', title: 'Actual Film', extra: true, match: false },
    { folder: 'Old Working Title {edition-Book Edit}', year: 2025, file: 'Actual Film (2025).mkv', title: 'Actual Film', match: false },
    { folder: 'Old Working Title', year: 2025, file: 'Actual Film (2025).mkv', title: 'Actual Film', providerYear: 2024, match: false },
  ]) test('movie filename evidence: ' + JSON.stringify(scenario), async () => {
    const [item] = await repository.upsertCollections([{
      rootId: 'movies', libraryKind: 'movie', identityKey: 'filename-test', sourceTitle: scenario.folder,
      parsedTitle: scenario.folder, year: scenario.year,
    }])
    const file = { ...mediaInput(item!.id, scenario.folder, scenario.file), rootId: 'movies', libraryKind: 'movie' as const, durationSeconds: (scenario.runtime ?? 100) * 60 }
    await repository.upsertMedia(file)
    if (scenario.extra) await repository.upsertMedia({ ...file, path: file.path + '.extra', filename: 'Extra (2025).mkv' })
    await repository.updateCollectionOverride(item!.id, 'block')
    const candidates: MetadataCandidate[] = [{ provider: 'tmdb', externalId: '1234', mediaType: 'movie', title: scenario.title, year: scenario.providerYear ?? scenario.filmYear ?? 2025 }]
    if (scenario.rival) candidates.push({ ...candidates[0]!, externalId: '5678' })
    const searches: string[] = []
    const provider = providerFor({ candidates, certification: 'G',
      candidatesForSearch(input) { searches.push(input.title); return input.title === scenario.folder && input.year === (scenario.year ?? undefined) ? [] : candidates },
      detailsForLanguage(_language, candidate) { return { ...candidate, runtimeMinutes: scenario.shortRival && candidate.externalId === '5678' ? 10 : 100, genres: [] } },
    })
    await new MetadataEnrichmentService(repository, provider, runtimeConfig).runPending()
    const after = await repository.getCollectionById(item!.id)
    expect(after?.metadataStatus === 'matched').toBe(scenario.match)
    expect(after?.metadataExternalId).toBe(scenario.match ? '1234' : null)
    expect(after?.parentOverride).toBe('block')
    expect(after?.effectiveDecision).toBe('block')
    if (scenario.match) expect(searches).toContain(scenario.file.replace(/ \(\d{4}\)\.mkv$/, ''))
  })

  for (const runtime of [99, 160]) test('a lone near-title candidate gets runtime evidence: ' + runtime, async () => {
    const [item] = await repository.upsertCollections([{
      rootId: 'movies', libraryKind: 'movie', identityKey: 'ivan', sourceTitle: 'Yowamushi Pedal ReRIDE (2014)',
      parsedTitle: 'Yowamushi Pedal ReRIDE', year: 2014,
    }])
    await repository.upsertMedia({ ...mediaInput(item!.id, 'Ivan', 'Yowamushi Pedal ReRIDE (2014).mkv'), rootId: 'movies', libraryKind: 'movie', durationSeconds: runtime * 60 })
    const provider = providerFor({ candidates: [{ provider: 'tmdb', externalId: '9797', mediaType: 'movie', title: 'Yowamushi Pedal Re:RIDE', year: 2014 }],
      detailsForLanguage(_language, candidate) { return { ...candidate, runtimeMinutes: 99, genres: [] } }, certification: 'PG',
    })
    await new MetadataEnrichmentService(repository, provider, runtimeConfig).runPending()
    expect((await repository.getCollectionById(item!.id))?.metadataStatus).toBe(runtime === 99 ? 'matched' : 'ambiguous')
  })

  for (const corroborated of [true, false]) test('festival year can corroborate a different primary movie year: ' + corroborated, async () => {
    const [item] = await repository.upsertCollections([{
      rootId: 'movies', libraryKind: 'movie', identityKey: 'harry', sourceTitle: 'The Plot Against Harry (1989)',
      parsedTitle: 'The Plot Against Harry', year: 1989,
    }])
    await repository.upsertMedia({ ...mediaInput(item!.id, 'Harry', 'The Plot Against Harry (1989).mkv'), rootId: 'movies', libraryKind: 'movie', durationSeconds: 4816 })
    await repository.updateCollectionOverride(item!.id, 'block')
    const provider = providerFor({ candidates: [{ provider: 'tmdb', externalId: '41943', mediaType: 'movie', title: 'The Plot Against Harry', year: 1971 }],
      detailsForLanguage(_language, candidate) { return { ...candidate, runtimeMinutes: 81, releaseYears: corroborated ? [1971, 1989, 1990] : [1971, 1990], genres: [] } }, certification: 'G',
    })
    await new MetadataEnrichmentService(repository, provider, runtimeConfig).runPending()
    expect(await repository.getCollectionById(item!.id)).toMatchObject({ metadataStatus: corroborated ? 'matched' : 'ambiguous', parentOverride: 'block', effectiveDecision: 'block' })
  })

  for (const customEdit of [false, true]) test('explains movie library layout issues before searching: ' + customEdit, async () => {
    const title = customEdit ? 'The Hobbit {edition-Book Edit}' : 'Riget (The Kingdom)'
    const [item] = await repository.upsertCollections([{ rootId: 'movies', libraryKind: 'movie', identityKey: 'layout', sourceTitle: title, parsedTitle: title, year: null }])
    for (const episode of [1, 2]) await repository.upsertMedia({ ...mediaInput(item!.id, title, customEdit ? `Film ${episode}.mkv` : `Riget S01E0${episode}.mkv`), rootId: 'movies', libraryKind: 'movie' })
    const provider = providerFor({})
    provider.searchMovie = async () => { throw new Error('Layout issue should be explained before searching') }
    await new MetadataEnrichmentService(repository, provider, runtimeConfig).runPending()
    const after = await repository.getCollectionById(item!.id)
    expect(after?.metadataStatus).toBe('ambiguous')
    expect(after?.metadataError).toContain(customEdit ? 'custom fan/book edit' : 'TV episodes')
  })

  test('PG opt-in browsing preserves review decisions without crowding the review queue', async () => {
    const item = await addCollection('Family Show', 2024)
    const service = new MetadataEnrichmentService(repository, providerFor({
      candidates: [{ provider: 'tmdb', externalId: '123', mediaType: 'tv', title: 'Family Show', originalTitle: 'Family Show', year: 2024 }],
      certification: 'TV-PG',
    }), runtimeConfig)
    await service.runPending()
    expect(await repository.getCollectionById(item.id)).toMatchObject({
      parentOverride: null, policyDecision: 'review', scheduleEligibleCount: 0,
    })
    expect(await repository.getCollections({ effectiveDecision: 'review', excludeParentalGuidance: true })).toHaveLength(0)
    expect((await repository.getCollections({ parentalGuidanceOnly: true })).map(c => c.id)).toEqual([item.id])
    expect((await repository.getAll())[0]?.collectionCertification).toBe('TV-PG')
    expect((await service.retryReviewLibrary()).processed).toBe(0)
  })

  test('rating retries preserve a matched identity without searching again', async () => {
    const item = await addCollection('Known Film', 2024)
    const provider = providerFor({
      candidates: [{ provider: 'tmdb', externalId: '456', mediaType: 'tv', title: 'Known Film', originalTitle: 'Known Film', year: 2024 }],
      certification: null,
    })
    const service = new MetadataEnrichmentService(repository, provider, runtimeConfig)
    await service.runPending()
    provider.searchTV = async () => { throw new Error('Known identity must not be searched again') }
    expect((await service.retryReviewLibrary()).failed).toBe(0)
    expect(await repository.getCollectionById(item.id)).toMatchObject({ metadataExternalId: '456', metadataStatus: 'matched' })
  })


  for (const failure of ['not_found', 'network', 'timeout', 'rate_limited', 'invalid_response', 'missing_series', 'partial_rival'] as const) {
    test('TV evidence handles missing rival seasons conservatively: ' + failure, async () => {
      const item = await addCollection('Fallout')
      const titles = ['The End', 'The Target', 'The Head']
      for (let i = 0; i < titles.length; i++) await repository.upsertMedia({
        ...mediaInput(item.id, 'Fallout', 'Fallout - S01E0' + (i + 1) + '.mkv'),
        episodeNumber: i + 1, episodeTitle: titles[i]! + ' Bluray-1080p v2',
      })
      await repository.upsertMedia({ ...mediaInput(item.id, 'Fallout', 'Fallout - S02E01.mkv'), seasonNumber: 2, episodeTitle: 'A New Season' })
      const provider = providerFor({ candidates: [
        { provider: 'tmdb', externalId: '106379', mediaType: 'tv', title: 'Fallout', year: 2024 },
        { provider: 'tmdb', externalId: '32366', mediaType: 'tv', title: 'Fallout', year: 2006 },
      ], certification: 'TV-MA' })
      const getTV = provider.getTV.bind(provider)
      provider.getTV = async (id, input) => {
        if (id === '32366' && failure === 'missing_series') throw new MetadataProviderError('Missing series', { code: 'not_found', provider: 'tmdb' })
        return getTV(id, input)
      }
      provider.getTVSeason = async (id, season) => {
        if (id === '32366' && season === 2) throw new MetadataProviderError('Season lookup failed', {
          code: failure === 'missing_series' || failure === 'partial_rival' ? 'not_found' : failure, provider: 'tmdb',
        })
        return titles.map((title, i) => ({ seasonNumber: season, episodeNumber: i + 1,
          title: id === '106379' || (failure === 'partial_rival' && i === 0) ? title : 'Unrelated story ' + i,
        }))
      }
      await new MetadataEnrichmentService(repository, provider, runtimeConfig).runPending()
      expect(await repository.getCollectionById(item.id)).toMatchObject({
        metadataStatus: failure === 'not_found' ? 'matched' : 'ambiguous',
        metadataExternalId: failure === 'not_found' ? '106379' : null,
      })
    })
  }


  for (const range of ['valid', 'wide', 'wrong_start'] as const) test('explicit paired episode range: ' + range, async () => {
    const item = await addCollection('The Powerpuff Girls')
    const stories = ['Monkey See', 'Mommy Fearest', 'Insect Inside', 'Powerpuff Bluff', 'Octi Evil', 'Geshundfight']
    for (let i = 0; i < 3; i++) {
      const start = i * 2 + 1
      await repository.upsertMedia({ ...mediaInput(item.id, 'The Powerpuff Girls', `The Powerpuff Girls - S01E${start}-E${start + (range === 'wide' ? 2 : 1)}.mkv`),
        episodeNumber: range === 'wrong_start' ? start + 10 : start, episodeTitle: stories[i*2] + ' + ' + stories[i*2+1],
      })
    }
    const provider = providerFor({ candidates: [
      { provider: 'tmdb', externalId: '607', mediaType: 'tv', title: 'The Powerpuff Girls', year: 1998 },
      { provider: 'tmdb', externalId: '66149', mediaType: 'tv', title: 'The Powerpuff Girls', year: 2016 },
    ] })
    provider.getTVSeason = async (id, season) => stories.map((title, i) => ({ seasonNumber: season, episodeNumber: i+1, title: id === '607' ? title : 'Unrelated ' + i }))
    await new MetadataEnrichmentService(repository, provider, runtimeConfig).runPending()
    expect((await repository.getCollectionById(item.id))?.metadataExternalId).toBe(range === 'valid' ? '607' : null)
  })

  for (const variant of ['consistent', 'conflicting', 'undated', 'repeated_position'] as const) test('TV filename title and year consensus: ' + variant, async () => {
    const item = await addCollection('That Mitchell and Web Look')
    // Replace the initial unnamed placeholder with a dated episodic filename below.
    for (let i = 1; i <= 3; i++) await repository.upsertMedia({
      ...mediaInput(item.id, 'That Mitchell and Web Look', `That Mitchell and Webb Look${variant === 'undated' ? '' : ` (${variant === 'conflicting' && i === 3 ? 2007 : 2006})`} - S01E0${variant === 'repeated_position' ? 1 : i} copy${i}.mkv`),
      episodeNumber: i,
    })
    const provider = providerFor({ candidatesForSearch: input => input.title === 'That Mitchell and Webb Look' ? [
      { provider: 'tmdb', externalId: 'correct', mediaType: 'tv', title: input.title, year: 2006 },
    ] : [], candidates: [{ provider: 'tmdb', externalId: 'correct', mediaType: 'tv', title: 'That Mitchell and Webb Look', year: 2006 }] })
    // The helper adds an undated episode, so give that record the same identity too.
    const initial = mediaInput(item.id, 'That Mitchell and Web Look')
    await repository.upsertMedia({ ...initial, filename: 'extra.txt' })
    await new MetadataEnrichmentService(repository, provider, runtimeConfig).runPending()
    expect((await repository.getCollectionById(item.id))?.metadataExternalId).toBe(variant === 'consistent' ? 'correct' : null)
  })

  for (const mode of ['unique', 'rival', 'wrong_date', 'same_guest'] as const) test('dated episode evidence requires dates and distinct guest names: ' + mode, async () => {
    const item = await addCollection('The Daily Show')
    const guests = mode === 'same_guest' ? ['Kevin Bacon', 'Kevin Bacon', 'Kevin Bacon'] : ['Kevin Bacon', 'Jeremy O Harris', 'Maya Hawke']
    for (let i = 0; i < 3; i++) await repository.upsertMedia({
      ...mediaInput(item.id, 'The Daily Show', `The Daily Show - 2024-06-${11+i} - ${guests[i]} WEBDL-1080p.mkv`),
      seasonNumber: 29, episodeNumber: null, episodeTitle: null,
    })
    const provider = providerFor({ candidates: [
      { provider: 'tmdb', externalId: 'main', mediaType: 'tv', title: 'The Daily Show', year: 1996 },
      { provider: 'tmdb', externalId: 'rival', mediaType: 'tv', title: 'The Daily Show', year: 2011 },
    ] })
    provider.getTVSeason = async (id, season) => guests.map((title, i) => ({ seasonNumber: season, episodeNumber: i+100, airDate: `2024-06-${(mode === 'wrong_date' ? 21 : 11)+i}`, title: `June ${(mode === 'wrong_date' ? 21 : 11)+i}, 2024 - ${id === 'main' || mode === 'rival' ? title : 'Other guest ' + i}` }))
    await new MetadataEnrichmentService(repository, provider, runtimeConfig).runPending()
    expect((await repository.getCollectionById(item.id))?.metadataExternalId).toBe(mode === 'unique' ? 'main' : null)
  })

  for (const count of [15, 21]) test('bounded TV comparison examines every plausible rival: ' + count, async () => {
    const item = await addCollection('What If')
    const titles = ['Captain Carter', 'Star Lord', 'Lost Heroes']
    for (let i = 0; i < 3; i++) await repository.upsertMedia({ ...mediaInput(item.id, 'What If', `What If - S01E0${i+1}.mkv`), episodeNumber: i+1, episodeTitle: titles[i] })
    const provider = providerFor({ candidates: Array.from({length: count}, (_, i) => ({ provider: 'tmdb', externalId: String(i), mediaType: 'tv' as const, title: 'What If', year: 2000+i })) })
    const examined = new Set<string>()
    provider.getTVSeason = async (id, season) => { examined.add(id); return titles.map((title, i) => ({ seasonNumber: season, episodeNumber: i+1, title: id === '0' ? title : 'Different ' + i })) }
    await new MetadataEnrichmentService(repository, provider, runtimeConfig).runPending()
    expect((await repository.getCollectionById(item.id))?.metadataExternalId).toBe(count === 15 ? '0' : null)
    expect(examined.size).toBe(count === 15 ? 15 : 0)
  })

  test('paired story files match split provider episodes after release tags are removed', async () => {
    const item = await addCollection('Arthur')
    const stories = ['Arthurs Eyes', 'Bad Hair Day', 'The Real Teacher', 'Spelling Trouble', 'All Wet', 'Dino Dilemma']
    for (let i = 0; i < 3; i++) await repository.upsertMedia({
      ...mediaInput(item.id, 'Arthur', 'Arthur - S01E0' + (i + 1) + '.mkv'),
      episodeNumber: i + 1, episodeTitle: stories[i*2]!.replaceAll(' ', '.') + '.-.' + stories[i*2+1]!.replaceAll(' ', '.') + '.480p.AMZN.WEBRip.x264',
    })
    const provider = providerFor({ candidates: [
      { provider: 'tmdb', externalId: '2153', mediaType: 'tv', title: 'Arthur', year: 1996 },
      { provider: 'tmdb', externalId: '291982', mediaType: 'tv', title: 'Arthur', year: 2025 },
    ], certification: 'TV-Y' })
    provider.getTVSeason = async (id, season) => stories.map((title, i) => ({
      seasonNumber: season, episodeNumber: i + 1, title: id === '2153' ? title : 'Other story ' + i,
    }))
    await new MetadataEnrichmentService(repository, provider, runtimeConfig).runPending()
    expect(await repository.getCollectionById(item.id)).toMatchObject({ metadataExternalId: '2153', metadataStatus: 'matched' })
  })

  for (const localTitle of ['Arthur', 'Arthur (US)']) for (const rivalMatches of [false, true]) test('episode evidence resolves a title tie only when unique: ' + localTitle + rivalMatches, async () => {
    const item = await addCollection(localTitle)
    const titles = ['A difficult day', 'The school trip', 'A new friend']
    for (let i = 0; i < titles.length; i++) await repository.upsertMedia({
      ...mediaInput(item.id, 'Arthur', 'Arthur - S01E0' + (i + 1) + '.mkv'),
      episodeNumber: i + 1, episodeTitle: titles[i]!,
    })
    const provider = providerFor({ candidates: [
      { provider: 'tmdb', externalId: '2153', mediaType: 'tv', title: 'Arthur', year: 1996 },
      { provider: 'tmdb', externalId: '291982', mediaType: 'tv', title: 'Arthur', year: 2025 },
    ], certification: 'TV-Y' })
    provider.getTVSeason = async (id, season) => titles.map((title, i) => ({
      seasonNumber: season, episodeNumber: i + 1, title: id === '2153' || rivalMatches ? title : 'Different story ' + i,
    }))
    await new MetadataEnrichmentService(repository, provider, runtimeConfig).runPending()
    expect(await repository.getCollectionById(item.id)).toMatchObject({
      metadataStatus: rivalMatches ? 'ambiguous' : 'matched', metadataExternalId: rivalMatches ? null : '2153',
    })
  })

  for (const runtime of [96, 150]) test('short official movie title requires measured runtime agreement: ' + runtime, async () => {
    const [item] = await repository.upsertCollections([{
      rootId: 'movies', libraryKind: 'movie', identityKey: 'borat-2', sourceTitle: 'Borat Subsequent Moviefilm (2020)',
      parsedTitle: 'Borat Subsequent Moviefilm', year: 2020,
    }])
    await repository.upsertMedia({ ...mediaInput(item!.id, 'Borat Subsequent Moviefilm'), rootId: 'movies', libraryKind: 'movie', durationSeconds: runtime * 60 })
    const provider = providerFor({ candidates: [{
      provider: 'tmdb', externalId: '740985', mediaType: 'movie',
      title: 'Borat Subsequent Moviefilm: Delivery of Prodigious Bribe to American Regime for Make Benefit Once Glorious Nation of Kazakhstan', year: 2020,
    }], certification: 'R' })
    const original = provider.getMovie.bind(provider)
    provider.getMovie = async (...args) => ({ ...await original(...args), runtimeMinutes: 96 })
    await new MetadataEnrichmentService(repository, provider, runtimeConfig).runPending()
    expect(await repository.getCollectionById(item!.id)).toMatchObject({ metadataStatus: runtime === 96 ? 'matched' : 'ambiguous' })
  })

  for (const hasAlias of [true, false]) test('low-score movie title requires a provider alias: ' + hasAlias, async () => {
    const [item] = await repository.upsertCollections([{
      rootId: 'movies', libraryKind: 'movie', identityKey: 'f1', sourceTitle: 'F1 The Movie (2025)',
      parsedTitle: 'F1 The Movie', year: 2025,
    }])
    await repository.upsertMedia({ ...mediaInput(item!.id, 'F1 The Movie'), rootId: 'movies', libraryKind: 'movie', durationSeconds: 155 * 60 })
    const provider = providerFor({ candidates: [{ provider: 'tmdb', externalId: '911430', mediaType: 'movie', title: 'F1', year: 2025 }], certification: 'PG-13' })
    const original = provider.getMovie.bind(provider)
    provider.getMovie = async (...args) => ({ ...await original(...args), runtimeMinutes: 155, alternativeTitles: hasAlias ? ['F1 The Movie'] : [] })
    await new MetadataEnrichmentService(repository, provider, runtimeConfig).runPending()
    expect(await repository.getCollectionById(item!.id)).toMatchObject({ metadataStatus: hasAlias ? 'matched' : 'unmatched' })
  })

  test('failed rating refresh retains known title and scheduling facets', async () => {
    const item = await addCollection('Known Show', 2024)
    const provider = providerFor({ candidates: [{
      provider: 'tmdb', externalId: '789', mediaType: 'tv', title: 'Known Show', year: 2024,
      posterPath: '/known.jpg',
    }], certification: null })
    const service = new MetadataEnrichmentService(repository, provider, runtimeConfig)
    await service.runPending()
    const originalDetails = provider.getTV.bind(provider)
    provider.getTV = async () => { throw new MetadataProviderError('Temporarily unavailable', { code: 'upstream', provider: 'tmdb', retryable: true }) }
    await service.retryReviewLibrary()
    provider.searchTV = async () => { throw new Error('Retry must retain the known identity') }
    await service.retryReviewLibrary()
    expect(await repository.getCollectionById(item.id)).toMatchObject({
      metadataExternalId: '789', metadataTitle: 'Known Show', posterPath: '/known.jpg',
      networks: ['ABC Kids'], genres: ['Animation', 'Family'], metadataStatus: 'error',
      parentOverride: null,
    })
    provider.getTV = originalDetails
    await service.retryReviewLibrary()
    expect(await repository.getCollectionById(item.id)).toMatchObject({
      metadataStatus: 'matched', metadataExternalId: '789', posterPath: '/known.jpg',
    })
  })

  for (const override of ['allow', 'block'] as const) test('metadata retry can identify a title while retaining parent ' + override, async () => {
    const item = await addCollection('Family Show', 2024)
    await new MetadataEnrichmentService(repository, providerFor({ candidates: [] }), runtimeConfig).runPending()
    await repository.updateCollectionOverride(item.id, override)
    const service = new MetadataEnrichmentService(repository, providerFor({
      candidates: [{ provider: 'tmdb', externalId: '321', mediaType: 'tv', title: 'Family Show', year: 2024 }],
      certification: override === 'allow' ? 'TV-MA' : 'TV-Y',
    }), runtimeConfig)
    expect((await service.retryReviewLibrary()).processed).toBe(1)
    expect(await repository.getCollectionById(item.id)).toMatchObject({
      metadataStatus: 'matched', metadataExternalId: '321', parentOverride: override, effectiveDecision: override,
    })
  })

  test('rating consensus survives cached reapplication and changes with the active profile', async () => {
    const item = await addCollection('Consensus Show', 2024)
    const provider = providerFor({ candidates: [{ provider: 'tmdb', externalId: '999', mediaType: 'tv', title: 'Consensus Show', year: 2024 }] })
    provider.getTVContentRating = async () => ({status: 'ambiguous', selected: null, all: [
      {region: 'US', certification: 'TV-G'}, {region: 'US', certification: 'TV-Y7'},
    ]})
    const service = new MetadataEnrichmentService(repository, provider, runtimeConfig)
    await service.runPending()
    expect(await repository.getCollectionById(item.id)).toMatchObject({
      ratingStatus: 'ambiguous', certification: null, policyDecision: 'allow', policyReason: 'rating_consensus',
    })
    await service.reapplyCachedPolicies()
    expect((await repository.getCollectionById(item.id))?.policyDecision).toBe('allow')
    const custom = new MetadataEnrichmentService(repository, provider, runtimeConfig, {
      id: 'custom', name: 'Custom', age: 7, rules: { allow: ['TV-G'], review: ['TV-Y7'], block: ['R'] },
    })
    await custom.reapplyCachedPolicies()
    expect((await repository.getCollectionById(item.id))?.policyDecision).toBe('review')
    await repository.updateCollectionOverride(item.id, 'block')
    await service.reapplyCachedPolicies()
    expect((await repository.getCollectionById(item.id))?.effectiveDecision).toBe('block')
  })

  test('automatic retry is bounded by daily and per-title cooldowns and preserves overrides', async () => {
    const item = await addCollection('Retry Show', 2024)
    const provider = providerFor({ candidates: [] })
    const service = new MetadataEnrichmentService(repository, provider, runtimeConfig)
    await service.runPending()
    await repository.updateCollectionOverride(item.id, 'block')
    const now = Date.UTC(2026, 8, 15)
    expect(await service.runAutomaticRetry(now)).toBe(1)
    expect(await service.runAutomaticRetry(now + 1000)).toBe(0)
    expect(await service.runAutomaticRetry(now + 86400000)).toBe(0)
    expect(await service.runAutomaticRetry(now + 7 * 86400000)).toBe(1)
    expect((await repository.getCollectionById(item.id))?.parentOverride).toBe('block')
  })

  test('automatic maintenance caps batches at 25 and continues with remaining titles the next day', async () => {
    for (let i = 0; i < 26; i++) await addCollection('Unmatched ' + i)
    const service = new MetadataEnrichmentService(repository, providerFor({ candidates: [] }), runtimeConfig)
    await service.runPending()
    const now = Date.UTC(2026, 8, 15)
    expect(await service.runAutomaticRetry(now)).toBe(25)
    expect(service.getState()).toMatchObject({ status: 'completed', total: 25, processed: 25 })
    expect(await service.runAutomaticRetry(now + 86400000)).toBe(1)
  })

  test('explicit TMDB folder identity bypasses search without bypassing ratings', async () => {
    const item = await addCollection('Different Folder Name {tmdb-123}')
    const provider = providerFor({ candidates: [{provider:'tmdb',externalId:'123',mediaType:'tv',title:'Provider Title',year:2020}], certification:'TV-MA' })
    provider.searchTV = async () => { throw new Error('Explicit ID should not need search') }
    await new MetadataEnrichmentService(repository,provider,runtimeConfig).runPending()
    expect(await repository.getCollectionById(item.id)).toMatchObject({
      metadataExternalId:'123', metadataTitle:'Provider Title', metadataStatus:'matched',
      policyDecision:'block', parentOverride:null,
    })
  })

  test('earlier decisions view finds resolved disagreements without changing overrides', async () => {
    const item = await addCollection('Earlier Decision')
    await repository.updateCollectionPolicy(item.id, 'allow', 'rating_allowed')
    await repository.updateCollectionOverride(item.id, 'block')
    expect((await repository.getCollections({ overrideDisagreesWithPolicy: true })).map(c => c.id)).toEqual([item.id])
    expect((await repository.getCollectionById(item.id))?.effectiveDecision).toBe('block')
    await repository.updateCollectionPolicy(item.id, 'review', 'rating_missing')
    expect(await repository.getCollections({ overrideDisagreesWithPolicy: true })).toHaveLength(0)
    await repository.updateCollectionPolicy(item.id, 'block', 'rating_blocked')
    expect(await repository.getCollections({ overrideDisagreesWithPolicy: true })).toHaveLength(0)
  })

  async function addCollection(title: string, year: number | null = null) {
    const [collection] = await repository.upsertCollections([
      {
        rootId: 'tv',
        libraryKind: 'tv',
        identityKey: JSON.stringify([title.toLowerCase(), year]),
        sourceTitle: year === null ? title : `${title} (${year})`,
        parsedTitle: title,
        year,
      },
    ])
    if (!collection) throw new Error('Expected collection to be created')
    await repository.upsertMedia(mediaInput(collection.id, title))
    return collection
  }

  test('keeps a collection in review when the provider has no key', async () => {
    const collection = await addCollection('Bluey', 2018)
    const provider = providerFor({ configured: false })
    const service = new MetadataEnrichmentService(repository, provider, {
      ...runtimeConfig,
      tmdbApiKey: null,
    })

    const state = await service.runPending()
    const updated = await repository.getCollectionById(collection.id)

    expect(state).toMatchObject({
      status: 'not_configured',
      providerHealth: 'not_configured',
      processed: 1,
      matched: 0,
      needsReview: 1,
    })
    expect(updated).toMatchObject({
      metadataStatus: 'not_configured',
      policyDecision: 'review',
      effectiveDecision: 'review',
      scheduleEligibleCount: 0,
    })
    expect(await repository.getAllVideos()).toEqual([])
  })

  test('allows an exact TMDB match with a Kids 7-safe rating', async () => {
    const collection = await addCollection('Bluey', 2018)
    const service = new MetadataEnrichmentService(
      repository,
      providerFor({
        candidates: [
          {
            provider: 'tmdb',
            externalId: '82728',
            mediaType: 'tv',
            title: 'Bluey',
            originalTitle: 'Bluey',
            year: 2018,
          },
        ],
        certification: 'TV-Y7',
      }),
      runtimeConfig
    )

    expect(await service.runPending()).toMatchObject({
      status: 'completed',
      providerHealth: 'connected',
      processed: 1,
      matched: 1,
      needsReview: 0,
    })
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      metadataExternalId: '82728',
      metadataStatus: 'matched',
      certification: 'TV-Y7',
      ratingStatus: 'resolved',
      networks: ['ABC Kids'],
      studios: ['Ludo Studio'],
      policyDecision: 'allow',
      effectiveDecision: 'allow',
      scheduleEligibleCount: 1,
    })
    expect(await repository.getAllVideos()).toHaveLength(1)
  })

  test('re-searches automatic matches while preserving explicit parent overrides', async () => {
    const collection = await addCollection('Bluey', 2018)
    const original = new MetadataEnrichmentService(
      repository,
      providerFor({
        candidates: [
          {
            provider: 'tmdb',
            externalId: '111',
            mediaType: 'tv',
            title: 'Bluey',
            year: 2018,
          },
        ],
        certification: 'TV-Y7',
      }),
      runtimeConfig
    )
    await original.runPending()
    await repository.updateCollectionOverride(collection.id, 'allow')

    const reevaluator = new MetadataEnrichmentService(
      repository,
      providerFor({
        candidates: [
          {
            provider: 'tmdb',
            externalId: '222',
            mediaType: 'tv',
            title: 'Bluey',
            year: 2018,
          },
        ],
        certification: 'TV-14',
        detailsForLanguage(_language, candidate) {
          return {
            ...candidate,
            genres: ['Documentary'],
            networks: ['BBC One'],
            studios: ['BBC Studios'],
          }
        },
      }),
      runtimeConfig
    )

    expect(await reevaluator.reevaluateLibrary()).toMatchObject({
      status: 'completed',
      processed: 1,
      matched: 1,
    })
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      metadataExternalId: '222',
      genres: ['Documentary'],
      networks: ['BBC One'],
      studios: ['BBC Studios'],
      policyDecision: 'block',
      parentOverride: 'allow',
      effectiveDecision: 'allow',
    })
  })

  test('retries without the year when a regional release year hides the exact title', async () => {
    const collection = await addCollection('A Close Shave', 1995)
    const exact: MetadataCandidate = {
      provider: 'tmdb',
      externalId: '532',
      mediaType: 'tv',
      title: 'A Close Shave',
      year: 1996,
    }
    const derivative: MetadataCandidate = {
      provider: 'tmdb',
      externalId: '999',
      mediaType: 'tv',
      title: 'The Digital Special Effects in "A Close Shave"',
      year: 1995,
    }
    const searchedYears: Array<number | undefined> = []
    const service = new MetadataEnrichmentService(
      repository,
      providerFor({
        candidates: [exact, derivative],
        candidatesForSearch(input) {
          searchedYears.push(input.year)
          return input.year === 1995 ? [derivative] : [exact, derivative]
        },
        certification: 'TV-Y7',
      }),
      runtimeConfig
    )

    await service.runPending()

    expect(searchedYears).toEqual([1995, undefined])
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      metadataExternalId: '532',
      metadataStatus: 'matched',
      matchConfidence: 0.98,
    })
  })

  test('retries unresolved metadata while preserving parent decisions', async () => {
    const retryable = await addCollection('A Close Shave', 1995)
    const parentDecided = await addCollection('Mystery Cartoon', 2001)
    const initiallyUnmatched = new MetadataEnrichmentService(
      repository,
      providerFor({ candidates: [] }),
      runtimeConfig
    )
    await initiallyUnmatched.runPending()
    await repository.updateCollectionOverride(parentDecided.id, 'allow')

    const exact: MetadataCandidate = {
      provider: 'tmdb',
      externalId: '532',
      mediaType: 'tv',
      title: 'A Close Shave',
      year: 1995,
    }
    const retry = new MetadataEnrichmentService(
      repository,
      providerFor({
        candidates: [exact],
        candidatesForSearch(input) {
          return input.title === 'A Close Shave' ? [exact] : []
        },
        certification: 'TV-Y7',
      }),
      runtimeConfig
    )

    expect(await retry.retryReviewLibrary()).toMatchObject({
      status: 'completed',
      processed: 2,
      matched: 1,
    })
    expect(await repository.getCollectionById(retryable.id)).toMatchObject({
      metadataExternalId: '532',
      metadataStatus: 'matched',
      policyDecision: 'allow',
    })
    expect(await repository.getCollectionById(parentDecided.id)).toMatchObject({
      metadataStatus: 'unmatched',
      parentOverride: 'allow',
      effectiveDecision: 'allow',
    })
  })

  test('stores TMDB episode titles separately from filename-derived titles', async () => {
    const collection = await addCollection('The Magic School Bus')
    const service = new MetadataEnrichmentService(
      repository,
      providerFor({
        candidates: [
          {
            provider: 'tmdb',
            externalId: '123',
            mediaType: 'tv',
            title: 'The Magic School Bus',
          },
        ],
        certification: 'TV-Y7',
        episodes: [
          {
            seasonNumber: 1,
            episodeNumber: 1,
            title: 'Gets Lost in Space',
            overview: 'The class explores the solar system.',
            airDate: '1994-09-10',
            stillPath: '/space.jpg',
          },
        ],
      }),
      runtimeConfig
    )

    await service.runPending()
    const [episode] = await repository.getCollectionMedia(collection.id)
    expect(episode).toMatchObject({
      episodeMetadataTitle: 'Gets Lost in Space',
      episodeOverview: 'The class explores the solar system.',
      episodeAirDate: '1994-09-10',
      episodeStillPath: '/space.jpg',
    })
  })

  test('does not infer a connection from a configured key when no provider call ran', async () => {
    const service = new MetadataEnrichmentService(
      repository,
      providerFor({ configured: true }),
      runtimeConfig
    )

    expect(service.getState()).toMatchObject({
      status: 'idle',
      providerHealth: 'unverified',
    })
    expect(await service.runPending()).toMatchObject({
      status: 'completed',
      total: 0,
      providerHealth: 'unverified',
    })

    await service.testConnection()
    expect(service.getState()).toMatchObject({
      providerHealth: 'connected',
      providerMessage: null,
    })
  })

  test('a successful connection test clears provider failure without erasing failed-record counts', async () => {
    await addCollection('Network Failure', 2024)
    const service = new MetadataEnrichmentService(repository, providerFor({ searchError:
      new MetadataProviderError('network unavailable', { code: 'network', provider: 'tmdb' }) }), runtimeConfig)
    await service.runPending()
    expect(service.getState()).toMatchObject({ failed: 1, providerHealth: 'degraded' })
    await service.testConnection()
    expect(service.getState()).toMatchObject({ failed: 1, providerHealth: 'connected', providerMessage: null })
  })

  test('degrades and redacts provider failures instead of leaking credentials', async () => {
    const collection = await addCollection('Network Failure', 2024)
    const error = new MetadataProviderError(
      'request failed with secret server-only-test-key',
      { code: 'network', provider: 'tmdb', retryable: true }
    )
    const service = new MetadataEnrichmentService(
      repository,
      providerFor({ searchError: error }),
      runtimeConfig
    )

    const state = await service.runPending()
    const updated = await repository.getCollectionById(collection.id)

    expect(state).toMatchObject({
      status: 'completed',
      providerHealth: 'degraded',
      providerMessage:
        'The metadata provider could not be reached over the network.',
      processed: 1,
      failed: 1,
    })
    expect(updated).toMatchObject({
      metadataStatus: 'error',
      policyDecision: 'review',
      effectiveDecision: 'review',
    })
    expect(JSON.stringify({ state, updated })).not.toContain(
      'server-only-test-key'
    )
  })

  test('records a failed connection test as degraded health', async () => {
    const error = new MetadataProviderError('credential secret', {
      code: 'unauthorized',
      provider: 'tmdb',
    })
    const service = new MetadataEnrichmentService(
      repository,
      providerFor({ connectionError: error }),
      runtimeConfig
    )

    await expect(service.testConnection()).rejects.toBe(error)
    expect(service.getState()).toMatchObject({
      providerHealth: 'degraded',
      providerMessage: 'The metadata provider rejected the configured credentials.',
    })
    expect(JSON.stringify(service.getState())).not.toContain('credential secret')
  })

  test('blocks a TV-14 match and never exposes it to scheduling', async () => {
    const collection = await addCollection('Teen Drama', 2024)
    const service = new MetadataEnrichmentService(
      repository,
      providerFor({
        candidates: [
          {
            provider: 'tmdb',
            externalId: '1400',
            mediaType: 'tv',
            title: 'Teen Drama',
            year: 2024,
          },
        ],
        certification: 'TV-14',
      }),
      runtimeConfig
    )

    await service.runPending()

    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      metadataStatus: 'matched',
      certification: 'TV-14',
      policyDecision: 'block',
      effectiveDecision: 'block',
      scheduleEligibleCount: 0,
    })
    expect(await repository.getAllVideos()).toEqual([])
  })

  test('sends ambiguous and unrated matches to parent review', async () => {
    const ambiguous = await addCollection('Shared Title', 2020)
    const ambiguousService = new MetadataEnrichmentService(
      repository,
      providerFor({
        candidates: [
          {
            provider: 'tmdb',
            externalId: '1',
            mediaType: 'tv',
            title: 'Shared Title',
            year: 2020,
          },
          {
            provider: 'tmdb',
            externalId: '2',
            mediaType: 'tv',
            title: 'Shared Title',
            year: 2020,
          },
        ],
      }),
      runtimeConfig
    )
    await ambiguousService.runPending()
    expect(await repository.getCollectionById(ambiguous.id)).toMatchObject({
      metadataStatus: 'ambiguous',
      policyDecision: 'review',
      effectiveDecision: 'review',
      scheduleEligibleCount: 0,
    })

    const unrated = await addCollection('No Rating', 2021)
    const unratedService = new MetadataEnrichmentService(
      repository,
      providerFor({
        candidates: [
          {
            provider: 'tmdb',
            externalId: '3',
            mediaType: 'tv',
            title: 'No Rating',
            year: 2021,
          },
        ],
        certification: null,
        ratingStatus: 'missing',
      }),
      runtimeConfig
    )
    await unratedService.runPending()
    expect(await repository.getCollectionById(unrated.id)).toMatchObject({
      metadataStatus: 'matched',
      ratingStatus: 'missing',
      certification: null,
      policyDecision: 'review',
      effectiveDecision: 'review',
      scheduleEligibleCount: 0,
    })
  })

  test('regional ratings activate on refresh, persist across restarts, and preserve parent decisions', async () => {
    const collection = await addCollection('Bluey', 2018)
    const provider = providerFor({ candidates: [{ provider: 'tmdb', externalId: '82728',
      mediaType: 'tv', title: 'Bluey', year: 2018 }], certification: 'ALL', certificationRegion: 'KR' })
    const service = new MetadataEnrichmentService(repository, provider, runtimeConfig)
    await service.runPending()
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      certification: 'ALL', certificationRegion: 'KR', policyDecision: 'allow',
    })
    const restarted = new MetadataEnrichmentService(repository, provider, runtimeConfig)
    await restarted.reapplyCachedPolicies()
    expect(await repository.getCollectionById(collection.id)).toMatchObject({ policyDecision: 'allow' })
    // Simulate an old cache, predating regional interpretation. Restarting
    // alone must retain the old unrecognized-rating decision.
    await repository.setSetting(`metadata_regional_rating_v1:${collection.id}`, '')
    await repository.updateCollectionPolicy(collection.id, 'review', 'rating_unrecognized', 'kids-7')
    await restarted.reapplyCachedPolicies()
    expect(await repository.getCollectionById(collection.id)).toMatchObject({ policyDecision: 'review' })
    await repository.updateCollectionOverride(collection.id, 'block')
    await restarted.reevaluateLibrary()
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      policyDecision: 'allow', parentOverride: 'block', effectiveDecision: 'block',
      certification: 'ALL', certificationRegion: 'KR',
    })
  })

  test('re-evaluates cached ratings when policy rules change without TMDB calls', async () => {
    const collection = await addCollection('Bluey', 2018)
    const originalService = new MetadataEnrichmentService(
      repository,
      providerFor({
        candidates: [
          {
            provider: 'tmdb',
            externalId: '82728',
            mediaType: 'tv',
            title: 'Bluey',
            year: 2018,
          },
        ],
        certification: 'TV-Y7',
      }),
      runtimeConfig
    )
    await originalService.runPending()
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      policyDecision: 'allow',
      effectiveDecision: 'allow',
    })

    const stricterProfile: RatingPolicyProfile = {
      id: 'strict-kids',
      name: 'Strict Kids',
      rules: {
        allow: ['G'],
        review: ['TV-Y'],
        block: ['TV-Y7'],
      },
    }
    const reloaded = new MetadataEnrichmentService(
      repository,
      providerFor({ candidates: [] }),
      runtimeConfig,
      stricterProfile
    )

    expect(await reloaded.reapplyCachedPolicies()).toBe(1)
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      certification: 'TV-Y7',
      policyDecision: 'block',
      effectiveDecision: 'block',
      policyProfileId: 'strict-kids',
      scheduleEligibleCount: 0,
    })
    expect(await repository.getAllVideos()).toEqual([])
  })

  test('missing startup policy revokes cached automatic allow but preserves parent authority', async () => {
    const collection = await addCollection('Bluey', 2018)
    const service = new MetadataEnrichmentService(
      repository,
      providerFor({
        candidates: [
          {
            provider: 'tmdb',
            externalId: '82728',
            mediaType: 'tv',
            title: 'Bluey',
            year: 2018,
          },
        ],
        certification: 'TV-Y7',
      }),
      runtimeConfig
    )
    await service.runPending()

    const noPolicy = new MetadataEnrichmentService(
      repository,
      providerFor({ candidates: [] }),
      runtimeConfig,
      null
    )
    expect(await noPolicy.reapplyCachedPolicies()).toBe(1)
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      policyDecision: 'review',
      policyReason: 'policy_missing',
      effectiveDecision: 'review',
      scheduleEligibleCount: 0,
    })

    await repository.updateCollectionOverride(collection.id, 'allow')
    expect(await noPolicy.reapplyCachedPolicies()).toBe(0)
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      policyDecision: 'review',
      parentOverride: 'allow',
      effectiveDecision: 'allow',
    })
  })

  test('holds cached ratings for review when regions change and refreshes a locked match', async () => {
    const collection = await addCollection('Bluey', 2018)
    const candidate: MetadataCandidate = {
      provider: 'tmdb',
      externalId: '82728',
      mediaType: 'tv',
      title: 'Bluey',
      originalTitle: 'Bluey',
      year: 2018,
    }
    const original = new MetadataEnrichmentService(
      repository,
      providerFor({ candidates: [candidate], certification: 'TV-Y7' }),
      runtimeConfig
    )
    expect(await original.synchronizeRatingRegions()).toBe(0)
    await original.runPending()
    await original.confirmMatch(collection.id, candidate.externalId)
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      metadataStatus: 'manual',
      metadataLocked: true,
      certification: 'TV-Y7',
      effectiveDecision: 'allow',
    })

    const changedConfig: MetadataRuntimeConfig = {
      ...runtimeConfig,
      preferredRatingRegion: 'AU',
    }
    const changed = new MetadataEnrichmentService(
      repository,
      providerFor({
        candidates: [candidate],
        certification: 'TV-14',
        certificationRegion: 'AU',
      }),
      changedConfig
    )
    expect(await changed.synchronizeRatingRegions()).toBe(1)
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      metadataExternalId: '82728',
      metadataStatus: 'pending',
      metadataLocked: true,
      certification: null,
      certificationRegion: null,
      policyDecision: 'review',
      effectiveDecision: 'review',
      scheduleEligibleCount: 0,
    })
    expect(await repository.getCollectionsNeedingMetadata()).toHaveLength(1)

    await changed.runPending()
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      metadataExternalId: '82728',
      metadataStatus: 'manual',
      metadataLocked: true,
      certification: 'TV-14',
      certificationRegion: 'AU',
      policyDecision: 'block',
      effectiveDecision: 'block',
      scheduleEligibleCount: 0,
    })
    expect(await repository.getAllVideos()).toEqual([])
  })

  test('tests supplied settings without persisting or exposing the candidate key', async () => {
    const builtConfigs: MetadataRuntimeConfig[] = []
    const service = new MetadataEnrichmentService(
      repository,
      providerFor({ configured: true }),
      runtimeConfig,
      undefined,
      (config) => {
        builtConfigs.push(config)
        return providerFor({ configured: config.tmdbApiKey !== null })
      }
    )
    const candidateKey = 'candidate-secret-value-123456'

    await service.testConfiguration({})
    await service.testConfiguration({
      tmdbApiKey: candidateKey,
      language: 'zh-tw',
      preferredRatingRegion: 'tw',
      fallbackRatingRegions: 'US',
      requestTimeoutMs: '2500',
    })

    expect(service.getState().providerHealth).toBe('connected')
    expect(builtConfigs).toEqual([
      {
        tmdbApiKey: candidateKey,
        language: 'zh-TW',
        preferredRatingRegion: 'TW',
        fallbackRatingRegions: ['US'],
        requestTimeoutMs: 2500,
      },
    ])
    expect(await repository.getSetting(METADATA_CONFIG_SETTING_KEY)).toBeNull()
    expect(service.getPublicConfig()).toMatchObject({
      configured: true,
      language: runtimeConfig.language,
    })
    expect(JSON.stringify(service.getPublicConfig())).not.toContain(candidateKey)
  })

  test('keeps the saved and active configuration unchanged when region invalidation fails', async () => {
    const collection = await addCollection('Bluey', 2018)
    const candidate: MetadataCandidate = {
      provider: 'tmdb',
      externalId: '82728',
      mediaType: 'tv',
      title: 'Bluey',
      year: 2018,
    }
    const initial = new MetadataEnrichmentService(
      repository,
      providerFor({ candidates: [candidate], certification: 'TV-Y7' }),
      runtimeConfig
    )
    await initial.synchronizeRatingRegions()
    await initial.runPending()

    const invalidationFailure = new Error('simulated invalidation failure')
    const failingRepository = new Proxy(repository as IMediaRepository, {
      get(target, property, receiver) {
        if (property === 'updateCollectionMetadata') {
          return async (
            id: number,
            metadata: Parameters<
              IMediaRepository['updateCollectionMetadata']
            >[1]
          ) => {
            if (metadata.status === 'pending') throw invalidationFailure
            return target.updateCollectionMetadata(id, metadata)
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    let activeProviderTests = 0
    let candidateProviderTests = 0
    const activeProvider: MetadataProvider = {
      ...providerFor({ configured: true }),
      async testConnection() {
        activeProviderTests++
      },
    }
    const service = new MetadataEnrichmentService(
      failingRepository,
      activeProvider,
      runtimeConfig,
      undefined,
      () => ({
        ...providerFor({ configured: true }),
        async testConnection() {
          candidateProviderTests++
        },
      })
    )

    await expect(
      service.updateConfiguration({ preferredRatingRegion: 'AU' })
    ).rejects.toBe(invalidationFailure)

    expect(service.getPublicConfig()).toMatchObject({
      language: 'en-US',
      preferredRatingRegion: 'US',
    })
    expect(await repository.getSetting(METADATA_CONFIG_SETTING_KEY)).toBeNull()
    await service.testConnection()
    expect(activeProviderTests).toBe(1)
    expect(candidateProviderTests).toBe(0)
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      metadataStatus: 'matched',
      certification: 'TV-Y7',
      policyDecision: 'review',
      effectiveDecision: 'review',
      scheduleEligibleCount: 0,
    })
  })

  test('requeues direct matches when language changes and refreshes localized fields', async () => {
    const collection = await addCollection('Bluey', 2018)
    const candidate: MetadataCandidate = {
      provider: 'tmdb',
      externalId: '82728',
      mediaType: 'tv',
      title: 'Bluey',
      originalTitle: 'Bluey',
      year: 2018,
    }
    const requestedLanguages: string[] = []
    const service = new MetadataEnrichmentService(
      repository,
      providerFor({ candidates: [candidate], certification: 'TV-Y7' }),
      runtimeConfig,
      undefined,
      () =>
        providerFor({
          candidates: [candidate],
          certification: 'TV-Y7',
          detailsForLanguage(language) {
            requestedLanguages.push(language)
            return {
              ...candidate,
              title: '妙妙犬布麗',
              overview: '繁體中文簡介',
              posterPath: '/bluey-zh-poster.jpg',
              backdropPath: '/bluey-zh-backdrop.jpg',
              genres: ['動畫', '家庭'],
              networks: ['澳洲兒童頻道'],
              studios: ['魯多工作室'],
            }
          },
        })
    )
    await service.synchronizeRatingRegions()
    await service.runPending()
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      metadataStatus: 'matched',
      metadataTitle: 'Bluey',
      policyDecision: 'allow',
    })

    await service.updateConfiguration({ language: 'zh-TW' })
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      metadataStatus: 'pending',
      policyDecision: 'allow',
      effectiveDecision: 'allow',
      scheduleEligibleCount: 1,
    })

    await service.runPending()
    expect(requestedLanguages).toEqual(['zh-TW'])
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      metadataStatus: 'matched',
      metadataTitle: '妙妙犬布麗',
      overview: '繁體中文簡介',
      posterPath: '/bluey-zh-poster.jpg',
      backdropPath: '/bluey-zh-backdrop.jpg',
      genres: ['動畫', '家庭'],
      networks: ['澳洲兒童頻道'],
      studios: ['魯多工作室'],
      certification: 'TV-Y7',
      policyDecision: 'allow',
    })
    expect(
      JSON.parse(
        (await repository.getSetting(METADATA_CONFIG_SETTING_KEY)) ?? '{}'
      ).language
    ).toBe('zh-TW')
  })

  test('does not let a pending run hydrate a region change with the old provider', async () => {
    const collection = await addCollection('Bluey', 2018)
    const candidate: MetadataCandidate = {
      provider: 'tmdb',
      externalId: '82728',
      mediaType: 'tv',
      title: 'Bluey',
      year: 2018,
    }
    const initial = new MetadataEnrichmentService(
      repository,
      providerFor({ candidates: [candidate], certification: 'TV-Y7' }),
      runtimeConfig
    )
    await initial.synchronizeRatingRegions()
    await initial.runPending()

    let releaseInvalidation!: () => void
    let invalidationStarted!: () => void
    const invalidationGate = new Promise<void>((resolve) => {
      releaseInvalidation = resolve
    })
    const invalidationEntered = new Promise<void>((resolve) => {
      invalidationStarted = resolve
    })
    let paused = false
    const gatedRepository = new Proxy(repository as IMediaRepository, {
      get(target, property, receiver) {
        if (property === 'updateCollectionMetadata') {
          return async (
            id: number,
            metadata: Parameters<
              IMediaRepository['updateCollectionMetadata']
            >[1]
          ) => {
            if (!paused && metadata.status === 'pending') {
              paused = true
              invalidationStarted()
              await invalidationGate
            }
            return target.updateCollectionMetadata(id, metadata)
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    let oldProviderHydrations = 0
    let newProviderHydrations = 0
    const oldBase = providerFor({
      candidates: [candidate],
      certification: 'TV-Y7',
    })
    const oldProvider: MetadataProvider = {
      ...oldBase,
      async getTV(externalId, input) {
        oldProviderHydrations++
        return oldBase.getTV(externalId, input)
      },
    }
    const service = new MetadataEnrichmentService(
      gatedRepository,
      oldProvider,
      runtimeConfig,
      undefined,
      () => {
        const nextBase = providerFor({
          candidates: [candidate],
          certification: 'TV-Y7',
          certificationRegion: 'AU',
        })
        return {
          ...nextBase,
          async getTV(externalId, input) {
            newProviderHydrations++
            return nextBase.getTV(externalId, input)
          },
        }
      }
    )

    const update = service.updateConfiguration({
      preferredRatingRegion: 'AU',
    })
    await invalidationEntered
    const pending = service.runPending()
    await Promise.resolve()
    expect(oldProviderHydrations).toBe(0)
    expect(newProviderHydrations).toBe(0)

    releaseInvalidation()
    await update
    await pending

    expect(oldProviderHydrations).toBe(0)
    expect(newProviderHydrations).toBe(1)
    expect(service.getPublicConfig().preferredRatingRegion).toBe('AU')
    expect(await repository.getCollectionById(collection.id)).toMatchObject({
      metadataStatus: 'matched',
      certificationRegion: 'AU',
      policyDecision: 'allow',
    })
  })

  test('persists a live provider swap while blank key input keeps the secret', async () => {
    const builtConfigs: MetadataRuntimeConfig[] = []
    const service = new MetadataEnrichmentService(
      repository,
      providerFor({ configured: true }),
      runtimeConfig,
      undefined,
      (config) => {
        builtConfigs.push(config)
        return providerFor({ configured: config.tmdbApiKey !== null })
      }
    )

    const publicConfig = await service.updateConfiguration({
      tmdbApiKey: '',
      language: 'en-GB',
      preferredRatingRegion: 'gb',
      fallbackRatingRegions: 'US, GB',
      requestTimeoutMs: '3500',
    })

    expect(builtConfigs[0]).toEqual({
      tmdbApiKey: runtimeConfig.tmdbApiKey,
      language: 'en-GB',
      preferredRatingRegion: 'GB',
      fallbackRatingRegions: ['US'],
      requestTimeoutMs: 3500,
    })
    expect(publicConfig).toEqual({
      provider: 'tmdb',
      configured: true,
      language: 'en-GB',
      preferredRatingRegion: 'GB',
      fallbackRatingRegions: ['US'],
      requestTimeoutMs: 3500,
    })
    expect(JSON.stringify(publicConfig)).not.toContain(runtimeConfig.tmdbApiKey!)

    const saved = JSON.parse(
      (await repository.getSetting(METADATA_CONFIG_SETTING_KEY)) ?? '{}'
    )
    expect(saved.tmdbApiKey).toBe(runtimeConfig.tmdbApiKey)
    expect(saved.preferredRatingRegion).toBe('GB')
  })
})
