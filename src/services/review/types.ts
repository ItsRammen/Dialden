/**
 * Review assistant contracts.
 *
 * The assistant adjudicates over metadata the library already holds. It never
 * supplies facts: disambiguation selects from a candidate list gathered from
 * TMDB, and suitability proposes a band the profile already defines. Both are
 * validated in `verdict.ts` before anything is written.
 */

/** Restrictiveness order. A proposal may tighten, never loosen. */
export type PolicyBand = 'allow' | 'review' | 'block'

export interface AssistantCandidate {
  readonly externalId: string
  readonly title: string
  readonly year?: number
  readonly overview?: string
  /** Minutes, per the provider. Checkable against the file on disk. */
  readonly runtimeMinutes?: number
}

export interface DisambiguationRequest {
  readonly collectionId: number
  readonly parsedTitle: string
  readonly year?: number
  readonly mediaType: 'movie' | 'tv'
  /**
   * How long the file actually is, in minutes. The one fact here that comes
   * from the library rather than the catalogue, and so the only one that can
   * settle a tie between two records with the same title and year.
   */
  readonly fileRuntimeMinutes?: number
  /** Never empty: with nothing to choose between there is nothing to ask. */
  readonly candidates: readonly AssistantCandidate[]
}

export interface DisambiguationVerdict {
  /** An id from the request's candidates, or null for "not confident". */
  readonly externalId: string | null
  readonly confidence: number
  readonly reason: string
}

export interface SuitabilityRequest {
  readonly collectionId: number
  readonly title: string
  readonly year?: number
  readonly overview?: string
  readonly genres: readonly string[]
  readonly profileAge: number
  /**
   * The band already established, when one exists. A proposal may match it or
   * tighten it, never loosen it.
   */
  readonly currentBand?: PolicyBand
}

export interface SuitabilityProposal {
  readonly band: PolicyBand
  readonly confidence: number
  readonly reason: string
}

/**
 * A rejected response is a normal outcome, not a failure. The collection stays
 * queued and the run continues.
 */
export type VerdictOutcome<T> =
  | { readonly status: 'accepted'; readonly value: T }
  | { readonly status: 'rejected'; readonly reason: string }

export interface ReviewAssistant {
  readonly id: string
  readonly configured: boolean
  testConnection(signal?: AbortSignal): Promise<void>
  disambiguate(
    request: DisambiguationRequest,
    signal?: AbortSignal
  ): Promise<VerdictOutcome<DisambiguationVerdict>>
  assessSuitability(
    request: SuitabilityRequest,
    signal?: AbortSignal
  ): Promise<VerdictOutcome<SuitabilityProposal>>
}
