import { describe, expect, test } from 'bun:test'
import {
  cacheKeyFor,
  resolveBumper,
} from '../src/services/bumpers/resolveBumper'
import {
  DEFAULT_BUMPER_RENDER,
  buildBumperArgs,
  escapeDrawText,
  fitHeadline,
} from '../src/services/bumpers/renderSpec'
import {
  DEFAULT_CHANNEL_BUMPER_CONFIG,
  type BumperContext,
  type ChannelBumperConfig,
} from '../src/services/bumpers/types'

const channel = { channelId: 'kids', channelName: 'Toast Kids' }

function context(overrides: Partial<BumperContext> = {}): BumperContext {
  return {
    ...channel,
    now: { title: 'SpongeBob SquarePants', collectionId: 10 },
    next: { title: 'Jimmy Neutron', collectionId: 20 },
    ...overrides,
  }
}

describe('which bumper belongs to a moment', () => {
  test('a file assigned to the programme starting wins outright', () => {
    // Somebody made this for this moment. Nothing generated beats that.
    const config: ChannelBumperConfig = {
      ...DEFAULT_CHANNEL_BUMPER_CONFIG,
      channelFile: { path: '/b/house.mp4', durationSeconds: 5 },
      collectionFiles: {
        20: { path: '/b/jimmy.mp4', durationSeconds: 4, collectionId: 20 },
      },
    }

    const plan = resolveBumper(context(), config)
    expect(plan.source).toBe('file')
    expect(plan.source === 'file' && plan.file.path).toBe('/b/jimmy.mp4')
  })

  test('the programme starting beats the one that just ended', () => {
    /* The announcement is about what you are staying for, so a SpongeBob
       clip does not play over the announcement of Jimmy Neutron. */
    const config: ChannelBumperConfig = {
      ...DEFAULT_CHANNEL_BUMPER_CONFIG,
      collectionFiles: {
        10: { path: '/b/spongebob.mp4', durationSeconds: 4, collectionId: 10 },
        20: { path: '/b/jimmy.mp4', durationSeconds: 4, collectionId: 20 },
      },
    }

    const plan = resolveBumper(context(), config)
    expect(plan.source === 'file' && plan.file.path).toBe('/b/jimmy.mp4')
  })

  test('falls back to the channel clip when no collection matches', () => {
    const config: ChannelBumperConfig = {
      ...DEFAULT_CHANNEL_BUMPER_CONFIG,
      channelFile: { path: '/b/house.mp4', durationSeconds: 5 },
      collectionFiles: {
        99: { path: '/b/other.mp4', durationSeconds: 4, collectionId: 99 },
      },
    }

    const plan = resolveBumper(context(), config)
    expect(plan.source === 'file' && plan.file.path).toBe('/b/house.mp4')
  })

  test('generates one when nothing is assigned', () => {
    const plan = resolveBumper(context(), DEFAULT_CHANNEL_BUMPER_CONFIG)

    expect(plan.source).toBe('generated')
    if (plan.source !== 'generated') throw new Error('expected generated')
    expect(plan.kind).toBe('now-next')
    expect(plan.text.eyebrow).toBe('That was SpongeBob SquarePants')
    expect(plan.text.headline).toBe('Jimmy Neutron')
  })

  test('announces only what follows when nothing preceded it', () => {
    // The first programme of a slot has no "that was".
    const plan = resolveBumper(
      context({ now: undefined }),
      DEFAULT_CHANNEL_BUMPER_CONFIG
    )

    if (plan.source !== 'generated') throw new Error('expected generated')
    expect(plan.kind).toBe('up-next')
    expect(plan.text.eyebrow).toBe('Up next')
    expect(plan.text.headline).toBe('Jimmy Neutron')
  })

  test('falls back to the station when nothing follows', () => {
    /* Saying "up next" with nothing to name would be a lie, and saying "now"
       about a programme that has ended reads as a mistake. */
    const plan = resolveBumper(
      context({ next: undefined }),
      DEFAULT_CHANNEL_BUMPER_CONFIG
    )

    if (plan.source !== 'generated') throw new Error('expected generated')
    expect(plan.kind).toBe('ident')
    expect(plan.text.headline).toBe('Toast Kids')
  })

  test('respects a channel that wants only its own name', () => {
    const plan = resolveBumper(context(), {
      ...DEFAULT_CHANNEL_BUMPER_CONFIG,
      defaultKind: 'ident',
    })

    if (plan.source !== 'generated') throw new Error('expected generated')
    expect(plan.kind).toBe('ident')
  })

  test('does nothing at all when switched off', () => {
    const plan = resolveBumper(context(), {
      ...DEFAULT_CHANNEL_BUMPER_CONFIG,
      enabled: false,
      channelFile: { path: '/b/house.mp4', durationSeconds: 5 },
    })

    expect(plan.source).toBe('none')
  })

  test('the same announcement renders once', () => {
    const first = resolveBumper(context(), DEFAULT_CHANNEL_BUMPER_CONFIG)
    const second = resolveBumper(context(), DEFAULT_CHANNEL_BUMPER_CONFIG)
    if (first.source !== 'generated' || second.source !== 'generated') {
      throw new Error('expected generated')
    }

    expect(first.cacheKey).toBe(second.cacheKey)
  })

  test('a different pairing renders separately', () => {
    const a = resolveBumper(context(), DEFAULT_CHANNEL_BUMPER_CONFIG)
    const b = resolveBumper(
      context({ next: { title: 'Danny Phantom', collectionId: 30 } }),
      DEFAULT_CHANNEL_BUMPER_CONFIG
    )
    if (a.source !== 'generated' || b.source !== 'generated') {
      throw new Error('expected generated')
    }

    expect(a.cacheKey).not.toBe(b.cacheKey)
  })

  test('recolouring the channel invalidates the cached render', () => {
    const plain = cacheKeyFor(
      'ident',
      { headline: 'Toast Kids' },
      DEFAULT_CHANNEL_BUMPER_CONFIG
    )
    const painted = cacheKeyFor('ident', { headline: 'Toast Kids' }, {
      ...DEFAULT_CHANNEL_BUMPER_CONFIG,
      accent: '0x00ff00',
    })

    expect(plain).not.toBe(painted)
  })
})

describe('the ffmpeg command', () => {
  const options = {
    ...DEFAULT_BUMPER_RENDER,
    fontFile: '/fonts/station.ttf',
    outputPath: '/cache/abc.mp4',
  }

  test('escapes what drawtext would otherwise read as syntax', () => {
    /* A colon separates drawtext options, a quote ends a value, a backslash
       escapes, and a percent starts an expansion. A programme title can
       contain all four. */
    expect(escapeDrawText("Bob's Burgers: 6.30")).toBe(
      "Bob\\'s Burgers\\: 6.30"
    )
    expect(escapeDrawText('100% Wolf')).toBe('100\\% Wolf')
    expect(escapeDrawText('back\\slash')).toBe('back\\\\slash')
  })

  test('keeps a long title on the screen', () => {
    const long = 'The Great Big Extremely Long Programme Title That Runs On'
    expect(fitHeadline(long).length).toBeLessThanOrEqual(34)
    expect(fitHeadline(long).endsWith('…')).toBe(true)
    expect(fitHeadline('Jimmy Neutron')).toBe('Jimmy Neutron')
  })

  test('renders every line it was given', () => {
    const args = buildBumperArgs(
      'now-next',
      {
        eyebrow: 'That was SpongeBob',
        headline: 'Jimmy Neutron',
        support: 'Starting at 18:30',
      },
      options
    )
    const filter = args[args.indexOf('-vf') + 1] ?? ''

    // The eyebrow is set in caps, as station captions are.
    expect(filter).toContain('THAT WAS SPONGEBOB')
    expect(filter).toContain('Jimmy Neutron')
    expect(filter).toContain('Starting at 18\\:30')
  })

  test('draws the station logo inside the title-safe corner', () => {
    const args = buildBumperArgs(
      'up-next',
      { headline: 'Jimmy Neutron' },
      { ...options, logoPath: '/logos/nick.png' }
    )
    /* Two video inputs cannot go through -vf, so a card carrying a logo is
       built as a filter graph and mapped explicitly. */
    expect(args).not.toContain('-vf')
    expect(args[args.indexOf('-i') + 1]).toBe(
      'color=c=0x0b0705:s=1920x1080:d=6:r=25'
    )
    expect(args).toContain('/logos/nick.png')
    const graph = args[args.indexOf('-filter_complex') + 1] ?? ''
    expect(graph).toContain('[2:v]scale=230:-1[logo]')
    /* Inside the safe area rather than against the edge: a television
       overscans, and the true corner is the first thing cropped. */
    expect(graph).toContain('overlay=x=W-w-96:y=H-h-54')
    // The audio still has to be carried through explicitly.
    expect(args).toContain('-map')
    expect(args[args.lastIndexOf('-map') + 1]).toBe('1:a')
  })

  test('keeps the simpler command when there is no logo', () => {
    const args = buildBumperArgs('ident', { headline: 'Toast Kids' }, options)
    expect(args).toContain('-vf')
    expect(args).not.toContain('-filter_complex')
  })

  test('always writes an audio track', () => {
    /* A segment with no audio stream makes the player reconfigure in the
       middle of a channel, which is the stall this product exists to avoid. */
    const args = buildBumperArgs('ident', { headline: 'Toast Kids' }, options)

    expect(args).toContain('anullsrc=channel_layout=stereo:sample_rate=48000')
    expect(args).toContain('aac')
  })

  test('is a fixed length regardless of the filter graph', () => {
    const args = buildBumperArgs('ident', { headline: 'Toast Kids' }, options)

    expect(args[args.indexOf('-t') + 1]).toBe('6')
    expect(args[args.length - 1]).toBe('/cache/abc.mp4')
  })

  test('uses the font it was handed rather than a system default', () => {
    // drawtext has no fontconfig in this container, so a name would fail.
    const args = buildBumperArgs('ident', { headline: 'Toast Kids' }, options)
    const filter = args[args.indexOf('-vf') + 1] ?? ''

    expect(filter).toContain('fontfile=/fonts/station.ttf')
  })
})
