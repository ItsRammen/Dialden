import { describe, expect, test } from 'bun:test'
import {
  describeStationInteractiveSequences,
  parseStationAssetFilename,
  selectStationFillerAsset,
  selectStationInteractiveSequence,
} from '../src/services/StationAssetService'
import type { MediaItem } from '../src/types'

/*
 * The filenames here are the ones the Nickstory v5 export actually writes, so
 * a change to the code-field contract fails these rather than surfacing as
 * silently unscheduled assets.
 */

let nextId = 1
function asset(filename: string, durationSeconds = 10): MediaItem {
  return { id: nextId++, filename, durationSeconds } as unknown as MediaItem
}

const ELEPHANTS_A = 'nick-jr--filler--generic--2008--play-with-us-elephants-part-a-N3151-01.mp4'
const ELEPHANTS_B = 'nick-jr--filler--generic--2008--play-with-us-elephants-part-b-N3151-02.mp4'
const ELEPHANTS_C = 'nick-jr--filler--generic--2008--play-with-us-elephants-part-c-N3151-03.mp4'
const HORSES_A = 'nick-jr--filler--generic--2008--play-with-us-horses-part-a-N3151-04.mp4'
const PLAIN_FILLER = 'nick-jr--filler--generic--2009--N10457-04.mp4'

describe('interactive sequence metadata', () => {
  test('reads the sequence family, group and part from the final code field', () => {
    const descriptor = parseStationAssetFilename(ELEPHANTS_A)

    // The five-part contract is unchanged: it is still a generic Nick Jr filler.
    expect(descriptor?.station).toBe('nick-jr')
    expect(descriptor?.kind).toBe('filler-general')
    expect(descriptor?.sequence).toEqual({
      family: 'play-with-us',
      id: 'nick-jr-play-with-us-elephants',
      subject: 'elephants',
      part: 'A',
    })
    expect(parseStationAssetFilename(ELEPHANTS_C)?.sequence?.part).toBe('C')
    // Different subjects are different groups.
    expect(parseStationAssetFilename(HORSES_A)?.sequence?.id).toBe('nick-jr-play-with-us-horses')
    // An ordinary filler carries no sequence at all.
    expect(parseStationAssetFilename(PLAIN_FILLER)?.sequence).toBeUndefined()
  })

  test('reads UGC navigation styling without inventing a new asset kind', () => {
    const rightNow = parseStationAssetFilename(
      'nick-jr--up-next--dora-the-explorer--2009--ugc-navigation-right-now-N10274-06.mp4'
    )
    expect(rightNow?.kind).toBe('bumper-up-next')
    expect(rightNow?.next).toBe('dora-the-explorer')
    expect(rightNow?.sourceStyle).toBe('ugc-navigation')
    expect(rightNow?.rightNow).toBe(true)
    expect(rightNow?.legacyWebCta).toBeUndefined()

    const webCta = parseStationAssetFilename(
      'nick-jr--more--max-and-ruby--2009--ugc-navigation-web-cta-when-we-come-back-N12077-03.mp4'
    )
    expect(webCta?.kind).toBe('bumper-more')
    expect(webCta?.show).toBe('max-and-ruby')
    expect(webCta?.legacyWebCta).toBe(true)
    // "when we come back" is not "right now", so it may run anywhere.
    expect(webCta?.rightNow).toBeUndefined()

    const plainCta = parseStationAssetFilename(
      'nick-jr--up-next--olivia--2009--ugc-navigation-coming-up-next-N12079-01.mp4'
    )
    expect(plainCta?.sourceStyle).toBe('ugc-navigation')
    expect(plainCta?.legacyWebCta).toBeUndefined()
    expect(plainCta?.rightNow).toBeUndefined()
  })

  test('an unrecognised code field still parses as an ordinary asset', () => {
    const descriptor = parseStationAssetFilename(
      'nick-jr--filler--generic--2008--something-nobody-has-written-yet-N9999-01.mp4'
    )
    expect(descriptor?.kind).toBe('filler-general')
    expect(descriptor?.sequence).toBeUndefined()
    expect(descriptor?.sourceStyle).toBeUndefined()
  })
})

describe('interactive sequences are scheduled as one decision', () => {
  test('a sequence part never enters the independent filler rotation', () => {
    const plain = asset(PLAIN_FILLER)
    const chosen = selectStationFillerAsset(
      [asset(ELEPHANTS_A), asset(ELEPHANTS_B), asset(ELEPHANTS_C), plain],
      'nick-jr',
      600,
      'seed'
    )

    expect(chosen).toBe(plain)
  })

  test('a station whose only fillers are sequence parts schedules no filler', () => {
    /* This is the point of the exclusion: an unanswered question is worse
       than a gap, so the parts sit out rather than playing at random. */
    expect(
      selectStationFillerAsset(
        [asset(ELEPHANTS_A), asset(ELEPHANTS_B), asset(ELEPHANTS_C)],
        'nick-jr',
        600,
        'seed'
      )
    ).toBeUndefined()
  })

  test('returns A then C, and drops the optional reminder in compact mode', () => {
    const items = [asset(ELEPHANTS_A), asset(ELEPHANTS_B), asset(ELEPHANTS_C)]

    const full = selectStationInteractiveSequence(items, 'nick-jr', 'seed')
    expect(full.map((item) => item.filename)).toEqual([ELEPHANTS_A, ELEPHANTS_B, ELEPHANTS_C])

    const compact = selectStationInteractiveSequence(items, 'nick-jr', 'seed', { compact: true })
    expect(compact.map((item) => item.filename)).toEqual([ELEPHANTS_A, ELEPHANTS_C])
  })

  test('never offers a group that cannot answer its own question', () => {
    // A without C, C without A, and B alone are all unusable.
    expect(selectStationInteractiveSequence([asset(ELEPHANTS_A)], 'nick-jr', 'seed')).toEqual([])
    expect(selectStationInteractiveSequence([asset(ELEPHANTS_C)], 'nick-jr', 'seed')).toEqual([])
    expect(selectStationInteractiveSequence([asset(ELEPHANTS_B)], 'nick-jr', 'seed')).toEqual([])
    expect(
      selectStationInteractiveSequence([asset(ELEPHANTS_A), asset(ELEPHANTS_B)], 'nick-jr', 'seed')
    ).toEqual([])
  })

  test('picks one group at a time and never mixes subjects', () => {
    const items = [
      asset(ELEPHANTS_A),
      asset(ELEPHANTS_C),
      asset(HORSES_A),
      asset('nick-jr--filler--generic--2008--play-with-us-horses-part-c-N3151-06.mp4'),
    ]
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const sequence = selectStationInteractiveSequence(items, 'nick-jr', seed)
      expect(sequence).toHaveLength(2)
      const ids = sequence.map(
        (item) => parseStationAssetFilename(item.filename)?.sequence?.id
      )
      expect(new Set(ids).size).toBe(1)
    }
  })

  test('another station cannot borrow a sequence', () => {
    expect(
      selectStationInteractiveSequence(
        [asset(ELEPHANTS_A), asset(ELEPHANTS_C)],
        'nick',
        'seed'
      )
    ).toEqual([])
  })

  test('reports which groups are usable, so a missing part is visible', () => {
    const described = describeStationInteractiveSequences(
      [asset(ELEPHANTS_A), asset(ELEPHANTS_B), asset(HORSES_A)],
      'nick-jr'
    )

    expect(described).toEqual([
      { id: 'nick-jr-play-with-us-elephants', parts: ['A', 'B'], usable: false },
      { id: 'nick-jr-play-with-us-horses', parts: ['A'], usable: false },
    ])
  })
})
