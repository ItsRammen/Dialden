import type { TranscodingMode } from '../config/runtime'
import { logger } from '../utils/logger'

export type FfmpegTranscodingBackend = 'software' | 'intel-qsv'

/** Resolved once at startup and safe to render in the administration UI. */
export interface FfmpegTranscodingStatus {
  readonly configuredMode: TranscodingMode
  readonly activeBackend: FfmpegTranscodingBackend
  readonly hardwareAcceleration: boolean
  readonly device?: string
  readonly fallbackReason?: string
}

export interface FfmpegTranscodingBackendOptions {
  readonly mode: TranscodingMode
  readonly qsvDevice: string
  readonly ffmpegPath?: string
}

export interface FfmpegProbeResult {
  readonly code: number | null
  readonly stderr: string
  readonly timedOut?: boolean
}

export type FfmpegProbeRunner = (
  command: readonly string[],
  timeoutMs: number
) => Promise<FfmpegProbeResult>

const QSV_PROBE_TIMEOUT_MS = 8_000

/**
 * Resolve the requested encoder using a real one-frame encode. Merely finding
 * `h264_qsv` in `ffmpeg -encoders` does not prove that the render node is
 * mounted, accessible to the runtime user, or backed by a working Intel driver.
 */
export async function resolveFfmpegTranscodingBackend(
  options: FfmpegTranscodingBackendOptions,
  runProbe: FfmpegProbeRunner = runFfmpegProbe
): Promise<FfmpegTranscodingStatus> {
  if (options.mode === 'software') {
    return {
      configuredMode: options.mode,
      activeBackend: 'software',
      hardwareAcceleration: false,
    }
  }

  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg'
  const command = intelQsvProbeCommand(ffmpegPath, options.qsvDevice)
  try {
    const result = await runProbe(command, QSV_PROBE_TIMEOUT_MS)
    if (result.code === 0 && !result.timedOut) {
      logger.info(`Intel QSV transcoding enabled on ${options.qsvDevice}`)
      return {
        configuredMode: options.mode,
        activeBackend: 'intel-qsv',
        hardwareAcceleration: true,
        device: options.qsvDevice,
      }
    }

    const fallbackReason = result.timedOut
      ? `Intel QSV probe timed out after ${QSV_PROBE_TIMEOUT_MS}ms`
      : probeFailureReason(result)
    logger.warn(`${fallbackReason}; using software transcoding`)
    return softwareFallback(options, fallbackReason)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const fallbackReason = `Intel QSV probe could not start: ${boundedDetail(detail)}`
    logger.warn(`${fallbackReason}; using software transcoding`)
    return softwareFallback(options, fallbackReason)
  }
}

function softwareFallback(
  options: FfmpegTranscodingBackendOptions,
  fallbackReason: string
): FfmpegTranscodingStatus {
  return {
    configuredMode: options.mode,
    activeBackend: 'software',
    hardwareAcceleration: false,
    device: options.qsvDevice,
    fallbackReason,
  }
}

function intelQsvProbeCommand(
  ffmpegPath: string,
  device: string
): readonly string[] {
  return [
    ffmpegPath,
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-init_hw_device',
    `vaapi=va:${device}`,
    '-init_hw_device',
    'qsv=qs@va',
    '-filter_hw_device',
    'qs',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=64x64:r=1:d=0.04',
    '-frames:v',
    '1',
    '-vf',
    'format=nv12',
    '-an',
    '-c:v',
    'h264_qsv',
    '-preset',
    'veryfast',
    '-f',
    'null',
    '-',
  ]
}

async function runFfmpegProbe(
  command: readonly string[],
  timeoutMs: number
): Promise<FfmpegProbeResult> {
  const child = Bun.spawn([...command], {
    stdout: 'ignore',
    stderr: 'pipe',
  })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, timeoutMs)
  try {
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ])
    return { code, stderr, timedOut }
  } finally {
    clearTimeout(timeout)
  }
}

function probeFailureReason(result: FfmpegProbeResult): string {
  const detail = boundedDetail(result.stderr)
  const suffix = detail ? `: ${detail}` : ''
  return `Intel QSV probe exited with code ${result.code ?? 'unknown'}${suffix}`
}

function boundedDetail(value: string): string {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const informative = lines.find(
    (line) =>
      /(?:no va display|permission denied|no such file|not found|unknown encoder|unavailable|unsupported|failed|error)/i.test(
        line
      ) && !/^error parsing global options:/i.test(line)
  )
  return (informative ?? lines.at(-1) ?? '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .slice(0, 500)
}
