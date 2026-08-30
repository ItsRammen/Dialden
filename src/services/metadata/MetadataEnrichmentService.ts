import {
  persistMetadataConfig,
  resolveMetadataConfigUpdate,
  toPublicMetadataConfig,
  type MetadataConfigUpdateInput,
  type MetadataRuntimeConfig,
  type PublicMetadataConfig,
} from '../../config/metadata'
import {
  MetadataProviderError,
  type ProviderEpisodeDetails,
  type MetadataProvider,
} from '../../metadata/types'
import type { IMediaRepository } from '../../repositories/IMediaRepository'
import {
  collectionRuntimeMinutes,
  resolveByRuntime,
} from './runtimeMatch'
import type { ReviewDecisionStore } from '../review/auditTypes'

/* Runtime lookups cost one request each, so only the best-ranked few are
   asked about; beyond that the extra calls buy nothing a reviewer would use. */
const RUNTIME_LOOKUP_LIMIT = 5
import type {
  MediaCollection,
  MetadataCandidateRecord,
  MetadataJobState,
} from '../../types'
import {
  DEFAULT_KIDS_7_POLICY,
  evaluatePolicy,
  type PolicyEvaluation,
  type RatingPolicyProfile,
} from '../../policy/PolicyEngine'
import {
  cleanCollectionTitle,
  matchMetadata,
  normalizeTitle,
  type ParsedCollectionTitle,
  type RankedMetadataCandidate,
} from './TitleMatcher'
import { TmdbMetadataProvider } from './TmdbMetadataProvider'

export type MetadataJobEventType =
  | 'library.metadata.started'
  | 'library.metadata.progress'
  | 'library.metadata.completed'
  | 'library.metadata.failed'

export interface MetadataJobEvent {
  readonly type: MetadataJobEventType
  readonly state: MetadataJobState
}

export type MetadataProviderFactory = (
  config: MetadataRuntimeConfig
) => MetadataProvider

export class MetadataEnrichmentService {
  private static readonly RATING_REGIONS_SETTING =
    'metadata_rating_regions_v1'
  private activeRun: Promise<MetadataJobState> | null = null
  private operationTail: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<
    (event: MetadataJobEvent) => void | Promise<void>
  >()
  private state: MetadataJobState = {
    status: 'idle',
    providerHealth: 'unverified',
    providerMessage: null,
    total: 0,
    processed: 0,
    matched: 0,
    needsReview: 0,
    failed: 0,
    currentCollectionId: null,
    startedAt: null,
    completedAt: null,
    error: null,
  }

  constructor(
    private readonly repository: IMediaRepository,
    private provider: MetadataProvider,
    private config: MetadataRuntimeConfig,
    private readonly profile: RatingPolicyProfile | null = DEFAULT_KIDS_7_POLICY,
    private readonly providerFactory: MetadataProviderFactory = createTmdbProvider,
    /** Absent in tests; without it a runtime match simply is not recorded. */
    private readonly audit?: ReviewDecisionStore
  ) {
    if (!provider.configured) {
      this.state = {
        ...this.state,
        providerHealth: 'not_configured',
        providerMessage: 'Metadata provider credentials are not configured.',
      }
    }
  }

  getState(): MetadataJobState {
    return { ...this.state }
  }

  /** The only configuration shape safe for admin and TV-client responses. */
  getPublicConfig(): PublicMetadataConfig {
    return toPublicMetadataConfig(this.config)
  }

  /**
   * Validate and exercise current or supplied form values without persisting
   * them or replacing the active provider. Blank API-key input keeps the
   * current server-side key.
   */
  testConfiguration(
    input: MetadataConfigUpdateInput,
    signal?: AbortSignal
  ): Promise<void> {
    return this.withExclusiveOperation(() =>
      this.testConfigurationUnlocked(input, signal)
    )
  }

  private async testConfigurationUnlocked(
    input: MetadataConfigUpdateInput,
    signal?: AbortSignal
  ): Promise<void> {
    const candidate = resolveMetadataConfigUpdate(this.config, input)
    if (sameMetadataConfig(candidate, this.config)) {
      await this.testConnectionUnlocked(signal)
      return
    }
    await this.providerFactory(candidate).testConnection(signal)
  }

  /**
   * Queue dependent refreshes safely, persist one complete configuration, then
   * swap the live provider. Callers never receive the secret-bearing object.
   */
  updateConfiguration(
    input: MetadataConfigUpdateInput
  ): Promise<PublicMetadataConfig> {
    return this.withExclusiveOperation(() =>
      this.applyConfigurationUpdate(input)
    )
  }

  private async applyConfigurationUpdate(
    input: MetadataConfigUpdateInput
  ): Promise<PublicMetadataConfig> {
    const previous = this.config
    const next = resolveMetadataConfigUpdate(this.config, input)
    const nextProvider = this.providerFactory(next)

    // Queue any safety- or locale-sensitive refresh before committing the new
    // setting. If invalidation fails, the saved and live configurations remain
    // untouched and the controller can truthfully report that the old config
    // is still active. Region invalidation revokes eligibility first, so even a
    // later repository failure leaves the affected collection fail-closed.
    await this.synchronizeConfigurationChange(previous, next, nextProvider, true)
    await persistMetadataConfig(this.repository, next)

    this.config = next
    this.provider = nextProvider
    this.state = {
      ...this.state,
      status: this.provider.configured ? 'idle' : 'not_configured',
      providerHealth: this.provider.configured
        ? 'unverified'
        : 'not_configured',
      providerMessage: this.provider.configured
        ? null
        : 'Metadata provider credentials are not configured.',
      currentCollectionId: null,
      error: null,
    }

    return this.getPublicConfig()
  }

  onEvent(
    listener: (event: MetadataJobEvent) => void | Promise<void>
  ): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  runPending(): Promise<MetadataJobState> {
    if (this.activeRun) return this.activeRun
    const run = this.withExclusiveOperation(() => this.processPending())
    this.activeRun = run
    void run.finally(() => {
      if (this.activeRun === run) this.activeRun = null
    })
    return run
  }

  /**
   * Queue every present show/movie for a fresh metadata and policy pass.
   * Automatically selected identities are searched again; manually confirmed
   * identities stay locked and are refreshed in place. Parent allow/block
   * overrides live in a separate column and are deliberately never changed.
   */
  reevaluateLibrary(): Promise<MetadataJobState> {
    if (this.activeRun) return this.activeRun
    const run = this.withExclusiveOperation(async () => {
      await this.queueLibraryReevaluationUnlocked(false)
      const state = await this.processPending()
      await this.reapplyCachedPoliciesUnlocked()
      return state
    })
    this.activeRun = run
    void run.finally(() => {
      if (this.activeRun === run) this.activeRun = null
    })
    return run
  }

  /**
   * Retry only unresolved collections which still depend on policy review.
   * Explicit parent decisions are skipped, while locked manual identities may
   * be refreshed in place when their certification is what needs review.
   */
  retryReviewLibrary(): Promise<MetadataJobState> {
    if (this.activeRun) return this.activeRun
    const run = this.withExclusiveOperation(async () => {
      await this.queueLibraryReevaluationUnlocked(true)
      const state = await this.processPending()
      await this.reapplyCachedPoliciesUnlocked()
      return state
    })
    this.activeRun = run
    void run.finally(() => {
      if (this.activeRun === run) this.activeRun = null
    })
    return run
  }

  private async queueLibraryReevaluationUnlocked(
    reviewOnly: boolean
  ): Promise<number> {
    let offset = 0
    let queued = 0
    const pageSize = 250
    while (true) {
      const collections = await this.repository.getCollections({
        presentOnly: true,
        limit: pageSize,
        offset,
      })
      if (collections.length === 0) break
      for (const collection of collections) {
        if (collection.libraryKind === 'other') continue
        if (
          reviewOnly &&
          (collection.parentOverride !== null ||
            collection.effectiveDecision !== 'review')
        ) continue
        const keepManualIdentity =
          collection.metadataLocked && Boolean(collection.metadataExternalId)
        const policyUpdated = await this.repository.updateCollectionPolicy(
          collection.id,
          'review',
          'library_reevaluation_requested',
          this.profileId()
        )
        if (!policyUpdated) continue
        const metadataUpdated = await this.repository.updateCollectionMetadata(
          collection.id,
          {
            provider: collection.metadataProvider ?? this.provider.id,
            externalId: keepManualIdentity
              ? collection.metadataExternalId
              : null,
            status: 'pending',
            locked: keepManualIdentity,
            title: null,
            originalTitle: null,
            year: null,
            overview: null,
            posterPath: null,
            backdropPath: null,
            genres: [],
            networks: [],
            studios: [],
            certification: null,
            certificationRegion: null,
            ratingStatus: 'missing',
            matchConfidence: null,
            candidates: [],
            error: null,
            matchedAt: null,
          }
        )
        if (!metadataUpdated) {
          throw new Error(
            'A library collection changed while queuing re-evaluation'
          )
        }
        queued++
      }
      offset += collections.length
      if (collections.length < pageSize) break
    }
    return queued
  }

  testConnection(signal?: AbortSignal): Promise<void> {
    return this.withExclusiveOperation(() =>
      this.testConnectionUnlocked(signal)
    )
  }

  private async testConnectionUnlocked(signal?: AbortSignal): Promise<void> {
    try {
      await this.provider.testConnection(signal)
      this.markProviderSuccess()
    } catch (error) {
      this.markProviderFailure(error)
      throw error
    }
  }

  /**
   * Re-evaluate every cached collection before playback consumers start. This
   * makes policy edits (or a missing/invalid policy) take effect without a
   * filesystem rescan or another TMDB request.
   */
  reapplyCachedPolicies(): Promise<number> {
    return this.withExclusiveOperation(() =>
      this.reapplyCachedPoliciesUnlocked()
    )
  }

  private async reapplyCachedPoliciesUnlocked(): Promise<number> {
    let offset = 0
    let updated = 0
    const pageSize = 250

    while (true) {
      const collections = await this.repository.getCollections({
        presentOnly: false,
        limit: pageSize,
        offset,
      })
      if (collections.length === 0) break
      for (const collection of collections) {
        const evaluation = this.evaluateCachedPolicy(collection)
        if (
          collection.policyDecision !== evaluation.decision ||
          collection.policyReason !== evaluation.reason ||
          collection.policyProfileId !== this.profileId()
        ) {
          if (
            await this.repository.updateCollectionPolicy(
              collection.id,
              evaluation.decision,
              evaluation.reason,
              this.profileId()
            )
          ) {
            updated++
          }
        }
      }
      offset += collections.length
      if (collections.length < pageSize) break
    }

    return updated
  }

  /**
   * Fail closed whenever the ordered certification-region preference changes.
   * Existing TMDB identities are retained, but their cached certification is
   * cleared and queued for refresh before it can authorize playback again.
   */
  synchronizeRatingRegions(): Promise<number> {
    return this.withExclusiveOperation(() =>
      this.synchronizeRatingRegionsUnlocked()
    )
  }

  private async synchronizeRatingRegionsUnlocked(): Promise<number> {
    return this.synchronizeConfigurationChange(
      this.config,
      this.config,
      this.provider,
      false
    )
  }

  private async synchronizeConfigurationChange(
    previousConfig: MetadataRuntimeConfig,
    nextConfig: MetadataRuntimeConfig,
    nextProvider: MetadataProvider,
    refreshLanguage: boolean
  ): Promise<number> {
    const signature = ratingRegionSignature(nextConfig)
    const previous = await this.repository.getSetting(
      MetadataEnrichmentService.RATING_REGIONS_SETTING
    )
    const ratingRegionsChanged =
      previous !== signature ||
      ratingRegionSignature(previousConfig) !== signature
    const languageChanged =
      refreshLanguage && previousConfig.language !== nextConfig.language
    if (!ratingRegionsChanged && !languageChanged) return 0

    let offset = 0
    let queued = 0
    const pageSize = 250
    while (true) {
      const collections = await this.repository.getCollections({
        presentOnly: false,
        limit: pageSize,
        offset,
      })
      if (collections.length === 0) break
      for (const collection of collections) {
        if (
          !collection.metadataExternalId ||
          !['matched', 'manual'].includes(collection.metadataStatus)
        ) {
          continue
        }
        if (ratingRegionsChanged) {
          const policyUpdated = await this.repository.updateCollectionPolicy(
            collection.id,
            'review',
            'rating_region_changed',
            this.profileId()
          )
          if (!policyUpdated) continue
        }

        const metadataUpdated =
          await this.repository.updateCollectionMetadata(collection.id, {
            provider: collection.metadataProvider ?? nextProvider.id,
            externalId: collection.metadataExternalId,
            status: 'pending',
            locked: collection.metadataLocked,
            ...(ratingRegionsChanged
              ? {
                  certification: null,
                  certificationRegion: null,
                  ratingStatus: 'missing' as const,
                  error: null,
                  matchedAt: null,
                }
              : { error: null }),
          })
        if (!metadataUpdated) {
          throw new Error('Metadata collection changed while queuing a refresh')
        }
        queued++
      }
      offset += collections.length
      if (collections.length < pageSize) break
    }

    if (ratingRegionsChanged) {
      await this.repository.setSetting(
        MetadataEnrichmentService.RATING_REGIONS_SETTING,
        signature
      )
    }
    return queued
  }

  confirmMatch(
    collectionId: number,
    externalId: string
  ): Promise<MediaCollection | null> {
    return this.withExclusiveOperation(() =>
      this.confirmMatchUnlocked(collectionId, externalId)
    )
  }

  private async confirmMatchUnlocked(
    collectionId: number,
    externalId: string
  ): Promise<MediaCollection | null> {
    if (!/^\d+$/.test(externalId) || Number(externalId) <= 0) return null
    const collection = await this.repository.getCollectionById(collectionId)
    if (!collection || collection.libraryKind === 'other') return null

    try {
      await this.hydrateMatch(collection, externalId, 'manual', 1, [], true)
      this.markProviderSuccess()
    } catch (error) {
      this.markProviderFailure(error)
      await this.recordErrorSafely(collection, error)
      throw error
    }
    return this.repository.getCollectionById(collectionId)
  }

  retryCollection(collectionId: number): Promise<MediaCollection | null> {
    return this.withExclusiveOperation(() =>
      this.retryCollectionUnlocked(collectionId)
    )
  }

  private async retryCollectionUnlocked(
    collectionId: number
  ): Promise<MediaCollection | null> {
    const collection = await this.repository.getCollectionById(collectionId)
    if (!collection) return null
    try {
      await this.processCollection(collection)
      if (collection.libraryKind !== 'other') this.markProviderSuccess()
    } catch (error) {
      this.markProviderFailure(error)
      await this.recordErrorSafely(collection, error)
      throw error
    }
    return this.repository.getCollectionById(collectionId)
  }

  private async processPending(): Promise<MetadataJobState> {
    let collections: MediaCollection[]
    try {
      collections = await this.repository.getCollectionsNeedingMetadata(5000)
    } catch (error) {
      this.markProviderFailure(error)
      this.state = {
        ...this.state,
        status: 'failed',
        total: 0,
        processed: 0,
        matched: 0,
        needsReview: 0,
        failed: 0,
        currentCollectionId: null,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: this.safeErrorMessage(error),
      }
      await this.emit('library.metadata.failed')
      return this.getState()
    }
    this.state = {
      status: this.provider.configured ? 'running' : 'not_configured',
      providerHealth: this.provider.configured
        ? this.state.providerHealth === 'not_configured'
          ? 'unverified'
          : this.state.providerHealth
        : 'not_configured',
      providerMessage: this.provider.configured
        ? this.state.providerHealth === 'not_configured'
          ? null
          : this.state.providerMessage
        : 'Metadata provider credentials are not configured.',
      total: collections.length,
      processed: 0,
      matched: 0,
      needsReview: 0,
      failed: 0,
      currentCollectionId: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
    }
    await this.emit('library.metadata.started')

    try {
      let terminalError: unknown = null
      for (const collection of collections) {
        this.state = { ...this.state, currentCollectionId: collection.id }
        if (!this.provider.configured) {
          await this.repository.updateCollectionMetadata(collection.id, {
            provider: this.provider.id,
            externalId: collection.metadataExternalId,
            status: 'not_configured',
            error: 'Metadata provider is not configured',
          })
          await this.repository.updateCollectionPolicy(
            collection.id,
            'review',
            'metadata_missing',
            this.profileId()
          )
          this.advance('review')
        } else {
          try {
            const outcome = await this.processCollection(collection)
            if (collection.libraryKind !== 'other') this.markProviderSuccess()
            this.advance(outcome)
          } catch (error) {
            this.markProviderFailure(error)
            await this.recordErrorSafely(collection, error)
            this.advance('failed')
            if (
              error instanceof MetadataProviderError &&
              (error.code === 'rate_limited' || error.code === 'unauthorized')
            ) {
              terminalError = error
            }
          }
        }
        await this.emit('library.metadata.progress')
        if (terminalError) break
      }

      this.state = {
        ...this.state,
        status: terminalError
          ? 'failed'
          : this.provider.configured
            ? 'completed'
            : 'not_configured',
        currentCollectionId: null,
        completedAt: new Date().toISOString(),
        error: terminalError ? this.safeErrorMessage(terminalError) : null,
      }
      await this.emit(
        terminalError
          ? 'library.metadata.failed'
          : 'library.metadata.completed'
      )
      return this.getState()
    } catch (error) {
      this.markProviderFailure(error)
      this.state = {
        ...this.state,
        status: 'failed',
        currentCollectionId: null,
        completedAt: new Date().toISOString(),
        error: this.safeErrorMessage(error),
      }
      await this.emit('library.metadata.failed')
      return this.getState()
    }
  }

  private async processCollection(
    collection: MediaCollection
  ): Promise<'matched' | 'review'> {
    if (collection.libraryKind === 'other') {
      await this.repository.updateCollectionMetadata(collection.id, {
        provider: this.provider.id,
        externalId: null,
        status: 'unmatched',
        candidates: [],
        error: null,
      })
      await this.repository.updateCollectionPolicy(
        collection.id,
        'review',
        'metadata_unmatched',
        this.profileId()
      )
      return 'review'
    }

    // Region invalidation and recoverable provider errors retain the selected
    // identity. Refresh it directly so a manual match remains locked and an
    // automatic exact match does not depend on search ordering changing.
    if (collection.metadataExternalId) {
      await this.hydrateMatch(
        collection,
        collection.metadataExternalId,
        collection.metadataLocked ? 'manual' : 'matched',
        collection.matchConfidence ?? (collection.metadataLocked ? 1 : 0),
        collection.metadataCandidates,
        collection.metadataLocked
      )
      return 'matched'
    }

    const searchInput = {
      title: collection.parsedTitle,
      ...(collection.year === null ? {} : { year: collection.year }),
      language: this.config.language,
    }
    let candidates =
      collection.libraryKind === 'movie'
        ? await this.provider.searchMovie(searchInput)
        : await this.provider.searchTV(searchInput)
    const parsed: ParsedCollectionTitle = {
      title: collection.parsedTitle,
      normalizedTitle: normalizeTitle(collection.parsedTitle),
      ...(collection.year === null ? {} : { year: collection.year }),
    }
    let result = matchMetadata(parsed, candidates)

    // TMDB's year filters use a single primary release/air year. A title can
    // legitimately be dated one year earlier in the library because of a
    // festival, broadcast, or regional release. Retry without the hard year
    // filter only when the filtered response contains no exact title at all;
    // the strict matcher still requires a unique exact title and permits at
    // most a one-year drift.
    if (
      collection.year !== null &&
      result.status !== 'matched' &&
      !result.candidates.some((candidate) => candidate.exactTitle)
    ) {
      const fallbackInput = {
        title: collection.parsedTitle,
        language: this.config.language,
      }
      const fallbackCandidates =
        collection.libraryKind === 'movie'
          ? await this.provider.searchMovie(fallbackInput)
          : await this.provider.searchTV(fallbackInput)
      candidates = [...candidates, ...fallbackCandidates]
      result = matchMetadata(parsed, candidates)
    }

    /* Filename furniture blocks the exact title the strict matcher requires:
       "28 Years Later Part 2 The Bone Temple" cannot match "28 Years Later:
       The Bone Temple" until the part marker goes. Search once more with it
       stripped, and adopt the result only when it is a clean match -- cleaning
       must never turn an honest unmatched into an ambiguous one. */
    if (result.status !== 'matched') {
      const cleanedTitle = cleanCollectionTitle(collection.parsedTitle)
      if (cleanedTitle) {
        const cleanedCandidates =
          collection.libraryKind === 'movie'
            ? await this.provider.searchMovie({
                title: cleanedTitle,
                ...(collection.year === null ? {} : { year: collection.year }),
                language: this.config.language,
                      })
            : await this.provider.searchTV({
                title: cleanedTitle,
                ...(collection.year === null ? {} : { year: collection.year }),
                language: this.config.language,
                      })
        const cleanedParsed: ParsedCollectionTitle = {
          title: cleanedTitle,
          normalizedTitle: normalizeTitle(cleanedTitle),
          ...(collection.year === null ? {} : { year: collection.year }),
        }
        const merged = [...candidates, ...cleanedCandidates]
        const cleanedResult = matchMetadata(cleanedParsed, merged)
        if (cleanedResult.status === 'matched') {
          candidates = merged
          result = cleanedResult
        }
      }
    }
    const candidateRecords =
      result.status === 'matched'
        ? this.toCandidateRecords(result.candidates)
        : await this.withRuntimes(
            collection,
            this.toCandidateRecords(result.candidates)
          )

    if (result.status !== 'matched' || !result.candidate) {
      const byRuntime = await this.matchOnRuntime(collection, candidateRecords)
      if (byRuntime) return 'matched'

      await this.repository.updateCollectionMetadata(collection.id, {
        provider: this.provider.id,
        externalId: null,
        status: result.status,
        matchConfidence: result.confidence,
        candidates: candidateRecords,
        ratingStatus: 'missing',
        certification: null,
        certificationRegion: null,
        error: null,
      })
      const evaluation = evaluatePolicy(this.profile, {
        matchStatus: result.status,
        certification: null,
      })
      await this.repository.updateCollectionPolicy(
        collection.id,
        evaluation.decision,
        evaluation.reason,
        this.profileId()
      )
      return 'review'
    }

    await this.hydrateMatch(
      collection,
      result.candidate.externalId,
      'matched',
      result.confidence,
      candidateRecords,
      false
    )
    return 'matched'
  }

  private async hydrateMatch(
    collection: MediaCollection,
    externalId: string,
    status: 'matched' | 'manual',
    confidence: number,
    candidates: readonly MetadataCandidateRecord[],
    locked: boolean
  ): Promise<void> {
    const details =
      collection.libraryKind === 'movie'
        ? await this.provider.getMovie(externalId, {
            language: this.config.language,
          })
        : await this.provider.getTV(externalId, {
            language: this.config.language,
          })
    const regions = [
      this.config.preferredRatingRegion,
      ...this.config.fallbackRatingRegions,
    ]
    const rating =
      collection.libraryKind === 'movie'
        ? await this.provider.getMovieCertification(externalId, regions)
        : await this.provider.getTVContentRating(externalId, regions)
    const certification = rating.selected?.certification ?? null
    const matchedAt = new Date().toISOString()

    await this.repository.updateCollectionMetadata(collection.id, {
      provider: this.provider.id,
      externalId,
      status,
      locked,
      title: details.title,
      originalTitle: details.originalTitle ?? null,
      year: details.year ?? null,
      overview: details.overview ?? null,
      posterPath: details.posterPath ?? null,
      backdropPath: details.backdropPath ?? null,
      genres: details.genres,
      networks: details.networks ?? [],
      studios: details.studios ?? [],
      certification,
      certificationRegion: rating.selected?.region ?? null,
      ratingStatus: rating.status,
      matchConfidence: confidence,
      candidates,
      error: null,
      matchedAt,
    })
    if (collection.libraryKind === 'tv') {
      try {
        await this.hydrateEpisodeMetadata(collection.id, externalId)
      } catch (error) {
        // Show-level identity, ratings, and policy remain useful when one
        // supplemental season request fails. A later refresh can retry it.
        console.warn(
          `Episode metadata refresh failed for collection ${collection.id}: ${this.safeErrorMessage(error)}`
        )
      }
    }
    const evaluation = evaluatePolicy(this.profile, {
      matchStatus: status,
      certification,
    })
    await this.repository.updateCollectionPolicy(
      collection.id,
      evaluation.decision,
      evaluation.reason,
      this.profileId()
    )
  }

  private async hydrateEpisodeMetadata(
    collectionId: number,
    externalId: string
  ): Promise<void> {
    if (!this.provider.getTVSeason) return
    const files = await this.repository.getCollectionMedia(collectionId)
    const seasons = [
      ...new Set(
        files
          .map((file) => file.seasonNumber)
          .filter(
            (season): season is number =>
              season !== null &&
              season !== undefined &&
              Number.isSafeInteger(season) &&
              season >= 0
          )
      ),
    ].sort((left, right) => left - right)
    const episodes: ProviderEpisodeDetails[] = []
    for (const season of seasons) {
      episodes.push(
        ...(await this.provider.getTVSeason(externalId, season, {
          language: this.config.language,
        }))
      )
    }
    await this.repository.updateCollectionEpisodeMetadata(collectionId, episodes)
  }

  private async recordError(
    collection: MediaCollection,
    error: unknown
  ): Promise<void> {
    await this.repository.updateCollectionMetadata(collection.id, {
      provider: this.provider.id,
      externalId: collection.metadataExternalId,
      status: this.provider.configured ? 'error' : 'not_configured',
      error: this.safeErrorMessage(error),
    })
    await this.repository.updateCollectionPolicy(
      collection.id,
      'review',
      this.provider.configured ? 'metadata_error' : 'metadata_missing',
      this.profileId()
    )
  }

  private async recordErrorSafely(
    collection: MediaCollection,
    error: unknown
  ): Promise<void> {
    try {
      await this.recordError(collection, error)
    } catch {
      // Preserve the original provider failure. Health is already degraded
      // even if persisting the row-level diagnostic also fails.
    }
  }

  /**
   * Fills in runtimes for the candidates of a collection nobody could match.
   *
   * Search results carry no runtime, so this costs one detail request per
   * candidate. It is therefore spent only where it can change the answer: a
   * collection that is already matched is left alone, and only the few
   * best-ranked candidates are asked about. A failure is not fatal -- the
   * candidate simply keeps no runtime and the review carries on.
   */
  /**
   * Last resort before a collection is queued for review: if the length of
   * the file identifies exactly one of the tied candidates, take it.
   *
   * This is the only place automation chooses between titles that ordinary
   * matching could not, so it is recorded in the audit trail like any other
   * automatic decision and reverts with the rest of them.
   */
  private async matchOnRuntime(
    collection: MediaCollection,
    candidates: readonly MetadataCandidateRecord[]
  ): Promise<boolean> {
    let fileRuntime: number | undefined
    try {
      const media = await this.repository.getCollectionMedia(collection.id)
      fileRuntime = collectionRuntimeMinutes(
        media.map((item) => item.durationSeconds)
      )
    } catch {
      return false
    }

    const resolved = resolveByRuntime(candidates, fileRuntime, collection.year)
    if (!resolved) return false

    try {
      await this.hydrateMatch(
        collection,
        resolved.candidate.externalId,
        'matched',
        resolved.candidate.confidence,
        candidates,
        false
      )
    } catch {
      // A provider failure here just means the collection stays for review.
      return false
    }

    await this.audit
      ?.recordReviewDecision({
        runId: `runtime-${new Date().toISOString().slice(0, 10)}`,
        collectionId: collection.id,
        action: 'match',
        source: 'policy',
        reason: 'metadata_ambiguous',
        detail: `File runs ${fileRuntime} min; ${resolved.candidate.title} is listed at ${resolved.candidate.runtimeMinutes} min (${resolved.deltaMinutes} min apart). Every other tied candidate was further off.`,
        model: null,
        promptVersion: null,
        confidence: resolved.candidate.confidence,
        previousOverride: collection.parentOverride,
        previousExternalId: collection.metadataExternalId,
        previousMetadataStatus: collection.metadataStatus,
      })
      .catch(() => {})

    return true
  }

  private async withRuntimes(
    collection: MediaCollection,
    candidates: MetadataCandidateRecord[]
  ): Promise<MetadataCandidateRecord[]> {
    if (candidates.length < 2) return candidates
    const enriched: MetadataCandidateRecord[] = []
    for (const [index, candidate] of candidates.entries()) {
      if (index >= RUNTIME_LOOKUP_LIMIT || candidate.runtimeMinutes !== undefined) {
        enriched.push(candidate)
        continue
      }
      try {
        const details =
          candidate.mediaType === 'movie'
            ? await this.provider.getMovie(candidate.externalId, {
                language: this.config.language,
              })
            : await this.provider.getTV(candidate.externalId, {
                language: this.config.language,
              })
        enriched.push({
          ...candidate,
          ...(details.runtimeMinutes === undefined
            ? {}
            : { runtimeMinutes: details.runtimeMinutes }),
          ...(candidate.overview || !details.overview
            ? {}
            : { overview: details.overview.slice(0, 600) }),
        })
      } catch {
        enriched.push(candidate)
      }
    }
    return enriched
  }

  private toCandidateRecords(
    candidates: readonly RankedMetadataCandidate[]
  ): MetadataCandidateRecord[] {
    return candidates.slice(0, 8).map(({ candidate, score }) => ({
      provider: candidate.provider,
      externalId: candidate.externalId,
      mediaType: candidate.mediaType,
      title: candidate.title,
      ...(candidate.originalTitle ? { originalTitle: candidate.originalTitle } : {}),
      ...(candidate.year === undefined ? {} : { year: candidate.year }),
      ...(candidate.posterPath ? { posterPath: candidate.posterPath } : {}),
      /* Overviews are the only thing that separates a remake from its
         original, so they are stored rather than re-fetched at review time.
         Trimmed because eight of them per collection is otherwise a lot of
         database for text nobody reads in full. */
      ...(candidate.overview
        ? { overview: candidate.overview.slice(0, 600) }
        : {}),
      ...(candidate.popularity === undefined
        ? {}
        : { popularity: candidate.popularity }),
      confidence: score,
    }))
  }

  private advance(outcome: 'matched' | 'review' | 'failed'): void {
    this.state = {
      ...this.state,
      processed: this.state.processed + 1,
      matched: this.state.matched + (outcome === 'matched' ? 1 : 0),
      needsReview: this.state.needsReview + (outcome === 'review' ? 1 : 0),
      failed: this.state.failed + (outcome === 'failed' ? 1 : 0),
    }
  }

  private async emit(type: MetadataJobEventType): Promise<void> {
    const event: MetadataJobEvent = { type, state: this.getState() }
    for (const listener of this.listeners) {
      try {
        await listener(event)
      } catch (error) {
        console.error(`Metadata event listener failed (${type})`, error)
      }
    }
  }

  private markProviderSuccess(): void {
    if (!this.provider.configured) return
    this.state = {
      ...this.state,
      providerHealth: this.state.failed > 0 ? 'degraded' : 'connected',
      providerMessage:
        this.state.failed > 0
          ? this.state.providerMessage ??
            'One or more metadata records failed during the latest refresh.'
          : null,
    }
  }

  private markProviderFailure(error: unknown): void {
    this.state = {
      ...this.state,
      providerHealth: this.provider.configured ? 'degraded' : 'not_configured',
      providerMessage: this.safeErrorMessage(error),
    }
  }

  private safeErrorMessage(error: unknown): string {
    if (!(error instanceof MetadataProviderError)) {
      return 'Metadata processing failed. Review the server logs for details.'
    }

    switch (error.code) {
      case 'not_configured':
        return 'Metadata provider credentials are not configured.'
      case 'unauthorized':
        return 'The metadata provider rejected the configured credentials.'
      case 'rate_limited':
        return 'The metadata provider temporarily rate-limited requests.'
      case 'network':
        return 'The metadata provider could not be reached over the network.'
      case 'timeout':
        return 'The metadata provider request timed out.'
      case 'upstream':
        return 'The metadata provider returned an upstream error.'
      case 'not_found':
        return 'The selected metadata record was not found.'
      case 'invalid_external_id':
        return 'The selected metadata identifier is invalid.'
      case 'invalid_response':
        return 'The metadata provider returned an invalid response.'
      case 'aborted':
        return 'The metadata provider request was cancelled.'
    }
  }

  private async withExclusiveOperation<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.operationTail
    let release!: () => void
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private profileId(): string {
    return this.profile?.id?.trim() || 'unconfigured'
  }

  private evaluateCachedPolicy(collection: MediaCollection): PolicyEvaluation {
    if (collection.metadataStatus === 'not_configured') {
      return evaluatePolicy(this.profile, null)
    }
    const matchStatus = collection.metadataStatus
    const certification =
      collection.ratingStatus === 'resolved' ? collection.certification : null
    return evaluatePolicy(this.profile, { matchStatus, certification })
  }
}

function createTmdbProvider(
  config: MetadataRuntimeConfig
): MetadataProvider {
  return new TmdbMetadataProvider({
    apiKey: config.tmdbApiKey,
    requestTimeoutMs: config.requestTimeoutMs,
  })
}

function ratingRegionSignature(config: MetadataRuntimeConfig): string {
  return JSON.stringify([
    config.preferredRatingRegion,
    ...config.fallbackRatingRegions,
  ])
}

function sameMetadataConfig(
  left: MetadataRuntimeConfig,
  right: MetadataRuntimeConfig
): boolean {
  return (
    left.tmdbApiKey === right.tmdbApiKey &&
    left.language === right.language &&
    left.preferredRatingRegion === right.preferredRatingRegion &&
    left.requestTimeoutMs === right.requestTimeoutMs &&
    left.fallbackRatingRegions.length === right.fallbackRatingRegions.length &&
    left.fallbackRatingRegions.every(
      (region, index) => region === right.fallbackRatingRegions[index]
    )
  )
}
