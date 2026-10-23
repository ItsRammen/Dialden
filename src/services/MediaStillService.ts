import { createHash } from 'node:crypto'
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { ResolvedMediaFile } from './MediaDeliveryService'

export type StillRenderer = (source: string, output: string) => Promise<boolean>

async function renderStill(source: string, output: string): Promise<boolean> {
  // One software decoder, bounded runtime; never reserve the TV streaming encoder.
  for (const seek of ['5', '0']) {
    const process = Bun.spawn(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-y', '-threads', '1', '-ss', seek, '-i', source, '-an', '-sn', '-dn',
      '-frames:v', '1', '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
      '-filter_threads', '1', '-threads', '1', '-q:v', '2', output],
      { stdout: 'ignore', stderr: 'ignore' })
    const timer = setTimeout(() => process.kill('SIGKILL'), 8000)
    let code: number
    try { code = await process.exited } finally { clearTimeout(timer) }
    if (code === 0 && await Bun.file(output).size > 0) return true
  }
  return false
}

/** One representative still per source revision, shared by all clients. */
export class MediaStillService {
  private active: Promise<void> | undefined
  private failed = new Map<string, number>()
  constructor(private readonly directory: string, private readonly render: StillRenderer = renderStill) {}

  async request(file: ResolvedMediaFile): Promise<{ path: string; etag: string } | null> {
    const key = createHash('sha256').update(JSON.stringify([2, file.path, file.size, file.lastModified.getTime()])).digest('hex')
    const path = join(this.directory, `${key}.jpg`)
    try { if ((await stat(path)).size > 0) return { path, etag: `"${key}"` } } catch {}
    if (this.active || (this.failed.get(key) ?? 0) > Date.now()) return null
    // Assign before any further await so bursts cannot spawn parallel decoders.
    this.active = (async () => {
      const temp = join(this.directory, `${key}.pending.jpg`)
      try {
        await mkdir(this.directory, { recursive: true })
        if (!await this.render(file.path, temp)) throw new Error('Still unavailable')
        if ((await stat(temp)).size <= 0) throw new Error('Empty still')
        await rename(temp, path)
        this.failed.delete(key)
        await this.prune()
      } catch {
        if (this.failed.size >= 128) this.failed.clear()
        this.failed.set(key, Date.now() + 60_000)
      } finally {
        await unlink(temp).catch(() => {})
      }
    })().finally(() => { this.active = undefined })
    return null
  }

  /** Also used for orderly shutdown/testing. */
  async idle(): Promise<void> { await this.active }

  private async prune(): Promise<void> {
    const names = (await readdir(this.directory)).filter(name => /^[a-f0-9]{64}\.jpg$/.test(name))
    if (names.length <= 500) return
    const entries = await Promise.all(names.map(async name => ({ name, modified: (await stat(join(this.directory, name))).mtimeMs })))
    entries.sort((a,b) => a.modified-b.modified)
    await Promise.all(entries.slice(0, entries.length-500).map(item => unlink(join(this.directory,item.name))))
  }
}
