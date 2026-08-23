import { describe, expect, test } from 'bun:test'
import {
  loadMetadataConfig,
  toPublicMetadataConfig,
} from '../src/config/metadata'

describe('metadata runtime configuration', () => {
  test('uses safe optional-provider defaults', () => {
    expect(loadMetadataConfig({})).toEqual({
      tmdbApiKey: null,
      language: 'en-US',
      preferredRatingRegion: 'US',
      fallbackRatingRegions: [],
      requestTimeoutMs: 10_000,
    })
  })

  test('normalizes key, language, region, fallbacks, and timeout', () => {
    expect(
      loadMetadataConfig({
        TMDB_API_KEY: '  secret-value  ',
        TMDB_LANGUAGE: 'zh-tw',
        RATING_REGION: 'tw',
        RATING_FALLBACK_REGIONS: ' US, gb,tw,US,invalid ',
        TMDB_REQUEST_TIMEOUT_MS: '2500',
      })
    ).toEqual({
      tmdbApiKey: 'secret-value',
      language: 'zh-TW',
      preferredRatingRegion: 'TW',
      fallbackRatingRegions: ['US', 'GB'],
      requestTimeoutMs: 2500,
    })
  })

  test('rejects invalid non-secret values without failing startup', () => {
    const config = loadMetadataConfig({
      TMDB_API_KEY: '   ',
      TMDB_LANGUAGE: 'not_a_locale',
      RATING_REGION: 'United States',
      TMDB_REQUEST_TIMEOUT_MS: '2',
    })

    expect(config.tmdbApiKey).toBeNull()
    expect(config.language).toBe('en-US')
    expect(config.preferredRatingRegion).toBe('US')
    expect(config.requestTimeoutMs).toBe(10_000)
  })

  test('constructs an explicitly redacted public shape', () => {
    const publicConfig = toPublicMetadataConfig(
      loadMetadataConfig({ TMDB_API_KEY: 'never-return-this' })
    )

    expect(publicConfig.configured).toBe(true)
    expect(publicConfig).not.toHaveProperty('tmdbApiKey')
    expect(JSON.stringify(publicConfig)).not.toContain('never-return-this')
  })
})
