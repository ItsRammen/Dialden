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
  /**
   * Operating-system process id, when the spawner knows it. Used to attribute
   * CPU time to the channel that spent it; a spawner in a test does not need
   * to supply one.
   */
  readonly pid?: number
  /**
   * Bounded tail of the process's stderr, resolved after exit when available.
   * Diagnostics only: a spawner that cannot capture stderr may omit it.
   */
  readonly stderrTail?: Promise<string>
}

export interface ChannelProcessSpawner {
  spawn(command: readonly string[]): SpawnedChannelProcess
}

export interface ChannelAudioProbe {
  hasAudio(sourcePath: string): Promise<boolean>
  /** Prefer language-aware selection when the probe supports it. */
  selectAudioStream?(sourcePath: string): Promise<number | null>
}

export interface ProbedAudioStream {
  readonly language?: string
  readonly default?: boolean
  readonly original?: boolean
}

/** English wins; otherwise respect original/default container intent. */
export function preferredAudioStreamIndex(
  streams: readonly ProbedAudioStream[]
): number | null {
  if (streams.length === 0) return null
  const english = streams
    .map((stream, index) => ({ stream, index }))
    .filter(({ stream }) => isEnglish(stream.language))
  if (english.length > 0) {
    return (
      english.find(({ stream }) => stream.default === true)?.index ??
      english.find(({ stream }) => stream.original === true)?.index ??
      english[0]!.index
    )
  }
  const original = streams.findIndex((stream) => stream.original === true)
  if (original >= 0) return original
  const defaultStream = streams.findIndex((stream) => stream.default === true)
  return defaultStream >= 0 ? defaultStream : 0
}

const AUDIO_PROBE_CACHE_TTL_MS = 10 * 60_000
const STDERR_TAIL_BYTES = 2_048

/**
 * Drains FFmpeg's stderr into a bounded tail so exit diagnostics survive into
 * worker lastError instead of scrolling past in the server console. The stream
 * is consumed continuously, which is what keeps a full pipe from stalling the
 * child — the same property the previous inherit-based approach relied on.
 */
async function collectStderrTail(
  stream: ReadableStream<Uint8Array>,
  capacityBytes = STDERR_TAIL_BYTES
): Promise<string> {
  let text = ''
  try {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (text.length > capacityBytes) text = text.slice(-capacityBytes)
    }
    text += decoder.decode()
  } catch {
    // Diagnostics are best-effort; never let capture failures mask the exit.
  }
  return text.slice(-capacityBytes)
}

function composeExitError(code: number, stderrTail?: string): string {
  const detail = boundedStderrDetail(stderrTail)
  return detail
    ? `FFmpeg exited with code ${code}: ${detail}`
    : `FFmpeg exited with code ${code}`
}

function boundedStderrDetail(stderrTail?: string): string | undefined {
  const lines = (stderrTail ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const informative = [...lines]
    .reverse()
    .find((line) => /(?:error|failed|invalid|no such|unable|mfx|vaapi|qsv)/i.test(line))
  const chosen = informative ?? lines.at(-1)
  return chosen ? chosen.slice(0, 500) : undefined
}

const SOFTWARE_TRANSCODING: FfmpegTranscodingStatus = {
  configuredMode: 'software',
  activeBackend: 'software',
  hardwareAcceleration: false,
}

const BUN_SPAWNER: ChannelProcessSpawner = {
  spawn(command) {
    const child = Bun.spawn([...command], { stdout: 'ignore', stderr: 'pipe' })
    return {
      exited: child.exited,
      kill: (signal = 'SIGTERM') => child.kill(signal as NodeJS.Signals),
      stderrTail: collectStderrTail(child.stderr),
      pid: child.pid,
    }
  },
}

class FfprobeChannelAudioProbe implements ChannelAudioProbe {
  constructor(private readonly ffprobePath: string) {}

  async hasAudio(sourcePath: string): Promise<boolean> {
    return (await this.selectAudioStream(sourcePath)) !== null
  }

  async selectAudioStream(sourcePath: string): Promise<number | null> {
    const child = Bun.spawn(
      [
        this.ffprobePath, '-v', 'error', '-select_streams', 'a',
        '-show_entries', 'stream=index:stream_tags=language:stream_disposition=default,original',
        '-of', 'json', sourcePath,
      ],
      { stdout: 'pipe', stderr: 'ignore' }
    )
    const output = await new Response(child.stdout).text()
    const code = await child.exited
    if (code !== 0) throw new Error(`ffprobe failed for ${sourcePath} with code ${code}`)
    let data: unknown
    try {
      data = JSON.parse(output)
    } catch {
      throw new Error(`ffprobe returned invalid audio metadata for ${sourcePath}`)
    }
    const streams =
      data && typeof data === 'object' && Array.isArray((data as { streams?: unknown }).streams)
        ? (data as {
            streams: Array<{
              tags?: { language?: unknown }
              disposition?: { default?: unknown; original?: unknown }
            }>
          }).streams
        : []
    return preferredAudioStreamIndex(
      streams.map((stream) => ({
        ...(typeof stream.tags?.language === 'string'
          ? { language: stream.tags.language }
          : {}),
        default: stream.disposition?.default === 1,
        original: stream.disposition?.original === 1,
      }))
    )
  }
}

/**
 * A bounded current/lookahead FFmpeg graph. All inputs are normalized and
 * concatenated inside one encoder/muxer, so A -> bumper -> B does not restart
 * HLS. A later lookahead window appends to the same rolling playlist.
 */
export class FfmpegContinuousHlsPipelineFactory implements ChannelPipelineFactory {
  /* Protected rather than private so the hardware pipeline can extend this one
     and replace only the filter graph, keeping the process handling, the audio
     probe and the segment numbering identical between the two. */
  protected lastStartNumber = 0
  private readonly audioProbeCache = new Map<
    string,
    {
      expiresAt: number
      promise: Promise<{ hasAudio: boolean; audioStreamIndex: number }>
    }
  >()

  constructor(
    protected readonly ffmpegPath = 'ffmpeg',
    protected readonly spawner: ChannelProcessSpawner = BUN_SPAWNER,
    protected readonly audioProbe: ChannelAudioProbe = new FfprobeChannelAudioProbe('ffprobe'),
    protected readonly now: () => number = Date.now,
    readonly transcodingStatus: FfmpegTranscodingStatus = SOFTWARE_TRANSCODING
  ) {}

  async start(request: ChannelPipelineRequest): Promise<ChannelPipelineHandle> {
    if (request.sequence.length === 0) throw new Error('Continuous HLS pipeline needs at least one source')
    const sequence = await Promise.all(
      request.sequence.map(async (item) => {
        let audio = { hasAudio: false, audioStreamIndex: 0 }
        if (item.hasAudio !== false) {
          try {
            audio = await this.probeAudio(item.sourcePath)
          } catch (error) {
            if (item.hasAudio !== true) throw error
            // The indexer's prior probe still establishes that audio exists.
            // Keep the channel available on a transient language-probe error.
            audio = { hasAudio: true, audioStreamIndex: 0 }
          }
          if (item.hasAudio === true && !audio.hasAudio) {
            audio = { hasAudio: true, audioStreamIndex: 0 }
          }
        }
        return { ...item, ...audio }
      })
    )
    const command = this.command({ ...request, sequence, position: sequence[0] ?? request.position })
    const process = this.spawner.spawn(command)
    let stopping = false
    let stopPromise: Promise<void> | null = null
    return {
      completed: Promise.all([
        process.exited,
        process.stderrTail ?? Promise.resolve(''),
      ]).then(([code, stderrTail]) => ({
        code,
        signal: stopping ? 'SIGTERM' : undefined,
        error:
          code === 0 || stopping ? undefined : composeExitError(code, stderrTail),
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
    const streams: Array<{
      video: number
      audio: number
      audioStreamIndex: number
    }> = []
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
      let audioStreamIndex = item.audioStreamIndex ?? 0
      if (item.hasAudio === false) {
        if (!item.sourceDurationSeconds || item.sourceDurationSeconds <= 0) {
          throw new Error(`Silent schedule item ${item.scheduleItemId} needs a source duration`)
        }
        args.push('-f', 'lavfi', '-t', decimal(item.sourceDurationSeconds), '-i', 'anullsrc=r=48000:cl=stereo')
        audio = inputIndex++
        audioStreamIndex = 0
      }
      streams.push({ video, audio, audioStreamIndex })
    }

    const chains: string[] = []
    streams.forEach(({ video, audio, audioStreamIndex }, index) => {
      const normalizedVideo = `[basev${index}]`
      chains.push(
        `[${video}:v:0]scale=${request.profile.maximumWidth}:${request.profile.maximumHeight}:force_original_aspect_ratio=decrease,` +
          `pad=${request.profile.maximumWidth}:${request.profile.maximumHeight}:(ow-iw)/2:(oh-ih)/2,` +
          `setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS${normalizedVideo}`
      )
      chains.push(
        `[${audio}:a:${audioStreamIndex}]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
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

  private async probeAudio(
    sourcePath: string
  ): Promise<{ hasAudio: boolean; audioStreamIndex: number }> {
    const now = this.now()
    const cached = this.audioProbeCache.get(sourcePath)
    if (cached && cached.expiresAt > now) return cached.promise
    if (cached) this.audioProbeCache.delete(sourcePath)
    const pending = (
      this.audioProbe.selectAudioStream
        ? this.audioProbe.selectAudioStream(sourcePath).then((index) => ({
            hasAudio: index !== null,
            audioStreamIndex: index ?? 0,
          }))
        : this.audioProbe.hasAudio(sourcePath).then((hasAudio) => ({
            hasAudio,
            audioStreamIndex: 0,
          }))
    ).catch((error) => {
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

function isEnglish(language: string | undefined): boolean {
  const normalized = language?.trim().toLowerCase().replace(/_/g, '-') ?? ''
  const primary = normalized.split('-')[0]
  return primary === 'en' || primary === 'eng' || normalized === 'english'
}

export function decimal(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error('FFmpeg time values must be finite and non-negative')
  return value.toFixed(3).replace(/\.000$/, '')
}
