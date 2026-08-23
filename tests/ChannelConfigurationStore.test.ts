import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LibraryChannelPolicy } from '../src/config/library'
import { ChannelConfigurationStore } from '../src/services/ChannelConfigurationStore'

const channel: LibraryChannelPolicy = {
  id: 'kids-club',
  name: 'Kids Club',
  enabled: true,
  timezone: 'Asia/Taipei',
  slots: [
    {
      days: ['mon'],
      start: '06:30',
      end: '08:30',
      groups: ['comfort'],
    },
  ],
}

describe('ChannelConfigurationStore', () => {
  test('uses policy defaults until an atomic appdata overlay is saved', () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-channels-'))
    try {
      const path = join(directory, 'channels.json')
      const store = new ChannelConfigurationStore(path, [channel])

      expect(store.load()).toEqual({ channels: [channel], manuallyOffAir: [] })
      store.save({ channels: [channel], manuallyOffAir: ['kids-club'] })

      expect(store.load()).toEqual({
        channels: [channel],
        manuallyOffAir: ['kids-club'],
      })
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
        version: 1,
        manuallyOffAir: ['kids-club'],
      })

      store.save({ channels: [channel], manuallyOffAir: [] })
      expect(store.load()).toEqual({ channels: [channel], manuallyOffAir: [] })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('rejects malformed persisted input instead of activating it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-channels-'))
    try {
      const path = join(directory, 'channels.json')
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          channels: [{ ...channel, timezone: 'Not/A_Timezone' }],
          manuallyOffAir: [],
        })
      )

      expect(() => new ChannelConfigurationStore(path).load()).toThrow(
        'invalid timezone'
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
