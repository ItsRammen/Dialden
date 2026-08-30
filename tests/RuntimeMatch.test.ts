import { describe, expect, test } from 'bun:test'
import {
  collectionRuntimeMinutes,
  resolveByRuntime,
} from '../src/services/metadata/runtimeMatch'
import type { MetadataCandidateRecord } from '../src/types'

function candidate(
  externalId: string,
  runtimeMinutes?: number,
  confidence = 1
): MetadataCandidateRecord {
  return {
    provider: 'tmdb',
    externalId,
    mediaType: 'movie',
    title: 'Alice in Wonderland',
    year: 2010,
    confidence,
    ...(runtimeMinutes === undefined ? {} : { runtimeMinutes }),
  }
}

describe('breaking a tie with the file runtime', () => {
  test('picks the one candidate the file length identifies', () => {
    // The real case: 6514s of file against Burton at 108 minutes.
    const resolved = resolveByRuntime(
      [candidate('12155', 108), candidate('135361', 33), candidate('423971', 52)],
      109
    )

    expect(resolved?.candidate.externalId).toBe('12155')
    expect(resolved?.deltaMinutes).toBe(1)
  })

  test('refuses when the file length is unknown', () => {
    expect(
      resolveByRuntime([candidate('1', 108), candidate('2', 33)], undefined)
    ).toBeNull()
    expect(resolveByRuntime([candidate('1', 108), candidate('2', 33)], 0)).toBeNull()
  })

  test('refuses when any tied candidate has no runtime', () => {
    // An unknown rival cannot be ruled out, so it rules out the comparison.
    expect(
      resolveByRuntime([candidate('1', 108), candidate('2', undefined)], 109)
    ).toBeNull()
  })

  test('refuses when two candidates are both close', () => {
    expect(
      resolveByRuntime([candidate('1', 108), candidate('2', 110)], 109)
    ).toBeNull()
  })

  test('refuses when the nearest rival is not clearly out', () => {
    // 109 vs 116 is seven minutes: a restored cut, not a different film.
    expect(
      resolveByRuntime([candidate('1', 108), candidate('2', 116)], 109)
    ).toBeNull()
  })

  test('refuses when nothing is close enough', () => {
    expect(
      resolveByRuntime([candidate('1', 70), candidate('2', 33)], 109)
    ).toBeNull()
  })

  test('will not confirm a lone candidate without a year to check', () => {
    // A near miss on the title needs the year to agree before its runtime
    // is allowed to settle anything.
    expect(resolveByRuntime([candidate('1', 108)], 109)).toBeNull()
    expect(resolveByRuntime([candidate('1', 108)], 109, null)).toBeNull()
  })

  test('only weighs the candidates that actually tie', () => {
    /* A poor-scoring candidate must not win on runtime alone, or a
       featurette could displace the feature it accompanies. */
    const resolved = resolveByRuntime(
      [
        candidate('1', 90, 1),
        candidate('2', 40, 1),
        candidate('3', 109, 0.6),
      ],
      109
    )

    expect(resolved).toBeNull()
  })

  test('accepts the edge of the window but not beyond it', () => {
    expect(
      resolveByRuntime([candidate('1', 106), candidate('2', 40)], 109)
    ).not.toBeNull()
    expect(
      resolveByRuntime([candidate('1', 105), candidate('2', 40)], 109)
    ).toBeNull()
  })
})

describe('the comparable length of a collection', () => {
  test('is the file itself for a film', () => {
    expect(collectionRuntimeMinutes([6514])).toBe(109)
  })

  test('is one episode for a series, not the total', () => {
    expect(collectionRuntimeMinutes([1320, 1350, 1290])).toBe(22)
  })

  test('is not dragged by a double-length special', () => {
    // A mean would report 28 minutes here; the median stays with the episodes.
    expect(collectionRuntimeMinutes([1320, 1350, 1290, 2700])).toBe(23)
  })

  test('ignores files that were never probed', () => {
    expect(collectionRuntimeMinutes([0, null, undefined, 6514])).toBe(109)
    expect(collectionRuntimeMinutes([0, null, undefined])).toBeUndefined()
    expect(collectionRuntimeMinutes([])).toBeUndefined()
  })
})

describe('confirming a lone near-miss with the runtime', () => {
  /** The real case: "A Tale of Autumn" against "An Autumn Tale". */
  const autumn = (
    confidence = 0.7857,
    runtimeMinutes = 112,
    year = 1998
  ): MetadataCandidateRecord => ({
    provider: 'tmdb',
    externalId: '10239',
    mediaType: 'movie',
    title: 'An Autumn Tale',
    year,
    confidence,
    runtimeMinutes,
  })

  const noise: MetadataCandidateRecord = {
    provider: 'tmdb',
    externalId: '17031',
    mediaType: 'movie',
    title: 'Dragonlance: Dragons of Autumn Twilight',
    year: 2008,
    confidence: 0.1173,
    runtimeMinutes: 91,
  }

  test('confirms a reordered title when the year and length agree', () => {
    const resolved = resolveByRuntime([autumn(), noise], 111, 1998)

    expect(resolved?.candidate.externalId).toBe('10239')
    expect(resolved?.deltaMinutes).toBe(1)
  })

  test('a far-back candidate neither blocks nor wins', () => {
    // Dragonlance shares one word. It must not be treated as a rival to
    // rule out, nor be able to win on a runtime of its own.
    const resolved = resolveByRuntime([autumn(), noise], 111, 1998)

    expect(resolved?.candidate.externalId).toBe('10239')
    expect(resolveByRuntime([noise], 91, 2008)).toBeNull()
  })

  test('refuses when the year disagrees', () => {
    /* A Real Young Girl: exact title, runtime would agree, but the year is
       twenty-five years out. That is indistinguishable from a remake, so a
       lone candidate never gets the benefit of the doubt. */
    expect(resolveByRuntime([autumn(0.9, 112, 2001)], 111, 1998)).toBeNull()
  })

  test('refuses when the title is only a weak resemblance', () => {
    expect(resolveByRuntime([autumn(0.55)], 111, 1998)).toBeNull()
  })

  test('refuses when the length does not actually agree', () => {
    expect(resolveByRuntime([autumn(0.7857, 120)], 111, 1998)).toBeNull()
  })

  test('refuses when the lone candidate has no runtime', () => {
    expect(
      resolveByRuntime([{ ...autumn(), runtimeMinutes: undefined }], 111, 1998)
    ).toBeNull()
  })

  test('a genuine rival puts it back to the stricter tie rules', () => {
    // Two contenders both near the file length: no decision.
    const rival: MetadataCandidateRecord = { ...autumn(), externalId: '99', runtimeMinutes: 110 }
    expect(resolveByRuntime([autumn(), rival], 111, 1998)).toBeNull()
  })
})

describe('only genuine ties are weighed', () => {
  const at = (
    externalId: string,
    confidence: number,
    runtimeMinutes?: number,
    year = 2010
  ): MetadataCandidateRecord => ({
    provider: 'tmdb',
    externalId,
    mediaType: 'movie',
    title: 'Title',
    year,
    confidence,
    ...(runtimeMinutes === undefined ? {} : { runtimeMinutes }),
  })

  test('a lesser title with no runtime cannot block a decision', () => {
    /* Collection 389 as the library holds it. "The Mad Hatter" is a
       featurette scoring 0.779 with no runtime recorded. Counting it as a
       rival abandoned a comparison the three tied records could settle. */
    const resolved = resolveByRuntime(
      [
        at('12155', 1, 108),
        at('135361', 1, 57),
        at('423971', 1, 99),
        at('57008', 0.833, 90),
        at('683578', 0.79, 5),
        at('683579', 0.779),
      ],
      109,
      2010
    )

    expect(resolved?.candidate.externalId).toBe('12155')
  })

  test('a lesser title with a close runtime cannot win either', () => {
    // The featurette runs 108 minutes here. It still is not the film.
    const resolved = resolveByRuntime(
      [at('12155', 1, 40), at('135361', 1, 57), at('683579', 0.779, 108)],
      109,
      2010
    )

    expect(resolved).toBeNull()
  })

  test('a true tie with an unknown runtime is still refused', () => {
    /* Collection 379: three records all titled Absolution, all 2024, one
       with no runtime at all. That is genuinely undecidable here. */
    const resolved = resolveByRuntime(
      [
        at('974453', 1, 112, 2024),
        at('1242249', 1, 3, 2024),
        at('1380432', 1, undefined, 2024),
        at('1284646', 0.812, 9, 2024),
      ],
      112,
      2024
    )

    expect(resolved).toBeNull()
  })

  test('a lone candidate needs clear air behind it', () => {
    // Two near-equal candidates are a tie, and a tie is judged on runtime
    // alone rather than given to the leader.
    const resolved = resolveByRuntime(
      [at('1', 0.79, 112, 1998), at('2', 0.72, 40, 1998)],
      111,
      1998
    )

    expect(resolved).toBeNull()
  })

  test('the autumn near-miss still resolves', () => {
    const resolved = resolveByRuntime(
      [at('10239', 0.7857, 112, 1998), at('17031', 0.1173, 91, 2008)],
      111,
      1998
    )

    expect(resolved?.candidate.externalId).toBe('10239')
  })
})
