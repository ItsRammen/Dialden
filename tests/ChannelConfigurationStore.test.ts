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

      expect(store.load()).toEqual({
        channels: [channel],
        manuallyOffAir: [],
        collectionGroups: [],
      })
      store.save({ channels: [channel], manuallyOffAir: ['kids-club'] })

      expect(store.load()).toEqual({
        channels: [channel],
        manuallyOffAir: ['kids-club'],
        collectionGroups: [],
      })
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
        version: 1,
        manuallyOffAir: ['kids-club'],
      })

      store.save({ channels: [channel], manuallyOffAir: [] })
      expect(store.load()).toEqual({
        channels: [channel],
        manuallyOffAir: [],
        collectionGroups: [],
      })
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

  test('persists validated per-channel branding while old channels still inherit', () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-channel-branding-'))
    try {
      const store = new ChannelConfigurationStore(join(directory, 'channels.json'))
      const branded = {
        ...channel,
        branding: {
          mode: 'custom' as const,
          burnIn: true,
          opacity: 210,
          position: 2 as const,
          x: 24,
          y: 24,
          sizePercent: 12,
        },
      }
      store.save({ channels: [branded], manuallyOffAir: [] })
      expect(store.load().channels[0]?.branding).toEqual(branded.branding)

      store.save({
        channels: [
          {
            ...branded,
            branding: { ...branded.branding, burnIn: false },
          },
        ],
        manuallyOffAir: [],
      })
      expect(store.load().channels[0]?.branding).not.toHaveProperty('burnIn')

      expect(() =>
        store.save({
          channels: [
            {
              ...branded,
              branding: { ...branded.branding, sizePercent: 80 },
            },
          ],
          manuallyOffAir: [],
        })
      ).toThrow('branding size')

      expect(() =>
        store.save({
          channels: [
            {
              ...branded,
              branding: {
                ...branded.branding,
                burnIn: 'yes' as unknown as boolean,
              },
            },
          ],
          manuallyOffAir: [],
        })
      ).toThrow('branding burn-in must be a boolean')

      expect(() =>
        store.save({
          channels: [
            {
              ...branded,
              branding: { ...branded.branding, mode: 'off', burnIn: true },
            },
          ],
          manuallyOffAir: [],
        })
      ).toThrow('cannot burn in disabled branding')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('persists a validated marathon policy while legacy channels stay unchanged', () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-channel-marathon-'))
    try {
      const store = new ChannelConfigurationStore(join(directory, 'channels.json'))
      const marathon = {
        ...channel,
        marathon: { enabled: true, frequency: 4, episodeCount: 6 },
      }
      store.save({ channels: [marathon], manuallyOffAir: [] })

      expect(store.load().channels[0]?.marathon).toEqual(marathon.marathon)
      expect(
        new ChannelConfigurationStore(
          join(directory, 'missing.json'),
          [channel]
        ).load().channels[0]
      ).not.toHaveProperty('marathon')

      expect(() =>
        store.save({
          channels: [
            {
              ...marathon,
              marathon: { ...marathon.marathon, frequency: 0 },
            },
          ],
          manuallyOffAir: [],
        })
      ).toThrow('marathon frequency')
      expect(() =>
        store.save({
          channels: [
            {
              ...marathon,
              marathon: { ...marathon.marathon, frequency: 101 },
            },
          ],
          manuallyOffAir: [],
        })
      ).toThrow('marathon frequency')
      expect(() =>
        store.save({
          channels: [
            {
              ...marathon,
              marathon: { ...marathon.marathon, episodeCount: 1 },
            },
          ],
          manuallyOffAir: [],
        })
      ).toThrow('marathon episode count')
      expect(() =>
        store.save({
          channels: [
            {
              ...marathon,
              marathon: { ...marathon.marathon, episodeCount: 21 },
            },
          ],
          manuallyOffAir: [],
        })
      ).toThrow('marathon episode count')
      expect(() =>
        store.save({
          channels: [
            {
              ...marathon,
              marathon: {
                ...marathon.marathon,
                enabled: 'yes' as unknown as boolean,
              },
            },
          ],
          manuallyOffAir: [],
        })
      ).toThrow('marathon enabled must be a boolean')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('validates a scheduled custom logo on a channel time block', () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-scheduled-branding-'))
    try {
      const store = new ChannelConfigurationStore(join(directory, 'channels.json'))
      const scheduled = {
        ...channel,
        slots: channel.slots.map((slot) => ({
          ...slot,
          branding: { mode: 'custom' as const, logoId: 'adult-swim' },
        })),
      }
      store.save({ channels: [scheduled], manuallyOffAir: [] })
      expect(store.load().channels[0]?.slots[0]?.branding).toEqual({
        mode: 'custom',
        logoId: 'adult-swim',
      })
      expect(() => store.save({
        channels: [{
          ...scheduled,
          slots: scheduled.slots.map((slot) => ({
            ...slot,
            branding: { mode: 'custom' as const, logoId: '../escape' },
          })),
        }],
        manuallyOffAir: [],
      })).toThrow('safe logo ID')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
