import {
  FfmpegContinuousHlsPipelineFactory,
  decimal,
} from './FfmpegContinuousHlsPipelineFactory'
import type {
  ChannelPipelineRequest,
  ChannelTimelinePosition,
} from './ContinuousChannelWorkerManager'

/**
 * The continuous HLS pipeline with the whole graph on the media engine:
 * hardware decode, hardware scale and letterbox, hardware encode, frames never
 * copied back to system memory.
 *
 * Everything here is shaped by what scripts/qsv-capability-probe.sh measured on
 * the deployed box rather than by what the hardware ought to support:
 *
 *  - `vpp_qsv` scales but has no `force_original_aspect_ratio`, so a letterbox
 *    is a composite: fit with `vpp_qsv`, then `overlay_qsv` onto a generated
 *    background at a fixed offset. The offset must be known before the command
 *    is built, which is why a source of unknown geometry is not eligible.
 *
 *  - `format=nv12` is mandatory on every `vpp_qsv`, not an optimisation. A
 *    10-bit source decodes to P010, and handing that to `h264_qsv` writes zero
 *    packets and reports no error at all. That silent empty output is the most
 *    likely explanation for the exit-218 failures that shelved the first
 *    attempt at this.
 *
 *  - There is no session ceiling to respect. 48 concurrent full-hardware
 *    sessions ran clean, far past the handful six channels need, so this
 *    imposes no concurrency limit; a made-up one would only hide real faults.
 *
 * `concat` cannot mix hardware and software frames, so eligibility is decided
 * for a whole append window: if any item in it cannot be decoded on the media
 * engine, or has no measured geometry, the entire window falls back to the
 * software pipeline. That is the rule the design rests on.
 */
/** The broadcast frame rate the whole lineup is normalised to, as in the
 *  software pipeline's fps=30. The GOP and the segment length both derive
 *  from it, so it is one constant rather than three literals. */
const TARGET_FPS = 30

export class FfmpegHardwareHlsPipelineFactory extends FfmpegContinuousHlsPipelineFactory {
  /** True when every item in the window can run on the media engine. */
  eligible(request: ChannelPipelineRequest): boolean {
    if (this.transcodingStatus.activeBackend !== 'intel-qsv') return false
    if (request.sequence.length === 0) return false
    return request.sequence.every((item) => isHardwareItem(item))
  }

  /* Process handling, the audio probe and segment numbering are inherited
     unchanged; only the graph differs. A mixed window falls back to the
     software command below, which keeps every frame in one concat uniform. */
  override command(request: ChannelPipelineRequest): string[] {
    if (!this.eligible(request)) return super.command(request)

    const device = this.transcodingStatus.device ?? '/dev/dri/renderD128'
    const width = request.profile.maximumWidth
    const height = request.profile.maximumHeight
    const args: string[] = [
      this.ffmpegPath,
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'warning',
      '-init_hw_device',
      `vaapi=va:${device}`,
      '-init_hw_device',
      'qsv=qs@va',
      '-filter_hw_device',
      'qs',
    ]

    const streams: Array<{
      video: number
      audio: number
      audioStreamIndex: number
      background?: number
      fit: Fit
      seconds: number
    }> = []
    let inputIndex = 0

    for (const item of request.sequence) {
      const fit = fitWithin(
        item.sourceWidth as number,
        item.sourceHeight as number,
        width,
        height
      )
      /* Decoded straight into hardware frames. -hwaccel must precede the input
         it applies to, so it is repeated rather than set once globally.

         Deliberately no -t. On a hardware input feeding a graph with several
         other hardware inputs, an input duration makes FFmpeg reconcile the
         streams through a software scaler it cannot apply to qsv frames, and
         the run dies with "Impossible to convert between the formats supported
         by the filter ... and the filter auto_scale". One input is fine, which
         is what made this look like contention for so long. The duration is
         bounded by trim/atrim in the graph instead, which is measured to work
         on the same files. -ss is unaffected and stays here. */
      args.push('-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv')
      if (item.loopSource) args.push('-stream_loop', '-1')
      if (item.sourceOffsetSeconds > 0) args.push('-ss', decimal(item.sourceOffsetSeconds))
      args.push('-i', item.sourcePath)
      const video = inputIndex++

      let background: number | undefined
      if (fit.pad) {
        /* The letterbox field. Generated per item so its clock matches that
           item; overlay_qsv ends the pair with the shorter of the two. */
        // Unbounded for the same reason; the trim after the composite ends it.
        args.push('-f', 'lavfi', '-i', `color=black:size=${width}x${height}:rate=30`)
        background = inputIndex++
      }

      let audio = video
      let audioStreamIndex = item.audioStreamIndex ?? 0
      if (item.hasAudio === false) {
        if (!item.sourceDurationSeconds || item.sourceDurationSeconds <= 0) {
          throw new Error(`Silent schedule item ${item.scheduleItemId} needs a source duration`)
        }
        args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo')
        audio = inputIndex++
        audioStreamIndex = 0
      }
      streams.push({
        video,
        audio,
        audioStreamIndex,
        ...(background === undefined ? {} : { background }),
        fit,
        seconds: item.sourceDurationSeconds as number,
      })
    }

    const chains: string[] = []
    streams.forEach(({ video, audio, audioStreamIndex, background, fit, seconds }, index) => {
      /* format=nv12 on every pass. Without it a 10-bit source reaches the
         encoder as P010 and the whole run produces nothing, silently. */
      const scaled = `[fitted${index}]`
      const bound = `trim=duration=${decimal(seconds)},setpts=PTS-STARTPTS`
      /* framerate is the hardware equivalent of the software chain's fps=30.
         Without it the graph reaches the muxer carrying no frame rate, FFmpeg
         assumes 25 and a 60-frame GOP becomes a 2.4s segment against a 2s
         target -- which skews the live edge and the playlist window. */
      chains.push(
        `[${video}:v:0]vpp_qsv=w=${fit.width}:h=${fit.height}:scale_mode=hq:` +
          `format=nv12:framerate=${TARGET_FPS}${scaled}`
      )
      if (fit.pad && background !== undefined) {
        chains.push(
          `[${background}:v:0]format=nv12,hwupload=extra_hw_frames=16[bg${index}]`
        )
        chains.push(
          `[bg${index}]${scaled}overlay_qsv=x=${fit.x}:y=${fit.y}:shortest=1,${bound}[v${index}]`
        )
      } else {
        chains.push(`${scaled}${bound}[v${index}]`)
      }
      chains.push(
        `[${audio}:a:${audioStreamIndex}]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
          `aresample=async=1:first_pts=0,atrim=duration=${decimal(seconds)},asetpts=PTS-STARTPTS[a${index}]`
      )
    })

    const pads = streams.map((_, index) => `[v${index}][a${index}]`).join('')
    chains.push(`${pads}concat=n=${streams.length}:v=1:a=1[joinedv][joineda]`)
    /* Paces the joined broadcast clock rather than each input clock, exactly as
       the software pipeline does. realtime passes frames through untouched, so
       it is indifferent to their being hardware frames. */
    chains.push('[joinedv]realtime=speed=1[outv]')
    chains.push('[joineda]arealtime=speed=1[outa]')

    const gop = Math.max(TARGET_FPS, Math.round(request.profile.segmentSeconds * TARGET_FPS))
    this.lastStartNumber = Math.max(
      this.lastStartNumber + 1_000,
      Math.floor(this.now() / 1_000) * 1_000
    )
    const flags = [
      'delete_segments',
      'independent_segments',
      'omit_endlist',
      'program_date_time',
      ...(request.appendToExistingPlaylist ? ['append_list', 'discont_start'] : []),
    ].join('+')

    args.push(
      '-filter_complex', chains.join(';'),
      '-map', '[outv]', '-map', '[outa]',
      '-r', String(TARGET_FPS),
      '-c:v', 'h264_qsv',
      '-preset', 'veryfast',
      '-global_quality', '23',
      '-look_ahead', '0',
      '-bf', '0',
      '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', String(request.profile.audioChannels),
      '-f', 'hls', '-hls_time', decimal(request.profile.segmentSeconds),
      '-hls_list_size', String(request.profile.playlistWindowSegments),
      '-start_number', String(this.lastStartNumber),
      '-hls_delete_threshold', '4', '-hls_flags', flags,
      '-hls_segment_filename', `${request.outputDirectory}/segment-%013d.ts`,
      request.playlistPath
    )
    return args
  }
}

interface Fit {
  readonly width: number
  readonly height: number
  readonly x: number
  readonly y: number
  readonly pad: boolean
}

/**
 * Largest even-dimensioned box of the source's aspect that fits the target,
 * and where to place it. Even dimensions because the encoder works in chroma
 * pairs and an odd width fails outright.
 */
export function fitWithin(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number
): Fit {
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight)
  const width = Math.max(2, Math.floor((sourceWidth * scale) / 2) * 2)
  const height = Math.max(2, Math.floor((sourceHeight * scale) / 2) * 2)
  const x = Math.floor((targetWidth - width) / 2 / 2) * 2
  const y = Math.floor((targetHeight - height) / 2 / 2) * 2
  return { width, height, x, y, pad: width !== targetWidth || height !== targetHeight }
}

function isHardwareItem(item: ChannelTimelinePosition): boolean {
  if (item.decodeHint !== 'hw') return false
  /* A duration is required because the bound is a trim in the graph rather
     than -t on the input; without one the item would run to end of file. */
  if (
    typeof item.sourceDurationSeconds !== 'number' ||
    !(item.sourceDurationSeconds > 0)
  ) {
    return false
  }
  // Geometry has to be known: the letterbox offset is fixed at build time.
  return (
    typeof item.sourceWidth === 'number' &&
    item.sourceWidth > 0 &&
    typeof item.sourceHeight === 'number' &&
    item.sourceHeight > 0
  )
}
