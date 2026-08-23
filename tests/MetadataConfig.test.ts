import { describe, expect, test } from 'bun:test'
import {
  METADATA_CONFIG_SETTING_KEY,
  MetadataConfigValidationError,
  loadMetadataConfig,
  loadPersistedMetadataConfig,
  persistMetadataConfig,
  resolveMetadataConfigUpdate,
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

  test('saved SQLite settings override environment bootstrap defaults', async () => {
    const saved = {
      version: 1,
      tmdbApiKey: 'saved-secret-value-1234567890',
      language: 'zh-TW',
      preferredRatingRegion: 'TW',
      fallbackRatingRegions: ['US', 'GB'],
      requestTimeoutMs: 4500,
    }
    const repository = {
      async getSetting(key: string) {
        expect(key).toBe(METADATA_CONFIG_SETTING_KEY)
        return JSON.stringify(saved)
      },
    }

    await expect(
      loadPersistedMetadataConfig(repository, {
        TMDB_API_KEY: 'environment-secret-value',
        TMDB_LANGUAGE: 'en-US',
        RATING_REGION: 'US',
      })
    ).resolves.toEqual({
      tmdbApiKey: saved.tmdbApiKey,
      language: 'zh-TW',
      preferredRatingRegion: 'TW',
      fallbackRatingRegions: ['US', 'GB'],
      requestTimeoutMs: 4500,
    })
  })

  test('uses environment bootstrap values only when no appdata setting exists', async () => {
    const repository = {
      async getSetting() {
        return null
      },
    }

    await expect(
      loadPersistedMetadataConfig(repository, {
        TMDB_API_KEY: 'environment-secret-value',
        TMDB_LANGUAGE: 'ja-JP',
      })
    ).resolves.toMatchObject({
      tmdbApiKey: 'environment-secret-value',
      language: 'ja-JP',
    })
  })

  test('disables metadata and reports a redacted diagnostic for corrupt appdata', async () => {
    const storedSecret = 'do-not-log-this-secret'
    const repository = {
      async getSetting() {
        return `{"tmdbApiKey":"${storedSecret}"`
      },
    }
    const diagnostics: string[] = []

    const config = await loadPersistedMetadataConfig(
      repository,
      {
        TMDB_API_KEY: 'environment-secret-value',
        TMDB_LANGUAGE: 'ja-JP',
      },
      (message) => diagnostics.push(message)
    )

    expect(config).toEqual({
      tmdbApiKey: null,
      language: 'en-US',
      preferredRatingRegion: 'US',
      fallbackRatingRegions: [],
      requestTimeoutMs: 10_000,
    })
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toContain('metadata is disabled')
    expect(JSON.stringify(diagnostics)).not.toContain(storedSecret)
    expect(JSON.stringify(diagnostics)).not.toContain('environment-secret-value')
  })

  test('treats an unsupported stored version as authoritative and disabled', async () => {
    const diagnostics: string[] = []
    const repository = {
      async getSetting() {
        return JSON.stringify({
          version: 2,
          tmdbApiKey: 'future-saved-secret-value',
        })
      },
    }

    await expect(
      loadPersistedMetadataConfig(
        repository,
        { TMDB_API_KEY: 'environment-secret-value' },
        (message) => diagnostics.push(message)
      )
    ).resolves.toMatchObject({ tmdbApiKey: null })
    expect(diagnostics).toHaveLength(1)
    expect(JSON.stringify(diagnostics)).not.toContain('future-saved-secret-value')
  })

  test('a saved API-key removal is not repopulated from the environment', async () => {
    const repository = {
      async getSetting() {
        return JSON.stringify({
          version: 1,
          tmdbApiKey: null,
          language: 'zh-TW',
          preferredRatingRegion: 'TW',
          fallbackRatingRegions: ['US'],
          requestTimeoutMs: 4500,
        })
      },
    }

    await expect(
      loadPersistedMetadataConfig(repository, {
        TMDB_API_KEY: 'environment-secret-must-stay-disabled',
        TMDB_LANGUAGE: 'en-US',
      })
    ).resolves.toEqual({
      tmdbApiKey: null,
      language: 'zh-TW',
      preferredRatingRegion: 'TW',
      fallbackRatingRegions: ['US'],
      requestTimeoutMs: 4500,
    })
  })

  test('persists one complete versioned appdata setting', async () => {
    const writes: Array<[string, string]> = []
    await persistMetadataConfig(
      {
        async setSetting(key, value) {
          writes.push([key, value])
        },
      },
      {
        tmdbApiKey: 'persisted-secret-value-123456',
        language: 'en-GB',
        preferredRatingRegion: 'GB',
        fallbackRatingRegions: ['US'],
        requestTimeoutMs: 6000,
      }
    )

    expect(writes).toHaveLength(1)
    expect(writes[0]?.[0]).toBe(METADATA_CONFIG_SETTING_KEY)
    expect(JSON.parse(writes[0]?.[1] ?? '{}')).toEqual({
      version: 1,
      tmdbApiKey: 'persisted-secret-value-123456',
      language: 'en-GB',
      preferredRatingRegion: 'GB',
      fallbackRatingRegions: ['US'],
      requestTimeoutMs: 6000,
    })
  })

  test('blank key preserves the secret while editable fields are normalized', () => {
    const updated = resolveMetadataConfigUpdate(
      {
        tmdbApiKey: 'existing-secret-value-123456',
        language: 'en-US',
        preferredRatingRegion: 'US',
        fallbackRatingRegions: [],
        requestTimeoutMs: 10_000,
      },
      {
        tmdbApiKey: '   ',
        language: 'zh-tw',
        preferredRatingRegion: 'tw',
        fallbackRatingRegions: ' us, TW, gb, us ',
        requestTimeoutMs: '2500',
      }
    )

    expect(updated).toEqual({
      tmdbApiKey: 'existing-secret-value-123456',
      language: 'zh-TW',
      preferredRatingRegion: 'TW',
      fallbackRatingRegions: ['US', 'GB'],
      requestTimeoutMs: 2500,
    })
  })

  test('validates form fields without including the submitted secret in errors', () => {
    const submittedSecret = 'bad secret that must not be reflected'
    try {
      resolveMetadataConfigUpdate(loadMetadataConfig({}), {
        tmdbApiKey: submittedSecret,
        language: 'not_a_locale',
        preferredRatingRegion: 'United States',
        fallbackRatingRegions: 'US, invalid',
        requestTimeoutMs: '1',
      })
      throw new Error('Expected validation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(MetadataConfigValidationError)
      expect(JSON.stringify(error)).not.toContain(submittedSecret)
      expect(
        Object.keys((error as MetadataConfigValidationError).fieldErrors)
      ).toEqual([
        'tmdbApiKey',
        'language',
        'preferredRatingRegion',
        'fallbackRatingRegions',
        'requestTimeoutMs',
      ])
    }
  })
})
