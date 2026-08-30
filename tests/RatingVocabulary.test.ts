import { describe, expect, test } from 'bun:test'
import { DEFAULT_KIDS_7_POLICY, evaluatePolicy } from '../src/policy/PolicyEngine'

function decide(certification: string) {
  return evaluatePolicy(DEFAULT_KIDS_7_POLICY, {
    matchStatus: 'matched',
    certification,
  })
}

describe('certifications from the regions we actually query', () => {
  test('British ratings are understood', () => {
    // BBFC U promises the same thing as the US G: suitable from age four.
    expect(decide('U').decision).toBe('allow')
    expect(decide('PG').decision).toBe('review')
    for (const band of ['12', '12A', '15', '18', 'R18']) {
      expect(decide(band).decision).toBe('block')
    }
  })

  test('Irish ratings are understood', () => {
    expect(decide('G').decision).toBe('allow')
    for (const band of ['12A', '15A', '16', '18']) {
      expect(decide(band).decision).toBe('block')
    }
  })

  test('Australian ratings are understood', () => {
    expect(decide('G').decision).toBe('allow')
    expect(decide('PG').decision).toBe('review')
    for (const band of ['M', 'MA15+', 'R18+', 'X18+']) {
      expect(decide(band).decision).toBe('block')
    }
    // TMDB carries these spaced as well; the library has an "R 18+".
    for (const band of ['MA 15+', 'R 18+', 'X 18+']) {
      expect(decide(band).decision).toBe('block')
    }
  })

  test('Canadian ratings are understood', () => {
    expect(decide('G').decision).toBe('allow')
    for (const band of ['14A', '18A', 'A', '13+', '16+', '18+']) {
      expect(decide(band).decision).toBe('block')
    }
  })

  test('American ratings are unchanged', () => {
    expect(decide('G').decision).toBe('allow')
    expect(decide('TV-Y7').decision).toBe('allow')
    expect(decide('PG').decision).toBe('review')
    for (const band of ['PG-13', 'TV-14', 'R', 'TV-MA', 'NC-17']) {
      expect(decide(band).decision).toBe('block')
    }
  })

  test('fantasy violence is a step above plain Y7', () => {
    expect(decide('TV-Y7').decision).toBe('allow')
    expect(decide('TV-Y7-FV').decision).toBe('review')
  })

  test('an unfamiliar band still goes to a parent, never to allow', () => {
    // The property that makes growing these lists safe.
    for (const band of ['RP13', 'FSK 12', '6', 'B15', 'SOMETHING ELSE']) {
      const outcome = decide(band)
      expect(outcome.decision).not.toBe('allow')
      expect(outcome.reason).toBe('rating_unrecognized')
    }
  })

  test('an absent rating is still absent, not blocked outright', () => {
    for (const band of ['', 'NR', 'NOT RATED', 'UNRATED', 'N/A']) {
      expect(decide(band).reason).toBe('rating_missing')
    }
  })

  test('spacing and dash styles do not change the answer', () => {
    expect(decide(' u ').decision).toBe('allow')
    expect(decide('pg').decision).toBe('review')
    expect(decide('PG – 13').decision).toBe('block')
    expect(decide('ma15+').decision).toBe('block')
  })

  test('no band is listed in two places at once', () => {
    const { allow, review, block } = DEFAULT_KIDS_7_POLICY.rules
    const all = [...allow, ...review, ...block]

    expect(new Set(all).size).toBe(all.length)
  })
})
