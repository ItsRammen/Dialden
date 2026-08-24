import { describe, expect, test } from 'bun:test'
import { FfmpegContinuousHlsPipelineFactory } from '../src/services/FfmpegContinuousHlsPipelineFactory'
import type { ChannelPipelineRequest } from '../src/services/ContinuousChannelWorkerManager'

const request = (): ChannelPipelineRequest => ({
  channelId: 'kids',
  outputDirectory: '/data/streams/kids/live',
  playlistPath: '/data/streams/kids/live/index.m3u8',
  playlistUrl: '/api/v1/channels/kids/live/index.m3u8',
  appendToExistingPlaylist: true,
  position: {
    scheduleItemId: 'episode-a', sourcePath: '/media/a.mkv', sourceOffsetSeconds: 180,
    timelineRevision: 'r1', type: 'program',
  },
  sequence: [
    { scheduleItemId: 'episode-a', sourcePath: '/media/a.mkv', sourceOffsetSeconds: 180, sourceDurationSeconds: 900, timelineRevision: 'r1', type: 'program' },
    { scheduleItemId: 'bumper', sourcePath: '/media/bumper.mp4', sourceOffsetSeconds: 0, sourceDurationSeconds: 20, timelineRevision: 'r1', type: 'bumper' },
    { scheduleItemId: 'episode-b', sourcePath: '/media/b.mkv', sourceOffsetSeconds: 0, timelineRevision: 'r1', type: 'program' },
  ],
  profile: { videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2, segmentSeconds: 2, playlistWindowSegments: 20, maximumWidth: 1920, maximumHeight: 1080 },
})

describe('FfmpegContinuousHlsPipelineFactory', () => {
  test('builds one normalized graph for episode, bumper, and next episode', () => {
    const command = new FfmpegContinuousHlsPipelineFactory().command(request())
    expect(command.filter((value) => value === '-i')).toHaveLength(3)
    expect(command).toContain('/media/a.mkv')
    expect(command).toContain('/media/bumper.mp4')
    expect(command).toContain('/media/b.mkv')
    const graph = command[command.indexOf('-filter_complex') + 1] ?? ''
    expect(graph).toContain('concat=n=3:v=1:a=1')
    expect(graph).toContain('format=yuv420p')
    expect(graph).toContain('[joinedv]realtime=speed=1[outv]')
    expect(graph).toContain('[joineda]arealtime=speed=1[outa]')
    expect(command).toContain('libx264')
    expect(command).toContain('aac')
  })

  test('paces the joined timeline instead of independently pacing lookahead inputs', () => {
    const command = new FfmpegContinuousHlsPipelineFactory().command(request())
    expect(command).not.toContain('-re')
    expect(command).not.toContain('-readrate')
    const graph = command[command.indexOf('-filter_complex') + 1] ?? ''
    expect(graph.indexOf('concat=n=3:v=1:a=1')).toBeLessThan(graph.indexOf('realtime=speed=1'))
  })

  test('keeps a rolling append-only live playlist at the stable path', () => {
    const command = new FfmpegContinuousHlsPipelineFactory().command(request())
    expect(command[command.indexOf('-hls_flags') + 1]).toContain('append_list')
    expect(command[command.indexOf('-hls_flags') + 1]).toContain('delete_segments')
    expect(command).toContain('/data/streams/kids/live/segment-%013d.ts')
    expect(command).toContain('-start_number')
    expect(command.at(-1)).toBe('/data/streams/kids/live/index.m3u8')
  })

  test('burns a per-channel logo into the normalized video feed', () => {
    const command = new FfmpegContinuousHlsPipelineFactory().command({
      ...request(),
      overlay: {
        sourcePath: '/data/channel-logos/kids.png',
        opacity: 0.8,
        position: 8,
        x: 32,
        y: 24,
        sizePercent: 12,
      },
    })

    expect(command).toContain('/data/channel-logos/kids.png')
    expect(command.slice(0, command.indexOf('/data/channel-logos/kids.png'))).toContain('-loop')
    const graph = command[command.indexOf('-filter_complex') + 1] ?? ''
    expect(graph).toContain('colorchannelmixer=aa=0.8')
    expect(graph).toContain('scale=230:-1[brand0]')
    expect(graph).toContain('overlay=x=W-w-32:y=H-h-24:shortest=1')
    expect(graph).toContain('[joinedv]realtime=speed=1[outv]')
  })

  test('switches scheduled logos between lookahead items before concatenation', () => {
    const value = request()
    const first = {
      ...value.sequence[0]!,
      overlay: { sourcePath: '/logos/nick.png', opacity: 1, position: 2 as const, x: 20, y: 20, sizePercent: 10 },
    }
    const second = {
      ...value.sequence[1]!,
      overlay: { sourcePath: '/logos/adult-swim.png', opacity: 0.7, position: 8 as const, x: 30, y: 30, sizePercent: 15 },
    }
    const third = { ...value.sequence[2]!, overlay: null }
    const command = new FfmpegContinuousHlsPipelineFactory().command({
      ...value,
      position: first,
      sequence: [first, second, third],
    })
    const graph = command[command.indexOf('-filter_complex') + 1] ?? ''
    expect(command).toContain('/logos/nick.png')
    expect(command).toContain('/logos/adult-swim.png')
    expect(graph).toContain('[brand0]')
    expect(graph).toContain('[brand1]')
    expect(graph).toContain('[basev2]null[v2]')
    expect(graph.indexOf('[brand0]')).toBeLessThan(graph.indexOf('concat=n=3'))
  })

  test('probes unknown audio layouts once per source before spawning', async () => {
    const commands: Array<readonly string[]> = []
    const probed: string[] = []
    const factory = new FfmpegContinuousHlsPipelineFactory(
      'ffmpeg',
      {
        spawn: (command) => {
          commands.push(command)
          return { exited: Promise.resolve(0), kill: () => {} }
        },
      },
      {
        hasAudio: async (path) => {
          probed.push(path)
          return !path.includes('bumper')
        },
      },
      () => 1_787_500_000_000
    )
    await factory.start(request())
    expect(probed).toEqual(['/media/a.mkv', '/media/bumper.mp4', '/media/b.mkv'])
    expect(commands[0]).toContain('anullsrc=r=48000:cl=stereo')
  })

  test('synthesizes stereo audio for a known silent bumper', () => {
    const value = request()
    const silent = { ...value.sequence[1]!, hasAudio: false }
    const command = new FfmpegContinuousHlsPipelineFactory().command({ ...value, sequence: [value.sequence[0]!, silent, value.sequence[2]!] })
    expect(command).toContain('anullsrc=r=48000:cl=stereo')
    expect(command.filter((item) => item === '-i')).toHaveLength(4)
  })

  test('loops an emergency asset for the full missing schedule range', () => {
    const value = request()
    const fallback = {
      ...value.sequence[0]!,
      sourcePath: '/media/standby.mp4',
      sourceDurationSeconds: 900,
      loopSource: true,
      type: 'offair' as const,
    }
    const command = new FfmpegContinuousHlsPipelineFactory().command({
      ...value,
      position: fallback,
      sequence: [fallback],
    })

    expect(command.slice(0, command.indexOf('/media/standby.mp4'))).toContain(
      '-stream_loop'
    )
    expect(command).toContain('900')
  })
})
