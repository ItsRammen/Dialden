import { test, expect } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FfmpegContinuousHlsPipelineFactory } from '../src/services/FfmpegContinuousHlsPipelineFactory'
import { LookaheadChannelPipelineFactory } from '../src/services/LookaheadChannelPipelineFactory'
import { parseSourcePlaylist } from '../src/services/VirtualTunerService'
import type { ChannelPipelineHandle, ChannelPipelineRequest } from '../src/services/ContinuousChannelWorkerManager'

// Opt-in because this exercises a real encoder and real-time media clocks.
test.skipIf(process.env.DIALDEN_FFMPEG_SMOKE !== '1')('real FFmpeg stages and resumes across a batch boundary without a cold-start gap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dialden-real-handoff-'))
  let handle: ChannelPipelineHandle | undefined
  try {
    const source = join(root, 'sample.mp4')
    const generate = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-c:a', 'aac', source],
      { stdout: 'ignore', stderr: 'inherit' })
    expect(await generate.exited).toBe(0)
    const position = { scheduleItemId: 'first', sourcePath: source, sourceOffsetSeconds: 0,
      sourceDurationSeconds: 8, hasAudio: true, timelineRevision: 'stable', type: 'program' as const }
    const input: ChannelPipelineRequest = { channelId: 'smoke', timelineStartMs: Date.now(),
      outputDirectory: root, playlistPath: join(root, 'index.m3u8'), playlistUrl: '/live', position,
      sequence: [position], appendToExistingPlaylist: false,
      profile: { videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2, segmentSeconds: 1,
        playlistWindowSegments: 16, maximumWidth: 320, maximumHeight: 180 } }
    handle = await new LookaheadChannelPipelineFactory(new FfmpegContinuousHlsPipelineFactory(), {
      async resolve() { return position },
      async resolveWindow() { return [{ ...position, scheduleItemId: 'next' }] },
    }, { leadMs: 8000, pollMs: 30 }).start(input)
    let lastSequence = -1
    let lastArrival = 0
    let maximumGap = 0
    let crossedBoundary = false
    let count = 0
    const deadline = Date.now() + 22000
    while (Date.now() < deadline && count < 12) {
      await Bun.sleep(50)
      let playlist
      try { playlist = parseSourcePlaylist(await readFile(input.playlistPath, 'utf8')) } catch { continue }
      for (const segment of playlist.segments) {
        if (segment.sourceSequence <= lastSequence) continue
        const at = Date.now()
        if (lastArrival) maximumGap = Math.max(maximumGap, at - lastArrival)
        lastArrival = at
        lastSequence = segment.sourceSequence
        count++
        crossedBoundary ||= segment.discontinuityBefore
        expect((await readFile(join(root, segment.sourceName))).length).toBeGreaterThan(0)
      }
    }
    console.info('Real FFmpeg handoff result', { count, crossedBoundary, maximumGapMs: maximumGap })
    expect(crossedBoundary).toBe(true)
    expect(count).toBeGreaterThanOrEqual(12)
    expect(maximumGap).toBeLessThan(2500)
  } finally { await handle?.stop(); await rm(root, { recursive: true, force: true }) }
}, 30000)
