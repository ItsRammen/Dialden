import { describe, expect, test } from 'bun:test'
import { LogoBackgroundStripper } from '../src/services/LogoBackgroundStripper'

/*
 * These build real PNGs through ffmpeg rather than using fixtures, so the test
 * exercises the same decode/encode path the server uses. The shapes are the
 * ones that actually turned up on channel logos: a transparency checkerboard
 * flattened into pixels, a flat white card, and -- the case a colour key gets
 * wrong -- a mark with its own white lettering enclosed inside it.
 */

const WIDTH = 64
const HEIGHT = 64

async function encodePng(pixels: Uint8Array): Promise<Uint8Array> {
  const proc = Bun.spawn(
    [
      'ffmpeg', '-v', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${WIDTH}x${HEIGHT}`, '-i', 'pipe:0',
      '-frames:v', '1', '-c:v', 'png', '-f', 'image2', 'pipe:1',
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }
  )
  proc.stdin.write(pixels)
  await proc.stdin.end()
  const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer())
  await proc.exited
  return out
}

async function decodePng(bytes: Uint8Array): Promise<Uint8Array> {
  const proc = Bun.spawn(
    ['ffmpeg', '-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }
  )
  proc.stdin.write(bytes)
  await proc.stdin.end()
  const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer())
  await proc.exited
  return out
}

function blank(): Uint8Array {
  return new Uint8Array(WIDTH * HEIGHT * 4)
}

function set(pixels: Uint8Array, x: number, y: number, r: number, g: number, b: number): void {
  const offset = (y * WIDTH + x) * 4
  pixels[offset] = r
  pixels[offset + 1] = g
  pixels[offset + 2] = b
  pixels[offset + 3] = 255
}

function alphaAt(pixels: Uint8Array, x: number, y: number): number {
  return pixels[(y * WIDTH + x) * 4 + 3]!
}

/** A checkerboard background with a solid orange disc in the middle. */
function checkerboardWithMark(): Uint8Array {
  const pixels = blank()
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const light = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0
      set(pixels, x, y, light ? 255 : 238, light ? 255 : 238, light ? 255 : 238)
    }
  }
  const cx = WIDTH / 2
  const cy = HEIGHT / 2
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= 18 ** 2) set(pixels, x, y, 244, 126, 32)
    }
  }
  return pixels
}

describe('LogoBackgroundStripper', () => {
  test('clears a transparency checkerboard that was flattened into the pixels', async () => {
    const png = await encodePng(checkerboardWithMark())
    const result = await new LogoBackgroundStripper().strip(png, WIDTH, HEIGHT)

    expect(result.changed).toBe(true)
    const pixels = await decodePng(result.bytes)
    // Corners were checkerboard, so they go.
    expect(alphaAt(pixels, 0, 0)).toBe(0)
    expect(alphaAt(pixels, WIDTH - 1, HEIGHT - 1)).toBe(0)
    // The mark itself stays.
    expect(alphaAt(pixels, WIDTH / 2, HEIGHT / 2)).toBe(255)
  })

  test('keeps white that is enclosed by the mark, which a colour key would erase', async () => {
    /* The Nickelodeon logo is exactly this shape: white lettering sitting
       inside an orange splat, the same #FFFFFF as the background around it.
       Only the background reaches the border, so only the background goes. */
    const pixels = checkerboardWithMark()
    for (let y = 30; y < 34; y += 1) {
      for (let x = 28; x < 36; x += 1) set(pixels, x, y, 255, 255, 255)
    }
    const png = await encodePng(pixels)
    const result = await new LogoBackgroundStripper().strip(png, WIDTH, HEIGHT)

    expect(result.changed).toBe(true)
    const out = await decodePng(result.bytes)
    expect(alphaAt(out, 31, 31)).toBe(255)
    expect(alphaAt(out, 0, 0)).toBe(0)
  })

  test('clears a flat white card', async () => {
    const pixels = blank()
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) set(pixels, x, y, 255, 255, 255)
    }
    for (let y = 20; y < 44; y += 1) {
      for (let x = 20; x < 44; x += 1) set(pixels, x, y, 40, 80, 200)
    }
    const result = await new LogoBackgroundStripper().strip(
      await encodePng(pixels), WIDTH, HEIGHT
    )

    expect(result.changed).toBe(true)
    const out = await decodePng(result.bytes)
    expect(alphaAt(out, 0, 0)).toBe(0)
    expect(alphaAt(out, 32, 32)).toBe(255)
  })

  test('leaves a logo that already carries real transparency alone', async () => {
    const pixels = checkerboardWithMark()
    pixels[3] = 0
    const png = await encodePng(pixels)
    const result = await new LogoBackgroundStripper().strip(png, WIDTH, HEIGHT)

    expect(result.changed).toBe(false)
    expect(result.reason).toBe('already has transparency')
    expect(result.bytes).toBe(png)
  })

  test('leaves a logo with a dark or busy border alone', async () => {
    const pixels = blank()
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) set(pixels, x, y, 12, 24, 60)
    }
    const result = await new LogoBackgroundStripper().strip(
      await encodePng(pixels), WIDTH, HEIGHT
    )

    expect(result.changed).toBe(false)
    expect(result.reason).toBe('border is not a painted background')
  })

  test('refuses to consume an image that is background all the way through', async () => {
    const pixels = blank()
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) set(pixels, x, y, 255, 255, 255)
    }
    const result = await new LogoBackgroundStripper().strip(
      await encodePng(pixels), WIDTH, HEIGHT
    )

    expect(result.changed).toBe(false)
    expect(result.reason).toBe('background would consume the image')
  })

  test('returns the upload untouched when it cannot be decoded', async () => {
    const bytes = new Uint8Array(24)
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const result = await new LogoBackgroundStripper().strip(bytes, 64, 64)

    expect(result.changed).toBe(false)
    expect(result.reason).toBe('could not decode')
    expect(result.bytes).toBe(bytes)
  })
})
