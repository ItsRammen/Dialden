import { describe, expect, test } from 'bun:test'
import {
  MIN_MATCH_CONFIDENCE,
  parseDisambiguation,
  parseSuitability,
} from '../src/services/review/verdict'
import type {
  DisambiguationRequest,
  SuitabilityRequest,
} from '../src/services/review/types'

/**
 * These tests are the feature's safety case. The assistant talks to a hosted
 * model over the network; what makes that acceptable is not the prompt but the
 * fact that nothing it returns reaches the library without passing here.
 */

const request: DisambiguationRequest = {
  collectionId: 341,
  parsedTitle: '28 Years Later Part 2 The Bone Temple',
  year: 2026,
  mediaType: 'movie',
  candidates: [
    { externalId: '1001', title: '28 Years Later', year: 2025 },
    { externalId: '1002', title: '28 Years Later: The Bone Temple', year: 2026 },
  ],
}

const suitability: SuitabilityRequest = {
  collectionId: 341,
  title: 'The Iron Giant',
  year: 1999,
  genres: ['Animation', 'Family'],
  profileAge: 7,
}

describe('parseDisambiguation', () => {
  describe('the containment rule', () => {
    test('rejects an id that was never offered', () => {
      // The whole guarantee: a model cannot introduce an identifier. It picks
      // from the library's own candidates or it picks nothing.
      const outcome = parseDisambiguation(
        { externalId: '9999', confidence: 0.99, reason: 'confident' },
        request
      )

      expect(outcome.status).toBe('rejected')
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toContain('9999')
      }
    })

    test('accepts an id that was offered', () => {
      const outcome = parseDisambiguation(
        { externalId: '1002', confidence: 0.95, reason: 'subtitle matches' },
        request
      )

      expect(outcome.status).toBe('accepted')
      if (outcome.status === 'accepted') {
        expect(outcome.value.externalId).toBe('1002')
        expect(outcome.value.reason).toBe('subtitle matches')
      }
    })

    test('accepts a numeric id, since providers vary', () => {
      const outcome = parseDisambiguation(
        { externalId: 1002, confidence: 0.95, reason: '' },
        request
      )

      expect(outcome.status).toBe('accepted')
      if (outcome.status === 'accepted') expect(outcome.value.externalId).toBe('1002')
    })
  })

  describe('abstention', () => {
    test('treats a null id as no decision rather than an error', () => {
      const outcome = parseDisambiguation(
        { externalId: null, confidence: 0.2, reason: 'cannot tell them apart' },
        request
      )

      expect(outcome.status).toBe('accepted')
      if (outcome.status === 'accepted') expect(outcome.value.externalId).toBeNull()
    })

    test('discards a pick made without confidence', () => {
      // A model asked to choose between near-identical sequels will answer
      // something. Low confidence is how it says it had to guess.
      const outcome = parseDisambiguation(
        { externalId: '1001', confidence: MIN_MATCH_CONFIDENCE - 0.01, reason: 'maybe' },
        request
      )

      expect(outcome.status).toBe('accepted')
      if (outcome.status === 'accepted') expect(outcome.value.externalId).toBeNull()
    })

    test('keeps a pick at exactly the threshold', () => {
      const outcome = parseDisambiguation(
        { externalId: '1001', confidence: MIN_MATCH_CONFIDENCE, reason: 'ok' },
        request
      )

      expect(outcome.status).toBe('accepted')
      if (outcome.status === 'accepted') expect(outcome.value.externalId).toBe('1001')
    })
  })

  describe('malformed output is rejected, never thrown', () => {
    test('handles JSON text as well as objects', () => {
      const outcome = parseDisambiguation(
        '{"externalId":"1002","confidence":0.9,"reason":"ok"}',
        request
      )

      expect(outcome.status).toBe('accepted')
    })

    test('rejects prose, truncation and arrays without throwing', () => {
      for (const raw of ['I think it is the second one', '{"externalId":', '[]', '', null]) {
        const outcome = parseDisambiguation(raw, request)
        expect(outcome.status).toBe('rejected')
      }
    })

    test('rejects a confidence that is missing or out of range', () => {
      expect(parseDisambiguation({ externalId: '1001' }, request).status).toBe('rejected')
      expect(
        parseDisambiguation({ externalId: '1001', confidence: 4 }, request).status
      ).toBe('rejected')
      expect(
        parseDisambiguation({ externalId: '1001', confidence: -1 }, request).status
      ).toBe('rejected')
    })

    test('rejects a structurally wrong id', () => {
      expect(
        parseDisambiguation(
          { externalId: { id: '1001' }, confidence: 0.9 },
          request
        ).status
      ).toBe('rejected')
    })
  })
})

describe('parseSuitability', () => {
  test('accepts a band the profile defines', () => {
    const outcome = parseSuitability(
      { band: 'allow', confidence: 0.9, reason: 'animated family film' },
      suitability
    )

    expect(outcome.status).toBe('accepted')
    if (outcome.status === 'accepted') expect(outcome.value.band).toBe('allow')
  })

  test('normalises case and surrounding space', () => {
    const outcome = parseSuitability(
      { band: ' Block ', confidence: 0.8, reason: '' },
      suitability
    )

    expect(outcome.status).toBe('accepted')
    if (outcome.status === 'accepted') expect(outcome.value.band).toBe('block')
  })

  test('rejects a band that is not one of the three', () => {
    for (const band of ['maybe', 'allowed', '', 'ALLOW_WITH_CARE']) {
      expect(parseSuitability({ band, confidence: 0.9 }, suitability).status).toBe(
        'rejected'
      )
    }
  })

  describe('a proposal may tighten but never loosen', () => {
    test('rejects loosening an established block', () => {
      // A certification already ruled this out. No amount of model confidence
      // may talk the library back into showing it.
      const outcome = parseSuitability(
        { band: 'allow', confidence: 0.99, reason: 'seems gentle' },
        { ...suitability, currentBand: 'block' }
      )

      expect(outcome.status).toBe('rejected')
      if (outcome.status === 'rejected') expect(outcome.reason).toContain('permissive')
    })

    test('rejects loosening review to allow', () => {
      expect(
        parseSuitability(
          { band: 'allow', confidence: 0.99 },
          { ...suitability, currentBand: 'review' }
        ).status
      ).toBe('rejected')
    })

    test('permits tightening', () => {
      expect(
        parseSuitability(
          { band: 'block', confidence: 0.9 },
          { ...suitability, currentBand: 'allow' }
        ).status
      ).toBe('accepted')
    })

    test('permits agreeing', () => {
      expect(
        parseSuitability(
          { band: 'review', confidence: 0.9 },
          { ...suitability, currentBand: 'review' }
        ).status
      ).toBe('accepted')
    })
  })

  test('rejects malformed output without throwing', () => {
    for (const raw of ['not json', '[]', null, undefined]) {
      expect(parseSuitability(raw, suitability).status).toBe('rejected')
    }
  })
})
