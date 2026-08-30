/**
 * Breaking a tie with the length of the file on disk.
 *
 * Title and year come from the catalogue, so when several records agree on
 * both there is nothing left to weigh. The duration of the file is measured
 * locally and is not a catalogue opinion, which makes it the one piece of
 * evidence that can separate them.
 *
 * Two situations reach here, and both are narrow, because this is the only
 * place automation settles a title that ordinary matching would not.
 *
 * Several contenders -- it chooses between them. Exactly one may fall inside
 * the tight window, every other must be clearly outside it, and all of them
 * must have a runtime, since an unknown rival cannot be ruled out.
 *
 * One contender -- it confirms a near miss. Ordinary matching refused the
 * candidate for not being an exact title, so there is no rival whose
 * wrongness is doing any of the work, and the test is stricter: a decent
 * title score, the same year, and a runtime inside the window.
 *
 * In both cases the file's own length must be known, and anything short of
 * unanimous leaves the collection for review. Pure, so the thresholds are
 * testable without a database or a provider.
 */
import type { MetadataCandidateRecord } from '../../types'

/**
 * A film runs a minute or two either side of its catalogue figure once
 * logos and credits are counted, so the window is absolute rather than
 * proportional: a percentage would be far too generous for a feature and
 * far too mean for a short.
 */
export const RUNTIME_MATCH_TOLERANCE_MINUTES = 3

/**
 * The window required when a tied candidate has no runtime recorded.
 *
 * A missing runtime is an absence of evidence, not evidence against the
 * candidate that does fit, so it no longer abandons the comparison outright.
 * What it does is remove the chance to rule that rival out, and the answer to
 * that is to demand more of the leader rather than to give up: it must agree
 * with the file almost exactly, not merely closely.
 */
export const RUNTIME_STRICT_TOLERANCE_MINUTES = 2

/**
 * How far a rival must sit before it counts as ruled out. A director's cut
 * or a restored edition routinely differs by ten minutes, so anything closer
 * than this is treated as still plausible and blocks the match.
 */
export const RUNTIME_RIVAL_MARGIN_MINUTES = 10

/**
 * How close to the leader a candidate must score to count as tied with it.
 *
 * Only genuine ties belong in the comparison. A wider net drags in titles
 * that merely resemble the leader -- "Alien: Absolution" beside "Absolution",
 * a making-of beside the film -- and since such entries frequently carry no
 * runtime at all, they abandon the comparison for a rivalry that was never
 * real.
 */
export const CONTENDER_SCORE_EPSILON = 0.02

/**
 * How far ahead of everything else a lone candidate must be. Without a tie
 * to adjudicate, the runtime is corroborating a near miss, and that is only
 * honest if nothing else was close to being the answer.
 */
export const LONE_CANDIDATE_LEAD_MARGIN = 0.25

/**
 * How well a lone candidate must match by title before its runtime is allowed
 * to confirm it. Ordinary matching has already refused it for not being an
 * exact title, so this guards against a weak name plus a coincidental length.
 */
export const LONE_CANDIDATE_MIN_CONFIDENCE = 0.7

export interface RuntimeResolution {
  readonly candidate: MetadataCandidateRecord
  /** Absolute difference in minutes, for the audit trail. */
  readonly deltaMinutes: number
}

/**
 * Returns the single candidate the file's length identifies, or null when the
 * evidence is anything short of unanimous.
 */
export function resolveByRuntime(
  candidates: readonly MetadataCandidateRecord[],
  fileRuntimeMinutes: number | undefined,
  /** Required for a lone candidate, which must agree on the year as well. */
  collectionYear?: number | null
): RuntimeResolution | null {
  if (
    fileRuntimeMinutes === undefined ||
    !Number.isFinite(fileRuntimeMinutes) ||
    fileRuntimeMinutes <= 0
  ) {
    return null
  }

  const contenders = contending(candidates)
  if (contenders.length === 0) return null

  /* A rival with no runtime cannot be ruled out, so the leader is held to the
     stricter window instead. Abandoning here was too blunt: a single record
     TMDB happens to hold no length for would veto a decision the rest of the
     field settles clearly. */
  const unknownRival = contenders.some(
    (candidate) => !isUsableRuntime(candidate.runtimeMinutes)
  )
  const tolerance = unknownRival
    ? RUNTIME_STRICT_TOLERANCE_MINUTES
    : RUNTIME_MATCH_TOLERANCE_MINUTES
  const measurable = contenders.filter((candidate) =>
    isUsableRuntime(candidate.runtimeMinutes)
  )
  // With nothing measurable there is no evidence at all, only a preference.
  if (measurable.length === 0) return null

  /* A single contender was never a tie: ordinary matching refused it for not
     being an exact title, so the runtime is corroborating a near miss rather
     than choosing between rivals. That deserves the stricter test -- a decent
     title score and the same year -- because there is no competitor whose
     wrongness is doing any of the work. */
  if (contenders.length === 1) {
    const only = contenders[0]
    if (!only) return null
    if (only.confidence < LONE_CANDIDATE_MIN_CONFIDENCE) return null
    if (!isUsableRuntime(only.runtimeMinutes)) return null
    // Nothing else may be near enough to have been the answer instead.
    const runnerUp = Math.max(
      0,
      ...candidates
        .filter((candidate) => candidate.externalId !== only.externalId)
        .map((candidate) => candidate.confidence)
    )
    if (only.confidence - runnerUp < LONE_CANDIDATE_LEAD_MARGIN) return null
    if (
      collectionYear === undefined ||
      collectionYear === null ||
      only.year !== collectionYear
    ) {
      return null
    }
    const delta = Math.abs((only.runtimeMinutes as number) - fileRuntimeMinutes)
    return delta <= RUNTIME_MATCH_TOLERANCE_MINUTES
      ? { candidate: only, deltaMinutes: delta }
      : null
  }

  const measured = measurable.map((candidate) => ({
    candidate,
    deltaMinutes: Math.abs((candidate.runtimeMinutes as number) - fileRuntimeMinutes),
  }))

  const inside = measured.filter((entry) => entry.deltaMinutes <= tolerance)
  if (inside.length !== 1) return null

  const winner = inside[0]
  if (!winner) return null

  const everyRivalRuledOut = measured.every(
    (entry) =>
      entry.candidate.externalId === winner.candidate.externalId ||
      entry.deltaMinutes >= RUNTIME_RIVAL_MARGIN_MINUTES
  )
  if (!everyRivalRuledOut) return null

  return { candidate: winner.candidate, deltaMinutes: winner.deltaMinutes }
}

/**
 * The candidates genuinely tied with the leader. Anything scoring measurably
 * below it is a different title, so it neither wins on a coincidental runtime
 * nor blocks a decision by having none recorded.
 */
function contending(
  candidates: readonly MetadataCandidateRecord[]
): readonly MetadataCandidateRecord[] {
  if (candidates.length === 0) return []
  const best = Math.max(...candidates.map((candidate) => candidate.confidence))
  return candidates.filter(
    (candidate) => candidate.confidence >= best - CONTENDER_SCORE_EPSILON
  )
}

function isUsableRuntime(value: number | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * The comparable length of a collection's media: a film is one file, a series
 * is one episode, so the median stands in for both. A single double-length
 * special cannot drag it, and a mean would be dragged by exactly that.
 */
export function collectionRuntimeMinutes(
  durationsSeconds: readonly (number | null | undefined)[]
): number | undefined {
  const usable = durationsSeconds
    .filter(
      (seconds): seconds is number =>
        typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    )
    .sort((left, right) => left - right)
  if (usable.length === 0) return undefined
  const middle = usable[Math.floor(usable.length / 2)]
  return middle === undefined ? undefined : Math.round(middle / 60)
}
