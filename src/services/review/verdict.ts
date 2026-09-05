/**
 * The safety boundary between a language model and the library.
 *
 * Nothing a model returns is written until it passes through here. The rules
 * are deliberately blunt, because the guarantee they buy is blunt: a wrong
 * answer can only ever pick the wrong item from a list the library already
 * had, or tighten a decision that was already going to be made.
 *
 * Pure and dependency-free so the guarantees are testable without a network.
 */
import type {
  DisambiguationRequest,
  DisambiguationVerdict,
  PolicyBand,
  SuitabilityProposal,
  SuitabilityRequest,
  VerdictOutcome,
} from './types'

/**
 * Below this a pick is treated as no decision. A model asked to choose between
 * near-identical sequels will answer something; the confidence is how it says
 * it had to guess.
 */
export const MIN_MATCH_CONFIDENCE = 0.75

/** Ascending permissiveness. A proposal may move down this list, never up. */
const BAND_RESTRICTIVENESS: Record<PolicyBand, number> = {
  allow: 0,
  review: 1,
  block: 2,
}

const BANDS = Object.keys(BAND_RESTRICTIVENESS) as readonly PolicyBand[]

function rejected<T>(reason: string): VerdictOutcome<T> {
  return { status: 'rejected', reason }
}

/** Accepts an object or the JSON text a chat completion usually returns. */
function asRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return null
    try {
      const parsed: unknown = JSON.parse(trimmed)
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null
}

function readConfidence(value: unknown): number | null {
  const numeric = typeof value === 'string' ? Number(value) : value
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return null
  if (numeric < 0 || numeric > 1) return null
  return numeric
}

function readReason(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 400) : ''
}

/**
 * Validates a disambiguation response against the candidates it was given.
 *
 * The central rule: an id the request did not offer is rejected outright. The
 * model selects from the library's own candidates and can never introduce one,
 * so a hallucinated identifier cannot reach the database.
 */
export function parseDisambiguation(
  raw: unknown,
  request: DisambiguationRequest,
  minConfidence: number = MIN_MATCH_CONFIDENCE
): VerdictOutcome<DisambiguationVerdict> {
  const record = asRecord(raw)
  if (!record) return rejected('Response was not a JSON object')

  const confidence = readConfidence(record['confidence'])
  if (confidence === null) {
    return rejected('Response had no usable confidence between 0 and 1')
  }
  const reason = readReason(record['reason'])

  const rawId = record['externalId']
  // An explicit abstention is a valid answer and leaves the item queued.
  if (rawId === null || rawId === undefined || rawId === '') {
    return { status: 'accepted', value: { externalId: null, confidence, reason } }
  }
  if (typeof rawId !== 'string' && typeof rawId !== 'number') {
    return rejected('Response externalId was neither a string nor a number')
  }

  const externalId = String(rawId)
  const offered = request.candidates.some(
    (candidate) => candidate.externalId === externalId
  )
  if (!offered) {
    return rejected(
      `Response chose "${externalId}", which was not among the candidates offered`
    )
  }

  if (confidence < minConfidence) {
    return { status: 'accepted', value: { externalId: null, confidence, reason } }
  }

  return { status: 'accepted', value: { externalId, confidence, reason } }
}

/**
 * Validates a suitability response.
 *
 * A proposal may agree with an established band or tighten it. Loosening is
 * rejected, so a model can never talk the library into showing something a
 * certification had already ruled out.
 */
export function parseSuitability(
  raw: unknown,
  request: SuitabilityRequest
): VerdictOutcome<SuitabilityProposal> {
  const record = asRecord(raw)
  if (!record) return rejected('Response was not a JSON object')

  const rawBand = record['band']
  const band =
    typeof rawBand === 'string'
      ? (rawBand.trim().toLowerCase() as PolicyBand)
      : null
  if (!band || !BANDS.includes(band)) {
    return rejected('Response band was not one of allow, review or block')
  }

  const confidence = readConfidence(record['confidence'])
  if (confidence === null) {
    return rejected('Response had no usable confidence between 0 and 1')
  }

  const current = request.currentBand
  if (
    current !== undefined &&
    BAND_RESTRICTIVENESS[band] < BAND_RESTRICTIVENESS[current]
  ) {
    return rejected(
      `Response proposed "${band}", which is more permissive than the established "${current}"`
    )
  }

  return {
    status: 'accepted',
    value: { band, confidence, reason: readReason(record['reason']) },
  }
}
