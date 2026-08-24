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
})
