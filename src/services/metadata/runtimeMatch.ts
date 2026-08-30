/**
 * Breaking a tie with the length of the file on disk.
 *
 * Title and year come from the catalogue, so when several records agree on
 * both there is nothing left to weigh. The duration of the file is measured
 * locally and is not a catalogue opinion, which makes it the one piece of
 * evidence that can separate them.
 *
 * The rule is deliberately narrow, because it is the only place automation
 * picks between titles that a person could not:
 *
 *  - The file's own length must be known.
 *  - Every tied candidate must have a runtime. One unknown and the comparison
 *    is abandoned, because an unknown rival cannot be ruled out.
 *  - Exactly one candidate may be inside the tight window.
 *  - Every other candidate must be clearly outside it.
 *
 * Anything less unanimous leaves the collection for review. Pure, so the
 * thresholds are testable without a database or a provider.
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
 * How far a rival must sit before it counts as ruled out. A director's cut
 * or a restored edition routinely differs by ten minutes, so anything closer
 * than this is treated as still plausible and blocks the match.
 */
export const RUNTIME_RIVAL_MARGIN_MINUTES = 10

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
  fileRuntimeMinutes: number | undefined
): RuntimeResolution | null {
  if (
    fileRuntimeMinutes === undefined ||
    !Number.isFinite(fileRuntimeMinutes) ||
    fileRuntimeMinutes <= 0
  ) {
    return null
  }

  const tied = topScoring(candidates)
  // One candidate is not a tie; ordinary matching already had its say.
  if (tied.length < 2) return null

  // An unknown runtime cannot be ruled out, so it rules out the comparison.
  if (tied.some((candidate) => !isUsableRuntime(candidate.runtimeMinutes))) {
    return null
  }

  const measured = tied.map((candidate) => ({
    candidate,
    deltaMinutes: Math.abs((candidate.runtimeMinutes as number) - fileRuntimeMinutes),
  }))

  const inside = measured.filter(
    (entry) => entry.deltaMinutes <= RUNTIME_MATCH_TOLERANCE_MINUTES
  )
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

/** Only the candidates ordinary matching could not separate are in play. */
function topScoring(
  candidates: readonly MetadataCandidateRecord[]
): readonly MetadataCandidateRecord[] {
  if (candidates.length === 0) return []
  const best = Math.max(...candidates.map((candidate) => candidate.confidence))
  return candidates.filter(
    (candidate) => Math.abs(candidate.confidence - best) < 1e-9
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
