import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  loadLibraryConfig,
  validateLibraryChannels,
} from '../src/config/library'

describe('library configuration', () => {
  test('legacy single-root mode remains unrestricted', () => {
    const config = loadLibraryConfig('/media', {})

    expect(config.roots).toEqual([
      { id: 'media', directory: '/media', kind: 'other' },
    ])
  })

  test('managed Plex roots fail closed without a policy', () => {
    const config = loadLibraryConfig('/media', {
      TOASTTV_TV_MEDIA: '/media/tv',
      TOASTTV_MOVIE_MEDIA: '/media/movies',
    })

    expect(config.roots[0]?.approvedCollections).toEqual([])
    expect(config.roots[1]?.approvedCollections).toEqual([])
  })

  test('Kids 7 policy approves Bluey but not an adult collection', () => {
    const config = loadLibraryConfig('/media', {
      TOASTTV_TV_MEDIA: '/media/tv',
      TOASTTV_MOVIE_MEDIA: '/media/movies',
      TOASTTV_LIBRARY_POLICY: resolve('config/kids-7.library.json'),
    })

    const tv = config.roots.find((root) => root.id === 'tv')
    expect(tv?.approvedCollections).toContain('Bluey (2018)')
    expect(tv?.approvedCollections).not.toContain('South Park')
    expect(config.policy?.profile?.age).toBe(7)
    expect(config.policy?.channels?.map((channel) => channel.id)).toEqual([
      'kids-club',
      'nature-discovery',
      'family-movies',
    ])
  })

  test('rejects ancestor and descendant managed roots', () => {
    expect(() =>
      loadLibraryConfig('/media', {
        TOASTTV_TV_MEDIA: '/media',
        TOASTTV_MOVIE_MEDIA: '/media/movies',
      })
    ).toThrow(/overlap/i)
  })

  test('rejects overlapping slots that would create two simultaneous timelines', () => {
    expect(() =>
      validateLibraryChannels([
        {
          id: 'kids',
          name: 'Kids',
          enabled: true,
          timezone: 'UTC',
          slots: [
            {
              days: ['mon'],
              start: '08:00',
              end: '10:00',
              groups: ['comfort'],
            },
            {
              days: ['mon'],
              start: '09:00',
              end: '11:00',
              groups: ['learning'],
            },
          ],
        },
      ])
    ).toThrow(/overlap/i)
  })

  test('rejects group delimiters that the channel editor cannot round-trip', () => {
    for (const group of ['family,movies', 'family|movies', 'family\nmovies']) {
      expect(() =>
        validateLibraryChannels([
          {
            id: 'kids',
            name: 'Kids',
            enabled: true,
            timezone: 'UTC',
            slots: [
              {
                days: ['mon'],
                start: '08:00',
                end: '10:00',
                groups: [group],
              },
            ],
          },
        ])
      ).toThrow(/invalid group/i)
    }
  })

  test('allows 24:00 only as the exact end-of-day boundary', () => {
    const channel = {
      id: 'all-day',
      name: 'All Day',
      enabled: true,
      timezone: 'UTC',
      slots: [
        {
          days: ['mon'],
          start: '00:00',
          end: '24:00',
          groups: ['all-day'],
        },
      ],
    }
    expect(validateLibraryChannels([channel])[0]?.slots[0]?.end).toBe('24:00')
    expect(() =>
      validateLibraryChannels([
        {
          ...channel,
          slots: [{ ...channel.slots[0], start: '24:00', end: '24:00' }],
        },
      ])
    ).toThrow(/invalid schedule time/i)
    expect(() =>
      validateLibraryChannels([
        {
          ...channel,
          slots: [{ ...channel.slots[0], end: '24:01' }],
        },
      ])
    ).toThrow(/invalid schedule time/i)
  })

  test('rejects the same group delimiters in a loaded collection policy', () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-policy-groups-'))
    try {
      const policyPath = join(directory, 'library.json')
      writeFileSync(
        policyPath,
        JSON.stringify({
          version: 1,
          roots: {
            tv: {
              collections: [
                { name: 'Example Show', groups: ['family,movies'] },
              ],
            },
            movies: { collections: [] },
          },
        })
      )

      expect(() =>
        loadLibraryConfig('/media', {
          TOASTTV_TV_MEDIA: '/media/tv',
          TOASTTV_MOVIE_MEDIA: '/media/movies',
          TOASTTV_LIBRARY_POLICY: policyPath,
        })
      ).toThrow(/invalid group/i)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
