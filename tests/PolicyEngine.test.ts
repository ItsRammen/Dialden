import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_KIDS_7_POLICY,
  evaluatePolicy,
  resolveEffectiveDecision,
  type RatingPolicyProfile,
} from '../src/policy/PolicyEngine'

describe('PolicyEngine', () => {
  test.each(['G', 'TV-Y', 'TV-Y7', 'TV-G'])(
    'automatically allows configured safe rating %s',
    (certification) => {
      expect(
        evaluatePolicy(DEFAULT_KIDS_7_POLICY, {
          matchStatus: 'matched',
          certification,
        })
      ).toEqual({
        decision: 'allow',
        reason: 'rating_allowed',
        certification,
      })
    }
  )

  test.each(['PG', 'TV-PG', 'Unknown', 'Unrated', 'NR'])(
    'sends borderline or missing rating %s to review',
    (certification) => {
      expect(
        evaluatePolicy(DEFAULT_KIDS_7_POLICY, {
          matchStatus: 'matched',
          certification,
        }).decision
      ).toBe('review')
    }
  )

  test.each(['PG-13', 'TV-14', 'R', 'TV-MA', 'NC-17'])(
    'blocks configured unsuitable rating %s',
    (certification) => {
      expect(
        evaluatePolicy(DEFAULT_KIDS_7_POLICY, {
          matchStatus: 'matched',
          certification,
        })
      ).toEqual({
        decision: 'block',
        reason: 'rating_blocked',
        certification,
      })
    }
  )

  test('unrecognized ratings never inherit an allow default', () => {
    expect(
      evaluatePolicy(DEFAULT_KIDS_7_POLICY, {
        matchStatus: 'matched',
        certification: 'TV-SOMETHING-NEW',
      })
    ).toEqual({
      decision: 'review',
      reason: 'rating_unrecognized',
      certification: 'TV-SOMETHING-NEW',
    })
  })

  test.each(['pending', 'ambiguous', 'unmatched', 'error'] as const)(
    'metadata state %s fails closed even with a safe rating',
    (matchStatus) => {
      expect(
        evaluatePolicy(DEFAULT_KIDS_7_POLICY, {
          matchStatus,
          certification: 'TV-Y',
        }).decision
      ).toBe('review')
    }
  )

  test('missing and invalid policy or metadata never allow', () => {
    expect(
      evaluatePolicy(null, { matchStatus: 'matched', certification: 'TV-Y' })
        .decision
    ).toBe('review')
    expect(evaluatePolicy(DEFAULT_KIDS_7_POLICY, null).decision).toBe('review')

    const invalidPolicy = {
      ...DEFAULT_KIDS_7_POLICY,
      rules: {
        allow: ['TV-Y'],
        review: [],
        block: ['TV-Y'],
      },
    } as RatingPolicyProfile
    expect(
      evaluatePolicy(invalidPolicy, {
        matchStatus: 'matched',
        certification: 'TV-Y',
      })
    ).toEqual({
      decision: 'review',
      reason: 'policy_invalid',
      certification: null,
    })
  })

  test('supports configurable profiles without implicit ratings', () => {
    const custom: RatingPolicyProfile = {
      id: 'custom',
      name: 'Custom',
      rules: { allow: ['PG'], review: ['G'], block: ['R'] },
    }

    expect(
      evaluatePolicy(custom, {
        matchStatus: 'manual',
        certification: 'pg',
      }).decision
    ).toBe('allow')
    expect(
      evaluatePolicy(custom, {
        matchStatus: 'matched',
        certification: 'TV-Y',
      }).decision
    ).toBe('review')
  })

  test('parent overrides take precedence in both directions', () => {
    expect(resolveEffectiveDecision('block', 'allow')).toEqual({
      decision: 'allow',
      source: 'parent_override',
    })
    expect(resolveEffectiveDecision('allow', 'block')).toEqual({
      decision: 'block',
      source: 'parent_override',
    })
    expect(resolveEffectiveDecision('review', null)).toEqual({
      decision: 'review',
      source: 'policy',
    })
    expect(resolveEffectiveDecision(undefined, null)).toEqual({
      decision: 'review',
      source: 'fail_closed',
    })
  })
})
