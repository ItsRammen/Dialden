/**
 * Turning a bumper into ffmpeg arguments.
 *
 * Kept apart from anything that runs a process, so the command can be asserted
 * character by character in a test rather than inspected by watching a video
 * come out. The escaping in particular deserves that: drawtext has its own
 * quoting rules, and a programme called "Bob's Burgers: 6.30" contains three
 * characters that each mean something to it.
 */
import type { BumperKind, BumperText } from './types'

export interface BumperRenderOptions {
  readonly width: number
  readonly height: number
  readonly durationSeconds: number
  /** A real font file. woff2 is not readable by drawtext. */
  readonly fontFile: string
  readonly background: string
  readonly foreground: string
  readonly accent: string
  /** Optional channel logo, drawn in the corner when present. */
  readonly logoPath?: string
  readonly outputPath: string
}

export const DEFAULT_BUMPER_RENDER: Omit<
  BumperRenderOptions,
  'fontFile' | 'outputPath'
> = {
  width: 1920,
  height: 1080,
  durationSeconds: 6,
  background: '0x0b0705',
  foreground: '0xf6ead9',
  accent: '0xffab2e',
}

/**
 * drawtext reads its text through its own parser, so a colon separates
 * options, a backslash escapes, and a single quote ends the value. Percent
 * introduces an expansion, which turns a title containing one into either an
 * error or somebody else's data.
 */
export function escapeDrawText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
}

/** Keeps a long programme title on screen instead of off the side of it. */
export function fitHeadline(value: string, limit = 34): string {
  const clean = value.replace(/\s+/gu, ' ').trim()
  return clean.length <= limit ? clean : clean.slice(0, limit - 1) + '…'
}

interface TextLine {
  readonly text: string
  readonly size: number
  readonly colour: string
  /** Offset from the vertical centre, in pixels. */
  readonly offset: number
}

function linesFor(
  kind: BumperKind,
  text: BumperText,
  options: BumperRenderOptions
): TextLine[] {
  const unit = options.height / 1080
  const lines: TextLine[] = []
  if (text.eyebrow) {
    lines.push({
      text: text.eyebrow.toLocaleUpperCase('en-GB'),
      size: Math.round(38 * unit),
      colour: options.accent,
      offset: Math.round(-120 * unit),
    })
  }
  lines.push({
    text: fitHeadline(text.headline),
    size: Math.round(kind === 'ident' ? 96 * unit : 84 * unit),
    colour: options.foreground,
    offset: Math.round(-10 * unit),
  })
  if (text.support) {
    lines.push({
      text: text.support,
      size: Math.round(34 * unit),
      colour: options.foreground,
      offset: Math.round(80 * unit),
    })
  }
  return lines
}

/**
 * The full argument vector. A silent audio track is included deliberately:
 * a segment with no audio stream at all forces the player to reconfigure
 * mid-channel, which is the stall this whole product exists to avoid.
 */
export function buildBumperArgs(
  kind: BumperKind,
  text: BumperText,
  options: BumperRenderOptions
): string[] {
  const lines = linesFor(kind, text, options)
  const filters = lines.map((line) => {
    const offset = line.offset >= 0 ? '+' + line.offset : String(line.offset)
    return [
      'drawtext=fontfile=' + escapeDrawText(options.fontFile),
      'text=' + escapeDrawText(line.text),
      'fontcolor=' + line.colour,
      'fontsize=' + line.size,
      'x=(w-text_w)/2',
      'y=(h-text_h)/2' + offset,
    ].join(':')
  })

  // A rule under the headline, in the same orange the interface uses.
  const ruleWidth = Math.round(options.width * 0.22)
  filters.push(
    [
      'drawbox=x=(w-' + ruleWidth + ')/2',
      'y=(h/2)+' + Math.round((options.height / 1080) * 40),
      'w=' + ruleWidth,
      'h=' + Math.max(2, Math.round((options.height / 1080) * 4)),
      'color=' + options.accent,
      't=fill',
    ].join(':')
  )

  /*
   * The logo sits inside the title-safe area rather than against the edge:
   * a television overscans, and a corner mark placed at the true corner is
   * the first thing to be cropped off the side of the picture.
   */
  const safeX = Math.round(options.width * 0.05)
  const safeY = Math.round(options.height * 0.05)
  const logoWidth = Math.round(options.width * 0.12)

  /* Two video inputs cannot be filtered with -vf, so a card carrying a logo is
     built with -filter_complex and mapped explicitly. Without one the simpler
     form is kept: it is the command every existing test asserts. */
  const video = options.logoPath
    ? [
        '-i', options.logoPath,
        '-filter_complex',
        '[0:v]' + filters.join(',') + '[card];' +
          '[2:v]scale=' + logoWidth + ':-1[logo];' +
          '[card][logo]overlay=' +
          'x=W-w-' + safeX + ':' +
          'y=H-h-' + safeY + '[v]',
        '-map', '[v]',
        '-map', '1:a',
      ]
    : ['-vf', filters.join(',')]

  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'lavfi',
    '-i',
    'color=c=' + options.background +
      ':s=' + options.width + 'x' + options.height +
      ':d=' + options.durationSeconds +
      ':r=25',
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    ...video,
    '-t', String(options.durationSeconds),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-g', '50',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ac', '2',
    '-ar', '48000',
    '-shortest',
    '-movflags', '+faststart',
    options.outputPath,
  ]
}
