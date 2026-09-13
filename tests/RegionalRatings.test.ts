import { describe, expect, test } from 'bun:test'
import { DEFAULT_KIDS_7_POLICY, evaluatePolicy, resolveEffectiveDecision } from '../src/policy/PolicyEngine'
import { resolveCertification } from '../src/services/metadata/RatingResolver'
const decide = (region: string, rating: string) => evaluatePolicy(DEFAULT_KIDS_7_POLICY, {
  matchStatus: 'matched', certificationRegion: region, certification: rating,
})
describe('approved Kids 7 regional ratings', () => {
  const bands = {
    JP: { allow: ['G'], review: ['PG12'], block: ['R15+', 'R18+'] },
    KR: { allow: ['ALL'], review: [], block: ['12', '15', '18', '19'] },
    HK: { allow: ['I'], review: [], block: ['II', 'IIA', 'IIB', 'III'] },
    TW: { allow: ['0+'], review: ['6+'], block: ['12+', '15+', '18+'] },
    DE: { allow: ['0', '6'], review: [], block: ['12', '16', '18'] },
    FR: { allow: ['U', 'TOUS PUBLICS'], review: [], block: ['12', '16', '18'] },
  }
  for (const [region, rules] of Object.entries(bands)) {
    for (const [decision, ratings] of Object.entries(rules)) {
      for (const rating of ratings) test(`${region} ${rating}: ${decision}`, () => {
        expect(decide(region, rating)).toMatchObject({ decision, certification: rating })
      })
    }
  }
  test('does not guess foreign labels or apply these defaults to custom profiles', () => {
    expect(decide('JP', 'U').decision).toBe('review')
    expect(decide('KR', 'G').decision).toBe('review')
    expect(decide('TW', '6').decision).toBe('review')
    expect(evaluatePolicy({ ...DEFAULT_KIDS_7_POLICY, id: 'custom' }, {
      matchStatus: 'matched', certification: 'ALL', certificationRegion: 'KR',
    }).decision).toBe('review')
  })
  test('manual approvals and blocks still win', () => {
    expect(resolveEffectiveDecision(decide('KR', 'ALL').decision, 'block').decision).toBe('block')
    expect(resolveEffectiveDecision(decide('KR', '15').decision, 'allow').decision).toBe('allow')
  })
  test('configured regions win, then Western regions, then regional fallback', () => {
    const ratings = [{ region: 'KR', certification: 'ALL' }, { region: 'AU', certification: 'PG' }]
    expect(resolveCertification(ratings, ['KR']).selected?.region).toBe('KR')
    expect(resolveCertification(ratings, ['US']).selected?.region).toBe('AU')
    expect(resolveCertification(ratings.slice(0, 1), ['US']).selected?.region).toBe('KR')
  })
  test('never hides a conflict behind a more permissive fallback', () => {
    expect(resolveCertification([{ region: 'US', certification: 'R' },
      { region: 'US', certification: 'NC-17' }, { region: 'KR', certification: 'ALL' }], ['US']).status).toBe('ambiguous')
  })
  test('unsupported and unknown ratings cannot silently approve', () => {
    expect(resolveCertification([{ region: 'ZZ', certification: 'G' }], ['US']).status).toBe('missing')
    expect(decide('KR', 'UNKNOWN BAND').decision).toBe('review')
  })
})
