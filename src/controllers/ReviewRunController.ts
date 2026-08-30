/**
 * Endpoints for automated library review.
 *
 * Nothing here runs on a schedule. A run happens only when someone asks for
 * one, because automating six hundred parental decisions in the background is
 * not a thing that should happen quietly. Every run is recorded and every run
 * can be undone as a unit.
 */
import { Hono, type Context } from 'hono'
import type { MediaCollection, OverrideDecision } from '../types'
import {
  loadPersistedReviewAssistantConfig,
  type ReviewAssistantSettingStore,
} from '../config/reviewAssistant'
import {
  OpenAiCompatibleReviewAssistant,
  PROMPT_VERSION,
} from '../services/review/OpenAiCompatibleReviewAssistant'
import { ReviewRunner, type ReviewRunReport } from '../services/review/ReviewRunner'
import { renderReviewRunReport } from '../templates/metadataSettings'
import type { ReviewDecisionStore } from '../services/review/auditTypes'

export interface ReviewRunControllerDeps {
  readonly library: {
    getReviewQueue(options?: {
      limit?: number
      offset?: number
    }): Promise<MediaCollection[]>
    getDetail(
      id: number
    ): Promise<{ collection: MediaCollection } | null>
    setOverride(id: number, decision: OverrideDecision): Promise<boolean>
  }
  readonly metadata: {
    confirmMatch(
      collectionId: number,
      externalId: string
    ): Promise<MediaCollection | null>
    retryCollection(collectionId: number): Promise<MediaCollection | null>
  }
  readonly audit: ReviewDecisionStore
  readonly assistantStore: ReviewAssistantSettingStore
  readonly refreshSchedules?: () => Promise<void>
}

export function createReviewRunController(deps: ReviewRunControllerDeps): Hono {
  const controller = new Hono()

  /** One run at a time: two passes would fight over the same queue. */
  let activeRun: Promise<ReviewRunReport> | null = null

  const libraryAdapter = {
    getReviewQueue: deps.library.getReviewQueue.bind(deps.library),
    getCollection: async (id: number): Promise<MediaCollection | null> =>
      (await deps.library.getDetail(id))?.collection ?? null,
    setOverride: deps.library.setOverride.bind(deps.library),
  }

  /**
   * Tests the slot and claims it in one synchronous block, and returns null if
   * a run is already going. Checking in the route handler instead would leave
   * a window across the body parse in which two requests both see the slot
   * free and both start a pass over the same queue.
   */
  const startRun = (
    dryRun: boolean,
    limit: number,
    collectionIds: readonly number[]
  ): Promise<ReviewRunReport> | null => {
    if (activeRun) return null
    const run = (async () => {
      const config = await loadPersistedReviewAssistantConfig(deps.assistantStore)
      const assistant = new OpenAiCompatibleReviewAssistant(config)
      const runner = new ReviewRunner({
        library: libraryAdapter,
        metadata: deps.metadata,
        audit: deps.audit,
        assistant,
        assistantModel: config.model,
        promptVersion: PROMPT_VERSION,
        ...(deps.refreshSchedules ? { refresh: deps.refreshSchedules } : {}),
      })
      return runner.run(
        {
          dryRun,
          limit,
          callBudget: config.callBudget,
          maxConcurrency: config.maxConcurrency,
          ...(collectionIds.length > 0 ? { collectionIds } : {}),
        },
        config.decisionPolicy
      )
    })()
    activeRun = run
    // Swallowed here only so a failed run still releases the slot; the
    // rejection is still delivered to the caller below.
    void run.catch(() => {})
    return run.finally(() => {
      activeRun = null
    })
  }

  /* Backs the buttons on the settings page. Answers with a fragment so the
     report appears in place rather than as a page reload that loses it. */
  controller.post('/settings/metadata/assistant/run', async (c) => {
    const run = startRun(c.req.query('dryRun') !== 'false', 250, [])
    if (!run) {
      return c.html(
        '<div class="metadata-inline-alert warning" role="status">A review run is already in progress.</div>'
      )
    }
    try {
      return c.html(renderReviewRunReport(await run))
    } catch (error) {
      return c.html(
        `<div class="metadata-inline-alert warning" role="status">${
          error instanceof Error ? error.message : 'The review run failed.'
        }</div>`
      )
    }
  })

  controller.post('/api/admin/v1/library/review-assistant/run', async (c) => {
    const body = (await readJson(c)) ?? {}
    /* Committing is the deliberate act, so a request that says nothing gets a
       dry run rather than six hundred writes. */
    const dryRun = body['dryRun'] !== false
    const limit = boundedInteger(body['limit'], 250, 1, 5000)
    const collectionIds = readIds(body['collectionIds'])
    if (collectionIds === null) {
      return c.json({ error: 'collectionIds must be an array of positive integers' }, 400)
    }

    const run = startRun(dryRun, limit, collectionIds)
    if (!run) {
      return c.json({ error: 'A review run is already in progress' }, 409)
    }

    try {
      return c.json({ report: await run })
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Review run failed' },
        500
      )
    }
  })

  controller.get('/api/admin/v1/library/review-assistant/runs', async (c) =>
    c.json({ runs: await deps.audit.listReviewRuns(20) })
  )

  controller.get('/api/admin/v1/library/review-assistant/decisions', async (c) => {
    const runId = c.req.query('runId')
    const decisions = await deps.audit.listReviewDecisions({
      ...(runId ? { runId } : {}),
      includeReverted: c.req.query('includeReverted') === 'true',
      limit: boundedInteger(c.req.query('limit'), 200, 1, 1000),
    })
    return c.json({ decisions })
  })

  /**
   * Puts each collection back the way automation found it. A match returns to
   * automatic matching rather than to whatever the assistant chose, so a
   * reverted collection is genuinely undecided again rather than silently
   * keeping the answer being undone.
   */
  controller.post('/api/admin/v1/library/review-assistant/revert', async (c) => {
    const body = (await readJson(c)) ?? {}
    const runId = typeof body['runId'] === 'string' ? body['runId'] : undefined
    const ids = readIds(body['ids'])
    if (ids === null) {
      return c.json({ error: 'ids must be an array of positive integers' }, 400)
    }
    if (!runId && ids.length === 0) {
      return c.json({ error: 'A runId or a list of decision ids is required' }, 400)
    }

    const decisions = await deps.audit.listReviewDecisions({
      ...(runId ? { runId } : {}),
      limit: 1000,
    })
    const targets =
      ids.length > 0
        ? decisions.filter((decision) => ids.includes(decision.id))
        : decisions

    const reverted: number[] = []
    const errors: { id: number; message: string }[] = []
    for (const decision of targets) {
      try {
        if (decision.action === 'match') {
          await deps.metadata.retryCollection(decision.collectionId)
        } else {
          await deps.library.setOverride(
            decision.collectionId,
            decision.previousOverride
          )
        }
        reverted.push(decision.id)
      } catch (error) {
        errors.push({
          id: decision.id,
          message: error instanceof Error ? error.message : 'Revert failed',
        })
      }
    }

    const marked = await deps.audit.markReviewDecisionsReverted(reverted)
    if (reverted.length > 0) await deps.refreshSchedules?.()
    return c.json({ reverted: marked, requested: targets.length, errors })
  })

  return controller
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(Math.trunc(parsed), min), max)
}

/** Returns null for a malformed list, so a bad request fails rather than runs. */
function readIds(value: unknown): number[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return null
  const ids: number[] = []
  for (const entry of value) {
    if (!Number.isSafeInteger(entry) || Number(entry) <= 0) return null
    ids.push(Number(entry))
  }
  return ids
}

async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await c.req.json()
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
