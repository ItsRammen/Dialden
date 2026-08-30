import { describe, expect, test } from 'bun:test'
import { cleanCollectionTitle } from '../src/services/metadata/TitleMatcher'

/**
 * The cleaner exists to turn filenames into titles that can match exactly. It
 * only ever widens the search: matchMetadata still demands a unique exact
 * normalized title, so cleaning cannot force a wrong match unless the cleaned
 * string happens to be exactly some other film's title. The cases that matter
 * are therefore the ones where cleaning must NOT happen.
 */
describe('cleanCollectionTitle', () => {
  describe('leaves real titles alone', () => {
    test('returns null when there is nothing to strip', () => {
      expect(cleanCollectionTitle('The Iron Giant')).toBeNull()
      expect(cleanCollectionTitle('Spirited Away')).toBeNull()
    })

    test('keeps a trailing part marker, which distinguishes real films', () => {
      // Deathly Hallows Part 1 and Part 2 are different films with different
      // certifications. Collapsing them onto each other is the worst outcome
      // this whole feature could produce.
      expect(
        cleanCollectionTitle('Harry Potter and the Deathly Hallows Part 1')
      ).toBeNull()
      expect(cleanCollectionTitle('Kill Bill Vol. 2')).toBeNull()
      expect(cleanCollectionTitle('Dune Part Two')).toBeNull()
    })

    test('keeps a trailing part marker even behind release furniture', () => {
      // Furniture is stripped first, which leaves the part marker trailing —
      // and therefore meaningful — rather than mid-title.
      expect(cleanCollectionTitle('Harry Potter and the Deathly Hallows Part 1 1080p BluRay'))
        .toBe('Harry Potter and the Deathly Hallows Part 1')
    })

    test('keeps parenthesised text, which can be a real subtitle', () => {
      expect(cleanCollectionTitle('Fantasia (Original)')).toBeNull()
    })
  })

  describe('strips filename furniture', () => {
    test('removes a mid-title part marker followed by a subtitle', () => {
      // The real title is "28 Years Later: The Bone Temple"; the queue had this
      // sitting unmatched because "Part 2" blocked the exact match.
      expect(cleanCollectionTitle('28 Years Later Part 2 The Bone Temple'))
        .toBe('28 Years Later The Bone Temple')
    })

    test('removes resolution, source and codec tags', () => {
      expect(cleanCollectionTitle('The Iron Giant 1080p BluRay x264'))
        .toBe('The Iron Giant')
      expect(cleanCollectionTitle('Coco 2160p WEB-DL HDR HEVC DDP5.1'))
        .toBe('Coco')
    })

    test('removes bracketed release groups but not parentheses', () => {
      expect(cleanCollectionTitle('Ponyo [YTS] {1080p}')).toBe('Ponyo')
    })

    test('treats dots and underscores as spaces', () => {
      expect(cleanCollectionTitle('The.Iron.Giant.1080p')).toBe('The Iron Giant')
    })

    test('removes edition markers, which do not change the certification', () => {
      expect(cleanCollectionTitle('Blade Runner Final Cut')).toBe('Blade Runner')
      expect(cleanCollectionTitle('Aliens Extended')).toBe('Aliens')
    })
  })

  describe('never returns something unusable', () => {
    test('returns null rather than an empty title', () => {
      expect(cleanCollectionTitle('1080p')).toBeNull()
      expect(cleanCollectionTitle('   ')).toBeNull()
      expect(cleanCollectionTitle('[YTS]')).toBeNull()
    })

    test('does not leave dangling separators behind', () => {
      expect(cleanCollectionTitle('The Iron Giant - 1080p')).toBe('The Iron Giant')
    })
  })
})
