import type {
  ChannelPipelineFactory,
  ChannelPipelineHandle,
  ChannelPipelineRequest,
  ChannelTimelinePosition,
} from './ContinuousChannelWorkerManager'
import type { FfmpegTranscodingStatus } from './FfmpegTranscodingBackend'

export interface SpawnedChannelProcess {
  readonly exited: Promise<number>
  kill(signal?: string): void
}

export interface ChannelProcessSpawner {
  spawn(command: readonly string[]): SpawnedChannelProcess
}

export interface ChannelAudioProbe {
  hasAudio(sourcePath: string): Promise<boolean>
}

const AUDIO_PROBE_CACHE_TTL_MS = 10 * 60_000

const SOFTWARE_TRANSCODING: FfmpegTranscodingStatus = {
  configuredMode: 'software',
  activeBackend: 'software',
  hardwareAcceleration: false,
}

const BUN_SPAWNER: ChannelProcessSpawner = {
  spawn(command) {
    // Inherit stderr so a noisy FFmpeg cannot block on an unread pipe.
    const child = Bun.spawn([...command], { stdout: 'ignore', stderr: 'inherit' })
    return {
      exited: child.exited,
      kill: (signal = 'SIGTERM') => child.kill(signal as NodeJS.Signals),
    }
  },
}

class FfprobeChannelAudioProbe implements ChannelAudioProbe {
  constructor(private readonly ffprobePath: string) {}

  async hasAudio(sourcePath: string): Promise<boolean> {
    const child = Bun.spawn(
      [
        this.ffprobePath, '-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=index', '-of', 'csv=p=0', sourcePath,
      ],
      { stdout: 'pipe', stderr: 'ignore' }
    )
    const output = await new Response(child.stdout).text()
    const code = await child.exited
    if (code !== 0) throw new Error(`ffprobe failed for ${sourcePath} with code ${code}`)
    return output.trim().length > 0
  }
}

/**
 * A bounded current/lookahead FFmpeg graph. All inputs are normalized and
 * concatenated inside one encoder/muxer, so A -> bumper -> B does not restart
 * HLS. A later lookahead window appends to the same rolling playlist.
 */
export class FfmpegContinuousHlsPipelineFactory implements ChannelPipelineFactory {
  private lastStartNumber = 0
  private readonly audioProbeCache = new Map<
    string,
    { expiresAt: number; promise: Promise<boolean> }
  >()

  constructor(
    private readonly ffmpegPath = 'ffmpeg',
    private readonly spawner: ChannelProcessSpawner = BUN_SPAWNER,
    private readonly audioProbe: ChannelAudioProbe = new FfprobeChannelAudioProbe('ffprobe'),
    private readonly now: () => number = Date.now,
    readonly transcodingStatus: FfmpegTranscodingStatus = SOFTWARE_TRANSCODING
  ) {}

  async start(request: ChannelPipelineRequest): Promise<ChannelPipelineHandle> {
    if (request.sequence.length === 0) throw new Error('Continuous HLS pipeline needs at least one source')
    const sequence = await Promise.all(
      request.sequence.map(async (item) => ({
        ...item,
        hasAudio:
          item.hasAudio === undefined
            ? await this.probeAudio(item.sourcePath)
            : item.hasAudio,
      }))
    )
    const command = this.command({ ...request, sequence, position: sequence[0] ?? request.position })
    const process = this.spawner.spawn(command)
    let stopping = false
    let stopPromise: Promise<void> | null = null
    return {
      completed: process.exited.then((code) => ({
        code,
        signal: stopping ? 'SIGTERM' : undefined,
        error: code === 0 || stopping ? undefined : `FFmpeg exited with code ${code}`,
      })),
      stop: () => {
        if (!stopPromise) {
          stopping = true
          process.kill('SIGTERM')
          stopPromise = process.exited.then(() => undefined)
        }
        return stopPromise
      },
    }
  }

  command(request: ChannelPipelineRequest): string[] {
    const args: string[] = [this.ffmpegPath, '-hide_banner', '-nostdin', '-loglevel', 'warning']
    const qsv = this.transcodingStatus.activeBackend === 'intel-qsv'
    if (qsv) {
      const device = this.transcodingStatus.device ?? '/dev/dri/renderD128'
      args.push(
        '-init_hw_device', `vaapi=va:${device}`,
        '-init_hw_device', 'qsv=qs@va',
        '-filter_hw_device', 'qs'
      )
    }
    const streams: Array<{ video: number; audio: number }> = []
    let inputIndex = 0
    for (const item of request.sequence) {
      // Decode into system memory. The normalization/concat graph below uses
      // software filters; handing it QSV hardware frames makes FFmpeg insert
      // an unsupported implicit conversion on some Intel generations. QSV is
      // still used for the final H.264 encode, which provides the largest CPU
      // reduction without making channel compatibility source-dependent.
      if (item.loopSource) args.push('-stream_loop', '-1')
      if (item.sourceOffsetSeconds > 0) args.push('-ss', decimal(item.sourceOffsetSeconds))
      if (item.sourceDurationSeconds !== undefined) args.push('-t', decimal(item.sourceDurationSeconds))
      args.push('-i', item.sourcePath)
      const video = inputIndex++
      let audio = video
      if (item.hasAudio === false) {
        if (!item.sourceDurationSeconds || item.sourceDurationSeconds <= 0) {
          throw new Error(`Silent schedule item ${item.scheduleItemId} needs a source duration`)
        }
        args.push('-f', 'lavfi', '-t', decimal(item.sourceDurationSeconds), '-i', 'anullsrc=r=48000:cl=stereo')
        audio = inputIndex++
      }
      streams.push({ video, audio })
    }

    const chains: string[] = []
    streams.forEach(({ video, audio }, index) => {
      const normalizedVideo = `[basev${index}]`
      chains.push(
        `[${video}:v:0]scale=${request.profile.maximumWidth}:${request.profile.maximumHeight}:force_original_aspect_ratio=decrease,` +
          `pad=${request.profile.maximumWidth}:${request.profile.maximumHeight}:(ow-iw)/2:(oh-ih)/2,` +
          `setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS${normalizedVideo}`
      )
      chains.push(
        `[${audio}:a:0]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
          `aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS[a${index}]`
      )
      chains.push(`${normalizedVideo}null[v${index}]`)
    })
    const pads = streams.map((_, index) => `[v${index}][a${index}]`).join('')
    // Pace the joined broadcast clock, not each input clock. Applying `-re` to
    // every lookahead input lets those clocks run concurrently; when concat
    // eventually selects a future input, FFmpeg can consider it late and emit
    // it faster than real time. `realtime`/`arealtime` see one continuous PTS
    // timeline and keep the HLS live edge aligned with wall clock.
    chains.push(`${pads}concat=n=${streams.length}:v=1:a=1[joinedv][joineda]`)
    // Keep normalization in system memory for now. Uploading only at the
    // encoder boundary is compatible with the existing mixed-codec graph
    // while still moving the costly H.264 encode to QSV.
    chains.push(
      qsv
        ? '[joinedv]realtime=speed=1,format=nv12[outv]'
        : '[joinedv]realtime=speed=1[outv]'
    )
    chains.push('[joineda]arealtime=speed=1[outa]')

    const gop = Math.max(30, Math.round(request.profile.segmentSeconds * 30))
    // Epoch-derived, monotonically increasing start numbers prevent a new
    // append window from overwriting segments still referenced by clients.
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
    const videoEncoderArgs = qsv
      ? [
          '-c:v', 'h264_qsv',
          '-preset', 'veryfast',
          '-global_quality', '23',
          '-look_ahead', '0',
          '-bf', '0',
          '-pix_fmt', 'nv12',
        ]
      : [
          '-c:v', 'libx264',
          '-preset', 'superfast',
          '-tune', 'zerolatency',
          '-pix_fmt', 'yuv420p',
        ]
    args.push(
      '-filter_complex', chains.join(';'),
      '-map', '[outv]', '-map', '[outa]',
      ...videoEncoderArgs,
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

  private async probeAudio(sourcePath: string): Promise<boolean> {
    const now = this.now()
    const cached = this.audioProbeCache.get(sourcePath)
    if (cached && cached.expiresAt > now) return cached.promise
    if (cached) this.audioProbeCache.delete(sourcePath)
    const pending = this.audioProbe.hasAudio(sourcePath).catch((error) => {
      if (this.audioProbeCache.get(sourcePath)?.promise === pending) {
        this.audioProbeCache.delete(sourcePath)
      }
      throw error
    })
    this.audioProbeCache.set(sourcePath, {
      expiresAt: now + AUDIO_PROBE_CACHE_TTL_MS,
      promise: pending,
    })
    // Keep this process-local optimization bounded for very large libraries.
    if (this.audioProbeCache.size > 2_048) {
      const oldest = this.audioProbeCache.keys().next().value
      if (oldest && oldest !== sourcePath) this.audioProbeCache.delete(oldest)
    }
    return pending
  }
}

function decimal(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error('FFmpeg time values must be finite and non-negative')
  return value.toFixed(3).replace(/\.000$/, '')
}
