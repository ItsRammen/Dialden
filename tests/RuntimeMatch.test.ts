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

  test('leaves a single candidate to ordinary matching', () => {
    // Not a tie; the normal rules already decided what to do with it.
    expect(resolveByRuntime([candidate('1', 108)], 109)).toBeNull()
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
