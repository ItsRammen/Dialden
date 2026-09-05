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

  test('states the broadcast frame rate rather than letting it be inferred', () => {
    /* Without it the graph reaches the muxer carrying no frame rate, FFmpeg
       assumes 25, and a 60-frame GOP yields a 2.4s segment against a 2s
       target -- observed on the deployed box before this was added. */
    const command = factory().command(request([item()]))

    expect(graph(command)).toContain('framerate=30')
    expect(command.join(' ')).toContain('-r 30')
    // The GOP is derived from the same rate, so segments land on the target.
    expect(command.join(' ')).toContain('-g 60')
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
    // The synthesized silence is bounded in the graph like everything else.
    expect(graph(command)).toContain('atrim=duration=30')
  })

  test('bounds each item in the graph rather than with an input -t', () => {
    /* Measured on the deployed box: an input duration on a hardware input,
       in a graph with other hardware inputs, makes FFmpeg reconcile through a
       software scaler it cannot apply to qsv frames, and nothing is written.
       One input alone is fine, which is why this read as contention for so
       long. trim/atrim in the graph produces real segments on the same files. */
    const command = factory().command(
      request([
        item({ sourceDurationSeconds: 30 }),
        item({ scheduleItemId: 'b', sourceWidth: 640, sourceHeight: 480, sourceDurationSeconds: 12 }),
      ])
    )
    const line = command.join(' ')

    expect(line).not.toContain('-t ')
    expect(graph(command)).toContain('trim=duration=30')
    expect(graph(command)).toContain('atrim=duration=30')
    expect(graph(command)).toContain('trim=duration=12')
    // -ss still belongs on the input; only the duration moved.
    expect(
      factory().command(request([item({ sourceOffsetSeconds: 8 })])).join(' ')
    ).toContain('-ss 8')
  })

  test('an item with no duration is not eligible', () => {
    // The bound is a trim in the graph, so a duration is required for it.
    const unbounded = request([item({ sourceDurationSeconds: undefined })])

    expect(factory().eligible(unbounded)).toBe(false)
    expect(factory().command(unbounded).join(' ')).not.toContain('-hwaccel qsv')
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

describe('pipeline failure reporting', () => {
  test('names the cause, not what it knocked over', async () => {
    /* A graph fault prints "Impossible to convert" and then thousands of bytes
       of pixel-format lists, after which every encoder reports -22. Searching
       backwards through a 2KB tail found only the encoder, so a filter-graph
       bug was reported as an audio encoder failure and cost hours. */
    const { __testing } = await import(
      '../src/services/FfmpegContinuousHlsPipelineFactory'
    )
    const stderr = [
      "Impossible to convert between the formats supported by the filter 'graph 0 input from stream 2:0' and the filter 'auto_scale_1'",
      'Pixel formats:',
      '  src: qsv',
      `  dst: ${Array.from({ length: 400 }, (_, i) => `fmt${i}`).join(' ')}`,
      '[aost#0:1/aac] Terminating thread with return code -22 (Invalid argument)',
    ].join('\n')

    const detail = __testing.boundedStderrDetail(stderr)

    expect(detail).toContain('Impossible to convert')
    // The symptom is still reported, but after the cause rather than instead.
    expect(detail).toContain('then:')
    expect(detail?.indexOf('Impossible')).toBeLessThan(detail?.indexOf('then:') ?? 0)
  })

  test('falls back to the last line when nothing looks like an error', async () => {
    const { __testing } = await import(
      '../src/services/FfmpegContinuousHlsPipelineFactory'
    )
    expect(__testing.boundedStderrDetail('one\ntwo\nthree')).toBe('three')
    expect(__testing.boundedStderrDetail('')).toBeUndefined()
  })
})

describe('benign FFmpeg chatter', () => {
  test('a routine demuxer warning is not reported as the cause', async () => {
    /* "UDTA parsing failed retrying raw" is an mp4 metadata atom the demuxer
       shrugs at. It was reported as the cause of a channel outage purely
       because it contains the word "failed" and came first. */
    const { __testing } = await import(
      '../src/services/FfmpegContinuousHlsPipelineFactory'
    )
    const detail = __testing.boundedStderrDetail(
      [
        '[in#2] UDTA parsing failed retrying raw',
        '[in#3] Could not find codec parameters',
        "Impossible to convert between the formats supported by the filter 'x' and the filter 'auto_scale_1'",
        '[vost#0:0/h264_qsv] Terminating thread with return code -22 (Invalid argument)',
      ].join('\n')
    )

    expect(detail).toContain('Impossible to convert')
    expect(detail).not.toContain('UDTA')
  })

  test('when everything is benign, it does not invent a cause', async () => {
    const { __testing } = await import(
      '../src/services/FfmpegContinuousHlsPipelineFactory'
    )
    const detail = __testing.boundedStderrDetail(
      '[in#2] UDTA parsing failed retrying raw\nlast line'
    )

    expect(detail).toBe('last line')
  })
})
