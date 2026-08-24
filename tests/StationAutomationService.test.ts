import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LibraryPolicyDocument } from '../src/config/library'
import type { IMediaRepository } from '../src/repositories/IMediaRepository'
import { ChannelConfigurationStore } from '../src/services/ChannelConfigurationStore'
import { ChannelService } from '../src/services/ChannelService'
import {
  loadStationAutomationCatalog,
  selectStationCollections,
  stationAirtimeSlots,
  stationCollectionProgrammingGroups,
  stationScheduleSlots,
} from '../src/services/StationAutomationService'
import type { MediaCollection, MediaItem } from '../src/types'

function collection(
  id: number,
  title: string,
  overrides: Partial<MediaCollection> = {}
): MediaCollection {
  return {
    id,
    rootId: 'tv',
    libraryKind: 'tv',
    identityKey: title.toLowerCase(),
    sourceTitle: title,
    parsedTitle: title,
    year: null,
    present: true,
    metadataProvider: 'tmdb',
    metadataExternalId: String(id),
    metadataStatus: 'matched',
    metadataLocked: false,
    metadataTitle: title,
    metadataOriginalTitle: null,
    metadataYear: null,
    overview: null,
    posterPath: null,
    backdropPath: null,
    genres: [],
    networks: [],
    studios: [],
    certification: 'TV-Y7',
    certificationRegion: 'US',
    ratingStatus: 'resolved',
    matchConfidence: 1,
    metadataCandidates: [],
    metadataError: null,
    policyDecision: 'allow',
    policyReason: 'rating_allowed',
    policyProfileId: 'kids-7',
    parentOverride: 'allow',
    effectiveDecision: 'allow',
    decisionSource: 'parent',
    fileCount: 2,
    seasonCount: 1,
    episodeCount: 2,
    readyFileCount: 2,
    failedFileCount: 0,
    legacyOverrideCount: 0,
    scheduleEligibleCount: 2,
    rootAvailable: true,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  }
}

function video(collectionTitle: string, id = 501): MediaItem {
  return {
    id,
    path: `/media/tv/${collectionTitle}/episode.mkv`,
    filename: 'episode.mkv',
    durationSeconds: 600,
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
    relativePath: `${collectionTitle}/episode.mkv`,
    libraryKind: 'tv',
    collectionTitle,
    policyEnabled: true,
    playbackOverride: null,
    rootAvailable: true,
    playbackEnabled: true,
    collectionId: id === 501 ? 1 : 2,
    collectionIdentityKey: collectionTitle.toLowerCase(),
  }
}

describe('station automation', () => {
  test('expands bounded airtime templates into editable non-overlapping slots', () => {
    expect(stationAirtimeSlots('all-day', 'generated')).toEqual([
      {
        days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
        start: '00:00',
        end: '24:00',
        groups: ['generated'],
      },
    ])
    expect(stationAirtimeSlots('school-day', 'generated')).toHaveLength(2)
    expect(stationAirtimeSlots('evening', 'generated')[0]).toMatchObject({
      start: '17:00',
      end: '21:00',
    })
    expect(
      stationAirtimeSlots('weekend-mornings', 'generated')[0]?.days
    ).toEqual(['sat', 'sun'])
  })

  test('builds TMDB facets and keeps brand-style presets explicitly catalog based', async () => {
    const records = [
      collection(1, 'SpongeBob SquarePants', {
        genres: ['Animation', 'Family'],
        networks: ['Nickelodeon'],
        studios: ['Nickelodeon Animation Studio'],
      }),
      collection(2, 'Bluey', {
        genres: ['Animation', 'Family'],
        networks: ['ABC Kids'],
        studios: ['Ludo Studio'],
      }),
      collection(4, 'PAW Patrol', {
        genres: ['Animation', 'Family'],
        networks: ['Nickelodeon'],
        studios: ['Nickelodeon Animation Studio'],
      }),
      collection(5, 'Bubble Guppies', {
        genres: ['Animation', 'Family'],
        networks: ['Nick Jr.'],
      }),
      collection(3, 'Broken Show', {
        scheduleEligibleCount: 0,
      }),
    ]
    const repository = {
      async getCollections(options: { offset?: number; limit?: number }) {
        const offset = options.offset ?? 0
        return records.slice(offset, offset + (options.limit ?? 250))
      },
    }

    const catalog = await loadStationAutomationCatalog(repository)
    expect(catalog.collections).toHaveLength(4)
    expect(catalog.networks).toContainEqual({
      name: 'Nickelodeon',
      collections: 2,
    })
    expect(
      catalog.presets.find((preset) => preset.id === 'nickelodeon-style')
    ).toMatchObject({ matchedCollections: 1, unofficial: true })
    expect(
      catalog.presets.find((preset) => preset.id === 'nick-jr-style')
    ).toMatchObject({ matchedCollections: 2, unofficial: true })
    expect(
      selectStationCollections(catalog, { preset: 'nickelodeon-style' }).map(
        (item) => item.displayTitle
      )
    ).toEqual(['SpongeBob SquarePants'])
    expect(
      selectStationCollections(catalog, { preset: 'nick-jr-style' }).map(
        (item) => item.displayTitle
      )
    ).toEqual(['Bubble Guppies', 'PAW Patrol'])
    expect(
      selectStationCollections(catalog, {
        preset: 'custom',
        studios: ['Ludo Studio'],
      }).map((item) => item.displayTitle)
    ).toEqual(['Bluey'])
  })

  test('keeps recognized Nick Jr. preschool titles out of the Nickelodeon-style preset', async () => {
    const records = [
      collection(1, 'SpongeBob SquarePants', {
        networks: ['Nickelodeon'],
        studios: ['Nickelodeon Animation Studio'],
      }),
      collection(2, "Blue's Clues", {
        networks: ['Nickelodeon'],
        studios: ['Nickelodeon Productions'],
      }),
      collection(3, "Ryan's Mystery Playdate", {
        networks: ['Nickelodeon'],
      }),
    ]
    const catalog = await loadStationAutomationCatalog({
      async getCollections(options) {
        const offset = options?.offset ?? 0
        return records.slice(offset, offset + (options?.limit ?? 250))
      },
    })

    expect(catalog.networks).toEqual([
      { name: 'Nickelodeon', collections: 3 },
    ])
    expect(
      catalog.presets.find((preset) => preset.id === 'nick-jr-style')
    ).toMatchObject({
      name: 'Nick Jr.-style preschool mix',
      matchedCollections: 2,
      description: expect.stringContaining('raw Network facets stay unchanged'),
    })
    expect(
      catalog.presets.find((preset) => preset.id === 'nickelodeon-style')
    ).toMatchObject({ name: 'Nickelodeon-style mix', matchedCollections: 1 })
    expect(
      selectStationCollections(catalog, { preset: 'nickelodeon-style' }).map(
        (item) => item.displayTitle
      )
    ).toEqual(['SpongeBob SquarePants'])
    expect(
      selectStationCollections(catalog, { preset: 'nick-jr-style' }).map(
        (item) => item.displayTitle
      )
    ).toEqual(["Blue's Clues", "Ryan's Mystery Playdate"])
  })

  test('includes a review collection when a parent approved one file', async () => {
    const playableFileOnly = collection(9, 'Parent Pick', {
      policyDecision: 'review',
      parentOverride: null,
      effectiveDecision: 'review',
      decisionSource: 'policy',
      scheduleEligibleCount: 1,
    })
    const calls: Array<Record<string, unknown>> = []
    const repository = {
      async getCollections(options: Record<string, unknown>) {
        calls.push(options)
        return [playableFileOnly]
      },
    }

    const catalog = await loadStationAutomationCatalog(repository)

    expect(catalog.collections.map((item) => item.id)).toEqual([9])
    expect(calls[0]).toMatchObject({ scheduleEligibleOnly: true })
    expect(calls[0]).not.toHaveProperty('effectiveDecision')
  })

  test('keeps animation out of the nature-documentary preset', async () => {
    const records = [
      collection(1, 'The Wild Thornberrys', {
        genres: ['Animation', 'Comedy', 'Family'],
        networks: ['Nickelodeon'],
      }),
      collection(2, 'Planet Earth III', {
        genres: ['Documentary'],
        networks: ['BBC One'],
      }),
    ]
    const catalog = await loadStationAutomationCatalog({
      async getCollections(options) {
        const offset = options?.offset ?? 0
        return records.slice(offset, offset + (options?.limit ?? 250))
      },
    })

    expect(
      selectStationCollections(catalog, {
        preset: 'nature-documentaries',
      }).map((item) => item.displayTitle)
    ).toEqual(['Planet Earth III'])
  })

  test('builds strict network dayparts without cross-network family guests', async () => {
    const records = [
      collection(1, "Dexter's Laboratory", {
        metadataYear: 1996,
        genres: ['Animation', 'Comedy'],
        networks: ['Cartoon Network'],
      }),
      collection(2, 'Bluey', {
        metadataYear: 2018,
        genres: ['Animation', 'Family'],
        networks: ['ABC Kids'],
      }),
    ]
    const catalog = await loadStationAutomationCatalog({
      async getCollections(options) {
        const offset = options?.offset ?? 0
        return records.slice(offset, offset + (options?.limit ?? 250))
      },
    })

    const network = catalog.networkProfiles?.find(
      (profile) => profile.id === 'cartoon-network'
    )
    expect(network).toMatchObject({ matchedShows: 1, matchedMovies: 0 })
    expect(network?.matches.map((match) => match.title)).toEqual([
      "Dexter's Laboratory",
    ])
    expect(() =>
      selectStationCollections(catalog, {
        preset: 'network-copy',
        networkId: 'cartoon-network',
        selectionMode: 'automatic',
      })
    ).toThrow('Choose the first and last year')
    expect(
      selectStationCollections(catalog, {
        preset: 'network-copy',
        networkId: 'cartoon-network',
        eraStartYear: 1997,
        eraEndYear: 2026,
        selectionMode: 'explicit',
        collectionIds: [1],
      }).map((item) => item.displayTitle)
    ).toEqual(["Dexter's Laboratory"])
    expect(() =>
      selectStationCollections(catalog, {
        preset: 'network-copy',
        networkId: 'cartoon-network',
        eraStartYear: 1997,
        eraEndYear: 2026,
        selectionMode: 'explicit',
        collectionIds: [2],
      })
    ).toThrow('must belong to the chosen network')
    expect(() =>
      selectStationCollections(catalog, {
        preset: 'network-copy',
        networkId: 'cartoon-network',
        eraStartYear: 1997,
        eraEndYear: 2026,
        selectionMode: 'automatic',
        collectionIds: [1],
      })
    ).toThrow('Automatic network selection cannot include explicit')
    expect(() =>
      selectStationCollections(catalog, {
        preset: 'network-copy',
        networkId: 'cartoon-network',
        eraStartYear: 1997,
        eraEndYear: 2026,
        selectionMode: 'explicit',
        collectionIds: [],
      })
    ).toThrow('Choose at least one show')

    const group = 'toasttv-auto-12345678'
    const slots = stationScheduleSlots(
      'all-day',
      group,
      'network-copy',
      {
        networkId: 'cartoon-network',
        eraStartYear: 1997,
        eraEndYear: 2026,
      }
    )
    expect(slots.length).toBeGreaterThan(3)
    expect(slots[0]?.groups[0]).toStartWith(`${group}-`)
    expect(
      stationCollectionProgrammingGroups(
        'network-copy',
        catalog.collections.find(
          (item) => item.displayTitle === "Dexter's Laboratory"
        )!,
        group,
        {
          networkId: 'cartoon-network',
          eraStartYear: 1997,
          eraEndYear: 2026,
        }
      )
    ).toEqual(
      expect.arrayContaining([
        group,
        `${group}-daytime`,
        `${group}-primetime`,
      ])
    )
  })

  test('publishes audience labels and strict Australian, BBC, and PBS catalogs', async () => {
    const records = [
      collection(1, 'Bluey', {
        metadataYear: 2018,
        networks: ['ABC Kids'],
      }),
      collection(2, 'Little Lunch', {
        metadataYear: 2015,
        networks: ['ABC3'],
      }),
      collection(3, 'Hardball', {
        metadataYear: 2019,
        networks: ['ABC ME'],
      }),
      collection(4, 'Hard Quiz Kids', {
        metadataYear: 2024,
        networks: ['ABC iview'],
      }),
      collection(5, 'Horrible Histories', {
        metadataYear: 2009,
        networks: ['CBBC'],
      }),
      collection(6, 'Hey Duggee', {
        metadataYear: 2014,
        networks: ['CBeebies'],
      }),
      collection(7, 'Wild Kratts', {
        metadataYear: 2011,
        networks: ['PBS KIDS'],
      }),
    ]
    const catalog = await loadStationAutomationCatalog({
      async getCollections(options) {
        const offset = options?.offset ?? 0
        return records.slice(offset, offset + (options?.limit ?? 250))
      },
    })

    const profiles = new Map(
      catalog.networkProfiles?.map((profile) => [profile.id, profile])
    )
    expect(profiles.get('abc3-abc-me')).toMatchObject({
      audience: 'school-age',
      availableEndYear: 2024,
      matchedShows: 2,
    })
    expect(
      profiles.get('abc3-abc-me')?.matches.map((match) => match.title)
    ).toEqual(['Hardball', 'Little Lunch'])
    expect(profiles.get('abc-family-au')).toMatchObject({
      audience: 'school-age',
      matchedShows: 3,
    })
    expect(profiles.get('abc-kids-au')).toMatchObject({
      audience: 'preschool',
      matchedShows: 2,
    })
    expect(
      profiles.get('abc-kids-au')?.matches.map((match) => match.title)
    ).toEqual(['Bluey', 'Hey Duggee'])
    expect(profiles.get('cbbc')).toMatchObject({
      audience: 'school-age',
      matchedShows: 1,
    })
    expect(profiles.get('cbeebies')).toMatchObject({
      audience: 'preschool',
      matchedShows: 2,
    })
    expect(profiles.get('pbs-kids')).toMatchObject({
      audience: 'school-age',
      matchedShows: 1,
    })
    expect(
      catalog.networkProfiles?.some(
        (profile) => String(profile.id) === 'adult-swim'
      )
    ).toBe(false)
    expect(() =>
      selectStationCollections(catalog, {
        preset: 'network-copy',
        networkId: 'abc3-abc-me',
        eraStartYear: 2009,
        eraEndYear: 2024,
        selectionMode: 'explicit',
        collectionIds: [1],
      })
    ).toThrow('must belong to the chosen network')
  })

  test('keeps Off air dayparts visible without creating playable slots', async () => {
    const records = [
      collection(1, 'Little Lunch', {
        metadataYear: 2015,
        networks: ['ABC3'],
      }),
    ]
    const catalog = await loadStationAutomationCatalog({
      async getCollections(options) {
        const offset = options?.offset ?? 0
        return records.slice(offset, offset + (options?.limit ?? 250))
      },
    })
    const profile = catalog.networkProfiles?.find(
      (candidate) => candidate.id === 'abc3-abc-me'
    )

    expect(profile?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'closed-overnight',
          name: 'Off air overnight',
        }),
        expect.objectContaining({ id: 'closed-late', name: 'Off air late' }),
      ])
    )

    const group = 'toasttv-auto-offair01'
    const slots = stationScheduleSlots('all-day', group, 'network-copy', {
      networkId: 'abc3-abc-me',
      eraStartYear: 2009,
      eraEndYear: 2016,
    })
    expect(slots[0]).toMatchObject({ start: '06:00' })
    expect(slots.at(-1)).toMatchObject({ end: '21:00' })
    expect(
      slots.some((slot) =>
        slot.groups.some((slotGroup) => slotGroup.includes('closed-'))
      )
    ).toBe(false)
    expect(
      stationCollectionProgrammingGroups(
        'network-copy',
        catalog.collections[0]!,
        group,
        {
          networkId: 'abc3-abc-me',
          eraStartYear: 2009,
          eraEndYear: 2016,
        }
      ).some((collectionGroup) => collectionGroup.includes('closed-'))
    ).toBe(false)
  })

  test('distinguishes an exact 5,000-collection catalog from an unsafe overflow', async () => {
    const repositoryWith = (total: number) => ({
      async getCollections(options: { offset?: number; limit?: number }) {
        const offset = options.offset ?? 0
        const length = Math.max(
          0,
          Math.min(options.limit ?? 250, total - offset)
        )
        return Array.from({ length }, (_, index) =>
          collection(offset + index + 1, `Show ${offset + index + 1}`)
        )
      },
    })

    const exact = await loadStationAutomationCatalog(repositoryWith(5_000))
    const overflow = await loadStationAutomationCatalog(repositoryWith(5_001))

    expect(exact.truncated).toBe(false)
    expect(overflow.truncated).toBe(true)
    expect(() =>
      selectStationCollections(overflow, { preset: 'all-approved-tv' })
    ).toThrow('exceeds 5,000 collections')
  })

  test('persists generated collection groups and schedules an approved show without policy groups', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-auto-station-'))
    try {
      const title = 'Bluey (2018)'
      const approved = collection(1, title, {
        metadataTitle: 'Bluey',
        genres: ['Animation', 'Family'],
        networks: ['ABC Kids'],
        studios: ['Ludo Studio'],
      })
      const alternateTitle = 'SpongeBob SquarePants'
      const alternate = collection(2, alternateTitle, {
        genres: ['Comedy'],
        networks: ['Nickelodeon'],
        studios: ['Nickelodeon Animation Studio'],
      })
      const repository = {
        async getCollections() {
          return [approved, alternate]
        },
        async getAll() {
          return [video(title), video(alternateTitle, 502)]
        },
      } as unknown as IMediaRepository
      const policy: LibraryPolicyDocument = {
        version: 1,
        roots: {
          tv: {
            collections: [{ name: title }, { name: alternateTitle }],
          },
        },
        channels: [],
      }
      const storePath = join(directory, 'channels.json')
      const store = new ChannelConfigurationStore(storePath)
      const clock = { now: () => new Date('2026-08-24T00:05:00.000Z') }
      const service = new ChannelService(repository, policy, clock, store)
      await expect(
        service.previewAutomatedStationBuild({
          id: 'family-animation',
          name: '',
          timezone: 'Not/A_Timezone',
          preset: 'family-animation',
        })
      ).rejects.toThrow()
      const preview = await service.previewAutomatedStation({
        preset: 'family-animation',
      })
      expect(preview).toMatchObject({ collectionCount: 1, eligibleFiles: 2 })

      const result = await service.createAutomatedStation({
        id: 'family-animation',
        name: 'Family Animation',
        timezone: 'UTC',
        preset: 'family-animation',
        marathon: { enabled: true, frequency: 12, episodeCount: 4 },
      })
      expect(result.channel.enabled).toBe(true)
      expect(result.channel.marathon).toEqual({
        enabled: true,
        frequency: 12,
        episodeCount: 4,
      })
      const generatedGroup = result.channel.slots[0]?.groups[0]
      expect(generatedGroup).toMatch(/^toasttv-auto-[0-9a-f]{8}$/)
      expect(
        (await service.getGuide('family-animation', 1))?.programs[0]?.mediaId
      ).toBe(501)

      const stored = JSON.parse(readFileSync(storePath, 'utf8')) as {
        collectionGroups: Array<{
          collectionId?: number
          collectionIdentityKey?: string
          libraryKind?: string
          rootId: string
          collectionTitle: string
          groups: string[]
        }>
      }
      expect(stored.collectionGroups).toEqual([
        {
          collectionId: 1,
          collectionIdentityKey: title.toLowerCase(),
          libraryKind: 'tv',
          rootId: 'tv',
          collectionTitle: title,
          groups: [generatedGroup as string],
        },
      ])

      const restored = new ChannelService(repository, policy, clock, store)
      expect(
        restored.administrationSnapshot().channels[0]?.marathon
      ).toEqual({ enabled: true, frequency: 12, episodeCount: 4 })
      expect(
        (await restored.getGuide('family-animation', 1))?.programs[0]?.mediaId
      ).toBe(501)

      restored.create({
        id: 'shared-reference',
        name: 'Shared Reference',
        enabled: true,
        timezone: 'UTC',
        slots: [
          {
            days: ['sun'],
            start: '00:00',
            end: '24:00',
            groups: [generatedGroup as string],
          },
        ],
      })
      expect(restored.delete('family-animation')).toBe(true)
      expect(
        (JSON.parse(readFileSync(storePath, 'utf8')) as {
          collectionGroups: unknown[]
        }).collectionGroups
      ).not.toEqual([])
      expect(restored.delete('shared-reference')).toBe(true)
      expect(
        (JSON.parse(readFileSync(storePath, 'utf8')) as {
          collectionGroups: unknown[]
        }).collectionGroups
      ).toEqual([])
      const rebuilt = await restored.createAutomatedStation({
        id: 'family-animation',
        name: 'Nick Mix',
        timezone: 'UTC',
        preset: 'custom',
        collectionIds: [2],
      })
      expect(rebuilt.collections.map((item) => item.id)).toEqual([2])
      const rebuiltGuide = await restored.getGuide('family-animation', 1)
      expect(
        rebuiltGuide?.programs.every((program) => program.mediaId === 502)
      ).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('materializes a strict network copy and restores its exact lineup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-era-station-'))
    try {
      const bluey = collection(1, 'Bluey', {
        metadataYear: 2018,
        genres: ['Animation', 'Family'],
        networks: ['ABC Kids'],
      })
      const dexter = collection(2, "Dexter's Laboratory", {
        metadataYear: 1996,
        genres: ['Animation', 'Comedy'],
        networks: ['Cartoon Network'],
      })
      const repository = {
        async getCollections() {
          return [bluey, dexter]
        },
        async getAll() {
          return [video('Bluey'), video("Dexter's Laboratory", 502)]
        },
      } as unknown as IMediaRepository
      const policy: LibraryPolicyDocument = {
        version: 1,
        roots: {
          tv: {
            collections: [{ name: 'Bluey' }, { name: "Dexter's Laboratory" }],
          },
        },
        channels: [],
      }
      const store = new ChannelConfigurationStore(join(directory, 'channels.json'))
      const service = new ChannelService(
        repository,
        policy,
        { now: () => new Date('2026-08-24T07:05:00.000Z') },
        store
      )

      const result = await service.createAutomatedStation({
        id: 'cn-copy',
        name: 'Cartoon Network Copy',
        timezone: 'UTC',
        preset: 'network-copy',
        networkId: 'cartoon-network',
        eraStartYear: 1997,
        eraEndYear: 2026,
        selectionMode: 'explicit',
        collectionIds: [2],
        airtime: 'all-day',
      })

      expect(result.channel.automation).toMatchObject({
        preset: 'network-copy',
        airtime: 'all-day',
        networkId: 'cartoon-network',
        eraStartYear: 1997,
        eraEndYear: 2026,
        selectionMode: 'explicit',
        collectionRefs: [
          {
            rootId: 'tv',
            libraryKind: 'tv',
            identityKey: "dexter's laboratory",
          },
        ],
      })
      expect(result.channel.slots.length).toBeGreaterThan(3)
      expect(result.channel.slots.map((slot) => slot.groups[0])).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/-morning$/),
          expect.stringMatching(/-daytime$/),
          expect.stringMatching(/-primetime$/),
        ])
      )
      expect(
        (await service.getGuide('cn-copy', 1))?.programs.every(
          (program) => program.collectionTitle === "Dexter's Laboratory"
        )
      ).toBe(true)

      const rescannedDexter = { ...dexter, id: 22 }
      const rescannedRepository = {
        async getCollections() {
          return [bluey, rescannedDexter]
        },
        async getAll() {
          return [
            video('Bluey'),
            { ...video("Dexter's Laboratory", 502), collectionId: 22 },
          ]
        },
      } as unknown as IMediaRepository
      const restored = new ChannelService(
        rescannedRepository,
        policy,
        { now: () => new Date('2026-08-24T07:05:00.000Z') },
        store
      )
      expect(await restored.stationAutomationDraft('cn-copy')).toMatchObject({
        id: 'cn-copy',
        preset: 'network-copy',
        airtime: 'all-day',
        networkId: 'cartoon-network',
        eraStartYear: 1997,
        eraEndYear: 2026,
        selectionMode: 'explicit',
        collectionIds: [22],
      })
      const lateNight = new ChannelService(
        rescannedRepository,
        policy,
        { now: () => new Date('2026-08-24T23:05:00.000Z') },
        store
      )
      expect(
        (await lateNight.getGuide('cn-copy', 1))?.programs.length
      ).toBeGreaterThan(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
