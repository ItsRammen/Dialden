import { describe, expect, test } from 'bun:test'
import { loadRuntimeConfig } from '../src/config/runtime'

describe('loadRuntimeConfig', () => {
  test('returns container-safe defaults', () => {
    const result = loadRuntimeConfig({})

    expect(result.port).toBe(1993)
    expect(result.hostname).toBe('0.0.0.0')
    expect(result.configPath).toBe('./data/config.json')
    expect(result.headless).toBe(false)
    expect(result.mediaReadOnly).toBe(false)
  })

  test('reads valid process-level overrides', () => {
    const result = loadRuntimeConfig({
      PORT: '8080',
      TOASTTV_HOST: '127.0.0.1',
      TOASTTV_CONFIG: '/app/data/config.json',
      TOASTTV_HEADLESS: 'yes',
      TOASTTV_MEDIA_READ_ONLY: 'on',
    })

    expect(result.port).toBe(8080)
    expect(result.hostname).toBe('127.0.0.1')
    expect(result.configPath).toBe('/app/data/config.json')
    expect(result.headless).toBe(true)
    expect(result.mediaReadOnly).toBe(true)
  })

  test('rejects an invalid port and false-like headless value', () => {
    const result = loadRuntimeConfig({
      PORT: '70000',
      TOASTTV_HEADLESS: 'false',
    })

    expect(result.port).toBe(1993)
    expect(result.headless).toBe(false)
  })
})
