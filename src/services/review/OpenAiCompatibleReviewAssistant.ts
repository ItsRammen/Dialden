/**
 * Review assistant over any OpenAI-compatible chat completions endpoint.
 *
 * The model is asked to select, never to supply. Every response goes through
 * `verdict.ts` before it can reach the library, so the worst a bad answer can
 * do is pick the wrong entry from a list the library already had, or propose a
 * band at least as strict as the one already established.
 *
 * Only public catalogue data is sent — titles, years, overviews and genres that
 * came from the metadata provider. File paths and directory names never leave
 * the network.
 */
import {
  MetadataProviderError,
  type MetadataProviderErrorCode,
} from '../../metadata/types'
import type { ReviewAssistantRuntimeConfig } from '../../config/reviewAssistant'
import {
  parseChannelLineupSuggestion,
  type ChannelLineupSuggestion,
  type ChannelLineupSuggestionRequest,
  type ChannelLineupSuggestionService,
} from '../ChannelLineupSuggestionService'
import { parseDisambiguation, parseSuitability } from './verdict'
import type {
  DisambiguationRequest,
  DisambiguationVerdict,
  ReviewAssistant,
  SuitabilityProposal,
  SuitabilityRequest,
  VerdictOutcome,
} from './types'

/** Bump when the wording changes, so stored decisions stay attributable. */
export const PROMPT_VERSION = 'review-2026-08-30'

const PROVIDER_ID = 'openai-compatible'

export type FetchLike = (
  input: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  }
) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}>

const DISAMBIGUATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['externalId', 'confidence', 'reason'],
  properties: {
    externalId: {
      type: ['string', 'null'],
      description: 'The id of the chosen candidate, or null if unsure.',
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string' },
  },
} as const

const SUITABILITY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['band', 'confidence', 'reason'],
  properties: {
    band: { type: 'string', enum: ['allow', 'review', 'block'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string' },
  },
} as const

const CHANNEL_LINEUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'rationale', 'collectionIds'],
  properties: {
    name: { type: 'string' },
    rationale: { type: 'string' },
    collectionIds: {
      type: 'array',
      minItems: 1,
      maxItems: 60,
      uniqueItems: true,
      items: { type: 'integer', minimum: 1 },
    },
  },
} as const

export class OpenAiCompatibleReviewAssistant
  implements ReviewAssistant, ChannelLineupSuggestionService {
  readonly id = PROVIDER_ID
  /** Cleared for the process once a provider refuses a strict schema. */
  private schemaSupported = true

  constructor(
    private readonly config: ReviewAssistantRuntimeConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike
  ) {}

  get configured(): boolean {
    return this.config.enabled && Boolean(this.config.apiKey && this.config.baseUrl)
  }

  async testConnection(signal?: AbortSignal): Promise<void> {
    await this.complete(
      [
        { role: 'system', content: 'Reply with {"ok":true} and nothing else.' },
        { role: 'user', content: 'ping' },
      ],
      null,
      signal
    )
  }

  async disambiguate(
    request: DisambiguationRequest,
    signal?: AbortSignal
  ): Promise<VerdictOutcome<DisambiguationVerdict>> {
    if (request.candidates.length === 0) {
      return { status: 'rejected', reason: 'No candidates were supplied' }
    }
    const content = await this.complete(
      [
        {
          role: 'system',
          content:
            'You identify which catalogue entry a media library title refers to. ' +
            'Choose only from the numbered candidates supplied. Never invent an id. ' +
            'If two candidates are plausible and you cannot tell them apart — sequels ' +
            'and separately released parts especially — return null with low confidence ' +
            'rather than guessing. ' +
            'Titles are often written differently for the same work: "&" for "and", ' +
            'digits for number words, a subtitle present on one side only, or a ' +
            'translated release title. Those differences alone are not evidence of a ' +
            'different work. A release year that differs by a few years is also weak ' +
            'evidence on its own, because catalogues carry re-releases and regional ' +
            'entries — but a different story, cast or era is decisive. ' +
            'When only one candidate is supplied the task is verification, not choice: ' +
            'it being the only option is not evidence that it is right, so return null ' +
            'unless it genuinely refers to the same work. ' +
            'When the file runtime is given, it is the strongest evidence available, ' +
            'because it is measured from the file itself rather than taken from a ' +
            'catalogue. A candidate whose runtime is within a few minutes is strongly ' +
            'supported; one that differs by more than about fifteen per cent is very ' +
            'unlikely to be the same cut, and a candidate roughly half or double the ' +
            'length is almost certainly a different work such as an abridged edition, ' +
            'a featurette, or a making-of.',
        },
        { role: 'user', content: renderDisambiguationPrompt(request) },
      ],
      { name: 'disambiguation', schema: DISAMBIGUATION_SCHEMA },
      signal
    )
    return parseDisambiguation(content, request)
  }

  async assessSuitability(
    request: SuitabilityRequest,
    signal?: AbortSignal
  ): Promise<VerdictOutcome<SuitabilityProposal>> {
    const content = await this.complete(
      [
        {
          role: 'system',
          content:
            'You advise a parent whether a title suits a child of the stated age. ' +
            'Answer with one band: "allow" if clearly suitable, "review" if a parent ' +
            'should judge, "block" if clearly unsuitable. When the description is thin ' +
            'or you are unsure, prefer the stricter band. Your answer is a suggestion a ' +
            'parent will confirm, never a final decision.',
        },
        { role: 'user', content: renderSuitabilityPrompt(request) },
      ],
      { name: 'suitability', schema: SUITABILITY_SCHEMA },
      signal
    )
    return parseSuitability(content, request)
  }

  async suggestChannelLineup(
    request: ChannelLineupSuggestionRequest,
    signal?: AbortSignal
  ): Promise<ChannelLineupSuggestion> {
    if (!request.goal.trim()) throw new Error('Describe the channel you want')
    if (request.collections.length === 0) {
      throw new Error('No approved TV shows are available for an AI suggestion')
    }
    const content = await this.complete(
      [
        {
          role: 'system',
          content:
            'You propose a cohesive personal TV channel from an approved local catalog. ' +
            'Select only collection IDs supplied by the user; never invent an ID or title. ' +
            'Prefer a varied, balanced lineup that directly matches the stated goal. ' +
            'This is an advisory draft: the administrator will inspect and confirm it.',
        },
        { role: 'user', content: renderChannelLineupPrompt(request) },
      ],
      { name: 'channel_lineup', schema: CHANNEL_LINEUP_SCHEMA },
      signal
    )
    return parseChannelLineupSuggestion(content, request)
  }

  /**
   * Many hosted models, free tiers especially, reject a strict JSON schema.
   * Ask for one, and on a rejection retry once asking only for JSON. The
   * validation boundary does not care which came back: it rejects anything
   * that fails the same checks either way.
   */
  private async complete(
    messages: readonly { role: string; content: string }[],
    schema: { name: string; schema: unknown } | null,
    signal?: AbortSignal
  ): Promise<string> {
    try {
      return await this.request(messages, schema, signal)
    } catch (error) {
      if (schema && isSchemaRejection(error)) {
        this.schemaSupported = false
        return this.request(messages, null, signal, true)
      }
      throw error
    }
  }

  private async request(
    messages: readonly { role: string; content: string }[],
    schema: { name: string; schema: unknown } | null,
    signal?: AbortSignal,
    forceJsonObject = false
  ): Promise<string> {
    if (!this.configured) {
      throw this.error('Review assistant is not configured', 'not_configured')
    }

    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutMs
    )
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort)

    try {
      const response = await this.fetchImpl(
        `${this.config.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.config.apiKey ?? ''}`,
          },
          body: JSON.stringify({
            model: this.config.model,
            temperature: 0,
            messages,
            ...(schema && this.schemaSupported
              ? {
                  response_format: {
                    type: 'json_schema',
                    json_schema: { name: schema.name, strict: true, schema: schema.schema },
                  },
                }
              : forceJsonObject || schema
                ? { response_format: { type: 'json_object' } }
                : {}),
          }),
          signal: controller.signal,
        }
      )

      if (!response.ok) throw await this.httpError(response)
      return extractContent(await response.text(), () =>
        this.error('Assistant returned an unreadable response', 'invalid_response')
      )
    } catch (error) {
      if (error instanceof MetadataProviderError) throw error
      // An abort raised by our own timer is a timeout; one raised by the
      // caller's signal is a deliberate cancellation.
      if (isAbort(error)) {
        throw signal?.aborted
          ? this.error('Assistant request was cancelled', 'aborted')
          : this.error('Assistant request timed out', 'timeout', true)
      }
      throw this.error('Assistant request failed', 'network', true, error)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private async httpError(response: {
    status: number
    headers: { get(name: string): string | null }
    text(): Promise<string>
  }): Promise<MetadataProviderError> {
    const status = response.status
    if (status === 401 || status === 403) {
      return this.error('Assistant rejected the API key', 'unauthorized', false, null, status)
    }
    if (status === 404) {
      return this.error('Assistant endpoint or model was not found', 'not_found', false, null, status)
    }
    if (status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'))
      const error = this.error('Assistant rate limited the request', 'rate_limited', true, null, status)
      return Number.isFinite(retryAfter) && retryAfter > 0
        ? new MetadataProviderError(error.message, {
            code: 'rate_limited',
            provider: PROVIDER_ID,
            retryable: true,
            retryAfterMs: retryAfter * 1000,
            status,
          })
        : error
    }
    return this.error(
      `Assistant returned HTTP ${status}`,
      'upstream',
      status >= 500,
      null,
      status
    )
  }

  private error(
    message: string,
    code: MetadataProviderErrorCode,
    retryable = false,
    cause?: unknown,
    status?: number
  ): MetadataProviderError {
    return new MetadataProviderError(message, {
      code,
      provider: PROVIDER_ID,
      retryable,
      ...(status === undefined ? {} : { status }),
      ...(cause === undefined || cause === null ? {} : { cause }),
    })
  }
}

/** Candidates are numbered so the prompt never implies an ordering preference. */
function renderDisambiguationPrompt(request: DisambiguationRequest): string {
  const lines = [
    `Library title: ${request.parsedTitle}`,
    request.year === undefined ? null : `Library year: ${request.year}`,
    `Kind: ${request.mediaType === 'movie' ? 'film' : 'television series'}`,
    request.fileRuntimeMinutes === undefined
      ? null
      : `Measured file runtime: ${request.fileRuntimeMinutes} minutes`,
    '',
    request.candidates.length === 1
      ? 'One candidate. Confirm it only if it is the same work; otherwise return null.'
      : 'Candidates:',
    ...request.candidates.map((candidate, index) => {
      const parts = [
        `${index + 1}. id=${candidate.externalId}`,
        `title=${candidate.title}`,
        candidate.year === undefined ? null : `year=${candidate.year}`,
        candidate.runtimeMinutes === undefined
          ? null
          : `runtime=${candidate.runtimeMinutes}min`,
        candidate.overview ? `overview=${truncate(candidate.overview, 400)}` : null,
      ].filter((part): part is string => part !== null)
      return parts.join(' | ')
    }),
  ]
  return lines.filter((line): line is string => line !== null).join('\n')
}

function renderSuitabilityPrompt(request: SuitabilityRequest): string {
  const lines = [
    `Child age: ${request.profileAge}`,
    `Title: ${request.title}`,
    request.year === undefined ? null : `Year: ${request.year}`,
    request.genres.length ? `Genres: ${request.genres.join(', ')}` : null,
    request.overview ? `Overview: ${truncate(request.overview, 800)}` : 'Overview: (none available)',
    request.currentBand === undefined
      ? null
      : `A previous assessment said "${request.currentBand}". You may agree or be stricter, never more permissive.`,
  ]
  return lines.filter((line): line is string => line !== null).join('\n')
}

function renderChannelLineupPrompt(
  request: ChannelLineupSuggestionRequest
): string {
  return [
    `Channel goal: ${truncate(request.goal, 500)}`,
    '',
    'Approved playable TV collections:',
    ...request.collections.map((collection) =>
      [
        `id=${collection.id}`,
        `title=${collection.displayTitle}`,
        collection.firstAirYear ? `year=${collection.firstAirYear}` : null,
        collection.genres.length ? `genres=${collection.genres.join(', ')}` : null,
        collection.networks.length
          ? `networks=${collection.networks.join(', ')}`
          : null,
        collection.studios.length
          ? `studios=${collection.studios.join(', ')}`
          : null,
      ]
        .filter((part): part is string => part !== null)
        .join(' | ')
    ),
  ].join('\n')
}

function truncate(value: string, limit: number): string {
  const clean = value.replace(/\s+/gu, ' ').trim()
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`
}

function extractContent(body: string, onInvalid: () => MetadataProviderError): string {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null) throw onInvalid()
    const choices = (parsed as { choices?: unknown }).choices
    if (!Array.isArray(choices) || choices.length === 0) throw onInvalid()
    const message = (choices[0] as { message?: { content?: unknown } }).message
    const content = message?.content
    if (typeof content !== 'string') throw onInvalid()
    return content
  } catch (error) {
    if (error instanceof MetadataProviderError) throw error
    throw onInvalid()
  }
}

/**
 * A provider that cannot do structured output answers 400 or 422 rather than
 * advertising the limitation, so the status is the signal.
 */
function isSchemaRejection(error: unknown): boolean {
  if (!(error instanceof MetadataProviderError)) return false
  return error.status === 400 || error.status === 422
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  )
}
