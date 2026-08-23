import { describe, expect, test } from 'bun:test'
import { resolveEffectiveDecision } from '../src/policy/PolicyEngine'
import {
  evaluateSchedulingEligibility,
  isSchedulingEligible,
  type SchedulingEligibilityFacts,
} from '../src/policy/eligibility'

const eligible: SchedulingEligibilityFacts = {
  rootAvailable: true,
  mediaType: 'video',
  isInterlude: false,
  durationSeconds: 420,
  effectiveDecision: 'allow',
}

describe('scheduling eligibility', () => {
  test('requires every positive eligibility fact', () => {
    expect(isSchedulingEligible(eligible)).toBe(true)
    expect(evaluateSchedulingEligibility(eligible)).toEqual({
      eligible: true,
      reason: null,
    })
  })

  test.each([
    [{ rootAvailable: false }, 'root_unavailable'],
    [{ rootAvailable: undefined }, 'root_unavailable'],
    [{ mediaType: 'intro' }, 'not_video'],
    [{ mediaType: undefined }, 'not_video'],
    [{ isInterlude: true }, 'interlude'],
    [{ isInterlude: undefined }, 'interlude'],
    [{ durationSeconds: 0 }, 'invalid_duration'],
    [{ durationSeconds: Number.NaN }, 'invalid_duration'],
    [{ durationSeconds: Number.POSITIVE_INFINITY }, 'invalid_duration'],
    [{ effectiveDecision: 'review' }, 'decision_not_allow'],
    [{ effectiveDecision: 'block' }, 'decision_not_allow'],
    [{ effectiveDecision: undefined }, 'decision_not_allow'],
  ] as const)('fails closed for %#', (override, reason) => {
    expect(evaluateSchedulingEligibility({ ...eligible, ...override })).toEqual({
      eligible: false,
      reason,
    })
  })

  test('uses the resolved parent-over-policy decision', () => {
    const parentAllowed = resolveEffectiveDecision('block', 'allow')
    const parentBlocked = resolveEffectiveDecision('allow', 'block')

    expect(
      isSchedulingEligible({
        ...eligible,
        effectiveDecision: parentAllowed.decision,
      })
    ).toBe(true)
    expect(
      isSchedulingEligible({
        ...eligible,
        effectiveDecision: parentBlocked.decision,
      })
    ).toBe(false)
  })
})
