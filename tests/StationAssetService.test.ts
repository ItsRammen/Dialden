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
    ['filler--generic-break-in', { kind: 'filler-general' }],
    ['standby--generic-standby', { kind: 'standby-loop' }],
  ] as const)('recognizes Nickstory v5 export %s', (fields, expected) => {
    expect(parseStationAssetFilename(`nickelodeon--${fields}--2008--NHD12095-11-2.m4v`)).toEqual({ station: 'nick', ...expected })
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
    expect(selectStationFillerAsset(items, 'nick', 40, 'gap')?.id).toBe(4)
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
