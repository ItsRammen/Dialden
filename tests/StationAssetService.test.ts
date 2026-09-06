import { describe, expect, test } from 'bun:test'
import type { MediaItem } from '../src/types'
import {
  buildStationAssetFilename,
  looksLikeStationAssetFilename,
  parseStationAssetFilename,
  selectStationFillerAsset,
  selectStationTransitionAsset,
  stationShowKey,
} from '../src/services/StationAssetService'

function asset(id: number, filename: string, durationSeconds = 8): MediaItem {
  return {
    id,
    path: `/media/interludes/${filename}`,
    filename,
    durationSeconds,
    isInterlude: true,
    mediaType: 'interlude',
    dateStart: null,
    dateEnd: null,
    codec: 'h264',
    width: 1920,
    height: 1080,
    warning: null,
    mtime: 1,
    compatibility: 'compatible',
    rootId: 'interludes',
    relativePath: filename,
    libraryKind: 'other',
    collectionTitle: filename,
    policyEnabled: true,
    playbackOverride: true,
    rootAvailable: true,
    playbackEnabled: true,
  }
}

describe('station asset filenames and selection', () => {
  test.each([
    ['more--spongebob-squarepants', { kind: 'bumper-more', show: 'spongebob-squarepants' }],
    ['up-next--the-fairly-oddparents', { kind: 'bumper-up-next', next: 'the-fairly-oddparents' }],
    ['now-next--now-spongebob-squarepants--next-the-fairly-oddparents', { kind: 'bumper-now-next', now: 'spongebob-squarepants', next: 'the-fairly-oddparents' }],
    ['ident--generic-station-id', { kind: 'ident-general' }],
    ['filler--generic-break-in', { kind: 'filler-general', role: 'break-in' }],
    ['filler--generic-break-out', { kind: 'filler-general', role: 'break-out' }],
    ['filler--generic-long-form-nick-extra-helpful-hints-break-out', { kind: 'filler-general', role: 'break-out' }],
    ['filler--generic-long-form-purple-and-brown', { kind: 'filler-general' }],
    // A seasonal piece appends its season after the position, and is still positioned.
    ['filler--generic-break-out-summer', { kind: 'filler-general', role: 'break-out' }],
    ['filler--generic-break-in-summer', { kind: 'filler-general', role: 'break-in' }],
    ['ident--generic-station-id-fall', { kind: 'ident-general' }],
    ['standby--generic-standby', { kind: 'standby-loop' }],
  ] as const)('recognizes Nickstory v5 export %s', (fields, expected) => {
    expect(parseStationAssetFilename(`nickelodeon--${fields}--2008--NHD12095-11-2.m4v`)).toEqual({ station: 'nick', ...expected })
  })

  describe('seasonal pieces', () => {
    const seasonal = (id: number, name: string): MediaItem => ({
      ...asset(id, `nickelodeon--filler--generic-${name}--2011--N1-${id}.mp4`),
      dateStart: '06-01',
      dateEnd: '08-31',
    })
    const evergreen = (id: number): MediaItem =>
      asset(id, `nickelodeon--filler--generic--2011--N2-${id}.mp4`)
    /* The schedule filters the pool by date before selection runs, so anything
       reaching the selector with a window is in season now. */
    const items = [
      seasonal(1, 'summer'),
      seasonal(2, 'summer'),
      ...[3, 4, 5, 6].map(evergreen),
    ]

    test('airs while its window holds, ahead of the evergreen rotation', () => {
      const chosen = selectStationFillerAsset(items, 'nick', 60, 'seed')
      expect([1, 2]).toContain(chosen?.id ?? -1)
    })

    test('gives way to the ordinary pool once they have all just played', () => {
      const played = [items[0]!.filename, items[1]!.filename]
      const chosen = selectStationFillerAsset(items, 'nick', 60, 'seed', played)
      expect(chosen?.id).toBeGreaterThan(2)
    })

    test('comes back round once they have aged out of the history', () => {
      // A full window of other pieces, so neither seasonal piece is recent.
      const played = Array.from({ length: 40 }, (_, index) => `other-${index}.mp4`)
      const chosen = selectStationFillerAsset(items, 'nick', 60, 'seed', played)
      expect([1, 2]).toContain(chosen?.id ?? -1)
    })

    test('is simply absent for a season the station has nothing for', () => {
      const winter = [evergreen(3), evergreen(4), evergreen(5)]
      const chosen = selectStationFillerAsset(winter, 'nick', 60, 'seed')
      expect(chosen?.id).toBeGreaterThan(2)
    })

    test('still respects the break position it was asked for', () => {
      /* A seasonal piece is not a free pass into a position it does not hold:
         in the real library most of them are break-out, which is why they
         surface through that pick rather than the middle of a pod. */
      const positioned = [
        seasonal(7, 'break-out-summer'),
        asset(9, 'nickelodeon--filler--generic-break-in--2011--N3-09.mp4'),
        ...[3, 4, 5, 6].map(evergreen),
      ]
      expect(
        selectStationFillerAsset(positioned, 'nick', 60, 'seed', [], 'break-out')?.id
      ).toBe(7)
      expect(
        selectStationFillerAsset(positioned, 'nick', 60, 'seed', [], 'break-in')?.id
      ).toBe(9)
      // And it stays out of the middle of a pod, in season or not.
      expect(
        selectStationFillerAsset(positioned, 'nick', 60, 'seed')?.id
      ).toBeGreaterThan(2)
    })
  })

  test('picks the leaving bumper at one end of a break and the handover at the other', () => {
    const more = asset(
      301,
      'nick-jr--more--dora-the-explorer--2009--ugc-navigation-when-we-come-back-N12075-05.mp4'
    )
    const upNext = asset(
      302,
      'nick-jr--up-next--dora-the-explorer--2009--ugc-navigation-coming-up-next-N12075-04.mp4'
    )
    const ident = asset(303, 'nick-jr--ident--generic-station-id--2009--N1-01.mp4')
    const items = [more, upNext, ident]
    // The same show resumes, so "we'll be right back" is the piece that leaves.
    const resuming = {
      station: 'nick-jr',
      currentShow: 'dora-the-explorer',
      nextShow: 'dora-the-explorer',
      seed: 'test',
    }
    expect(
      selectStationTransitionAsset(items, { ...resuming, position: 'break-out' })
    ).toBe(more)
    expect(
      selectStationTransitionAsset(items, { ...resuming, position: 'break-in' })
    ).toBe(upNext)

    /* Leaving is optional, so it never falls back to something generic --
       otherwise every break would open and close with an ident. */
    expect(
      selectStationTransitionAsset([ident], { ...resuming, position: 'break-out' })
    ).toBeUndefined()
    expect(
      selectStationTransitionAsset([ident], { ...resuming, position: 'break-in' })
    ).toBe(ident)

    // A different show follows, so there is no "back" to be right back to.
    expect(
      selectStationTransitionAsset(items, {
        ...resuming,
        currentShow: 'go-diego-go',
        position: 'break-out',
      })
    ).toBeUndefined()
  })

  test('reads the tune-in marker from the production code, not the semantic field', () => {
    const cta = parseStationAssetFilename(
      'nick-jr--filler--generic-long-form-interstitial-standalone--2012--show-team-umizoomi-schedule-cta-N14785-01.mp4'
    )
    expect(cta?.scheduleCta).toBe(true)
    // Stated outright by long-form exports; older short ones simply omit it.
    expect(cta?.role).toBe('standalone')
    const plain = parseStationAssetFilename(
      'nick-jr--filler--generic-long-form-interstitial-standalone--2008--N3588-01.mp4'
    )
    expect(plain?.scheduleCta).toBeUndefined()
    expect(plain?.role).toBe('standalone')
  })

  test('uses explicit current/next roles and matches year-suffixed library titles', () => {
    const clip = asset(101, 'nickelodeon--now-next--now-spongebob-squarepants--next-the-fairly-oddparents--2008--NHD12095-11-2.mp4')
    const context = { station: 'nick', currentShow: 'other-show', nextShow: 'spongebob-squarepants-1999', followingShow: 'the-fairly-oddparents-2001', seed: 'test' }
    expect(selectStationTransitionAsset([clip], context)).toBe(clip)
    expect(selectStationTransitionAsset([clip], { ...context, nextShow: context.followingShow, followingShow: context.nextShow })).toBeUndefined()
    expect(selectStationTransitionAsset([clip], { ...context, station: 'disney' })).toBeUndefined()
  })

  test.each([
    'nickelodeon--now-next--spongebob+fairly-oddparents--2008--CODE.mp4',
    'nickelodeon--more--spongebob+fairly-oddparents--2008--CODE.mp4',
    'nickelodeon--ident--spongebob--2008--CODE.mp4',
    'nickelodeon--up-next--generic--2008--CODE.mp4',
  ])('keeps ambiguous export out of the generic fallback: %s', (filename) => {
    expect(parseStationAssetFilename(filename)).toBeNull()
    expect(looksLikeStationAssetFilename(filename)).toBe(true)
    expect(selectStationTransitionAsset([asset(101, filename)], { station: 'nick', currentShow: 'a', nextShow: 'b', seed: 'test' })).toBeUndefined()
  })

  test('builds canonical names from friendly configuration values', () => {
    expect(
      buildStationAssetFilename({
        station: 'Nick',
        kind: 'bumper-now-next',
        now: 'SpongeBob SquarePants (1999)',
        next: 'The Fairly OddParents (2001)',
        targetSeconds: 12,
        variant: 5,
      }, '.MOV')
    ).toBe(
      'nick__bumper-now-next__now-spongebob-squarepants-1999__next-the-fairly-oddparents-2001__target-12s__v05.mov'
    )
    expect(() =>
      buildStationAssetFilename({
        station: 'Nick',
        kind: 'bumper-more',
        targetSeconds: 8,
        variant: 1,
      })
    ).toThrow('Show is required')
  })

  test('parses the documented Nick filename contract', () => {
    expect(
      parseStationAssetFilename(
        'nick__bumper-now-next__now-spongebob-squarepants-1999__next-the-fairly-oddparents-2001__target-12s__v05.mp4'
      )
    ).toEqual({
      station: 'nick',
      kind: 'bumper-now-next',
      now: 'spongebob-squarepants-1999',
      next: 'the-fairly-oddparents-2001',
      targetSeconds: 12,
      variant: 5,
    })
    expect(
      parseStationAssetFilename('nick__bumper-more__v01.mp4')
    ).toBeNull()
  })

  test('rejects contradictory or duplicate semantic fields', () => {
    expect(
      parseStationAssetFilename(
        'nick__ident-general__show-spongebob-squarepants-1999__v01.mp4'
      )
    ).toBeNull()
    expect(
      parseStationAssetFilename(
        'nick__bumper-up-next__next-spongebob__next-rugrats__v01.mp4'
      )
    ).toBeNull()
    expect(looksLikeStationAssetFilename('Nick Generic Bumper.mp4')).toBe(false)
    expect(looksLikeStationAssetFilename('nick__bumper-typo__v01.mp4')).toBe(true)
  })

  test('prefers exact now-next, then more, up-next, and general assets', () => {
    const items = [
      asset(1, 'nick__ident-general__target-08s__v01.mp4'),
      asset(2, 'nick__bumper-up-next__next-spongebob-squarepants-1999__target-08s__v01.mp4'),
      asset(3, 'nick__bumper-more__show-spongebob-squarepants-1999__target-08s__v01.mp4'),
      asset(4, 'nick__bumper-now-next__now-spongebob-squarepants-1999__next-the-fairly-oddparents-2001__target-08s__v01.mp4'),
    ]
    expect(
      selectStationTransitionAsset(items, {
        station: 'nick',
        currentShow: 'rugrats-1991',
        nextShow: 'spongebob-squarepants-1999',
        followingShow: 'the-fairly-oddparents-2001',
        seed: 'one',
      })?.id
    ).toBe(4)
    expect(
      selectStationTransitionAsset(items, {
        station: 'nick',
        currentShow: 'spongebob-squarepants-1999',
        nextShow: 'spongebob-squarepants-1999',
        seed: 'two',
      })?.id
    ).toBe(3)
  })

  test('uses fillers before standby and never borrows another station asset', () => {
    const items = [
      asset(1, 'cbbc__filler-general__target-30s__v01.mp4', 30),
      asset(2, 'nick__standby-loop__target-60s__v01.mp4', 60),
      asset(3, 'nick__filler-general__target-15s__v01.mp4', 15),
      asset(4, 'nick__filler-general__target-30s__v01.mp4', 30),
    ]
    /* The point is the station and the kind, not which of the two eligible
       nick fillers wins: with a length band rather than a strict maximum both
       qualify, so pinning one id would be asserting a hash outcome. */
    const chosen = selectStationFillerAsset(items, 'nick', 40, 'gap')
    expect([3, 4]).toContain(chosen?.id ?? -1)
    expect(chosen?.id).not.toBe(1) // another station's filler
    expect(chosen?.id).not.toBe(2) // standby, only used when no filler exists
    expect(stationShowKey('The Fairly OddParents (2001)')).toBe(
      'the-fairly-oddparents-2001'
    )
  })

  test('does not treat a malformed structured filename as a legacy bumper', () => {
    const malformed = asset(1, 'cbbc__bumper-typo__v01.mp4')
    expect(
      selectStationTransitionAsset([malformed], {
        station: 'nick',
        currentShow: 'rugrats-1991',
        nextShow: 'spongebob-squarepants-1999',
        seed: 'invalid',
      })
    ).toBeUndefined()
  })
})

describe('filling a long gap', () => {
  /* Reproduces what Nickelodeon actually aired: a 14m21s hole between a
     programme ending at 08:45:39 and the next slot at 09:00, filled with the
     same 28s clip thirty times. The library had 190 fillers available; the
     selector collapsed to "longest that fits" and exactly one asset is 28s,
     so the varying seed never had a choice to make. */
  const library = [
    asset(1, 'nick__filler-general__target-28s__v01.mp4', 28),
    asset(2, 'nick__filler-general__target-19s__v01.mp4', 19),
    asset(3, 'nick__filler-general__target-19s__v02.mp4', 19),
    asset(4, 'nick__filler-general__target-18s__v01.mp4', 18),
    asset(5, 'nick__filler-general__target-10s__v01.mp4', 10),
    asset(6, 'nick__filler-general__target-5s__v01.mp4', 5),
  ]

  function fillGap(seconds: number): Array<{ id: number; seconds: number }> {
    const played: Array<{ id: number; seconds: number }> = []
    const recent: string[] = []
    let remaining = seconds
    while (remaining > 0 && played.length < 200) {
      const chosen = selectStationFillerAsset(
        library,
        'nick',
        remaining,
        `nick|${remaining}|filler`,
        recent
      )
      if (!chosen) break
      recent.push(chosen.filename)
      if (recent.length > 3) recent.shift()
      const seconds = Math.min(chosen.durationSeconds, remaining)
      played.push({ id: chosen.id, seconds })
      remaining -= seconds
    }
    return played
  }

  test('does not play the same clip over and over', () => {
    const played = fillGap(861) // the real gap: 14m21s

    expect(played.length).toBeGreaterThan(0)
    // Nothing back to back.
    for (let index = 1; index < played.length; index += 1) {
      expect(played[index]?.id).not.toBe(played[index - 1]?.id)
    }
    // And more than one clip did the work.
    expect(new Set(played.map((item) => item.id)).size).toBeGreaterThan(2)
  })

  test('still fills the gap exactly, without overrunning the slot', () => {
    const played = fillGap(861)
    expect(played.reduce((total, item) => total + item.seconds, 0)).toBe(861)
  })

  test('a station with only one usable filler still fills the gap', () => {
    // The no-repeat rule must not deadlock a thin library.
    const single = [asset(1, 'nick__filler-general__target-10s__v01.mp4', 10)]
    const recent: string[] = []
    let remaining = 30
    let plays = 0
    while (remaining > 0 && plays < 10) {
      const chosen = selectStationFillerAsset(single, 'nick', remaining, `s|${remaining}`, recent)
      if (!chosen) break
      recent.push(chosen.filename)
      remaining -= Math.min(chosen.durationSeconds, remaining)
      plays += 1
    }
    expect(remaining).toBe(0)
    expect(plays).toBe(3)
  })

  test('when nothing fits, truncates the shortest rather than a long clip', () => {
    // A 2s remainder should cut a 5s clip, not carve 2s out of a 28s one.
    expect(selectStationFillerAsset(library, 'nick', 2, 'tail')?.id).toBe(6)
  })
})
