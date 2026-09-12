import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface AudioNormalizationSettings { enabled: boolean; nightMode: boolean }
export interface LoudnessMeasurement { integrated: number; peak: number; silent?: boolean }
interface CachedMeasurement extends LoudnessMeasurement { size: number; mtime: number }

/** Measure stereo output once; applying gain never waits for the measurement. */
export class AudioNormalizationService {
  private readonly cache = new Map<string, CachedMeasurement>()
  private readonly queue = new Map<string, { path: string; stream: number }>()
  private readonly checked = new Map<string, number>()
  private worker: Promise<void> | null = null
  private active: string | null = null
  private failures = 0
  private abort = new AbortController()
  constructor(private readonly file: string,
    readonly settings: () => Promise<AudioNormalizationSettings>,
    private readonly analyze: (path: string, stream: number, signal?: AbortSignal) => Promise<LoudnessMeasurement> = measureLoudness) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      for (const [key, value] of Object.entries(saved).slice(-5000)) {
        const row = value as CachedMeasurement
        if (/^[a-f0-9]{64}$/.test(key) && [row.integrated, row.peak, row.size, row.mtime].every(Number.isFinite)) this.cache.set(key, row)
      }
    } catch { /* Empty or unavailable cache: playback remains usable. */ }
  }
  status() { return { measured: this.cache.size, queued: this.queue.size, analyzing: this.active !== null, failures: this.failures } }
  pauseAnalysis() { this.abort.abort(); this.queue.clear(); this.abort = new AbortController() }
  async stop() { this.abort.abort(); this.queue.clear(); await this.whenIdle() }
  whenIdle() { return this.worker ?? Promise.resolve() }
  filter(path: string, stream: number, settings: AudioNormalizationSettings): string {
    if (!settings.enabled && !settings.nightMode) return ''
    const key = createHash('sha256').update(JSON.stringify([path, stream, 'stereo-v1'])).digest('hex')
    if (settings.enabled && !this.abort.signal.aborted && Date.now() - (this.checked.get(key) ?? 0) > 60000 && !this.queue.has(key) && this.active !== key && this.queue.size < 100) {
      this.queue.set(key, { path, stream })
      if (!this.worker) {
        this.worker = this.run().finally(() => { this.worker = null })
      }
    }
    const row = settings.enabled && this.checked.has(key) ? this.cache.get(key) : undefined
    const filters: string[] = []
    if (row) {
      // -18 LUFS target, -2 dBTP ceiling, at most +12 dB boost.
      const gain = row.silent === true ? 0 : Math.max(-60, Math.min(12, -18 - row.integrated, -2 - row.peak))
      filters.push(`volume=${gain.toFixed(3)}dB`)
    }
    if (settings.nightMode) filters.push('acompressor=threshold=0.125:ratio=4:attack=20:release=250:makeup=1')
    filters.push('alimiter=limit=0.794328:level=false:latency=1')
    return filters.join(',') + ','
  }
  private async run() {
    while (this.queue.size) {
      const [key, job] = this.queue.entries().next().value!
      this.queue.delete(key); this.active = key
      try {
        if (!(await this.settings()).enabled) { this.queue.clear(); break }
        const before = await stat(job.path)
        const old = this.cache.get(key)
        if (!old || old.size !== before.size || old.mtime !== before.mtimeMs) {
          this.cache.delete(key)
          const result = await this.analyze(job.path, job.stream, this.abort.signal)
          const after = await stat(job.path)
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Source changed during audio analysis')
          if (![result.integrated, result.peak].every(Number.isFinite)) throw new Error('No measurable audio')
          this.cache.delete(key)
          this.cache.set(key, { ...result, size: after.size, mtime: after.mtimeMs })
          while (this.cache.size > 5000) this.cache.delete(this.cache.keys().next().value!)
          await mkdir(dirname(this.file), { recursive: true })
          await writeFile(this.file + '.tmp', JSON.stringify(Object.fromEntries(this.cache)), { mode: 0o600 })
          await rename(this.file + '.tmp', this.file)
        }
      } catch { this.cache.delete(key); this.failures++ /* No analysis failure may interrupt playback. */ }
      finally {
        this.checked.set(key, Date.now()); this.active = null
        while (this.checked.size > 5000) this.checked.delete(this.checked.keys().next().value!)
      }
    }
  }
}

export async function measureLoudness(path: string, stream: number, signal?: AbortSignal): Promise<LoudnessMeasurement> {
  if (signal?.aborted) throw new Error('Audio analysis stopped')
  const child = Bun.spawn(['ffmpeg', '-nostdin', '-hide_banner', '-nostats', '-threads', '1', '-filter_threads', '1',
    '-readrate', '8', '-i', path, '-map', `0:a:${stream}`, '-vn', '-sn', '-dn',
    '-af', 'aformat=sample_rates=48000:channel_layouts=stereo,loudnorm=I=-18:TP=-2:LRA=11:print_format=json', '-f', 'null', '-'],
    { stdout: 'ignore', stderr: 'pipe' })
  const cancel = () => { child.kill() }
  signal?.addEventListener('abort', cancel, { once: true })
  const timeout = setTimeout(cancel, 30 * 60000)
  try {
    const [output, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
    if (code !== 0) throw new Error('Audio analysis failed')
    const match = output.match(/\{\s*"input_i"[\s\S]*?\}/g)?.pop()
    if (!match) throw new Error('Audio measurement missing')
    const data = JSON.parse(match)
    if (data.input_i === '-inf') return { integrated: -70, peak: Number.isFinite(Number(data.input_tp)) ? Number(data.input_tp) : -70, silent: true }
    return { integrated: Number(data.input_i), peak: Number(data.input_tp) }
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel) }
}
