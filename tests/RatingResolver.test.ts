import { describe, expect, test } from 'bun:test'
import { resolveCertification } from '../src/services/metadata/RatingResolver'

describe('metadata rating region resolution', () => {
  test('selects the preferred region and preserves all raw ratings', () => {
    const result = resolveCertification(
      [
        { region: 'US', certification: 'PG', releaseType: 3 },
        { region: 'GB', certification: 'U', releaseType: 3 },
      ],
      ['US', 'GB']
    )

    expect(result.status).toBe('resolved')
    expect(result.selected).toEqual({
      region: 'US',
      certification: 'PG',
      releaseType: 3,
    })
    expect(result.all).toHaveLength(2)
  })

  test('falls back only when the preferred region has no rating', () => {
    const result = resolveCertification(
      [{ region: 'GB', certification: 'U' }],
      ['TW', 'GB']
    )

    expect(result.status).toBe('resolved')
    expect(result.selected?.region).toBe('GB')
  })

  test('fails closed on conflicting certifications in the selected region', () => {
    const result = resolveCertification(
      [
        { region: 'US', certification: 'PG', releaseType: 3 },
        { region: 'US', certification: 'PG-13', releaseType: 4 },
        { region: 'GB', certification: 'U' },
      ],
      ['US', 'GB']
    )

    expect(result.status).toBe('ambiguous')
    expect(result.selected).toBeNull()
  })

  test('treats duplicate spellings of one certification as one value', () => {
    const result = resolveCertification(
      [
        { region: 'us', certification: ' pg ', releaseType: 4 },
        { region: 'US', certification: 'PG', releaseType: 3 },
      ],
      ['us']
    )

    expect(result.status).toBe('resolved')
    expect(result.selected?.releaseType).toBe(3)
  })

  test('returns missing for empty, invalid, or unconfigured regions', () => {
    const result = resolveCertification(
      [
        { region: 'USA', certification: 'PG' },
        { region: 'US', certification: '   ' },
      ],
      ['US']
    )

    expect(result).toEqual({ status: 'missing', selected: null, all: [] })
  })
})
