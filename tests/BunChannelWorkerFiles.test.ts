import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
      let resolved = false
      const readiness = files
        .waitForFreshSegment(directory, minimumModifiedAt, undefined, 2)
        .then(() => {
          resolved = true
        })

      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(resolved).toBe(false)
      writeFileSync(join(directory, 'segment-0000000000002.ts'), 'second')
      await readiness
      expect(resolved).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
