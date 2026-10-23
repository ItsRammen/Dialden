import { describe, test, expect } from 'bun:test'
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LookaheadChannelPipelineFactory } from '../src/services/LookaheadChannelPipelineFactory'
import { parseSourcePlaylist } from '../src/services/VirtualTunerService'
import type { ChannelPipelineRequest, ChannelPipelineHandle, ChannelPipelineExit } from '../src/services/ContinuousChannelWorkerManager'

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await Bun.sleep(10) }
  throw new Error('Timed out')
}

function request(directory: string): ChannelPipelineRequest {
  const position = { scheduleItemId: 'one', sourcePath: '/media/one.mp4', sourceOffsetSeconds: 0,
    sourceDurationSeconds: 10, timelineRevision: 'revision', type: 'program' as const }
  return { channelId: 'nick', timelineStartMs: 100000, outputDirectory: directory,
    playlistPath: join(directory, 'index.m3u8'), playlistUrl: '/live/index.m3u8', position,
    sequence: [position], appendToExistingPlaylist: false,
    profile: { videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2, segmentSeconds: 1,
      playlistWindowSegments: 8, maximumWidth: 640, maximumHeight: 360 } }
}

function fakeEncoder() {
  const jobs: { request: ChannelPipelineRequest; suspended: boolean; stopped: boolean;
    finish: (exit: ChannelPipelineExit) => void; handle: ChannelPipelineHandle }[] = []
  return {
    jobs,
    async start(value: ChannelPipelineRequest) {
      let finish!: (exit: ChannelPipelineExit) => void
      const completed = new Promise<ChannelPipelineExit>(resolve => { finish = resolve })
      const job = { request: value, suspended: false, stopped: false, finish, handle: {} as ChannelPipelineHandle }
      job.handle = { completed, suspend() { job.suspended = true }, resume() { job.suspended = false },
        stop() { job.stopped = true; finish({ code: 0 }) } }
      jobs.push(job)
      for (let i = 0; i < 3; i++) await writeFile(join(value.outputDirectory, `segment-${String(1000 + i).padStart(13, '0')}.ts`), `batch-${jobs.length}-${i}`)
      await writeFile(value.playlistPath, '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n' +
        [0, 1, 2].map(i => `#EXTINF:1,\nsegment-${String(1000 + i).padStart(13, '0')}.ts\n`).join(''))
      return job.handle
    },
  }
}

describe('lookahead pipeline publication', () => {
  test('bounds public segment retention while a worker stays alive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dialden-retention-'))
    const encoder = fakeEncoder()
    const input = request(directory)
    let handle: ChannelPipelineHandle | undefined
    try {
      handle = await new LookaheadChannelPipelineFactory(encoder, {
        async resolve() { return null }, async resolveWindow() { return [] },
      }, { pollMs: 5 }).start(input)
      await until(async () => { try { return (await readFile(input.playlistPath, 'utf8')).includes('#EXTINF') } catch { return false } })
      const batch = encoder.jobs[0]!.request
      const names = Array.from({ length: 50 }, (_, i) => `segment-${String(1003 + i).padStart(13, '0')}.ts`)
      for (const name of names) await writeFile(join(batch.outputDirectory, name), 'segment')
      await writeFile(batch.playlistPath, '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:3\n' + names.map(name => `#EXTINF:1,\n${name}\n`).join(''))
      await until(async () => parseSourcePlaylist(await readFile(input.playlistPath, 'utf8')).segments.length === 8)
      await until(async () => (await readdir(directory)).filter(name => name.endsWith('.ts')).length <= 40)
      const published = parseSourcePlaylist(await readFile(input.playlistPath, 'utf8'))
      for (const segment of published.segments) expect((await readFile(join(directory, segment.sourceName))).length).toBeGreaterThan(0)
    } finally { await handle?.stop(); await rm(directory, { recursive: true, force: true }) }
  })

  test('recovery preserves contiguous sequence numbers when the old window slides out', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dialden-recovery-'))
    const original = request(directory)
    const input = { ...original, appendToExistingPlaylist: true,
      profile: { ...original.profile, playlistWindowSegments: 3 } }
    let handle: ChannelPipelineHandle | undefined
    try {
      await writeFile(input.playlistPath, '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:42\n#EXTINF:1,\nsegment-0000000000042.ts\n')
      handle = await new LookaheadChannelPipelineFactory(fakeEncoder(), {
        async resolve() { return null }, async resolveWindow() { return [] },
      }, { pollMs: 5 }).start(input)
      await until(async () => parseSourcePlaylist(await readFile(input.playlistPath, 'utf8')).segments.length === 3)
      const parsed = parseSourcePlaylist(await readFile(input.playlistPath, 'utf8'))
      expect(parsed.segments.map(item => item.sourceSequence)).toEqual([43, 44, 45])
      expect(parsed.segments[0]!.discontinuityBefore).toBe(true)
    } finally { await handle?.stop(); await rm(directory, { recursive: true, force: true }) }
  })

  test('a prepared encoder failure never publishes its media', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dialden-failed-handoff-'))
    const encoder = fakeEncoder()
    const input = request(directory)
    let handle: ChannelPipelineHandle | undefined
    try {
      handle = await new LookaheadChannelPipelineFactory(encoder, {
        async resolve() { return null }, async resolveWindow() { return [input.position] },
      }, { leadMs: 30000, pollMs: 5 }).start(input)
      await until(() => encoder.jobs[1]?.suspended === true)
      encoder.jobs[1]!.finish({ code: 1, error: 'encoder failure' })
      encoder.jobs[0]!.finish({ code: 0 })
      expect((await handle.completed).code).toBe(1)
      const parsed = parseSourcePlaylist(await readFile(input.playlistPath, 'utf8'))
      expect(parsed.segments).toHaveLength(3)
      for (const segment of parsed.segments) {
        expect(await readFile(join(directory, segment.sourceName), 'utf8')).toStartWith('batch-1-')
      }
    } finally { await handle?.stop(); await rm(directory, { recursive: true, force: true }) }
  })

  test('prepares privately, preserves old segments, and commits a continuous playlist at batch EOF', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dialden-handoff-'))
    const encoder = fakeEncoder()
    const input = request(directory)
    const resolutions: number[] = []
    let handle: ChannelPipelineHandle | undefined
    try {
      const factory = new LookaheadChannelPipelineFactory(encoder, {
        async resolve() { return null },
        async resolveWindow(_id, at) {
          resolutions.push(at.getTime())
          return [{ ...input.position, scheduleItemId: 'two', sourcePath: '/media/two.mp4' }]
        },
      }, { leadMs: 30000, pollMs: 5 })
      handle = await factory.start(input)
      await until(() => encoder.jobs[1]?.suspended === true)
      const before = parseSourcePlaylist(await readFile(input.playlistPath, 'utf8'))
      expect(before.segments).toHaveLength(3)
      expect(resolutions[0]).toBe(110000)
      expect(await readFile(join(directory, before.segments[0]!.sourceName), 'utf8')).toBe('batch-1-0')
      encoder.jobs[0]!.finish({ code: 0 })
      await until(async () => parseSourcePlaylist(await readFile(input.playlistPath, 'utf8')).segments.length === 6)
      const after = parseSourcePlaylist(await readFile(input.playlistPath, 'utf8'))
      expect(after.segments.slice(0, 3)).toEqual([...before.segments])
      expect(after.segments[3]!.discontinuityBefore).toBe(true)
      expect(after.segments[3]!.sourceSequence).toBe(before.segments[2]!.sourceSequence + 1)
      expect(await readFile(join(directory, after.segments[3]!.sourceName), 'utf8')).toBe('batch-2-0')
      expect(encoder.jobs[1]!.suspended).toBe(false)
    } finally {
      await handle?.stop()
      expect(encoder.jobs.slice(1).every(job => job.stopped)).toBe(true)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('stopping a channel cancels both the live encoder and its paused successor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dialden-cancel-'))
    const encoder = fakeEncoder()
    const input = request(directory)
    try {
      const factory = new LookaheadChannelPipelineFactory(encoder, {
        async resolve() { return null }, async resolveWindow() { return [input.position] },
      }, { leadMs: 30000, pollMs: 5 })
      const handle = await factory.start(input)
      await until(() => encoder.jobs[1]?.suspended === true)
      await handle.stop()
      expect(encoder.jobs).toHaveLength(2)
      expect(encoder.jobs.every(job => job.stopped)).toBe(true)
      expect((await handle.completed).code).toBe(0)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test('does not prepare media from a changed schedule revision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dialden-revision-'))
    const encoder = fakeEncoder()
    const input = request(directory)
    try {
      const factory = new LookaheadChannelPipelineFactory(encoder, {
        async resolve() { return null }, async resolveWindow() { return [{ ...input.position, timelineRevision: 'new' }] },
      }, { leadMs: 30000, pollMs: 5 })
      const handle = await factory.start(input)
      encoder.jobs[0]!.finish({ code: 0 })
      expect((await handle.completed).code).toBe(0)
      expect(encoder.jobs).toHaveLength(1)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
