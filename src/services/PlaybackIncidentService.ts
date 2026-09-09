import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface PlaybackIncident { clientId: string; receivedAt: string; id: string; event: string; [key: string]: string | number | null }
const events = new Set(['stall', 'media-error', 'recovery-started', 'recovered', 'playback-failed', 'tuning-timeout'])
/** Bounded persistent incident ring. No media URLs, paths or raw error strings. */
export class PlaybackIncidentService {
  private rows: PlaybackIncident[] = []
  private queue: Promise<void> = Promise.resolve()
  constructor(private readonly path: string, private readonly context?: (channelId: string) => Record<string, string | number | null>) {
    try { if (existsSync(path)) { const rows = JSON.parse(readFileSync(path, 'utf8')); if (Array.isArray(rows)) this.rows = rows.slice(-500) } } catch { /* Start a fresh ring if the old diagnostic file is unreadable. */ }
  }
  snapshot(): PlaybackIncident[] { return this.rows.filter((row) => Date.parse(row.receivedAt) >= Date.now() - 7 * 86400000).reverse() }
  async record(clientId: string, input: unknown): Promise<string[]> {
    if (!Array.isArray(input)) return []
    const batch: PlaybackIncident[] = []
    for (const raw of input.slice(0, 2)) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id.length > 100 || !events.has(raw.event)) continue
      const row: PlaybackIncident = { clientId, id: raw.id, event: raw.event, receivedAt: new Date().toISOString() }
      for (const key of ['channelId', 'programId', 'timelineRevision', 'sessionId', 'version']) if (typeof raw[key] === 'string') row[key] = raw[key].slice(0, 100)
      for (const key of ['clientTimeMs', 'estimatedServerTimeMs', 'mediaTime', 'bufferAhead', 'readyState', 'networkState', 'frames', 'droppedFrames', 'errorCode', 'recoveryMs']) if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) row[key] = raw[key]
      if (typeof row.channelId === 'string' && this.context) Object.assign(row, this.context(row.channelId))
      batch.push(row)
    }
    const task = this.queue.catch(() => {}).then(async () => {
      const fresh = batch.filter((row) => !this.rows.some((old) => old.clientId === row.clientId && old.id === row.id))
      if (!fresh.length) return
      const cutoff = Date.now() - 7 * 86400000
      const next = [...this.rows, ...fresh].filter((row) => Date.parse(row.receivedAt) >= cutoff).slice(-500)
      await mkdir(dirname(this.path), { recursive: true })
      await writeFile(this.path + '.tmp', JSON.stringify(next), { mode: 0o600 })
      await rename(this.path + '.tmp', this.path)
      this.rows = next
    })
    this.queue = task
    await task
    return batch.map((row) => row.id)
  }
}
