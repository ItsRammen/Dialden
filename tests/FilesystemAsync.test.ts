import { test, expect } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FilesystemClient } from '../src/clients/FilesystemClient'

test('async traversal preserves supported extensions, exclusions and errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'async-scan-'))
  const fs = new FilesystemClient()
  try {
    await mkdir(join(root, 'skip')); await mkdir(join(root, 'keep'))
    await writeFile(join(root, 'keep', 'movie.MKV'), '')
    await writeFile(join(root, 'skip', 'hidden.mkv'), '')
    await writeFile(join(root, 'other.txt'), '')
    expect(await fs.listFilesAsync(root, ['.mkv'], [join(root, 'skip')])).toEqual([join(root, 'keep', 'movie.MKV')])
    expect(await fs.getMtimeAsync(join(root, 'keep', 'movie.MKV'))).toBeGreaterThan(0)
    expect(await fs.getMtimeAsync(join(root, 'absent'))).toBeNull()
    await expect(fs.listFilesAsync(join(root, 'absent'), ['.mkv'])).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
