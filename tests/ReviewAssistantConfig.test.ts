import { describe, expect, test } from 'bun:test'
import {
  disabledReviewAssistantConfig,
  loadPersistedReviewAssistantConfig,
  loadReviewAssistantConfig,
  parseStoredReviewAssistantConfig,
  REVIEW_ASSISTANT_CONFIG_SETTING_KEY,
  toPublicReviewAssistantConfig,
} from '../src/config/reviewAssistant'
import { DEFAULT_AUTO_DECISION_POLICY } from '../src/services/review/autoDecision'

function store(value: string | null) {
  return {
    getSetting: async (key: string) =>
      key === REVIEW_ASSISTANT_CONFIG_SETTING_KEY ? value : null,
  }
}

describe('review assistant configuration', () => {
  describe('the assistant is optional', () => {
    test('is off when no credentials are supplied', () => {
      // The deterministic layer must keep working with nothing configured.
      const config = loadReviewAssistantConfig({})

      expect(config.enabled).toBe(false)
      expect(config.apiKey).toBeNull()
      expect(config.decisionPolicy).toEqual(DEFAULT_AUTO_DECISION_POLICY)
    })

    test('stays off with a key but no endpoint, and vice versa', () => {
      expect(loadReviewAssistantConfig({ REVIEW_ASSISTANT_API_KEY: 'k' }).enabled).toBe(false)
      expect(
        loadReviewAssistantConfig({ REVIEW_ASSISTANT_BASE_URL: 'https://api.example' })
          .enabled
      ).toBe(false)
    })

    test('turns on once both are present', () => {
      const config = loadReviewAssistantConfig({
        REVIEW_ASSISTANT_API_KEY: 'k',
        REVIEW_ASSISTANT_BASE_URL: 'https://api.example/v1',
        REVIEW_ASSISTANT_MODEL: 'some-model',
      })

      expect(config.enabled).toBe(true)
      expect(config.model).toBe('some-model')
    })
  })

  describe('base URL handling', () => {
    test('tolerates a trailing slash and an appended completions path', () => {
      for (const raw of [
        'https://api.example/v1',
        'https://api.example/v1/',
        'https://api.example/v1/chat/completions',
      ]) {
        const config = loadReviewAssistantConfig({
          REVIEW_ASSISTANT_API_KEY: 'k',
          REVIEW_ASSISTANT_BASE_URL: raw,
        })
        expect(config.baseUrl).toBe('https://api.example/v1')
      }
    })

    test('refuses a stored URL that is not http or https', () => {
      const stored = parseStoredReviewAssistantConfig({
        version: 1,
        baseUrl: 'file:///etc/passwd',
        apiKey: 'k',
      })

      expect(stored).toBeNull()
    })
  })

  describe('stored settings fail closed', () => {
    test('falls back to the environment when nothing is stored', async () => {
      const config = await loadPersistedReviewAssistantConfig(store(null), {
        REVIEW_ASSISTANT_API_KEY: 'k',
        REVIEW_ASSISTANT_BASE_URL: 'https://api.example/v1',
      })

      expect(config.enabled).toBe(true)
    })

    test('disables the assistant on invalid stored settings rather than reviving env', async () => {
      // An administrator who removed a key must not have it resurrected by a
      // stale row, so a corrupt value disables rather than falls back.
      const messages: string[] = []
      const config = await loadPersistedReviewAssistantConfig(
        store('{ not json'),
        { REVIEW_ASSISTANT_API_KEY: 'k', REVIEW_ASSISTANT_BASE_URL: 'https://api.example/v1' },
        (message) => messages.push(message)
      )

      expect(config.enabled).toBe(false)
      expect(config.apiKey).toBeNull()
      expect(messages).toHaveLength(1)
    })

    test('rejects an unknown settings version', () => {
      expect(parseStoredReviewAssistantConfig({ version: 2, baseUrl: '' })).toBeNull()
    })

    test('rejects an unrecognised treatment rather than guessing', () => {
      const stored = parseStoredReviewAssistantConfig({
        version: 1,
        baseUrl: 'https://api.example/v1',
        apiKey: 'k',
        decisionPolicy: { ...DEFAULT_AUTO_DECISION_POLICY, reviewBand: 'sometimes' },
      })

      expect(stored).toBeNull()
    })

    test('accepts a policy that omits keys, keeping the defaults', () => {
      const stored = parseStoredReviewAssistantConfig({
        version: 1,
        baseUrl: 'https://api.example/v1',
        apiKey: 'k',
        enabled: true,
        decisionPolicy: { reviewBand: 'approve' },
      })

      expect(stored?.decisionPolicy.reviewBand).toBe('approve')
      expect(stored?.decisionPolicy.missingRating).toBe(
        DEFAULT_AUTO_DECISION_POLICY.missingRating
      )
    })
  })

  describe('bounds', () => {
    test('clamps nonsense timeouts, concurrency and budget to safe defaults', () => {
      const config = loadReviewAssistantConfig({
        REVIEW_ASSISTANT_API_KEY: 'k',
        REVIEW_ASSISTANT_BASE_URL: 'https://api.example/v1',
        REVIEW_ASSISTANT_TIMEOUT_MS: '0',
        REVIEW_ASSISTANT_CONCURRENCY: '9999',
        REVIEW_ASSISTANT_CALL_BUDGET: 'lots',
      })

      expect(config.requestTimeoutMs).toBe(30_000)
      expect(config.maxConcurrency).toBe(2)
      expect(config.callBudget).toBe(250)
    })
  })

  test('the public view never carries the API key', () => {
    // This object is serialised into HTTP responses.
    const config = loadReviewAssistantConfig({
      REVIEW_ASSISTANT_API_KEY: 'super-secret',
      REVIEW_ASSISTANT_BASE_URL: 'https://api.example/v1',
    })
    const publicView = toPublicReviewAssistantConfig(config)

    expect(JSON.stringify(publicView)).not.toContain('super-secret')
    expect(publicView.configured).toBe(true)
  })

  test('a disabled config still carries the deterministic policy table', () => {
    const config = disabledReviewAssistantConfig({
      ...DEFAULT_AUTO_DECISION_POLICY,
      reviewBand: 'approve',
    })

    expect(config.enabled).toBe(false)
    expect(config.decisionPolicy.reviewBand).toBe('approve')
  })
})
