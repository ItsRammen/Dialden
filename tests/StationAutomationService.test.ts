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

  test('builds era dayparts while allowing modern family guest programming', async () => {
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

    const era = catalog.eraTemplates?.find(
      (template) => template.id === 'cartoon-network-1997-2004'
    )
    expect(era).toMatchObject({ matchedShows: 2, matchedMovies: 0 })
    expect(era?.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Bluey',
          relationship: 'family-guest',
        }),
      ])
    )
    expect(
      selectStationCollections(catalog, {
        preset: 'cartoon-network-1997-2004',
      }).map((item) => item.displayTitle)
    ).toEqual(['Bluey', "Dexter's Laboratory"])

    const group = 'toasttv-auto-12345678'
    const slots = stationScheduleSlots(
      'all-day',
      group,
      'cartoon-network-1997-2004'
    )
    expect(slots.length).toBeGreaterThan(3)
    expect(slots[0]?.groups[0]).toStartWith(`${group}-`)
    expect(
      stationCollectionProgrammingGroups(
        'cartoon-network-1997-2004',
        catalog.collections.find((item) => item.displayTitle === 'Bluey')!,
        group
      )
    ).toEqual(
      expect.arrayContaining([
        group,
        `${group}-morning`,
        `${group}-daytime`,
      ])
    )
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

  test('materializes era dayparts and restores the selected Auto recipe', async () => {
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
        id: 'cn-family-mix',
        name: 'Cartoon Family Mix',
        timezone: 'UTC',
        preset: 'cartoon-network-1997-2004',
        airtime: 'all-day',
      })

      expect(result.channel.automation).toEqual({
        preset: 'cartoon-network-1997-2004',
        airtime: 'all-day',
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
        (await service.getGuide('cn-family-mix', 1))?.programs.every(
          (program) => program.collectionTitle === 'Bluey'
        )
      ).toBe(true)

      const restored = new ChannelService(
        repository,
        policy,
        { now: () => new Date('2026-08-24T07:05:00.000Z') },
        store
      )
      expect(await restored.stationAutomationDraft('cn-family-mix')).toMatchObject({
        id: 'cn-family-mix',
        preset: 'cartoon-network-1997-2004',
        airtime: 'all-day',
        collectionIds: expect.arrayContaining([1, 2]),
      })
      const lateNight = new ChannelService(
        repository,
        policy,
        { now: () => new Date('2026-08-24T23:05:00.000Z') },
        store
      )
      expect(
        (await lateNight.getGuide('cn-family-mix', 1))?.programs.length
      ).toBeGreaterThan(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
