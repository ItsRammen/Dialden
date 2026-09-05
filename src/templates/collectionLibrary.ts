import { renderLayout } from './layout'
import { escapeHtml } from './utils'

export type CollectionLibraryKind = 'tv' | 'movie' | 'interlude'
export type CollectionMetadataStatus =
  | 'pending'
  | 'matched'
  | 'ambiguous'
  | 'unmatched'
  | 'manual'
  | 'no_rating'
  | 'error'
  | 'not_configured'
export type CollectionPolicyDecision = 'allow' | 'review' | 'block'
export type CollectionParentOverride = 'allow' | 'block' | null
export type CollectionTechnicalStatus =
  | 'available'
  | 'root_unavailable'
  | 'probe_pending'
  | 'probe_failed'

export interface CollectionLibrarySummaryViewModel {
  readonly tvCollections: number
  readonly tvEpisodes: number
  readonly movieCollections: number
  readonly interludes: number
  readonly reviewCollections: number
  readonly totalFiles?: number
}

export interface CollectionMetadataViewModel {
  readonly status: CollectionMetadataStatus
  readonly providerName?: string
  readonly matchedTitle?: string
  readonly externalId?: string | number
  readonly certification?: string
  readonly certificationRegion?: string
  /** The rung the certification puts this on, in plain words. */
  readonly audienceLabel?: string
  readonly reason?: string
}

export interface CollectionDecisionViewModel {
  readonly policyDecision: CollectionPolicyDecision
  readonly policyReason: string
  readonly parentOverride: CollectionParentOverride
  readonly effectiveDecision: CollectionPolicyDecision
  readonly effectiveReason: string
}

export interface CollectionTechnicalViewModel {
  readonly status: CollectionTechnicalStatus
  readonly reason: string
  readonly availableFiles: number
  readonly totalFiles: number
  readonly failedFiles?: number
}

export interface CollectionActionsViewModel {
  readonly approveAction?: string
  readonly blockAction?: string
  readonly resetAction?: string
  readonly changeMatchHref?: string
  readonly csrfToken?: string
}

export interface CollectionCardViewModel {
  readonly id: string | number
  readonly href: string
  readonly title: string
  readonly year?: number
  readonly kind: CollectionLibraryKind
  readonly posterUrl?: string
  readonly seasonCount?: number
  readonly episodeCount?: number
  readonly fileCount: number
  readonly metadata: CollectionMetadataViewModel
  readonly decision: CollectionDecisionViewModel
  readonly technical: CollectionTechnicalViewModel
  readonly actions?: CollectionActionsViewModel
  readonly bulkFormId?: string
}

export interface CollectionSeasonViewModel {
  readonly label: string
  readonly episodeCount: number
  readonly href: string
}

export interface CollectionEpisodeViewModel {
  readonly numberLabel: string
  readonly title: string
  readonly durationLabel: string
  readonly overview?: string
  readonly airDate?: string
  readonly technicalSummary?: string
}

export interface CollectionMetadataCandidateViewModel {
  readonly externalId: string
  readonly title: string
  readonly year?: number
  readonly confidence: number
  /** What separates candidates that share a title and a year. */
  readonly overview?: string
  readonly posterUrl?: string
  readonly referenceUrl?: string
  readonly runtimeLabel?: string
  /**
   * How well the title and year agree -- not a probability that this is the
   * right title. Several records can score identically, which is the whole
   * reason this list needs a person or the assistant.
   */
  readonly scoreLabel: string
  /** Set when this candidate cannot be separated from others by score alone. */
  readonly tiedWith?: number
  readonly confirmAction: string
}

export interface CollectionDetailViewModel extends CollectionCardViewModel {
  readonly overview?: string
  readonly genres?: readonly string[]
  readonly seasons?: readonly CollectionSeasonViewModel[]
  readonly selectedSeasonLabel?: string
  readonly episodes?: readonly CollectionEpisodeViewModel[]
  readonly metadataCandidates?: readonly CollectionMetadataCandidateViewModel[]
  readonly manualMatchAction?: string
  readonly metadataRetryAction?: string
}

export interface CollectionReviewQueueViewModel {
  readonly totalCollections: number
  readonly metadataCollections: number
  readonly approvalCollections: number
  readonly collections: readonly CollectionCardViewModel[]
}

export interface CollectionPaginationViewModel {
  readonly page: number
  readonly previousHref?: string
  readonly nextHref?: string
}

export type CollectionLibraryView =
  | 'summary'
  | 'tv'
  | 'movies'
  | 'interludes'
  | 'review'
  | 'detail'

export interface CollectionLibraryViewModel {
  readonly activeView: CollectionLibraryView
  readonly summary: CollectionLibrarySummaryViewModel
  readonly heading?: string
  readonly description?: string
  readonly collections?: readonly CollectionCardViewModel[]
  readonly detail?: CollectionDetailViewModel
  readonly review?: CollectionReviewQueueViewModel
  readonly emptyMessage?: string
  readonly updateAvailable?: boolean
  readonly currentPath?: string
  readonly search?: string
  readonly filter?: CollectionPolicyDecision | 'all' | 'unmatched'
  readonly bulkAction?: string
  readonly bulkReturnPath?: string
  readonly pagination?: CollectionPaginationViewModel
}

const KIND_LABEL: Record<CollectionLibraryKind, string> = {
  tv: 'TV show',
  movie: 'Movie',
  interlude: 'Interlude',
}

const METADATA_LABEL: Record<CollectionMetadataStatus, string> = {
  pending: 'Pending match',
  matched: 'Matched',
  ambiguous: 'Ambiguous match',
  unmatched: 'Unmatched',
  manual: 'Manually matched',
  no_rating: 'Matched — no rating',
  error: 'Metadata error',
  not_configured: 'Provider not configured',
}

const DECISION_LABEL: Record<CollectionPolicyDecision, string> = {
  allow: 'Allow',
  review: 'Needs review',
  block: 'Block',
}

const OVERRIDE_LABEL: Record<Exclude<CollectionParentOverride, null>, string> = {
  allow: 'Parent approved',
  block: 'Parent blocked',
}

const TECHNICAL_LABEL: Record<CollectionTechnicalStatus, string> = {
  available: 'Available',
  root_unavailable: 'Library root unavailable',
  probe_pending: 'Media scan pending',
  probe_failed: 'Media scan errors',
}

function count(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Math.max(0, Math.floor(value)).toLocaleString('en-US')
}

function quantity(value: number, singular: string, plural = `${singular}s`): string {
  return `${count(value)} ${value === 1 ? singular : plural}`
}

function year(value: number | undefined): string {
  if (!Number.isInteger(value) || (value ?? 0) < 0) return ''
  return String(value)
}

function safeInternalHref(value: string | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (
    !trimmed.startsWith('/') ||
    trimmed.startsWith('//') ||
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    return null
  }
  return escapeHtml(trimmed)
}

function safePosterUrl(value: string | undefined): string | null {
  return safeInternalHref(value)
}

function renderSummary(summary: CollectionLibrarySummaryViewModel): string {
  const legacyRootWarning =
    (summary.totalFiles ?? 0) > 0 &&
    summary.tvCollections === 0 &&
    summary.movieCollections === 0
      ? `<div class="collection-config-warning" role="alert">
          <strong>${count(summary.totalFiles ?? 0)} files were indexed without managed TV or movie roots.</strong>
          <span>Mount the libraries at <code>/media/tv</code> and <code>/media/movies</code>, set <code>TOASTTV_TV_MEDIA</code> and <code>TOASTTV_MOVIE_MEDIA</code>, then rescan. Files indexed only through legacy <code>/media</code> cannot become show or movie collections.</span>
        </div>`
      : ''
  return `
    <section class="collection-summary" aria-labelledby="collection-summary-title">
      <h2 id="collection-summary-title" class="collection-visually-hidden">Library summary</h2>
      ${legacyRootWarning}
      <div class="collection-summary-grid">
        <a href="/library/tv" class="collection-summary-card">
          <span class="collection-summary-label">TV shows</span>
          <strong>${count(summary.tvCollections)}</strong>
          <span>${quantity(summary.tvEpisodes, 'episode')}</span>
        </a>
        <a href="/library/movies" class="collection-summary-card">
          <span class="collection-summary-label">Movies</span>
          <strong>${count(summary.movieCollections)}</strong>
          <span>${summary.movieCollections === 1 ? 'collection' : 'collections'}</span>
        </a>
        <a href="/library/interludes" class="collection-summary-card">
          <span class="collection-summary-label">Interludes</span>
          <strong>${count(summary.interludes)}</strong>
          <span>${summary.interludes === 1 ? 'item' : 'items'}</span>
        </a>
        <a href="/library/review" class="collection-summary-card collection-summary-review">
          <span class="collection-summary-label">Needs review</span>
          <strong>${count(summary.reviewCollections)}</strong>
          <span>${summary.reviewCollections === 1 ? 'collection' : 'collections'}</span>
        </a>
      </div>
    </section>
  `
}

function renderMetadata(metadata: CollectionMetadataViewModel): string {
  const matchParts = [metadata.providerName, metadata.matchedTitle]
    .filter((value): value is string => Boolean(value))
    .map(escapeHtml)
  if (metadata.externalId !== undefined) {
    matchParts.push(`ID ${escapeHtml(String(metadata.externalId))}`)
  }
  const certification = metadata.certification
    ? `${escapeHtml(metadata.certification)}${metadata.certificationRegion ? ` (${escapeHtml(metadata.certificationRegion)})` : ''}`
    : 'No rating available'

  return `
    <div class="collection-state-group collection-metadata-${metadata.status}">
      <h4>Metadata</h4>
      <dl>
        <div><dt>Status</dt><dd>${METADATA_LABEL[metadata.status]}</dd></div>
        <div><dt>Match</dt><dd>${matchParts.length > 0 ? matchParts.join(' · ') : 'No confirmed match'}</dd></div>
        <div><dt>Certification</dt><dd>${certification}</dd></div>
        <div><dt>Audience</dt><dd>${
          metadata.audienceLabel
            ? escapeHtml(metadata.audienceLabel)
            : 'Not established'
        }</dd></div>
      </dl>
      ${metadata.reason ? `<p><strong>Metadata reason:</strong> ${escapeHtml(metadata.reason)}</p>` : ''}
    </div>
  `
}

function renderDecision(decision: CollectionDecisionViewModel): string {
  const override = decision.parentOverride
    ? OVERRIDE_LABEL[decision.parentOverride]
    : 'None — using policy'

  return `
    <div class="collection-state-group collection-effective-${decision.effectiveDecision}">
      <h4>Approval</h4>
      <dl>
        <div><dt>Policy result</dt><dd>${DECISION_LABEL[decision.policyDecision]}</dd></div>
        <div><dt>Parent override</dt><dd>${override}</dd></div>
        <div><dt>Effective decision</dt><dd><strong>${DECISION_LABEL[decision.effectiveDecision]}</strong></dd></div>
      </dl>
      <p><strong>Policy reason:</strong> ${escapeHtml(decision.policyReason)}</p>
      <p class="collection-effective-reason"><strong>Effective reason:</strong> ${escapeHtml(decision.effectiveReason)}</p>
    </div>
  `
}

function renderTechnical(technical: CollectionTechnicalViewModel): string {
  return `
    <div class="collection-state-group collection-technical-${technical.status}">
      <h4>Technical availability</h4>
      <dl>
        <div><dt>Status</dt><dd>${TECHNICAL_LABEL[technical.status]}</dd></div>
        <div><dt>Ready files</dt><dd>${count(technical.availableFiles)} of ${count(technical.totalFiles)}</dd></div>
        <div><dt>File errors</dt><dd>${count(technical.failedFiles ?? 0)}</dd></div>
      </dl>
      <p><strong>Availability reason:</strong> ${escapeHtml(technical.reason)}</p>
    </div>
  `
}

function renderPostAction(
  action: string | undefined,
  label: string,
  className: string,
  title: string,
  csrfToken?: string
): string {
  const safeAction = safeInternalHref(action)
  if (!safeAction) return ''
  return `
    <form method="post" action="${safeAction}">
      ${csrfToken ? `<input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">` : ''}
      <button class="collection-action ${className}" type="submit" aria-label="${label} ${escapeHtml(title)}">${label}</button>
    </form>
  `
}

function renderActions(
  title: string,
  actions: CollectionActionsViewModel | undefined
): string {
  if (!actions) return ''
  const changeMatchHref = safeInternalHref(actions.changeMatchHref)
  const output = [
    renderPostAction(
      actions.approveAction,
      'Parent approve',
      'collection-action-approve',
      title,
      actions.csrfToken
    ),
    renderPostAction(
      actions.blockAction,
      'Parent block',
      'collection-action-block',
      title,
      actions.csrfToken
    ),
    renderPostAction(
      actions.resetAction,
      'Use policy',
      'collection-action-reset',
      title,
      actions.csrfToken
    ),
    changeMatchHref
      ? `<a class="collection-action collection-action-match" href="${changeMatchHref}" aria-label="Change metadata match for ${escapeHtml(title)}">Change metadata match</a>`
      : '',
  ].join('')

  return output ? `<div class="collection-actions" aria-label="Collection actions">${output}</div>` : ''
}

function renderCollectionFacts(collection: CollectionCardViewModel): string {
  const facts: string[] = [KIND_LABEL[collection.kind]]
  const displayYear = year(collection.year)
  if (displayYear) facts.push(displayYear)
  if (collection.kind === 'tv') {
    facts.push(quantity(collection.seasonCount ?? 0, 'season'))
    facts.push(quantity(collection.episodeCount ?? 0, 'episode'))
  } else {
    facts.push(`${count(collection.fileCount)} file${collection.fileCount === 1 ? '' : 's'}`)
  }
  return facts.join(' · ')
}

function renderCollectionCardStatus(collection: CollectionCardViewModel): string {
  const metadataDetail = collection.metadata.certification
    ? `${METADATA_LABEL[collection.metadata.status]} · ${escapeHtml(collection.metadata.certification)}`
    : METADATA_LABEL[collection.metadata.status]
  const technicalDetail =
    collection.technical.status === 'available'
      ? `${count(collection.technical.availableFiles)} of ${count(collection.technical.totalFiles)} ready`
      : collection.technical.status === 'probe_failed'
        ? quantity(collection.technical.failedFiles ?? 0, 'file error')
        : TECHNICAL_LABEL[collection.technical.status]
  const issues = [
    collection.technical.status !== 'available'
      ? collection.technical.reason
      : undefined,
    ['ambiguous', 'unmatched', 'no_rating', 'error', 'not_configured'].includes(
      collection.metadata.status
    )
      ? collection.metadata.reason
      : undefined,
  ].filter((value): value is string => Boolean(value))

  return `<div class="collection-card-status" aria-label="Collection status">
    <div class="collection-status-row collection-metadata-${collection.metadata.status}">
      <span>Metadata</span><strong>${metadataDetail}</strong>
    </div>
    <div class="collection-status-row collection-effective-${collection.decision.effectiveDecision}">
      <span>Approval</span><strong>${DECISION_LABEL[collection.decision.effectiveDecision]}</strong>
    </div>
    <div class="collection-status-row collection-technical-${collection.technical.status}">
      <span>Files</span><strong>${technicalDetail}</strong>
    </div>
    ${issues.map((issue) => `<p class="collection-card-issue">${escapeHtml(issue)}</p>`).join('')}
  </div>`
}

export function renderCollectionCard(
  collection: CollectionCardViewModel
): string {
  const href = safeInternalHref(collection.href) ?? '/library'
  const poster = safePosterUrl(collection.posterUrl)

  return `
    <article class="collection-card">
      ${collection.bulkFormId ? `<label class="collection-select"><input type="checkbox" name="ids" value="${escapeHtml(String(collection.id))}" form="${escapeHtml(collection.bulkFormId)}"><span>Select ${escapeHtml(collection.title)}</span></label>` : ''}
      <a class="collection-poster" href="${href}" aria-label="Open ${escapeHtml(collection.title)}">
        ${poster ? `<img src="${poster}" alt="" loading="lazy" width="240" height="360">` : '<span aria-hidden="true">▣</span>'}
      </a>
      <div class="collection-card-body">
        <header>
          <p>${renderCollectionFacts(collection)}</p>
          <h3><a href="${href}">${escapeHtml(collection.title)}</a></h3>
        </header>
        ${renderCollectionCardStatus(collection)}
        <a class="collection-card-details" href="${href}">View details</a>
        ${renderActions(collection.title, collection.actions)}
      </div>
    </article>
  `
}

function renderCollectionGrid(
  collections: readonly CollectionCardViewModel[],
  emptyMessage: string
): string {
  if (collections.length === 0) {
    return `<p class="collection-empty" role="status">${escapeHtml(emptyMessage)}</p>`
  }
  return `<div class="collection-grid">${collections.map(renderCollectionCard).join('')}</div>`
}

function renderBulkActions(view: CollectionLibraryViewModel): string {
  const action = safeInternalHref(view.bulkAction)
  const returnPath = safeInternalHref(view.bulkReturnPath) ?? '/library'
  if (!action || !(view.collections?.length || view.review?.collections.length)) {
    return ''
  }
  return `<form id="collection-bulk-form" class="collection-bulk-actions" method="post" action="${action}">
    <input type="hidden" name="returnPath" value="${returnPath}">
    <strong>Selected collections</strong>
    <button class="collection-action collection-action-approve" name="action" value="allow" type="submit">Parent approve</button>
    <button class="collection-action collection-action-block" name="action" value="block" type="submit">Parent block</button>
    <button class="collection-action collection-action-reset" name="action" value="policy" type="submit">Use policy</button>
    <small>Select titles deliberately; unknown and unmatched media is never preselected.</small>
  </form>`
}

function renderPagination(
  pagination: CollectionPaginationViewModel | undefined
): string {
  if (!pagination || (!pagination.previousHref && !pagination.nextHref)) {
    return ''
  }
  const previousHref = safeInternalHref(pagination.previousHref)
  const nextHref = safeInternalHref(pagination.nextHref)
  return `<nav class="collection-pagination" aria-label="Collection pages">
    ${previousHref ? `<a rel="prev" href="${previousHref}">Previous</a>` : '<span></span>'}
    <strong>Page ${count(pagination.page)}</strong>
    ${nextHref ? `<a rel="next" href="${nextHref}">Next</a>` : '<span></span>'}
  </nav>`
}

export function renderCollectionDetail(
  detail: CollectionDetailViewModel
): string {
  const poster = safePosterUrl(detail.posterUrl)
  const seasons = detail.seasons ?? []
  const candidates = detail.metadataCandidates ?? []
  const episodes = detail.episodes ?? []
  const manualMatchAction = safeInternalHref(detail.manualMatchAction)
  const metadataRetryAction = safeInternalHref(detail.metadataRetryAction)

  return `
    <section class="collection-detail" aria-labelledby="collection-detail-title">
      <a class="collection-back-link" href="/library/${detail.kind === 'tv' ? 'tv' : detail.kind === 'movie' ? 'movies' : 'interludes'}">← Back to ${detail.kind === 'tv' ? 'TV shows' : detail.kind === 'movie' ? 'movies' : 'interludes'}</a>
      <div class="collection-detail-hero">
        <div class="collection-detail-poster">
          ${poster ? `<img src="${poster}" alt="" width="300" height="450">` : '<span aria-hidden="true">▣</span>'}
        </div>
        <div>
          <p class="collection-kind">${renderCollectionFacts(detail)}</p>
          <h2 id="collection-detail-title">${escapeHtml(detail.title)}</h2>
          ${detail.genres?.length ? `<p class="collection-genres">${detail.genres.map(escapeHtml).join(' · ')}</p>` : ''}
          ${detail.overview ? `<p class="collection-overview">${escapeHtml(detail.overview)}</p>` : ''}
          ${renderActions(detail.title, detail.actions)}
        </div>
      </div>

      <div class="collection-detail-states">
        ${renderMetadata(detail.metadata)}
        ${renderDecision(detail.decision)}
        ${renderTechnical(detail.technical)}
      </div>

      ${
        candidates.length > 0 || manualMatchAction
          ? `<section class="collection-match-review" aria-labelledby="collection-match-title">
              <h3 id="collection-match-title">Choose the metadata match</h3>
              <p>Confirm only the title that represents this collection. The choice is remembered across rescans. The percentage is how closely the title and year agree, not a judgement that a record is the right one — several can agree equally well.</p>
              ${candidates.length > 0 ? `<ul>${candidates
                .map((candidate) => {
                  const action = safeInternalHref(candidate.confirmAction)
                  if (!action) return ''
                  /* Three records can share a title and a year -- "Aladdin"
                     1992 returns the Disney film alongside two others. Without
                     the poster, the summary and the id, the rows read as
                     identical and there is nothing to choose between. */
                  return `<li>
                    ${
                      candidate.posterUrl
                        ? `<img class="collection-candidate-poster" src="${escapeHtml(candidate.posterUrl)}" alt="" loading="lazy" width="46" height="69">`
                        : '<span class="collection-candidate-poster collection-candidate-poster--empty" aria-hidden="true"></span>'
                    }
                    <div class="collection-candidate-body">
                      <strong>${escapeHtml(candidate.title)}</strong>${candidate.year ? ` <span>${year(candidate.year)}</span>` : ''}
                      <small>${escapeHtml(candidate.scoreLabel)}${
                        candidate.tiedWith
                          ? ` · <span class="collection-candidate-tie">ties with ${candidate.tiedWith} other${candidate.tiedWith === 1 ? '' : 's'}</span>`
                          : ''
                      }${
                        candidate.runtimeLabel
                          ? ` · ${escapeHtml(candidate.runtimeLabel)}`
                          : ''
                      } · ${
                        candidate.referenceUrl
                          ? `<a href="${escapeHtml(candidate.referenceUrl)}" target="_blank" rel="noopener noreferrer">TMDB ${escapeHtml(candidate.externalId)}</a>`
                          : `TMDB ${escapeHtml(candidate.externalId)}`
                      }</small>
                      ${
                        candidate.overview
                          ? `<p class="collection-candidate-overview">${escapeHtml(candidate.overview)}</p>`
                          : ''
                      }
                    </div>
                    <form method="post" action="${action}">
                      <input type="hidden" name="externalId" value="${escapeHtml(candidate.externalId)}">
                      <button class="collection-action collection-action-match" type="submit">Confirm</button>
                    </form>
                  </li>`
                })
                .join('')}</ul>` : '<p>No suggested matches are available.</p>'}
              ${
                manualMatchAction
                  ? `<form class="collection-manual-match" method="post" action="${manualMatchAction}">
                      <label for="collection-tmdb-id">Confirm a TMDB ID manually</label>
                      <input id="collection-tmdb-id" name="externalId" inputmode="numeric" pattern="[0-9]+" required>
                      <button class="collection-action collection-action-match" type="submit">Use TMDB ID</button>
                    </form>`
                  : ''
              }
              ${
                metadataRetryAction
                  ? `<form method="post" action="${metadataRetryAction}"><button class="collection-action" type="submit">Retry automatic match</button></form>`
                  : ''
              }
            </section>`
          : ''
      }

      ${
        detail.kind === 'tv'
          ? `<section class="collection-seasons" aria-labelledby="collection-seasons-title">
              <h3 id="collection-seasons-title">Seasons</h3>
              ${
                seasons.length > 0
                  ? `<ul>${seasons
                      .map((season) => {
                        const href = safeInternalHref(season.href) ?? '/library'
                        return `<li><a href="${href}"><strong>${escapeHtml(season.label)}</strong><span>${quantity(season.episodeCount, 'episode')}</span></a></li>`
                      })
                      .join('')}</ul>`
                  : '<p class="collection-empty">No seasons indexed.</p>'
              }
            </section>`
          : ''
      }

      ${
        detail.selectedSeasonLabel
          ? `<section class="collection-episodes" aria-labelledby="collection-episodes-title">
              <h3 id="collection-episodes-title">${escapeHtml(detail.selectedSeasonLabel)}</h3>
              ${episodes.length > 0 ? `<ol>${episodes
                .map(
                  (episode) => `<li>
                    <span class="collection-episode-number">${escapeHtml(episode.numberLabel)}</span>
                    <div class="collection-episode-copy">
                      <strong>${escapeHtml(episode.title)}</strong>
                      ${episode.airDate ? `<small>${escapeHtml(episode.airDate)}</small>` : ''}
                      ${episode.overview ? `<p>${escapeHtml(episode.overview)}</p>` : ''}
                    </div>
                    <time>${escapeHtml(episode.durationLabel)}</time>
                    ${episode.technicalSummary ? `<details><summary>Technical details</summary><p>${escapeHtml(episode.technicalSummary)}</p></details>` : ''}
                  </li>`
                )
                .join('')}</ol>` : '<p class="collection-empty">No episodes indexed for this season.</p>'}
            </section>`
          : ''
      }

      <details class="collection-advanced-details">
        <summary>Advanced media details</summary>
        <p>Technical file information is available in the file catalog.</p>
        <a href="/library/files">Open Advanced files</a>
      </details>
    </section>
  `
}

export function renderCollectionReview(
  review: CollectionReviewQueueViewModel
): string {
  return `
    <section class="collection-review" aria-labelledby="collection-review-title">
      <div class="collection-section-heading">
        <div>
          <p class="collection-eyebrow">Review queue</p>
          <h2 id="collection-review-title">Needs review (${count(review.totalCollections)})</h2>
        </div>
        <nav aria-label="Review queues">
          <a href="/library/review">Approval ${count(review.approvalCollections)}</a>
          <a href="/library/review/metadata">Metadata ${count(review.metadataCollections)}</a>
        </nav>
      </div>
      ${renderCollectionGrid(review.collections, 'No collections need review.')}
    </section>
  `
}

export function renderCollectionLibraryContent(
  view: CollectionLibraryViewModel
): string {
  const heading = escapeHtml(view.heading ?? 'Library')
  const description = view.description
    ? `<p>${escapeHtml(view.description)}</p>`
    : ''
  const collections = view.collections ?? []
  const currentPath = safeInternalHref(view.currentPath) ?? '/library'

  let primaryContent = ''
  if (view.detail) {
    primaryContent = renderCollectionDetail(view.detail)
  } else if (view.review) {
    primaryContent = renderCollectionReview(view.review)
  } else if (view.activeView !== 'summary' || collections.length > 0) {
    primaryContent = `
      <section class="collection-results" aria-labelledby="collection-results-title">
        <div class="collection-section-heading">
          <h2 id="collection-results-title">${heading}</h2>
          <span>${quantity(collections.length, 'collection')}</span>
        </div>
        ${renderCollectionGrid(collections, view.emptyMessage ?? 'No collections match this view.')}
      </section>
    `
  }

  return `
    <div class="collection-library">
      <header class="collection-library-header">
        <div>
          <p class="collection-eyebrow">Catalog operations</p>
          <h1>${heading}</h1>
          ${description}
        </div>
        <a class="collection-advanced-link" href="/library/files">File diagnostics</a>
      </header>
      <nav class="collection-library-nav" aria-label="Library sections">
        <a href="/library">Overview</a>
        <a href="/library/tv">TV shows</a>
        <a href="/library/movies">Movies</a>
        <a href="/library/interludes">Interludes</a>
        <a href="/library/bumpers">Bumper Manager</a>
        <a href="/library/review">Review queue</a>
      </nav>
      <section id="collection-live-work" class="collection-live-work" role="status" aria-live="polite" hidden>
        <strong id="collection-live-title">Library scan</strong>
        <progress id="collection-live-progress" max="1" value="0"></progress>
        <span id="collection-live-detail"></span>
      </section>
      ${
        view.activeView === 'tv' || view.activeView === 'movies'
          ? `<div class="collection-library-tools">
              <nav aria-label="Approval filters">
                ${(['all', 'allow', 'review', 'block', 'unmatched'] as const)
                  .map((filter) => `<a${view.filter === filter ? ' aria-current="page"' : ''} href="${currentPath}?status=${filter}">${filter === 'allow' ? 'Approved' : filter === 'review' ? 'Needs review' : filter === 'block' ? 'Blocked' : filter === 'unmatched' ? 'Unmatched' : 'All'}</a>`)
                  .join('')}
              </nav>
              <form method="get" action="${currentPath}" role="search">
                ${view.filter && view.filter !== 'all' ? `<input type="hidden" name="status" value="${escapeHtml(view.filter)}">` : ''}
                <label for="collection-search">Search collections and episodes</label>
                <input id="collection-search" name="search" value="${escapeHtml(view.search ?? '')}">
                <button type="submit">Search</button>
              </form>
            </div>`
          : ''
      }
      ${renderSummary(view.summary)}
      ${renderBulkActions(view)}
      ${primaryContent}
      ${renderPagination(view.pagination)}
    </div>
  `
}

export function renderCollectionLibrary(
  view: CollectionLibraryViewModel
): string {
  return renderLayout(
    'Library',
    `<link rel="stylesheet" href="/css/collection-library.css">
     ${renderCollectionLibraryContent(view)}
     <script>
       (function () {
         if (!window.EventSource) return;
         var work = document.getElementById('collection-live-work');
         var title = document.getElementById('collection-live-title');
         var progress = document.getElementById('collection-live-progress');
         var detail = document.getElementById('collection-live-detail');
         var source = new EventSource('/events/dashboard');
         function showScan(state) {
           if (!state || !work || !title || !progress || !detail) return;
           work.hidden = false;
           title.textContent = state.status === 'failed' ? 'Library scan failed' : 'Scanning library';
           progress.max = Math.max(1, Number(state.discoveredFiles) || 1);
           progress.value = Math.min(progress.max, Number(state.processedFiles) || 0);
           detail.textContent = String(state.processedFiles || 0) + ' / ' + String(state.discoveredFiles || 0) + (state.currentFile ? ' · ' + state.currentFile : '');
           if (state.status === 'completed') {
             title.textContent = 'Library scan completed';
             window.setTimeout(function () { window.location.reload(); }, 800);
           }
         }
         function showMetadata(state) {
           if (!state || !work || !title || !progress || !detail) return;
           work.hidden = false;
           title.textContent = state.status === 'failed' ? 'Metadata task needs attention' : 'Matching metadata';
           progress.max = Math.max(1, Number(state.total) || 1);
           progress.value = Math.min(progress.max, Number(state.processed) || 0);
           detail.textContent = String(state.processed || 0) + ' / ' + String(state.total || 0) + ' collections';
           if (state.status === 'completed' || state.status === 'not_configured') {
             window.setTimeout(function () { window.location.reload(); }, 800);
           }
         }
         source.onmessage = function (message) {
           try {
             var event = JSON.parse(message.data);
             if (event.type === 'sync') {
               if (event.libraryScan && (event.libraryScan.status === 'scanning' || event.libraryScan.status === 'discovering')) showScan(event.libraryScan);
               else if (event.metadata && event.metadata.status === 'running') showMetadata(event.metadata);
             } else if (String(event.type).indexOf('library.scan.') === 0) showScan(event.state);
             else if (String(event.type).indexOf('library.metadata.') === 0) showMetadata(event.state);
           } catch (_) {}
         };
       })();
     </script>`,
    { updateAvailable: view.updateAvailable }
  )
}
