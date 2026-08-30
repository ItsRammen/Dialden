/**
 * Runs automated review over the outstanding queue.
 *
 * Two layers, in order. Deterministic policy settles everything it can from a
 * table the operator controls. Only what it cannot settle — a title with more
 * than one plausible match — is put to the assistant, and only to *choose*
 * between candidates the library already gathered.
 *
 * Nothing here decides on its own authority:
 *
 *  - A collection a person has already ruled on is never touched.
 *  - Every change is written to the audit trail with the state it replaced,
 *    so a whole run reverts as a unit.
 *  - `dryRun` walks the identical path and writes nothing, so the report you
 *    read before committing is the report you would have got.
 */
import type { MediaCollection, MetadataCandidateRecord, OverrideDecision } from '../../types'
import type { PolicyEvaluation, PolicyReason } from '../../policy/PolicyEngine'
import {
  DEFAULT_AUTO_DECISION_POLICY,
  decideAutomatically,
  describeAutoOutcome,
  type AutoDecisionPolicy,
} from './autoDecision'
import type { ReviewAssistant } from './types'
import type { ReviewDecisionDraft, ReviewDecisionStore } from './auditTypes'

export interface ReviewRunOptions {
  /** Reports what would happen and writes nothing. */
  readonly dryRun: boolean
  /** How many outstanding collections to walk. */
  readonly limit: number
  /** Hard ceiling on assistant calls for this run. */
  readonly callBudget: number
  readonly maxConcurrency: number
  /** Restricts the run to specific collections; otherwise the whole queue. */
  readonly collectionIds?: readonly number[]
  readonly signal?: AbortSignal
}

export interface ReviewRunSample {
  readonly collectionId: number
  readonly title: string
  readonly action: 'approve' | 'block' | 'match' | 'left'
  readonly source: 'policy' | 'assistant'
  readonly reason: string
  readonly detail: string
  readonly confidence?: number
}

export interface ReviewRunReport {
  readonly runId: string
  readonly dryRun: boolean
  readonly scanned: number
  /** Already decided by a person; automation never revisits these. */
  readonly skippedParentDecided: number
  readonly approved: number
  readonly blocked: number
  readonly matched: number
  /** Still waiting for you, either by policy or because nothing was confident. */
  readonly leftForYou: number
  readonly assistant: {
    readonly available: boolean
    readonly attempted: number
    readonly applied: number
    /** The model was asked and was not confident enough to answer. */
    readonly declined: number
    readonly failed: number
    readonly budgetExhausted: boolean
  }
  readonly samples: readonly ReviewRunSample[]
  readonly errors: readonly { collectionId: number; message: string }[]
}

export interface ReviewRunnerDeps {
  readonly library: {
    getReviewQueue(options?: {
      limit?: number
      offset?: number
    }): Promise<MediaCollection[]>
    getCollection(id: number): Promise<MediaCollection | null>
    setOverride(id: number, decision: OverrideDecision): Promise<boolean>
  }
  readonly metadata: {
    confirmMatch(
      collectionId: number,
      externalId: string
    ): Promise<MediaCollection | null>
  }
  readonly audit: ReviewDecisionStore
  readonly assistant?: ReviewAssistant
  readonly assistantModel?: string
  readonly promptVersion?: string
  /** Applied after writes so schedules reflect the new decisions. */
  readonly refresh?: () => Promise<void>
  readonly newRunId?: () => string
}

const MAX_SAMPLES = 40

export class ReviewRunner {
  constructor(private readonly deps: ReviewRunnerDeps) {}

  async run(
    options: ReviewRunOptions,
    policy: AutoDecisionPolicy = DEFAULT_AUTO_DECISION_POLICY
  ): Promise<ReviewRunReport> {
    const runId = (this.deps.newRunId ?? defaultRunId)()
    const queue = await this.collect(options)

    const samples: ReviewRunSample[] = []
    const errors: { collectionId: number; message: string }[] = []
    const assistQueue: MediaCollection[] = []
    let skippedParentDecided = 0
    let approved = 0
    let blocked = 0
    let leftForYou = 0
    let wrote = false

    for (const collection of queue) {
      if (options.signal?.aborted) break
      const hasParentOverride = collection.parentOverride !== null
      if (hasParentOverride) {
        skippedParentDecided++
        continue
      }

      const outcome = decideAutomatically(
        { evaluation: evaluationOf(collection), hasParentOverride },
        policy
      )

      if (outcome.action === 'approve' || outcome.action === 'block') {
        const detail = describeAutoOutcome(outcome)
        if (!options.dryRun) {
          try {
            await this.applyOverride(runId, collection, outcome.action, detail)
            wrote = true
          } catch (error) {
            errors.push({ collectionId: collection.id, message: messageOf(error) })
            continue
          }
        }
        if (outcome.action === 'approve') approved++
        else blocked++
        pushSample(samples, {
          collectionId: collection.id,
          title: titleOf(collection),
          action: outcome.action,
          source: 'policy',
          reason: outcome.reason,
          detail,
        })
        continue
      }

      if (outcome.action === 'assist') {
        assistQueue.push(collection)
        continue
      }

      // 'manual' and 'none' both leave the item exactly where it was.
      if (outcome.action === 'manual') leftForYou++
    }

    const assisted = await this.runAssistant(
      runId,
      assistQueue,
      options,
      samples,
      errors
    )
    leftForYou += assisted.left
    if (assisted.applied > 0) wrote = true

    if (wrote) await this.deps.refresh?.()

    return {
      runId,
      dryRun: options.dryRun,
      scanned: queue.length,
      skippedParentDecided,
      approved,
      blocked,
      matched: assisted.applied,
      leftForYou,
      assistant: {
        available: this.assistantAvailable,
        attempted: assisted.attempted,
        applied: assisted.applied,
        declined: assisted.declined,
        failed: assisted.failed,
        budgetExhausted: assisted.budgetExhausted,
      },
      samples,
      errors,
    }
  }

  private get assistantAvailable(): boolean {
    return this.deps.assistant?.configured === true
  }

  private async collect(options: ReviewRunOptions): Promise<MediaCollection[]> {
    if (options.collectionIds && options.collectionIds.length > 0) {
      const found: MediaCollection[] = []
      for (const id of options.collectionIds.slice(0, options.limit)) {
        const collection = await this.deps.library.getCollection(id)
        if (collection) found.push(collection)
      }
      return found
    }
    return this.deps.library.getReviewQueue({ limit: options.limit })
  }

  /**
   * Only disambiguation reaches the model. It selects from candidates already
   * on disk, so a wrong answer picks the wrong entry from a list you already
   * had rather than inventing one.
   */
  private async runAssistant(
    runId: string,
    queue: readonly MediaCollection[],
    options: ReviewRunOptions,
    samples: ReviewRunSample[],
    errors: { collectionId: number; message: string }[]
  ): Promise<{
    attempted: number
    applied: number
    declined: number
    failed: number
    left: number
    budgetExhausted: boolean
  }> {
    const assistant = this.deps.assistant
    let attempted = 0
    let applied = 0
    let declined = 0
    let failed = 0
    let left = 0
    let budgetExhausted = false

    if (!assistant?.configured) {
      // Configured off is not an error: policy asked for help nobody offered.
      return {
        attempted: 0,
        applied: 0,
        declined: 0,
        failed: 0,
        left: queue.length,
        budgetExhausted: false,
      }
    }

    /* A single candidate is still worth asking about: "A Tale of Mari & 3
       Puppies" against "A Tale of Mari and Three Puppies" is a question with
       an answer, and it is exactly the sort the deterministic matcher scores
       just under its own threshold. Only an empty list has nothing to ask. */
    const actionable = queue.filter((collection) => {
      if (candidatesOf(collection).length >= 1) return true
      left++
      return false
    })

    let cursor = 0
    let spent = 0
    const budget = Math.max(0, options.callBudget)
    const workers = Math.min(
      Math.max(1, options.maxConcurrency),
      Math.max(1, actionable.length)
    )

    const worker = async (): Promise<void> => {
      for (;;) {
        if (options.signal?.aborted) return
        if (spent >= budget) {
          budgetExhausted = true
          return
        }
        const index = cursor++
        if (index >= actionable.length) return
        const collection = actionable[index]
        if (!collection) return
        spent++
        attempted++

        const candidates = candidatesOf(collection)
        let outcome
        try {
          outcome = await assistant.disambiguate(
            {
              collectionId: collection.id,
              parsedTitle: collection.parsedTitle,
              ...(collection.year === null ? {} : { year: collection.year }),
              mediaType: collection.libraryKind === 'movie' ? 'movie' : 'tv',
              candidates: candidates.map((candidate) => ({
                externalId: candidate.externalId,
                title: candidate.title,
                ...(candidate.year === undefined ? {} : { year: candidate.year }),
                ...(candidate.overview === undefined
                  ? {}
                  : { overview: candidate.overview }),
              })),
            },
            options.signal
          )
        } catch (error) {
          failed++
          left++
          errors.push({ collectionId: collection.id, message: messageOf(error) })
          continue
        }

        if (outcome.status !== 'accepted' || outcome.value.externalId === null) {
          declined++
          left++
          pushSample(samples, {
            collectionId: collection.id,
            title: titleOf(collection),
            action: 'left',
            source: 'assistant',
            reason: collection.policyReason,
            detail:
              outcome.status === 'accepted'
                ? outcome.value.reason
                : outcome.reason,
            ...(outcome.status === 'accepted'
              ? { confidence: outcome.value.confidence }
              : {}),
          })
          continue
        }

        const verdict = outcome.value
        const externalId = verdict.externalId
        // Narrowed above; restated so the type follows the control flow.
        if (externalId === null) continue
        if (!options.dryRun) {
          try {
            await this.applyMatch(runId, collection, externalId, verdict)
          } catch (error) {
            failed++
            left++
            errors.push({
              collectionId: collection.id,
              message: messageOf(error),
            })
            continue
          }
        }
        applied++
        pushSample(samples, {
          collectionId: collection.id,
          title: titleOf(collection),
          action: 'match',
          source: 'assistant',
          reason: collection.policyReason,
          detail: verdict.reason,
          confidence: verdict.confidence,
        })
      }
    }

    await Promise.all(Array.from({ length: workers }, () => worker()))
    return { attempted, applied, declined, failed, left, budgetExhausted }
  }

  private async applyOverride(
    runId: string,
    collection: MediaCollection,
    action: 'approve' | 'block',
    detail: string
  ): Promise<void> {
    const decision: OverrideDecision = action === 'approve' ? 'allow' : 'block'
    const changed = await this.deps.library.setOverride(collection.id, decision)
    if (!changed) throw new Error('Collection could not be updated')
    await this.deps.audit.recordReviewDecision(
      this.draft(runId, collection, action, 'policy', detail, null)
    )
  }

  private async applyMatch(
    runId: string,
    collection: MediaCollection,
    externalId: string,
    verdict: { confidence: number; reason: string }
  ): Promise<void> {
    const updated = await this.deps.metadata.confirmMatch(
      collection.id,
      externalId
    )
    if (!updated) throw new Error('Collection could not be matched')
    await this.deps.audit.recordReviewDecision(
      this.draft(
        runId,
        collection,
        'match',
        'assistant',
        verdict.reason,
        verdict.confidence
      )
    )
  }

  private draft(
    runId: string,
    collection: MediaCollection,
    action: 'approve' | 'block' | 'match',
    source: 'policy' | 'assistant',
    detail: string,
    confidence: number | null
  ): ReviewDecisionDraft {
    return {
      runId,
      collectionId: collection.id,
      action,
      source,
      reason: collection.policyReason,
      detail,
      model: source === 'assistant' ? (this.deps.assistantModel ?? null) : null,
      promptVersion:
        source === 'assistant' ? (this.deps.promptVersion ?? null) : null,
      confidence,
      previousOverride: collection.parentOverride,
      previousExternalId: collection.metadataExternalId,
      previousMetadataStatus: collection.metadataStatus,
    }
  }
}

function evaluationOf(collection: MediaCollection): PolicyEvaluation {
  return {
    decision: collection.policyDecision,
    reason: collection.policyReason as PolicyReason,
    certification: collection.certification,
  }
}

function candidatesOf(
  collection: MediaCollection
): readonly MetadataCandidateRecord[] {
  return collection.metadataCandidates ?? []
}

function titleOf(collection: MediaCollection): string {
  return collection.metadataTitle ?? collection.parsedTitle
}

function pushSample(samples: ReviewRunSample[], sample: ReviewRunSample): void {
  if (samples.length < MAX_SAMPLES) samples.push(sample)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

function defaultRunId(): string {
  return `run-${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`
}
