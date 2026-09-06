import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScheduleCardService, scheduleCardLines, type ScheduleCardRequest } from '../src/services/ScheduleCardService'
import type { ScheduledProgram } from '../src/services/ChannelService'
const at = Date.parse('2026-09-06T10:00:00Z')
function item(id: number, minutes: number, title: string): ScheduledProgram {
  return { id: String(id), channelId: 'nick', mediaId: id, title, collectionTitle: title, type: 'program', scheduledStart: new Date(at + minutes * 60000).toISOString(), scheduledEnd: new Date(at + (minutes + 10) * 60000).toISOString(), durationSeconds: 600, durationMs: 600000, sourceStartSeconds: 0, sourceDurationSeconds: 600, transitionIn: 'hard_cut', transitionOut: 'hard_cut' }
}
function request(): ScheduleCardRequest {
  const card = { ...item(0, 0, 'Card'), generated: 'schedule-card' as const, type: 'bumper' as const, sourceDurationSeconds: 1, durationSeconds: 1, scheduledEnd: new Date(at + 1000).toISOString() }
  return { channelName: "Nick: 100% 'fun' \\ today", timezone: 'UTC', program: card, programs: [card, item(1, 1, "Bob's Burgers: 100% \\ now"), { ...item(3, 12, 'Do not announce an ident'), type: 'interlude' }, item(2, 22, 'Fairly OddParents'), item(4, 95, 'Too far away')] }
}
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
describe('schedule cards', () => {
  test('uses actual upcoming show times and excludes assets and distant programs', () => {
    const text = scheduleCardLines(request()).join('\n')
    expect(text).toContain('10:01 AM')
    expect(text).toContain('Fairly OddParents')
    expect(text).not.toContain('Do not announce')
    expect(text).not.toContain('Too far away')
    expect(text).not.toContain('\nCard')
  })
  test.skipIf(!Bun.which('ffmpeg') || !Bun.which('ffprobe'))('renders punctuation safely, includes audio, and reuses identical cached cards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'schedule-card-test-')); dirs.push(dir)
    const service = new ScheduleCardService(dir)
    const input = request()
    const [first, second] = await Promise.all([service.resolve(input), service.resolve(input)])
    expect(first).toBe(second)
    expect((await readdir(dir)).filter((name) => name.endsWith('.mp4'))).toHaveLength(1)
    const probe = Bun.spawn(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', first], { stdout: 'pipe', stderr: 'pipe' })
    const result = await new Response(probe.stdout).json() as { streams: Array<{ codec_type: string }>; format: { duration: string } }
    expect(await probe.exited).toBe(0)
    expect(result.streams.find((s) => s.codec_type === 'video')).toMatchObject({ codec_name: 'h264', width: 1280, height: 720 })
    expect(result.streams.find((s) => s.codec_type === 'audio')).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 })
    expect(Number(result.format.duration)).toBeCloseTo(1, 1)
    const changed = await service.resolve({ ...input, channelName: 'Different channel' })
    expect(changed).not.toBe(first)
  }, 15000)
})
