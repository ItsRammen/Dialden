import { describe, expect, test } from 'bun:test'
import {
  AUDIENCE_BANDS,
  audienceBandFor,
  bandRank,
  bandWithinCeiling,
  isAudienceBand,
} from '../src/policy/audienceBands'
import { DEFAULT_KIDS_7_POLICY } from '../src/policy/PolicyEngine'

describe('placing a certification on the ladder', () => {
  test('the youngest rung is the ratings meant for everyone', () => {
    for (const cert of ['G', 'U', 'UC', 'TV-Y', 'TV-G']) {
      expect(audienceBandFor(cert)).toBe('everyone')
    }
  })

  test('guidance ratings sit with younger children', () => {
    for (const cert of ['PG', 'TV-PG', 'TV-Y7', 'TV-Y7-FV']) {
      expect(audienceBandFor(cert)).toBe('young')
    }
  })

  test('the twelves sit with older children', () => {
    for (const cert of ['12', '12A']) {
      expect(audienceBandFor(cert)).toBe('older')
    }
  })

  test('thirteen and fourteen round up, not down', () => {
    /* PG-13 is nominally thirteen, above the 12 rung and below the 15. A
       system guarding what a child watches rounds towards the older
       audience, so a twelve-year-old's ceiling does not admit it. */
    for (const cert of ['PG-13', 'TV-14', '14A', '13+']) {
      expect(audienceBandFor(cert)).toBe('teen')
    }
  })

  test('fifteens and sixteens sit with teenagers', () => {
    for (const cert of ['15', '15A', '16', 'M', 'MA15+', 'MA 15+']) {
      expect(audienceBandFor(cert)).toBe('teen')
    }
  })

  test('the eighteens are adults only', () => {
    for (const cert of ['R', 'NC-17', 'TV-MA', '18', '18A', 'R18', 'R 18+', 'X18+']) {
      expect(audienceBandFor(cert)).toBe('adult')
    }
  })

  test('an unfamiliar rating has no band at all', () => {
    // Null is not a rung. It is the absence of an answer.
    for (const cert of ['FSK 12', 'RP13', 'B15', '', '   ', 'WHAT']) {
      expect(audienceBandFor(cert)).toBeNull()
    }
    expect(audienceBandFor(null)).toBeNull()
    expect(audienceBandFor(undefined)).toBeNull()
  })

  test('spacing and dash styles do not change the rung', () => {
    expect(audienceBandFor(' pg-13 ')).toBe('teen')
    expect(audienceBandFor('PG – 13')).toBe('teen')
    expect(audienceBandFor('ma 15+')).toBe('teen')
    expect(audienceBandFor('r  18+')).toBe('adult')
  })
})

describe('a ceiling admits its rung and everything below', () => {
  test('a younger ceiling admits only what is at or below it', () => {
    expect(bandWithinCeiling('everyone', 'young')).toBe(true)
    expect(bandWithinCeiling('young', 'young')).toBe(true)
    expect(bandWithinCeiling('older', 'young')).toBe(false)
    expect(bandWithinCeiling('adult', 'young')).toBe(false)
  })

  test('the highest ceiling admits every band', () => {
    for (const band of AUDIENCE_BANDS) {
      expect(bandWithinCeiling(band, 'adult')).toBe(true)
    }
  })

  test('an unknown band is admitted by no ceiling whatsoever', () => {
    // The property that makes an unrecognised rating safe to store.
    for (const ceiling of AUDIENCE_BANDS) {
      expect(bandWithinCeiling(null, ceiling)).toBe(false)
      expect(bandWithinCeiling(undefined, ceiling)).toBe(false)
    }
  })

  test('the ladder is strictly ordered', () => {
    for (let index = 1; index < AUDIENCE_BANDS.length; index += 1) {
      const lower = AUDIENCE_BANDS[index - 1]
      const upper = AUDIENCE_BANDS[index]
      if (!lower || !upper) throw new Error('ladder is malformed')
      expect(bandRank(lower)).toBeLessThan(bandRank(upper))
    }
  })
})

describe('the ladder agrees with the policy it will replace', () => {
  test('everything Kids 7 allows sits at or below the young rung', () => {
    for (const cert of DEFAULT_KIDS_7_POLICY.rules.allow) {
      const band = audienceBandFor(cert)
      expect(band).not.toBeNull()
      expect(bandWithinCeiling(band, 'young')).toBe(true)
    }
  })

  test('everything Kids 7 blocks sits above the young rung', () => {
    // A disagreement here would mean the two tables tell different stories
    // about the same rating, which is how a child sees the wrong thing.
    for (const cert of DEFAULT_KIDS_7_POLICY.rules.block) {
      const band = audienceBandFor(cert)
      expect(band).not.toBeNull()
      expect(bandWithinCeiling(band, 'young')).toBe(false)
    }
  })

  test('every rating the policy knows has a band', () => {
    const known = [
      ...DEFAULT_KIDS_7_POLICY.rules.allow,
      ...DEFAULT_KIDS_7_POLICY.rules.review,
      ...DEFAULT_KIDS_7_POLICY.rules.block,
    ]
    for (const cert of known) {
      expect(audienceBandFor(cert)).not.toBeNull()
    }
  })
})

describe('band guards', () => {
  test('recognises its own values and nothing else', () => {
    for (const band of AUDIENCE_BANDS) expect(isAudienceBand(band)).toBe(true)
    for (const value of ['', 'ADULT', 'kids', 7, null, undefined, {}]) {
      expect(isAudienceBand(value)).toBe(false)
    }
  })
})

describe('the band a real collection reports', () => {
  test('is derived from the certification, so it cannot go stale', async () => {
    // Stored separately it could disagree with the rating it came from,
    // which is precisely the failure the review queue keeps surfacing.
    const { MediaRepository } = await import('../src/repositories/MediaRepository')
    const repository = new MediaRepository(':memory:')
    await repository.initialize()
    try {
      const [collection] = await repository.upsertCollections([
        {
          rootId: 'movies',
          libraryKind: 'movie',
          identityKey: JSON.stringify(['a real young girl', 1976]),
          sourceTitle: 'A Real Young Girl (1976)',
          parsedTitle: 'A Real Young Girl',
          year: 1976,
        },
      ])
      if (!collection) throw new Error('expected a collection')

      await repository.updateCollectionMetadata(collection.id, {
        provider: 'tmdb',
        externalId: '1631',
        status: 'matched',
        matchConfidence: 1,
        candidates: [],
        ratingStatus: 'resolved',
        certification: '18A',
        certificationRegion: 'CA',
        error: null,
      })

      const stored = await repository.getCollectionById(collection.id)
      expect(stored?.certification).toBe('18A')
      expect(stored?.audienceBand).toBe('adult')
    } finally {
      await repository.close()
    }
  })

  test('is absent when no certification was resolved', async () => {
    const { MediaRepository } = await import('../src/repositories/MediaRepository')
    const repository = new MediaRepository(':memory:')
    await repository.initialize()
    try {
      const [collection] = await repository.upsertCollections([
        {
          rootId: 'movies',
          libraryKind: 'movie',
          identityKey: 'untitled',
          sourceTitle: 'Untitled',
          parsedTitle: 'Untitled',
          year: null,
        },
      ])
      if (!collection) throw new Error('expected a collection')

      const stored = await repository.getCollectionById(collection.id)
      expect(stored?.audienceBand).toBeNull()
    } finally {
      await repository.close()
    }
  })
})
