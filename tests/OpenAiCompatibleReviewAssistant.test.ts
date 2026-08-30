import { describe, expect, test } from 'bun:test'
import {
  OpenAiCompatibleReviewAssistant,
  type FetchLike,
} from '../src/services/review/OpenAiCompatibleReviewAssistant'
import { MetadataProviderError } from '../src/metadata/types'
import { disabledReviewAssistantConfig } from '../src/config/reviewAssistant'
import { DEFAULT_AUTO_DECISION_POLICY } from '../src/services/review/autoDecision'
import type {
  DisambiguationRequest,
  SuitabilityRequest,
} from '../src/services/review/types'

const config = {
  ...disabledReviewAssistantConfig(DEFAULT_AUTO_DECISION_POLICY),
  enabled: true,
  apiKey: 'test-key',
  baseUrl: 'https://api.example/v1',
  model: 'test-model',
  requestTimeoutMs: 50,
}

const request: DisambiguationRequest = {
  collectionId: 341,
  parsedTitle: '28 Years Later Part 2 The Bone Temple',
  year: 2026,
  mediaType: 'movie',
  candidates: [
    { externalId: '1001', title: '28 Years Later', year: 2025, overview: 'A sequel.' },
    { externalId: '1002', title: '28 Years Later: The Bone Temple', year: 2026 },
  ],
}

const suitability: SuitabilityRequest = {
  collectionId: 7,
  title: 'The Iron Giant',
  genres: ['Animation', 'Family'],
  overview: 'A boy befriends a giant robot.',
  profileAge: 7,
}

/** Records what was sent and replies with a canned completion. */
function fakeFetch(
  content: string,
  options: { status?: number; headers?: Record<string, string> } = {}
) {
  const calls: { url: string; body: any; headers: Record<string, string> }[] = []
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers })
    return {
      ok: (options.status ?? 200) < 400,
      status: options.status ?? 200,
      headers: { get: (name: string) => options.headers?.[name.toLowerCase()] ?? null },
      text: async () =>
        options.status && options.status >= 400
          ? 'error body'
          : JSON.stringify({ choices: [{ message: { content } }] }),
    }
  }
  return { impl, calls }
}

describe('OpenAiCompatibleReviewAssistant', () => {
  describe('what it sends', () => {
    test('posts to the completions path and authorises with the key', async () => {
      const { impl, calls } = fakeFetch('{"externalId":"1002","confidence":0.9,"reason":"ok"}')
      await new OpenAiCompatibleReviewAssistant(config, impl).disambiguate(request)

      expect(calls[0]!.url).toBe('https://api.example/v1/chat/completions')
      expect(calls[0]!.headers['authorization']).toBe('Bearer test-key')
      expect(calls[0]!.body.model).toBe('test-model')
      expect(calls[0]!.body.temperature).toBe(0)
    })

    test('sends every candidate id, so the model can only choose from them', async () => {
      const { impl, calls } = fakeFetch('{"externalId":"1002","confidence":0.9,"reason":""}')
      await new OpenAiCompatibleReviewAssistant(config, impl).disambiguate(request)

      const prompt = calls[0]!.body.messages[1].content
      expect(prompt).toContain('id=1001')
      expect(prompt).toContain('id=1002')
    })

    test('never sends a file path or directory name', async () => {
      // Only public catalogue data leaves the network. The request type has no
      // field for a path, and this pins that the prompt cannot grow one.
      const { impl, calls } = fakeFetch('{"externalId":null,"confidence":0.1,"reason":""}')
      await new OpenAiCompatibleReviewAssistant(config, impl).disambiguate(request)

      const sent = JSON.stringify(calls[0]!.body)
      expect(sent).not.toContain('/media')
      expect(sent).not.toContain('\\\\')
      expect(sent).not.toMatch(/\.(mkv|mp4|avi)/)
    })

    test('asks for a constrained schema', async () => {
      const { impl, calls } = fakeFetch('{"band":"allow","confidence":0.9,"reason":""}')
      await new OpenAiCompatibleReviewAssistant(config, impl).assessSuitability(suitability)

      expect(calls[0]!.body.response_format.type).toBe('json_schema')
      expect(calls[0]!.body.response_format.json_schema.strict).toBe(true)
    })

    test('tells the model when a band is already established', async () => {
      const { impl, calls } = fakeFetch('{"band":"block","confidence":0.9,"reason":""}')
      await new OpenAiCompatibleReviewAssistant(config, impl).assessSuitability({
        ...suitability,
        currentBand: 'review',
      })

      expect(calls[0]!.body.messages[1].content).toContain('never more permissive')
    })
  })

  describe('what it accepts back', () => {
    test('returns a verdict for a well-formed choice', async () => {
      const { impl } = fakeFetch('{"externalId":"1002","confidence":0.93,"reason":"subtitle"}')
      const outcome = await new OpenAiCompatibleReviewAssistant(config, impl).disambiguate(request)

      expect(outcome.status).toBe('accepted')
      if (outcome.status === 'accepted') expect(outcome.value.externalId).toBe('1002')
    })

    test('rejects an invented id rather than passing it on', async () => {
      // The validation boundary is applied inside the client, so no caller can
      // forget to apply it.
      const { impl } = fakeFetch('{"externalId":"9999","confidence":0.99,"reason":"sure"}')
      const outcome = await new OpenAiCompatibleReviewAssistant(config, impl).disambiguate(request)

      expect(outcome.status).toBe('rejected')
    })

    test('rejects prose without throwing', async () => {
      const { impl } = fakeFetch('I think it is the second one')
      const outcome = await new OpenAiCompatibleReviewAssistant(config, impl).disambiguate(request)

      expect(outcome.status).toBe('rejected')
    })

    test('rejects a suitability answer that loosens an established band', async () => {
      const { impl } = fakeFetch('{"band":"allow","confidence":0.99,"reason":"gentle"}')
      const outcome = await new OpenAiCompatibleReviewAssistant(config, impl).assessSuitability({
        ...suitability,
        currentBand: 'block',
      })

      expect(outcome.status).toBe('rejected')
    })

    test('asks nothing when there is nothing to choose between', async () => {
      const { impl, calls } = fakeFetch('{}')
      const outcome = await new OpenAiCompatibleReviewAssistant(config, impl).disambiguate({
        ...request,
        candidates: [],
      })

      expect(outcome.status).toBe('rejected')
      expect(calls).toHaveLength(0)
    })
  })

  describe('failures surface the way TMDB failures do', () => {
    const cases: [number, string, boolean][] = [
      [401, 'unauthorized', false],
      [404, 'not_found', false],
      [429, 'rate_limited', true],
      [500, 'upstream', true],
      [400, 'upstream', false],
    ]

    for (const [status, code, retryable] of cases) {
      test(`HTTP ${status} becomes ${code} (retryable: ${retryable})`, async () => {
        const { impl } = fakeFetch('', { status })
        try {
          await new OpenAiCompatibleReviewAssistant(config, impl).disambiguate(request)
          throw new Error('should have thrown')
        } catch (error) {
          expect(error).toBeInstanceOf(MetadataProviderError)
          const failure = error as MetadataProviderError
          expect(failure.code).toBe(code as never)
          expect(failure.retryable).toBe(retryable)
        }
      })
    }

    test('carries a retry-after through so a queue can honour it', async () => {
      const { impl } = fakeFetch('', { status: 429, headers: { 'retry-after': '30' } })
      try {
        await new OpenAiCompatibleReviewAssistant(config, impl).disambiguate(request)
        throw new Error('should have thrown')
      } catch (error) {
        expect((error as MetadataProviderError).retryAfterMs).toBe(30_000)
      }
    })

    test('a malformed envelope is invalid_response, not a crash', async () => {
      const impl: FetchLike = async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => 'not json at all',
      })
      try {
        await new OpenAiCompatibleReviewAssistant(config, impl).disambiguate(request)
        throw new Error('should have thrown')
      } catch (error) {
        expect((error as MetadataProviderError).code).toBe('invalid_response')
      }
    })

    test('refuses to call anything when unconfigured', async () => {
      const { impl, calls } = fakeFetch('{}')
      const assistant = new OpenAiCompatibleReviewAssistant(
        disabledReviewAssistantConfig(),
        impl
      )

      expect(assistant.configured).toBe(false)
      try {
        await assistant.disambiguate(request)
        throw new Error('should have thrown')
      } catch (error) {
        expect((error as MetadataProviderError).code).toBe('not_configured')
      }
      expect(calls).toHaveLength(0)
    })

    test('a slow provider times out as retryable rather than hanging', async () => {
      const impl: FetchLike = (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const abort = new Error('aborted')
            abort.name = 'AbortError'
            reject(abort)
          })
        })
      try {
        await new OpenAiCompatibleReviewAssistant(config, impl).disambiguate(request)
        throw new Error('should have thrown')
      } catch (error) {
        expect((error as MetadataProviderError).code).toBe('timeout')
        expect((error as MetadataProviderError).retryable).toBe(true)
      }
    })
  })
})
