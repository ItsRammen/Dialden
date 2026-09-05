/**
 * Repairs channel logos that arrive with their background painted on.
 *
 * Logos pulled from stock-image sites are routinely saved with the editor's
 * transparency checkerboard baked in as real pixels, or flattened onto a white
 * card. Both look correct in a file browser and wrong the moment they sit on
 * the app's dark chrome, which is where every channel logo is shown.
 *
 * The repair has to be an edge-connected flood fill rather than a colour key.
 * Keying out white globally would erase the white lettering inside a logo --
 * the Nickelodeon wordmark sits enclosed in the splat and is the same #FFFFFF
 * as the checkerboard around it. Only the background reaches the border, so
 * only the background is filled.
 *
 * There is no image library in the dependency tree and this deliberately does
 * not add one: ffmpeg is already a hard requirement of the server and already
 * used to turn a logo PNG into raw pixels for the mpv overlay, so it does the
 * codec work here too and the algorithm stays in plain TypeScript.
 *
 * Every failure path returns the original bytes. A logo that cannot be
 * decoded, or that does not clearly carry a painted background, is stored
 * exactly as uploaded -- this must never be a way to lose an upload.
 */

/** How far a pixel may sit from a sampled background colour and still be it. */
const COLOUR_TOLERANCE = 30
/** A background tone is light and close to neutral; logo colours are not. */
const MIN_BACKGROUND_CHANNEL = 200
const MAX_BACKGROUND_SPREAD = 28
/** More distinct border tones than this is a photo, not a painted backdrop. */
const MAX_BACKGROUND_TONES = 4
/** Guard rails: filling nearly everything, or nearly nothing, is a misfire. */
const MIN_FILLED_FRACTION = 0.02
const MAX_FILLED_FRACTION = 0.98

export interface LogoStripResult {
  readonly bytes: Uint8Array
  readonly changed: boolean
  /** Why the image was left alone, for logging and tests. */
  readonly reason: string
}

interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

function isBackgroundTone({ r, g, b }: Rgb): boolean {
  if (r < MIN_BACKGROUND_CHANNEL || g < MIN_BACKGROUND_CHANNEL || b < MIN_BACKGROUND_CHANNEL) {
    return false
  }
  return Math.max(r, g, b) - Math.min(r, g, b) <= MAX_BACKGROUND_SPREAD
}

function matches(pixels: Uint8Array, offset: number, tone: Rgb): boolean {
  return (
    Math.abs(pixels[offset]! - tone.r) <= COLOUR_TOLERANCE &&
    Math.abs(pixels[offset + 1]! - tone.g) <= COLOUR_TOLERANCE &&
    Math.abs(pixels[offset + 2]! - tone.b) <= COLOUR_TOLERANCE
  )
}

/** Runs ffmpeg with `input` on stdin and returns stdout, or null if it fails. */
async function runFfmpeg(args: string[], input: Uint8Array): Promise<Uint8Array | null> {
  try {
    const proc = Bun.spawn(['ffmpeg', '-v', 'error', ...args], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    proc.stdin.write(input)
    await proc.stdin.end()
    const output = new Uint8Array(await new Response(proc.stdout).arrayBuffer())
    await proc.exited
    if (proc.exitCode !== 0 || output.length === 0) return null
    return output
  } catch {
    return null
  }
}

export class LogoBackgroundStripper {
  /**
   * Returns a PNG with the painted background made transparent, or the
   * original bytes when the image does not carry one.
   */
  async strip(bytes: Uint8Array, width: number, height: number): Promise<LogoStripResult> {
    const unchanged = (reason: string): LogoStripResult => ({ bytes, changed: false, reason })

    if (width < 2 || height < 2) return unchanged('image too small to have a border')

    const pixels = await runFfmpeg(
      ['-i', 'pipe:0', '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'],
      bytes
    )
    if (!pixels || pixels.length !== width * height * 4) return unchanged('could not decode')

    // A logo that already carries real transparency is left alone: whoever
    // made it has already said what should show through.
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index]! !== 255) return unchanged('already has transparency')
    }

    const tones = this.sampleBorderTones(pixels, width, height)
    if (tones === null) return unchanged('border is not a painted background')

    const filled = this.floodFillFromBorder(pixels, width, height, tones)
    const fraction = filled / (width * height)
    if (fraction < MIN_FILLED_FRACTION) return unchanged('no connected background to remove')
    if (fraction > MAX_FILLED_FRACTION) return unchanged('background would consume the image')

    const encoded = await runFfmpeg(
      [
        '-f', 'rawvideo', '-pix_fmt', 'rgba',
        '-s', `${width}x${height}`, '-i', 'pipe:0',
        '-frames:v', '1', '-c:v', 'png', '-f', 'image2', 'pipe:1',
      ],
      pixels
    )
    if (!encoded) return unchanged('could not re-encode')

    return { bytes: encoded, changed: true, reason: 'removed painted background' }
  }

  /**
   * Collects the distinct tones around the border. A checkerboard yields two,
   * a flat card one. Anything busier, or anything dark, is a real picture and
   * gets left alone.
   */
  private sampleBorderTones(
    pixels: Uint8Array,
    width: number,
    height: number
  ): Rgb[] | null {
    const tones: Rgb[] = []
    const consider = (x: number, y: number): boolean => {
      const offset = (y * width + x) * 4
      const tone = { r: pixels[offset]!, g: pixels[offset + 1]!, b: pixels[offset + 2]! }
      if (!isBackgroundTone(tone)) return false
      if (!tones.some((known) => matches(pixels, offset, known))) tones.push(tone)
      return tones.length <= MAX_BACKGROUND_TONES
    }

    for (let x = 0; x < width; x += 1) {
      if (!consider(x, 0) || !consider(x, height - 1)) return null
    }
    for (let y = 0; y < height; y += 1) {
      if (!consider(0, y) || !consider(width - 1, y)) return null
    }
    return tones.length > 0 ? tones : null
  }

  /**
   * Clears every background-coloured pixel reachable from the border, so
   * enclosed light areas -- a white wordmark inside a coloured mark -- survive.
   */
  private floodFillFromBorder(
    pixels: Uint8Array,
    width: number,
    height: number,
    tones: Rgb[]
  ): number {
    const total = width * height
    const seen = new Uint8Array(total)
    const stack: number[] = []

    const push = (index: number): void => {
      if (index < 0 || index >= total || seen[index] === 1) return
      const offset = index * 4
      if (!tones.some((tone) => matches(pixels, offset, tone))) return
      seen[index] = 1
      stack.push(index)
    }

    for (let x = 0; x < width; x += 1) {
      push(x)
      push((height - 1) * width + x)
    }
    for (let y = 0; y < height; y += 1) {
      push(y * width)
      push(y * width + width - 1)
    }

    let filled = 0
    while (stack.length > 0) {
      const index = stack.pop()!
      pixels[index * 4 + 3] = 0
      filled += 1
      const x = index % width
      if (x > 0) push(index - 1)
      if (x < width - 1) push(index + 1)
      push(index - width)
      push(index + width)
    }
    return filled
  }
}
