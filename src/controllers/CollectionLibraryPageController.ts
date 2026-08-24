import { Hono, type Context } from 'hono'
import type { CollectionLibraryService } from '../services/CollectionLibraryService'
import type { MetadataEnrichmentService } from '../services/metadata/MetadataEnrichmentService'
import {
  renderCollectionLibrary,
  type CollectionCardViewModel,
  type CollectionDetailViewModel,
  type CollectionLibrarySummaryViewModel,
  type CollectionLibraryViewModel,
  type CollectionMetadataStatus,
  type CollectionTechnicalViewModel,
} from '../templates/collectionLibrary'
import {
  parseEpisodeDisplayTitle,
  parseEpisodeRange,
} from '../domain/CollectionIdentity'
import type {
  LibrarySummary,
  MediaCollection,
  MediaItem,
  PolicyDecision,
} from '../types'
import { cleanFilename } from '../utils/cleanFilename'

interface CollectionLibraryPageControllerDeps {
  readonly library: CollectionLibraryService
  readonly metadata: Pick<MetadataEnrichmentService, 'confirmMatch' | 'retryCollection'>
  readonly refreshSchedules?: () => Promise<void>
  readonly updateAvailable?: () => boolean | undefined
}

const COLLECTION_PAGE_SIZE = 50

export function createCollectionLibraryPageController(
  deps: CollectionLibraryPageControllerDeps
) {
  const controller = new Hono()

  controller.get('/library', async (c) => {
    const summary = await buildSummary(deps.library)
    return c.html(
      renderCollectionLibrary({
        activeView: 'summary',
        summary,
        heading: 'Library',
        description:
          'Browse shows and movies by collection, and review every scheduling decision.',
        updateAvailable: deps.updateAvailable?.(),
      })
    )
  })

  controller.get('/library/tv', (c) => renderCollectionList(c, deps, 'tv'))
  controller.get('/library/movies', (c) =>
    renderCollectionList(c, deps, 'movie')
  )

  controller.get('/library/interludes', async (c) => {
    const [summary, files] = await Promise.all([
      buildSummary(deps.library),
      deps.library.getInterludes(),
    ])
    const collections = files.map(interludeCard)
    return c.html(
      renderCollectionLibrary({
        activeView: 'interludes',
        summary,
        heading: 'Interludes',
        description:
          'Station assets are listed separately from show and movie collections.',
        collections,
        emptyMessage: 'No interlude or station assets are indexed.',
        updateAvailable: deps.updateAvailable?.(),
      })
    )
  })

  controller.get('/library/review', (c) => renderReview(c, deps, false))
  controller.get('/library/review/metadata', (c) =>
    renderReview(c, deps, true)
  )

  controller.get('/library/collections/:id', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.text('Invalid collection ID', 400)
    const [summary, detail] = await Promise.all([
      buildSummary(deps.library),
      deps.library.getDetail(id),
    ])
    if (!detail) return c.text('Collection not found', 404)
    const selectedSeason = parseSeason(c.req.query('season'))
    return c.html(
      renderCollectionLibrary({
        activeView: 'detail',
        summary,
        heading: detail.collection.metadataTitle ?? detail.collection.parsedTitle,
        detail: collectionDetailModel(detail.collection, detail.files, selectedSeason),
        updateAvailable: deps.updateAvailable?.(),
      })
    )
  })

  controller.post('/library/collections/:id/approve', (c) =>
    postOverride(c, deps, 'allow')
  )
  controller.post('/library/collections/:id/block', (c) =>
    postOverride(c, deps, 'block')
  )
  controller.post('/library/collections/:id/reset-policy', (c) =>
    postOverride(c, deps, null)
  )

  controller.post('/library/collections/:id/metadata-match', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.text('Invalid collection ID', 400)
    const body = await c.req.parseBody()
    const externalId = String(body['externalId'] ?? '')
    if (!/^\d+$/.test(externalId)) return c.text('Invalid metadata ID', 400)
    try {
      const collection = await deps.metadata.confirmMatch(id, externalId)
      if (!collection) return c.text('Collection not found', 404)
      await deps.refreshSchedules?.()
      return c.redirect(`/library/collections/${id}`, 303)
    } catch (error) {
      return c.text(
        error instanceof Error ? error.message : 'Metadata match failed',
        502
      )
    }
  })

  controller.post('/library/collections/:id/metadata-retry', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.text('Invalid collection ID', 400)
    try {
      const collection = await deps.metadata.retryCollection(id)
      if (!collection) return c.text('Collection not found', 404)
      await deps.refreshSchedules?.()
      return c.redirect(`/library/collections/${id}`, 303)
    } catch (error) {
      return c.text(
        error instanceof Error ? error.message : 'Metadata retry failed',
        502
      )
    }
  })

  controller.post('/library/collections/bulk-override', async (c) => {
    const body = await c.req.parseBody({ all: true })
    const rawIds = body['ids']
    const values = Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : []
    const ids = values
      .map((value) => String(value))
      .filter((value) => /^\d+$/.test(value))
      .map(Number)
    const action = String(body['action'] ?? '')
    if (ids.length === 0 || !['allow', 'block', 'policy'].includes(action)) {
      return c.text('Select at least one collection and a valid action', 400)
    }
    try {
      await deps.library.setOverrides(
        ids,
        action === 'policy' ? null : action === 'allow' ? 'allow' : 'block'
      )
      await deps.refreshSchedules?.()
    } catch (error) {
      return c.text(error instanceof Error ? error.message : 'Bulk update failed', 400)
    }
    const returnPath = String(body['returnPath'] ?? '/library')
    return c.redirect(safeReturnPath(returnPath), 303)
  })

  return controller
}

async function renderCollectionList(
  c: Context,
  deps: CollectionLibraryPageControllerDeps,
  kind: 'tv' | 'movie'
) {
  const rawStatus = c.req.query('status') ?? 'all'
  const filter = ['allow', 'review', 'block'].includes(rawStatus)
    ? (rawStatus as PolicyDecision)
    : null
  const search = c.req.query('search') ?? ''
  const page = parsePage(c.req.query('page'))
  const unmatched = rawStatus === 'unmatched'
  const pageResult = await deps.library.list({
    kind,
    ...(filter ? { effectiveDecision: filter } : {}),
    ...(unmatched ? { metadataStatus: 'unmatched' as const } : {}),
    search,
    limit: COLLECTION_PAGE_SIZE + 1,
    offset: (page - 1) * COLLECTION_PAGE_SIZE,
  })
  const hasNext = pageResult.length > COLLECTION_PAGE_SIZE
  const collections = pageResult.slice(0, COLLECTION_PAGE_SIZE)
  const summary = await buildSummary(deps.library)
  const heading = kind === 'tv' ? 'TV shows' : 'Movies'
  const currentPath = kind === 'tv' ? '/library/tv' : '/library/movies'
  const view: CollectionLibraryViewModel = {
    activeView: kind === 'tv' ? 'tv' : 'movies',
    summary,
    heading,
    description:
      kind === 'tv'
        ? 'Approval applies to the show, so new episodes inherit the collection decision.'
        : 'Browse movie metadata, ratings, parent decisions, and technical availability.',
    collections: collections.map(collectionCard),
    emptyMessage: `No ${heading.toLowerCase()} match this view.`,
    currentPath,
    search,
    filter:
      rawStatus === 'unmatched'
        ? 'unmatched'
        : filter ?? 'all',
    updateAvailable: deps.updateAvailable?.(),
    bulkAction: '/library/collections/bulk-override',
    bulkReturnPath: pageHref(currentPath, page, { status: rawStatus, search }),
    pagination: paginationModel(currentPath, page, hasNext, {
      status: rawStatus,
      search,
    }),
  }
  return c.html(renderCollectionLibrary(view))
}

async function renderReview(
  c: Context,
  deps: CollectionLibraryPageControllerDeps,
  metadataOnly: boolean
) {
  const page = parsePage(c.req.query('page'))
  const offset = (page - 1) * COLLECTION_PAGE_SIZE
  const [librarySummary, pageResult] = await Promise.all([
    deps.library.getSummary(),
    metadataOnly
      ? deps.library.getMetadataReviewQueue({
          presentOnly: true,
          limit: COLLECTION_PAGE_SIZE + 1,
          offset,
        })
      : deps.library.getReviewQueue({
          presentOnly: true,
          limit: COLLECTION_PAGE_SIZE + 1,
          offset,
        }),
  ])
  const hasNext = pageResult.length > COLLECTION_PAGE_SIZE
  const selected = pageResult.slice(0, COLLECTION_PAGE_SIZE)
  const currentPath = metadataOnly
    ? '/library/review/metadata'
    : '/library/review'
  return c.html(
    renderCollectionLibrary({
      activeView: 'review',
      summary: summaryModel(librarySummary),
      heading: metadataOnly ? 'Metadata review' : 'Needs review',
      review: {
        totalCollections: metadataOnly
          ? librarySummary.metadataReviewCollections
          : librarySummary.reviewCollections,
        metadataCollections: librarySummary.metadataReviewCollections,
        approvalCollections: librarySummary.reviewCollections,
        collections: selected.map(collectionCard),
      },
      updateAvailable: deps.updateAvailable?.(),
      bulkAction: '/library/collections/bulk-override',
      bulkReturnPath: pageHref(currentPath, page),
      pagination: paginationModel(currentPath, page, hasNext),
    })
  )
}

async function postOverride(
  c: Context,
  deps: CollectionLibraryPageControllerDeps,
  decision: 'allow' | 'block' | null
) {
  const id = parseId(c.req.param('id'))
  if (id === null) return c.text('Invalid collection ID', 400)
  if (!(await deps.library.setOverride(id, decision))) {
    return c.text('Collection not found', 404)
  }
  await deps.refreshSchedules?.()
  return c.redirect(`/library/collections/${id}`, 303)
}

async function buildSummary(
  library: CollectionLibraryService
): Promise<CollectionLibrarySummaryViewModel> {
  return summaryModel(await library.getSummary())
}

function summaryModel(
  summary: LibrarySummary
): CollectionLibrarySummaryViewModel {
  return {
    tvCollections: summary.tvCollections,
    tvEpisodes: summary.tvEpisodes,
    movieCollections: summary.movieCollections,
    interludes: summary.interludeFiles,
    reviewCollections: summary.reviewCollections,
    totalFiles: summary.totalFiles,
  }
}

function collectionCard(collection: MediaCollection): CollectionCardViewModel {
  const title = collection.metadataTitle ?? collection.parsedTitle
  return {
    id: collection.id,
    href: `/library/collections/${collection.id}`,
    title,
    ...(collection.metadataYear ?? collection.year
      ? { year: collection.metadataYear ?? collection.year ?? undefined }
      : {}),
    kind: collection.libraryKind === 'tv' ? 'tv' : 'movie',
    ...(posterUrl(collection.posterPath)
      ? { posterUrl: posterUrl(collection.posterPath) ?? undefined }
      : {}),
    seasonCount: collection.seasonCount,
    episodeCount: collection.episodeCount,
    fileCount: collection.fileCount,
    metadata: metadataModel(collection),
    decision: decisionModel(collection),
    technical: technicalModel(collection),
    actions: {
      approveAction: `/library/collections/${collection.id}/approve`,
      blockAction: `/library/collections/${collection.id}/block`,
      resetAction: `/library/collections/${collection.id}/reset-policy`,
      changeMatchHref: `/library/collections/${collection.id}?match=1`,
    },
    bulkFormId: 'collection-bulk-form',
  }
}

function collectionDetailModel(
  collection: MediaCollection,
  files: readonly MediaItem[],
  selectedSeason: number | null
): CollectionDetailViewModel {
  const card = collectionCard(collection)
  const seasons = new Map<number | null, number>()
  for (const file of files) {
    const season = file.seasonNumber ?? null
    seasons.set(season, (seasons.get(season) ?? 0) + 1)
  }
  const episodes =
    selectedSeason === null
      ? []
      : files
          .filter((file) => file.seasonNumber === selectedSeason)
          .sort(
            (left, right) =>
              (left.episodeNumber ?? Number.MAX_SAFE_INTEGER) -
              (right.episodeNumber ?? Number.MAX_SAFE_INTEGER)
          )
          .map((file) => {
            const range = parseEpisodeRange(file.relativePath || file.filename)
            const parsedTitle =
              parseEpisodeDisplayTitle(file.relativePath || file.filename) ||
              file.episodeTitle?.trim()
            const isMultiEpisode = Boolean(range?.endEpisodeNumber)
            const providerTitle = file.episodeMetadataTitle?.trim()
            const multiEpisodeTitle = providerTitle?.includes(' + ')
              ? providerTitle
              : parsedTitle
            return {
              numberLabel:
                file.episodeNumber === null || file.episodeNumber === undefined
                  ? '—'
                  : range?.endEpisodeNumber
                    ? `${String(file.episodeNumber).padStart(2, '0')}–${String(range.endEpisodeNumber).padStart(2, '0')}`
                    : String(file.episodeNumber).padStart(2, '0'),
              title:
                (isMultiEpisode ? multiEpisodeTitle : providerTitle) ||
                parsedTitle ||
                cleanFilename(file.filename),
              durationLabel: formatDuration(file.durationSeconds),
              ...(file.episodeOverview
                ? { overview: file.episodeOverview }
                : {}),
              ...(file.episodeAirDate ? { airDate: file.episodeAirDate } : {}),
              technicalSummary: [
                file.codec?.toUpperCase(),
                file.height ? `${file.height}p` : null,
                file.compatibility,
                file.warning,
              ]
                .filter(Boolean)
                .join(' · '),
            }
          })
  return {
    ...card,
    overview: collection.overview ?? undefined,
    genres: collection.genres,
    seasons: [...seasons.entries()]
      .sort(([left], [right]) => (left ?? -1) - (right ?? -1))
      .map(([seasonNumber, episodeCount]) => ({
        label: seasonNumber === null ? 'Unassigned season' : `Season ${seasonNumber}`,
        episodeCount,
        href:
          seasonNumber === null
            ? `/library/collections/${collection.id}`
            : `/library/collections/${collection.id}?season=${seasonNumber}`,
      })),
    ...(selectedSeason === null
      ? {}
      : {
          selectedSeasonLabel: `Season ${selectedSeason}`,
          episodes,
        }),
    metadataCandidates: collection.metadataCandidates.map((candidate) => ({
      externalId: candidate.externalId,
      title: candidate.title,
      ...(candidate.year === undefined ? {} : { year: candidate.year }),
      confidence: candidate.confidence,
      confirmAction: `/library/collections/${collection.id}/metadata-match`,
    })),
    manualMatchAction: `/library/collections/${collection.id}/metadata-match`,
    metadataRetryAction: `/library/collections/${collection.id}/metadata-retry`,
  }
}

function interludeCard(item: MediaItem): CollectionCardViewModel {
  const effective: PolicyDecision =
    item.rootAvailable === true && item.playbackEnabled === true
      ? 'allow'
      : 'review'
  return {
    id: item.id,
    href: `/library/files?search=${encodeURIComponent(item.filename)}`,
    title: cleanFilename(item.filename),
    kind: 'interlude',
    fileCount: 1,
    metadata: {
      status: 'not_configured',
      reason: 'Station assets are managed as files and are not sent to TMDB.',
    },
    decision: {
      policyDecision: effective,
      policyReason:
        effective === 'allow' ? 'Explicit file policy permits playback.' : 'No explicit playable decision.',
      parentOverride:
        item.playbackOverride === true
          ? 'allow'
          : item.playbackOverride === false
            ? 'block'
            : null,
      effectiveDecision: effective,
      effectiveReason:
        effective === 'allow' ? 'Playable station asset.' : 'Not schedulable.',
    },
    technical: {
      status:
        item.rootAvailable !== true
          ? 'root_unavailable'
          : item.durationSeconds > 0
            ? 'available'
            : 'probe_failed',
      reason:
        item.rootAvailable !== true
          ? 'The interlude root is not available.'
          : item.durationSeconds > 0
            ? 'The file has valid technical metadata.'
            : 'The file has no valid duration.',
      availableFiles: item.durationSeconds > 0 ? 1 : 0,
      totalFiles: 1,
      failedFiles: item.durationSeconds > 0 ? 0 : 1,
    },
  }
}

function metadataModel(collection: MediaCollection) {
  let status: CollectionMetadataStatus = collection.metadataStatus
  if (
    (status === 'matched' || status === 'manual') &&
    collection.ratingStatus !== 'resolved'
  ) {
    status = 'no_rating'
  }
  return {
    status,
    providerName: collection.metadataProvider ?? undefined,
    matchedTitle: collection.metadataTitle ?? undefined,
    externalId: collection.metadataExternalId ?? undefined,
    certification: collection.certification ?? undefined,
    certificationRegion: collection.certificationRegion ?? undefined,
    reason: collection.metadataError ?? metadataReason(collection),
  }
}

function decisionModel(collection: MediaCollection) {
  return {
    policyDecision: collection.policyDecision,
    policyReason: humanizeReason(collection.policyReason),
    parentOverride: collection.parentOverride,
    effectiveDecision: collection.effectiveDecision,
    effectiveReason:
      collection.parentOverride === 'allow'
        ? `Parent approved; this overrides the ${collection.policyDecision} policy result.`
        : collection.parentOverride === 'block'
          ? `Parent blocked; this overrides the ${collection.policyDecision} policy result.`
          : `Using the ${collection.policyProfileId} policy result.`,
  }
}

function technicalModel(
  collection: MediaCollection
): CollectionTechnicalViewModel {
  if (!collection.rootAvailable) {
    return {
      status: 'root_unavailable',
      reason: 'The configured media root did not complete a current scan.',
      availableFiles: collection.readyFileCount,
      totalFiles: collection.fileCount,
      failedFiles: collection.failedFileCount,
    }
  }
  if (collection.failedFileCount > 0) {
    return {
      status: 'probe_failed',
      reason: 'One or more files failed technical inspection.',
      availableFiles: collection.readyFileCount,
      totalFiles: collection.fileCount,
      failedFiles: collection.failedFileCount,
    }
  }
  if (collection.readyFileCount < collection.fileCount) {
    return {
      status: 'probe_pending',
      reason: 'Technical indexing is still incomplete.',
      availableFiles: collection.readyFileCount,
      totalFiles: collection.fileCount,
      failedFiles: collection.failedFileCount,
    }
  }
  return {
    status: 'available',
    reason:
      collection.scheduleEligibleCount > 0
        ? `${collection.scheduleEligibleCount} ${collection.scheduleEligibleCount === 1 ? 'file is' : 'files are'} eligible for automatic schedules.`
        : 'Files are technically ready; approval or programming rules may still exclude them.',
    availableFiles: collection.readyFileCount,
    totalFiles: collection.fileCount,
    failedFiles: collection.failedFileCount,
  }
}

function metadataReason(collection: MediaCollection): string | undefined {
  if (collection.metadataStatus === 'pending') return 'Waiting for background matching.'
  if (collection.metadataStatus === 'ambiguous') return 'More than one plausible title was found.'
  if (collection.metadataStatus === 'unmatched') return 'No reliable title match was found.'
  if (collection.metadataStatus === 'not_configured') return 'TMDB is not configured on the server.'
  if (collection.ratingStatus === 'ambiguous') return 'Conflicting certifications were returned for the selected region.'
  if (collection.ratingStatus === 'missing') return 'No certification was available in the preferred or fallback regions.'
  return undefined
}

function posterUrl(path: string | null): string | null {
  if (!path || !/^\/[A-Za-z0-9._/-]+$/.test(path)) return null
  return `/api/v1/artwork/tmdb/w342${path}`
}

function humanizeReason(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/^./, (character) => character.toUpperCase())
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Unknown duration'
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.floor(seconds % 60)
  return `${minutes}:${String(remainder).padStart(2, '0')}`
}

function parseId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function parseSeason(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,3}$/.test(value)) return null
  const season = Number(value)
  return Number.isSafeInteger(season) ? season : null
}

function parsePage(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) return 1
  const page = Number(value)
  return Number.isSafeInteger(page) && page > 0 ? Math.min(page, 10_000) : 1
}

function pageHref(
  path: string,
  page: number,
  filters: { readonly status?: string; readonly search?: string } = {}
): string {
  const params = new URLSearchParams()
  if (filters.status && filters.status !== 'all') {
    params.set('status', filters.status)
  }
  if (filters.search) params.set('search', filters.search)
  if (page > 1) params.set('page', String(page))
  const query = params.toString()
  return query ? `${path}?${query}` : path
}

function paginationModel(
  path: string,
  page: number,
  hasNext: boolean,
  filters: { readonly status?: string; readonly search?: string } = {}
) {
  return {
    page,
    ...(page > 1 ? { previousHref: pageHref(path, page - 1, filters) } : {}),
    ...(hasNext ? { nextHref: pageHref(path, page + 1, filters) } : {}),
  }
}

function safeReturnPath(value: string): string {
  return /^\/library(?:[/?].*)?$/.test(value) && !value.startsWith('//')
    ? value
    : '/library'
}
