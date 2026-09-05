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
    expect(result.transcodingMode).toBe('software')
    expect(result.qsvDevice).toBe('/dev/dri/renderD128')
  })

  test('reads valid process-level overrides', () => {
    const result = loadRuntimeConfig({
      PORT: '8080',
      TOASTTV_HOST: '127.0.0.1',
      TOASTTV_CONFIG: '/app/data/config.json',
      TOASTTV_HEADLESS: 'yes',
      TOASTTV_MEDIA_READ_ONLY: 'on',
      TOASTTV_STATION_ASSETS_WRITABLE: 'true',
      TOASTTV_TRANSCODING_MODE: 'intel-qsv',
      TOASTTV_QSV_DEVICE: '/dev/dri/renderD129',
    })

    expect(result.port).toBe(8080)
    expect(result.hostname).toBe('127.0.0.1')
    expect(result.configPath).toBe('/app/data/config.json')
    expect(result.headless).toBe(true)
    expect(result.mediaReadOnly).toBe(true)
    expect(result.transcodingMode).toBe('intel-qsv')
    expect(result.qsvDevice).toBe('/dev/dri/renderD129')
  })

  test('rejects an invalid port and false-like headless value', () => {
    const result = loadRuntimeConfig({
      PORT: '70000',
      TOASTTV_HEADLESS: 'false',
      TOASTTV_TRANSCODING_MODE: 'not-an-encoder',
    })

    expect(result.port).toBe(1993)
    expect(result.headless).toBe(false)
    expect(result.transcodingMode).toBe('software')
  })

  test('keeps programme read-only access independent of station asset settings', () => {
    const result = loadRuntimeConfig({ TOASTTV_MEDIA_READ_ONLY: 'true' })
    expect(result.mediaReadOnly).toBe(true)
    expect(result).not.toHaveProperty('stationAssetsWritable')

  })

  test('accepts automatic hardware probing without changing the device default', () => {
    const result = loadRuntimeConfig({ TOASTTV_TRANSCODING_MODE: ' AUTO ' })

    expect(result.transcodingMode).toBe('auto')
    expect(result.qsvDevice).toBe('/dev/dri/renderD128')
  })
})
