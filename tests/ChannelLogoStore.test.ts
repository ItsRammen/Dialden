import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChannelLogoStore } from '../src/services/ChannelLogoStore'

describe('ChannelLogoStore', () => {
  test('stores a bounded PNG under the server-controlled channel path', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-channel-logo-'))
    try {
      const store = new ChannelLogoStore(directory)
      const pngBytes = new Uint8Array(24)
      pngBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      new DataView(pngBytes.buffer).setUint32(16, 64)
      new DataView(pngBytes.buffer).setUint32(20, 64)
      const png = new File(
        [pngBytes],
        'kids.png',
        { type: 'image/png' }
      )

      const path = await store.save('kids', png)

      expect(path).toBe(join(directory, 'kids.png'))
      expect(store.has('kids')).toBe(true)
      expect(readFileSync(path)[0]).toBe(0x89)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('rejects non-PNG data and unsafe channel identifiers', async () => {
    const store = new ChannelLogoStore(join(tmpdir(), 'unused-channel-logos'))
    await expect(
      store.save('kids', new File(['not png'], 'logo.png'))
    ).rejects.toThrow('valid PNG')
    expect(() => store.path('../escape')).toThrow('not safe')
    expect(() => store.path('kids', '../escape')).toThrow('not safe')
  })

  test('stores and lists scheduled variants without exposing arbitrary paths', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-channel-variants-'))
    try {
      const store = new ChannelLogoStore(directory)
      const bytes = new Uint8Array(24)
      bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      new DataView(bytes.buffer).setUint32(16, 64)
      new DataView(bytes.buffer).setUint32(20, 64)
      await store.save('kids', new File([bytes], 'nick.png'), 'nick')
      await store.save('kids', new File([bytes], 'adult-swim.png'), 'adult-swim')
      expect(store.variants('kids')).toEqual(['adult-swim', 'nick'])
      expect(store.has('kids', 'nick')).toBe(true)
      store.remove('kids')
      expect(store.variants('kids')).toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  /*
   * The repair itself is covered in LogoBackgroundStripper.test.ts. These two
   * pin the wiring: every logo write goes through save(), so a logo saved with
   * a painted background comes out transparent by default, and the opt-out
   * genuinely reaches the disk untouched.
   */
  async function whiteCardPng(): Promise<Uint8Array> {
    const width = 32
    const height = 32
    const pixels = new Uint8Array(width * height * 4)
    for (let index = 0; index < width * height; index += 1) {
      const inMark = index % width >= 10 && index % width < 22 &&
        Math.floor(index / width) >= 10 && Math.floor(index / width) < 22
      pixels[index * 4] = inMark ? 40 : 255
      pixels[index * 4 + 1] = inMark ? 80 : 255
      pixels[index * 4 + 2] = inMark ? 200 : 255
      pixels[index * 4 + 3] = 255
    }
    const proc = Bun.spawn(
      [
        'ffmpeg', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba',
        '-s', `${width}x${height}`, '-i', 'pipe:0',
        '-frames:v', '1', '-c:v', 'png', '-f', 'image2', 'pipe:1',
      ],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }
    )
    proc.stdin.write(pixels)
    await proc.stdin.end()
    const png = new Uint8Array(await new Response(proc.stdout).arrayBuffer())
    await proc.exited
    return png
  }

  test('repairs a painted-on background by default', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-logo-repair-'))
    try {
      const png = await whiteCardPng()
      const store = new ChannelLogoStore(directory)
      const path = await store.save('kids', new File([png], 'kids.png'))

      const stored = readFileSync(path)
      expect(stored[0]).toBe(0x89)
      // Colour type 6 is RGBA: the flattened card came in without an alpha
      // channel and is written back with one.
      expect(stored.readUInt8(25)).toBe(6)
      expect(stored.length).not.toBe(png.length)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('stores the upload byte for byte when the background is kept', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-logo-keep-'))
    try {
      const png = await whiteCardPng()
      const store = new ChannelLogoStore(directory)
      const path = await store.save(
        'kids', new File([png], 'kids.png'), undefined, { keepBackground: true }
      )

      expect(Buffer.compare(readFileSync(path), Buffer.from(png))).toBe(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
