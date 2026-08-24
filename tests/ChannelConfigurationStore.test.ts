import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  channelLockedHandoffGroup,
  type LibraryChannelPolicy,
} from '../src/config/library'
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

  test('persists Auto-builder provenance for era stations', () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-channel-automation-'))
    try {
      const store = new ChannelConfigurationStore(join(directory, 'channels.json'))
      const automatic = {
        ...channel,
        automation: {
          preset: 'cartoon-network-1997-2004',
          airtime: 'all-day' as const,
        },
      }
      store.save({ channels: [automatic], manuallyOffAir: [] })
      expect(store.load().channels[0]?.automation).toEqual(automatic.automation)

      expect(() =>
        store.save({
          channels: [
            {
              ...automatic,
              automation: { ...automatic.automation, preset: '../invalid' },
            },
          ],
          manuallyOffAir: [],
        })
      ).toThrow('automation preset')
      expect(() =>
        store.save({
          channels: [
            {
              ...automatic,
              automation: {
                ...automatic.automation,
                airtime: 'sometimes' as 'all-day',
              },
            },
          ],
          manuallyOffAir: [],
        })
      ).toThrow('automation airtime')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('persists a strict network range and durable explicit collection lineup', () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-network-copy-'))
    try {
      const store = new ChannelConfigurationStore(join(directory, 'channels.json'))
      const networkCopy = {
        ...channel,
        automation: {
          preset: 'network-copy',
          airtime: 'all-day' as const,
          networkId: 'cartoon-network' as const,
          eraStartYear: 1997,
          eraEndYear: 2026,
          selectionMode: 'explicit' as const,
          collectionRefs: [
            {
              rootId: 'tv',
              libraryKind: 'tv' as const,
              identityKey: 'tv:cartoon-network:dexters-laboratory',
            },
          ],
        },
      }
      store.save({ channels: [networkCopy], manuallyOffAir: [] })
      expect(store.load().channels[0]?.automation).toEqual(
        networkCopy.automation
      )

      const handoff = {
        identity: 'adult-swim' as const,
        mode: 'locked-off-air' as const,
        start: '21:00',
        end: '06:00',
      }
      expect(() =>
        store.save({
          channels: [
            {
              ...networkCopy,
              automation: { ...networkCopy.automation, handoff },
            },
          ],
          manuallyOffAir: [],
        })
      ).toThrow('every overnight minute locked off-air')

      const everyDay = [
        'sun',
        'mon',
        'tue',
        'wed',
        'thu',
        'fri',
        'sat',
      ] as const
      const lockedGroup = channelLockedHandoffGroup(networkCopy.id)
      const withLockedHandoff = {
        ...networkCopy,
        slots: [
          {
            days: everyDay,
            start: '00:00',
            end: '06:00',
            groups: [lockedGroup],
            branding: { mode: 'custom' as const, logoId: 'adult-swim' },
          },
          {
            days: everyDay,
            start: '06:00',
            end: '21:00',
            groups: ['comfort'],
          },
          {
            days: everyDay,
            start: '21:00',
            end: '24:00',
            groups: [lockedGroup],
            branding: { mode: 'custom' as const, logoId: 'adult-swim' },
          },
        ],
        automation: {
          ...networkCopy.automation,
          handoff,
        },
      }
      store.save({ channels: [withLockedHandoff], manuallyOffAir: [] })
      expect(store.load().channels[0]?.automation?.handoff).toEqual(
        withLockedHandoff.automation.handoff
      )
      expect(() =>
        store.save({
          channels: [
            {
              ...withLockedHandoff,
              automation: {
                ...withLockedHandoff.automation,
                handoff: {
                  ...withLockedHandoff.automation.handoff,
                  start: '06:00',
                  end: '21:00',
                },
              },
            },
          ],
          manuallyOffAir: [],
        })
      ).toThrow('must start between 17:00')
      expect(() =>
        store.save({
          channels: [
            {
              ...withLockedHandoff,
              automation: {
                ...withLockedHandoff.automation,
                handoff: {
                  ...withLockedHandoff.automation.handoff,
                  start: '07:00',
                  end: '06:59',
                },
              },
            },
          ],
          manuallyOffAir: [],
        })
      ).toThrow('must start between 17:00')

      expect(() =>
        store.save({
          channels: [
            {
              ...networkCopy,
              automation: {
                ...networkCopy.automation,
                networkId: 'abc-kids' as 'cartoon-network',
              },
            },
          ],
          manuallyOffAir: [],
        })
      ).toThrow('automation network is invalid')
      expect(() =>
        store.save({
          channels: [
            {
              ...networkCopy,
              automation: {
                ...networkCopy.automation,
                eraStartYear: 2027,
              },
            },
          ],
          manuallyOffAir: [],
        })
      ).toThrow('automation era range is invalid')
      expect(() =>
        store.save({
          channels: [
            {
              ...networkCopy,
              automation: {
                ...networkCopy.automation,
                eraEndYear: 2027,
              },
            },
          ],
          manuallyOffAir: [],
        })
      ).toThrow("outside the selected network's available years")
      expect(() =>
        store.save({
          channels: [
            {
              ...networkCopy,
              automation: {
                ...networkCopy.automation,
                collectionRefs: [],
              },
            },
          ],
          manuallyOffAir: [],
        })
      ).toThrow('explicit network selection requires collection references')
      expect(() =>
        store.save({
          channels: [
            {
              ...networkCopy,
              automation: {
                ...networkCopy.automation,
                collectionRefs: [
                  {
                    rootId: 'tv',
                    libraryKind: 'other' as 'tv',
                    identityKey: 'bonus-feature',
                  },
                ],
              },
            },
          ],
          manuallyOffAir: [],
        })
      ).toThrow('automation collection reference 0 is invalid')
      expect(() =>
        store.save({
          channels: [
            {
              ...networkCopy,
              automation: {
                ...networkCopy.automation,
                networkId: 'toonami' as 'cartoon-network',
                eraStartYear: 1997,
                eraEndYear: 2026,
              },
            },
          ],
          manuallyOffAir: [],
        })
      ).toThrow("outside the selected network's available years")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('reserves locked handoff groups from persisted media assignments', () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-locked-group-'))
    try {
      const store = new ChannelConfigurationStore(join(directory, 'channels.json'))
      expect(() =>
        store.save({
          channels: [channel],
          manuallyOffAir: [],
          collectionGroups: [
            {
              rootId: 'tv',
              collectionTitle: 'Bluey (2018)',
              groups: [channelLockedHandoffGroup('cn-copy')],
            },
          ],
        })
      ).toThrow('cannot assign the reserved after-hours group')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('persists the expanded child-channel profiles at their documented boundaries', () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-expanded-networks-'))
    try {
      const store = new ChannelConfigurationStore(join(directory, 'channels.json'))
      const profiles = [
        ['abc3-abc-me', 2009, 2024],
        ['abc-family-au', 2024, 2026],
        ['abc-kids-au', 2009, 2026],
        ['cbbc', 2002, 2026],
        ['cbeebies', 2002, 2026],
        ['pbs-kids', 1994, 2026],
      ] as const
      for (const [networkId, eraStartYear, eraEndYear] of profiles) {
        store.save({
          channels: [
            {
              ...channel,
              automation: {
                preset: 'network-copy',
                airtime: 'all-day',
                networkId,
                eraStartYear,
                eraEndYear,
                selectionMode: 'automatic',
              },
            },
          ],
          manuallyOffAir: [],
        })
        expect(store.load().channels[0]?.automation?.networkId).toBe(networkId)
      }
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
