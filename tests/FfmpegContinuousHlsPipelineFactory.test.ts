import { describe, expect, test } from 'bun:test'
import { FfmpegContinuousHlsPipelineFactory } from '../src/services/FfmpegContinuousHlsPipelineFactory'
import type { ChannelPipelineRequest } from '../src/services/ContinuousChannelWorkerManager'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

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
  test('keeps QSV-hinted inputs in system memory for the software concat graph', () => {
    const value = request()
    const first = { ...value.sequence[0]!, decodeHint: 'hw' as const }
    const second = { ...value.sequence[1]!, decodeHint: 'sw' as const }
    const third = { ...value.sequence[2]! }
    const factory = new FfmpegContinuousHlsPipelineFactory(
      'ffmpeg',
      undefined,
      undefined,
      () => 1_787_500_000_000,
      {
        configuredMode: 'intel-qsv',
        activeBackend: 'intel-qsv',
        hardwareAcceleration: true,
        device: '/dev/dri/renderD129',
      }
    )
    const command = factory.command({
      ...value,
      position: first,
      sequence: [first, second, third],
    })

    expect(command.filter((value) => value === '-i')).toHaveLength(3)
    expect(command).not.toContain('-hwaccel')
    expect(command).toContain('h264_qsv')
  })

  test('ignores hardware decode hints in software mode', () => {
    const value = request()
    const sequence = value.sequence.map((item) => ({
      ...item,
      decodeHint: 'hw' as const,
    }))
    const command = new FfmpegContinuousHlsPipelineFactory().command({
      ...value,
      sequence,
    })
    expect(command).not.toContain('-hwaccel')
  })

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
    expect(command.slice(command.indexOf('-preset'), command.indexOf('-preset') + 2)).toEqual([
      '-preset',
      'superfast',
    ])
    expect(command).toContain('aac')
  })

  test('uses Intel QSV for encode-only acceleration', () => {
    const factory = new FfmpegContinuousHlsPipelineFactory(
      'ffmpeg',
      undefined,
      undefined,
      () => 1_787_500_000_000,
      {
        configuredMode: 'intel-qsv',
        activeBackend: 'intel-qsv',
        hardwareAcceleration: true,
        device: '/dev/dri/renderD129',
      }
    )
    const command = factory.command(request())
    const graph = command[command.indexOf('-filter_complex') + 1] ?? ''

    expect(command).toContain('vaapi=va:/dev/dri/renderD129')
    expect(command).toContain('qsv=qs@va')
    expect(command).toContain('h264_qsv')
    expect(command).not.toContain('libx264')
    expect(command).not.toContain('zerolatency')
    expect(graph).toContain('[joinedv]realtime=speed=1,format=nv12[outv]')
    expect(command[command.indexOf('-pix_fmt') + 1]).toBe('nv12')
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

  test('never burns a logo into the normalized video feed', () => {
    const command = new FfmpegContinuousHlsPipelineFactory().command(request())

    expect(command).not.toContain('-loop')
    expect(command).not.toContain('/data/channel-logos/kids.png')
    const graph = command[command.indexOf('-filter_complex') + 1] ?? ''
    expect(graph).not.toContain('overlay=')
    expect(graph).not.toContain('[brand')
    expect(command.filter((value) => value === '-i')).toHaveLength(3)
    expect(graph).toContain('[joinedv]realtime=speed=1[outv]')
  })

  test('probes unknown audio layouts concurrently and caches them per source', async () => {
    const commands: Array<readonly string[]> = []
    const probed: string[] = []
    const probes = new Map<string, ReturnType<typeof deferred<boolean>>>()
    const factory = new FfmpegContinuousHlsPipelineFactory(
      'ffmpeg',
      {
        spawn: (command) => {
          commands.push(command)
          return { exited: Promise.resolve(0), kill: () => {} }
        },
      },
      {
        hasAudio: (path) => {
          probed.push(path)
          const pending = deferred<boolean>()
          probes.set(path, pending)
          return pending.promise
        },
      },
      () => 1_787_500_000_000
    )
    const starting = factory.start(request())
    await Promise.resolve()
    expect(probed).toEqual(['/media/a.mkv', '/media/bumper.mp4', '/media/b.mkv'])
    for (const [path, pending] of probes) pending.resolve(!path.includes('bumper'))
    await starting
    await factory.start(request())
    expect(probed).toHaveLength(3)
    expect(commands[0]).toContain('anullsrc=r=48000:cl=stereo')
  })

  test('expires cached audio layouts so an in-place media replacement is re-probed', async () => {
    let now = 1_787_500_000_000
    let probes = 0
    const factory = new FfmpegContinuousHlsPipelineFactory(
      'ffmpeg',
      {
        spawn: () => ({ exited: Promise.resolve(0), kill: () => {} }),
      },
      {
        hasAudio: async () => {
          probes += 1
          return true
        },
      },
      () => now
    )

    await factory.start(request())
    await factory.start(request())
    expect(probes).toBe(3)

    now += 10 * 60_000 + 1
    await factory.start(request())
    expect(probes).toBe(6)
  })

  test('shares one stop promise until the FFmpeg process has actually exited', async () => {
    const exited = deferred<number>()
    let kills = 0
    const value = request()
    const sequence = value.sequence.map((item) => ({ ...item, hasAudio: true }))
    const factory = new FfmpegContinuousHlsPipelineFactory(
      'ffmpeg',
      {
        spawn: () => ({
          exited: exited.promise,
          kill: () => {
            kills += 1
          },
        }),
      }
    )
    const handle = await factory.start({
      ...value,
      position: sequence[0]!,
      sequence,
    })

    const first = handle.stop()
    const second = handle.stop()
    expect(kills).toBe(1)

    exited.resolve(0)
    await Promise.all([first, second])
    expect(kills).toBe(1)
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
