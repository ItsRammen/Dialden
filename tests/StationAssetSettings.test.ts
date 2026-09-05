import { describe, expect, test } from 'bun:test'
import { mock } from 'jest-mock-extended'
import type { IMediaRepository } from '../src/repositories/IMediaRepository'
import { ConfigRepository } from '../src/repositories/ConfigRepository'

describe('saved station asset access', () => {
  test('imports legacy access once, persists UI choices, and ignores the old flag thereafter', async () => {
    const store: Record<string, string> = {}
    const media = mock<IMediaRepository>()
    media.getAllSettings.mockImplementation(async () => ({ ...store }))
    media.setSetting.mockImplementation(async (key, value) => { store[key] = value })
    const first = new ConfigRepository('/missing.json', { TOASTTV_STATION_ASSETS_WRITABLE: 'true' })
    await first.initialize(media)
    expect((await first.get()).library.stationAssetsWritable).toBe(true)
    await first.update({ library: { stationAssetsWritable: false } })
    const restarted = new ConfigRepository('/missing.json', { TOASTTV_STATION_ASSETS_WRITABLE: 'true' })
    await restarted.initialize(media)
    expect((await restarted.get()).library.stationAssetsWritable).toBe(false)
    await restarted.update({ library: { stationAssetsWritable: true } })
    expect((await restarted.get()).library.stationAssetsWritable).toBe(true)
  })

  test('new installations start disabled with no deployment flag required', async () => {
    const store: Record<string, string> = {}
    const media = mock<IMediaRepository>()
    media.getAllSettings.mockImplementation(async () => ({ ...store }))
    media.setSetting.mockImplementation(async (key, value) => { store[key] = value })
    const config = new ConfigRepository('/missing.json', {})
    await config.initialize(media)
    expect((await config.get()).library.stationAssetsWritable).toBe(false)
  })
})
