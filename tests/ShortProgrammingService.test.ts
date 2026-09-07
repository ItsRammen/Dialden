import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChannelConfigurationStore } from '../src/services/ChannelConfigurationStore'
import { expect, test } from 'bun:test'
import { selectBlockShorts } from '../src/services/ShortProgrammingService'
import { validateLibraryChannels } from '../src/config/library'
import type { MediaItem } from '../src/types'
const item = (id: number, durationSeconds: number) => ({ id, durationSeconds } as MediaItem)
test('finds two full shorts that fit with handovers, instead of one longer short', () => {
  const selected = selectBlockShorts([item(1, 600), item(2, 420), item(3, 420)], 853, 600, 2, 5)
  expect(selected.map((i) => i.id)).toEqual([2, 3])
  expect(selected.reduce((n, i) => n + i.durationSeconds + 5, 0)).toBeLessThanOrEqual(853)
})
test('rejects oversized and fractional overrun files, deduplicates, and respects count', () => {
  expect(selectBlockShorts([item(1, 420.1)], 425, 600, 2, 5)).toEqual([])
  expect(selectBlockShorts([item(1, 601)], 900, 600, 2, 5)).toEqual([])
  expect(selectBlockShorts([item(1, 100), item(1, 100), item(2, 100)], 900, 600, 1, 5)).toHaveLength(1)
  expect(selectBlockShorts([], 900, 600, 2, 5)).toEqual([])
})
test('validates and retains durable shorts configuration', () => {
  const channel = { id: 'nick', name: 'Nick', timezone: 'UTC', slots: [], shorts: { enabled: true, groups: [], collections: ['["tv","tv","random-cartoons"]'], maximumDurationSeconds: 600, maximumPerBlock: 2 } }
  expect(validateLibraryChannels([channel])[0]!.shorts).toEqual(channel.shorts)
  expect(() => validateLibraryChannels([{ ...channel, shorts: { ...channel.shorts, maximumPerBlock: 99 } }])).toThrow()
  expect(() => validateLibraryChannels([{ ...channel, shorts: { ...channel.shorts, collections: [] } }])).toThrow()
})

test('shorts collection selections survive a configuration save and reload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shorts-config-'))
  try {
    const channel = validateLibraryChannels([{ id: 'nick', name: 'Nick', timezone: 'UTC', slots: [], shorts: { enabled: true, groups: [], collections: ['["tv","tv","random-cartoons"]'] } }])[0]!
    const store = new ChannelConfigurationStore(join(dir, 'channels.json'))
    store.save({ channels: [channel], manuallyOffAir: [], collectionGroups: [] })
    expect(new ChannelConfigurationStore(join(dir, 'channels.json')).load().channels[0]!.shorts).toEqual(channel.shorts)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
