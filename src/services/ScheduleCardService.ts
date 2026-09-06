import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ScheduledProgram } from './ChannelService'

export interface ScheduleCardRequest {
  channelName: string
  timezone: string
  program: ScheduledProgram
  programs: readonly ScheduledProgram[]
  logoPath?: string
}

/** Text comes from the final guide, never from an independently rebuilt lineup. */
export function scheduleCardLines(request: ScheduleCardRequest): string[] {
  const at = Date.parse(request.program.scheduledEnd)
  const upcoming = request.programs.filter((p) =>
    !p.generated && (p.type === 'program' || p.type === 'movie' || p.type === 'short') &&
    Date.parse(p.scheduledStart) >= at)
  const hour = upcoming.filter((p) => Date.parse(p.scheduledStart) < at + 3_600_000)
  const pool = hour.length ? hour : upcoming.slice(0, 1)
  const page = Math.floor(Date.parse(request.program.scheduledStart) / 30_000) % Math.max(1, Math.ceil(pool.length / 4))
  const time = new Intl.DateTimeFormat('en', { timeZone: request.timezone, hour: 'numeric', minute: '2-digit' })
  const clean = (value: string, max: number) => {
    const text = value.replace(/[\r\n\t]+/g, ' ').trim()
    return text.length > max ? text.slice(0, max - 1) + '…' : text
  }
  return [clean(request.channelName, 42), hour.length ? 'COMING UP IN THE NEXT HOUR' : 'COMING UP',
    ...pool.slice(page * 4, page * 4 + 4).map((p) =>
      time.format(new Date(p.scheduledStart)) + '   ' + clean(p.collectionTitle || p.title, 48)),
    ...(pool.length ? [] : ['No upcoming programs in this guide window.']),
  ]
}

/** Serialized software renders; no extra GPU sessions. Cached outside the media library. */
export class ScheduleCardService {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly pending = new Map<string, Promise<string>>()
  constructor(private readonly directory: string, private readonly ffmpeg = 'ffmpeg') {}

  async resolve(request: ScheduleCardRequest): Promise<string> {
    const lines = scheduleCardLines(request)
    const duration = request.program.sourceDurationSeconds
    if (!Number.isFinite(duration) || duration <= 0 || duration > 60) throw new Error('Invalid schedule card duration')
    const logo = request.logoPath && existsSync(request.logoPath) ? request.logoPath : undefined
    const logoVersion = logo ? (await stat(logo)).mtimeMs : null
    const key = createHash('sha256').update(JSON.stringify(['card-v1', lines, duration, logo, logoVersion])).digest('hex')
    const output = join(this.directory, key + '.mp4')
    if (existsSync(output)) return output
    const existing = this.pending.get(key)
    if (existing) return existing
    const task = this.queue.catch(() => {}).then(async () => {
      if (existsSync(output)) return output
      await this.render(lines, duration, logo, output)
      return output
    })
    this.pending.set(key, task)
    this.queue = task
    try { return await task } finally { this.pending.delete(key) }
  }

  private async render(lines: string[], duration: number, logo: string | undefined, output: string): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const work = await mkdtemp(join(this.directory, '.render-'))
    try {
      const font = ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/TTF/DejaVuSans.ttf', '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf'].find(existsSync)
      if (!font) throw new Error('No font available for schedule cards')
      await copyFile(font, join(work, 'font.ttf'))
      for (let i = 0; i < lines.length; i++) await writeFile(join(work, `line${i}.txt`), lines[i]!)
      const filters = lines.map((_, i) => `drawtext=fontfile=font.ttf:textfile=line${i}.txt:expansion=none:fontcolor=${i === 1 ? '0x70b7ff' : 'white'}:fontsize=${i === 0 ? 42 : i === 1 ? 24 : 30}:x=64:y=${i === 0 ? 55 : i === 1 ? 135 : 215 + (i - 2) * 82}`)
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=0x0b1220:s=1280x720:r=30', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']
      if (logo) {
        await copyFile(logo, join(work, 'logo.png'))
        args.push('-i', 'logo.png', '-filter_complex_threads', '1', '-filter_complex', `[0:v]${filters.join(',')}[card];[2:v]scale=112:80:force_original_aspect_ratio=decrease[logo];[card][logo]overlay=W-w-48:40[v]`, '-map', '[v]', '-map', '1:a')
      } else args.push('-vf', filters.join(','), '-filter_threads', '1')
      args.push('-t', String(duration), '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', 'card.mp4')
      const process = Bun.spawn([this.ffmpeg, ...args], { cwd: work, stdout: 'ignore', stderr: 'pipe' })
      const timeout = setTimeout(() => process.kill('SIGKILL'), 45_000)
      try {
        const [code, detail] = await Promise.all([process.exited, new Response(process.stderr).text()])
        if (code !== 0) throw new Error(`Schedule card render failed (${code}): ${detail.slice(-1000)}`)
      } finally { clearTimeout(timeout) }
      await rename(join(work, 'card.mp4'), output)
      // Old cards cannot be in a current 30-second playback window.
      for (const name of await readdir(this.directory)) {
        if (!/^[a-f0-9]{64}\.mp4$/.test(name)) continue
        const path = join(this.directory, name)
        if (Date.now() - (await stat(path)).mtimeMs > 86_400_000) await rm(path, { force: true })
      }
    } finally { await rm(work, { recursive: true, force: true }) }
  }
}
