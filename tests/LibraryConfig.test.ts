import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { loadLibraryConfig } from '../src/config/library'

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
})
