import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BunChannelWorkerFiles } from '../src/services/BunChannelWorkerFiles'

describe('BunChannelWorkerFiles', () => {
  test('waits for two fresh HLS segments before declaring a cold worker ready', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-hls-ready-'))
    try {
      const files = new BunChannelWorkerFiles()
      const minimumModifiedAt = Date.now() - 1_000
      writeFileSync(join(directory, 'segment-0000000000001.ts'), 'first')
      writeFileSync(
        join(directory, 'index.m3u8'),
        '#EXTM3U\n#EXTINF:1.0,\nsegment-0000000000001.ts\n'
      )
      let resolved = false
      const readiness = files
        .waitForFreshSegment(directory, minimumModifiedAt, undefined, 2)
        .then(() => {
          resolved = true
        })

      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(resolved).toBe(false)
      writeFileSync(join(directory, 'segment-0000000000002.ts'), 'second')
      writeFileSync(
        join(directory, 'index.m3u8'),
        '#EXTM3U\n#EXTINF:1.0,\nsegment-0000000000001.ts\n#EXTINF:1.0,\nsegment-0000000000002.ts\n'
      )
      await readiness
      expect(resolved).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('requires every counted playlist segment to be fresh and non-empty', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-hls-usable-'))
    try {
      const files = new BunChannelWorkerFiles()
      const minimumModifiedAt = Date.now() - 1_000
      const first = join(directory, 'segment-0000000000001.ts')
      const second = join(directory, 'segment-0000000000002.ts')
      writeFileSync(first, 'first')
      writeFileSync(second, '')
      const stale = new Date(minimumModifiedAt - 1_000)
      utimesSync(first, stale, stale)
      writeFileSync(
        join(directory, 'index.m3u8'),
        '#EXTM3U\n#EXTINF:1.0,\nsegment-0000000000001.ts\n#EXTINF:1.0,\nsegment-0000000000002.ts\n'
      )

      let resolved = false
      const readiness = files
        .waitForFreshSegment(directory, minimumModifiedAt, undefined, 2)
        .then(() => {
          resolved = true
        })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(resolved).toBe(false)

      writeFileSync(first, 'first-fresh')
      writeFileSync(second, 'second-fresh')
      await readiness
      expect(resolved).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('does not accept a torn playlist with an EXTINF missing its URI', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toasttv-hls-torn-'))
    try {
      const files = new BunChannelWorkerFiles()
      const minimumModifiedAt = Date.now() - 1_000
      writeFileSync(join(directory, 'segment-0000000000001.ts'), 'first')
      writeFileSync(join(directory, 'segment-0000000000002.ts'), 'second')
      writeFileSync(
        join(directory, 'index.m3u8'),
        '#EXTM3U\n#EXTINF:1.0,\nsegment-0000000000001.ts\n#EXTINF:1.0,\n'
      )

      let resolved = false
      const readiness = files
        .waitForFreshSegment(directory, minimumModifiedAt, undefined, 2)
        .then(() => {
          resolved = true
        })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(resolved).toBe(false)

      writeFileSync(
        join(directory, 'index.m3u8'),
        '#EXTM3U\n#EXTINF:1.0,\nsegment-0000000000001.ts\n#EXTINF:1.0,\nsegment-0000000000002.ts\n'
      )
      await readiness
      expect(resolved).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
