import { describe, expect, test } from 'bun:test'
import {
  FfmpegHardwareHlsPipelineFactory,
  fitWithin,
} from '../src/services/FfmpegHardwareHlsPipelineFactory'
import type {
  ChannelPipelineRequest,
  ChannelTimelinePosition,
  ContinuousHlsProfile,
} from '../src/services/ContinuousChannelWorkerManager'

/*
 * The graph cannot be executed here -- it needs the media engine -- so these
 * pin the command that gets built. Every assertion corresponds to something
 * scripts/qsv-capability-probe.sh measured on the deployed box.
 */

const QSV = { activeBackend: 'intel-qsv', device: '/dev/dri/renderD128' } as never
const SOFTWARE = { activeBackend: 'software' } as never

const PROFILE: ContinuousHlsProfile = {
  videoCodec: 'h264',
  audioCodec: 'aac',
  audioChannels: 2,
  segmentSeconds: 2,
  playlistWindowSegments: 8,
  maximumWidth: 1920,
  maximumHeight: 1080,
}

function item(over: Partial<ChannelTimelinePosition> = {}): ChannelTimelinePosition {
  return {
    scheduleItemId: 'item-1',
    sourcePath: '/media/tv/show.mkv',
    sourceOffsetSeconds: 0,
    sourceDurationSeconds: 60,
    hasAudio: true,
    decodeHint: 'hw',
    sourceWidth: 1920,
    sourceHeight: 1080,
    timelineRevision: 'rev',
    type: 'program',
    ...over,
  } as ChannelTimelinePosition
}

function request(sequence: ChannelTimelinePosition[]): ChannelPipelineRequest {
  return {
    channelId: 'nick-jr',
    sequence,
    position: sequence[0],
    profile: PROFILE,
    outputDirectory: '/tmp/out',
    playlistPath: '/tmp/out/live.m3u8',
    appendToExistingPlaylist: false,
  } as unknown as ChannelPipelineRequest
}

function factory(status = QSV): FfmpegHardwareHlsPipelineFactory {
  return new FfmpegHardwareHlsPipelineFactory(
    'ffmpeg',
    { spawn: () => ({}) } as never,
    { hasAudio: async () => true, selectAudioStream: async () => 0 } as never,
    () => 1_700_000_000_000,
    status
  )
}

const graph = (command: string[]): string =>
  command[command.indexOf('-filter_complex') + 1] ?? ''

describe('hardware HLS pipeline', () => {
  test('decodes on the media engine and never copies frames back', () => {
    const command = factory().command(request([item()]))

    expect(command).toContain('-hwaccel')
    expect(command).toContain('qsv')
    expect(command.join(' ')).toContain('-hwaccel qsv -hwaccel_output_format qsv')
    expect(command.join(' ')).toContain('-c:v h264_qsv')
    // A download back to system memory would defeat the point.
    expect(graph(command)).not.toContain('hwdownload')
  })

  test('every vpp_qsv converts to nv12', () => {
    /* Not an optimisation: a 10-bit source decodes to P010 and h264_qsv then
       writes zero packets and reports no error at all. Measured. */
    const command = factory().command(
      request([item(), item({ scheduleItemId: 'b', sourceWidth: 640, sourceHeight: 480 })])
    )
    const passes = graph(command).match(/vpp_qsv=[^,;[\]]*/g) ?? []

    expect(passes.length).toBeGreaterThan(0)
    for (const pass of passes) expect(pass).toContain('format=nv12')
  })

  test('letterboxes a 4:3 source by compositing, since vpp_qsv cannot pad', () => {
    const command = factory().command(
      request([item({ sourceWidth: 640, sourceHeight: 480 })])
    )
    const chains = graph(command)

    // 640x480 into 1920x1080 fits as 1440x1080, centred with 240px bars.
    expect(chains).toContain('vpp_qsv=w=1440:h=1080')
    expect(chains).toContain('overlay_qsv=x=240:y=0')
    // The background is an input, not a filter node; the graph references it.
    expect(chains).toMatch(/\[\d+:v:0\]format=nv12,hwupload/)
    expect(command.join(' ')).toContain('color=black:size=1920x1080:rate=30')
  })

  test('a source that already fills the frame is not composited', () => {
    const chains = graph(factory().command(request([item()])))

    expect(chains).toContain('vpp_qsv=w=1920:h=1080')
    expect(chains).not.toContain('overlay_qsv')
    expect(chains).not.toContain('color=black')
  })

  test('one ineligible item sends the whole window to software', () => {
    /* concat cannot mix hardware and software frames, so eligibility is a
       property of the window rather than of each item. */
    const mixed = request([item(), item({ scheduleItemId: 'b', decodeHint: 'sw' })])
    const command = factory().command(mixed)

    expect(factory().eligible(mixed)).toBe(false)
    expect(command.join(' ')).not.toContain('-hwaccel qsv')
    // The software pipeline still uses QSV for the encode alone.
    expect(command.join(' ')).toContain('-c:v h264_qsv')
    expect(graph(command)).toContain('scale=1920:1080')
  })

  test('a source of unknown geometry is not eligible', () => {
    // The letterbox offset is fixed at build time, so it must be known.
    const unknown = request([item({ sourceWidth: undefined, sourceHeight: undefined })])

    expect(factory().eligible(unknown)).toBe(false)
    expect(factory().command(unknown).join(' ')).not.toContain('-hwaccel qsv')
  })

  test('falls back when the box is not running QSV at all', () => {
    expect(factory(SOFTWARE).eligible(request([item()]))).toBe(false)
  })

  test('imposes no concurrency limit', () => {
    /* 48 concurrent full-hardware sessions ran clean on the deployed box, so a
       ceiling here would be invention -- and would hide the real failure. */
    const many = Array.from({ length: 12 }, (_, index) =>
      item({ scheduleItemId: `item-${index}` })
    )
    expect(factory().eligible(request(many))).toBe(true)
    expect(graph(factory().command(request(many)))).toContain('concat=n=12')
  })

  test('keeps the silent-source and offset handling of the software pipeline', () => {
    const command = factory().command(
      request([
        item({ hasAudio: false, sourceDurationSeconds: 30, sourceOffsetSeconds: 12.5 }),
      ])
    )

    expect(command.join(' ')).toContain('anullsrc=r=48000:cl=stereo')
    expect(command.join(' ')).toContain('-ss 12.5')
  })

  test('a silent source with no duration is still refused', () => {
    expect(() =>
      factory().command(
        request([item({ hasAudio: false, sourceDurationSeconds: undefined })])
      )
    ).toThrow('needs a source duration')
  })
})

describe('fitWithin', () => {
  test('fills the frame when the aspect already matches', () => {
    expect(fitWithin(1920, 1080, 1920, 1080)).toEqual({
      width: 1920, height: 1080, x: 0, y: 0, pad: false,
    })
    expect(fitWithin(1280, 720, 1920, 1080).pad).toBe(false)
  })

  test('pillarboxes 4:3 and letterboxes wider-than-16:9', () => {
    expect(fitWithin(640, 480, 1920, 1080)).toEqual({
      width: 1440, height: 1080, x: 240, y: 0, pad: true,
    })
    expect(fitWithin(1920, 960, 1920, 1080)).toEqual({
      width: 1920, height: 960, x: 0, y: 60, pad: true,
    })
  })

  test('never produces an odd dimension or offset', () => {
    // The encoder works in chroma pairs; an odd width fails outright.
    for (const [w, h] of [[623, 479], [1441, 1079], [999, 333], [17, 5]]) {
      const fit = fitWithin(w as number, h as number, 1920, 1080)
      expect(fit.width % 2).toBe(0)
      expect(fit.height % 2).toBe(0)
      expect(fit.x % 2).toBe(0)
      expect(fit.y % 2).toBe(0)
      expect(fit.width).toBeLessThanOrEqual(1920)
      expect(fit.height).toBeLessThanOrEqual(1080)
    }
  })
})
