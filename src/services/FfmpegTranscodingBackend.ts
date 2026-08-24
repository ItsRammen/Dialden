import type { TranscodingMode } from '../config/runtime'
import { logger } from '../utils/logger'
import { readdir } from 'node:fs/promises'

export type FfmpegTranscodingBackend = 'software' | 'intel-qsv'

/** Resolved once at startup and safe to render in the administration UI. */
export interface FfmpegTranscodingStatus {
  readonly configuredMode: TranscodingMode
  readonly activeBackend: FfmpegTranscodingBackend
  readonly hardwareAcceleration: boolean
  /** The path supplied through TOASTTV_QSV_DEVICE. It may be a DRM directory. */
  readonly requestedDevice?: string
  /** The concrete render node selected for QSV, when one was resolved. */
  readonly device?: string
  /** Concrete render nodes discovered from the requested path. */
  readonly deviceCandidates?: readonly string[]
  /** Bounded diagnostics for each concrete node that was tested. */
  readonly probeAttempts?: readonly FfmpegTranscodingProbeAttempt[]
  readonly fallbackReason?: string
}

export interface FfmpegTranscodingProbeAttempt {
  readonly device: string
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly detail?: string
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

export type QsvDeviceDiscoverer = (
  requestedDevice: string
) => Promise<readonly string[]>

const QSV_PROBE_TIMEOUT_MS = 8_000

/**
 * Resolve the requested encoder using a real one-frame encode. Merely finding
 * `h264_qsv` in `ffmpeg -encoders` does not prove that the render node is
 * mounted, accessible to the runtime user, or backed by a working Intel driver.
 */
export async function resolveFfmpegTranscodingBackend(
  options: FfmpegTranscodingBackendOptions,
  runProbe: FfmpegProbeRunner = runFfmpegProbe,
  discoverDevices: QsvDeviceDiscoverer = discoverQsvDeviceCandidates
): Promise<FfmpegTranscodingStatus> {
  if (options.mode === 'software') {
    return {
      configuredMode: options.mode,
      activeBackend: 'software',
      hardwareAcceleration: false,
    }
  }

  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg'
  let deviceCandidates: readonly string[]
  try {
    deviceCandidates = await discoverDevices(options.qsvDevice)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const fallbackReason = `Intel QSV device discovery failed: ${boundedDetail(detail)}`
    logger.warn(`${fallbackReason}; using software transcoding`)
    return softwareFallback(options, fallbackReason, [], [])
  }

  if (deviceCandidates.length === 0) {
    const fallbackReason =
      `Intel QSV device directory ${options.qsvDevice} contains no renderD devices`
    logger.warn(`${fallbackReason}; using software transcoding`)
    return softwareFallback(options, fallbackReason, deviceCandidates, [])
  }

  const probeAttempts: FfmpegTranscodingProbeAttempt[] = []
  for (const device of deviceCandidates) {
    const command = intelQsvProbeCommand(ffmpegPath, device)
    try {
      const result = await runProbe(command, QSV_PROBE_TIMEOUT_MS)
      probeAttempts.push(probeAttempt(device, result))
      if (result.code === 0 && !result.timedOut) {
        logger.info(`Intel QSV transcoding enabled on ${device}`)
        return {
          configuredMode: options.mode,
          activeBackend: 'intel-qsv',
          hardwareAcceleration: true,
          requestedDevice: options.qsvDevice,
          device,
          deviceCandidates,
          probeAttempts,
        }
      }

      // A directory mount may expose multiple GPUs. Keep looking after a
      // device-specific failure so the first non-Intel node does not prevent a
      // later Intel render node from being selected.
      if (deviceCandidates.length > 1) continue

      const fallbackReason = result.timedOut
        ? `Intel QSV probe timed out after ${QSV_PROBE_TIMEOUT_MS}ms`
        : probeFailureReason(result)
      logger.warn(`${fallbackReason}; using software transcoding`)
      return softwareFallback(
        options,
        fallbackReason,
        deviceCandidates,
        probeAttempts
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const bounded = boundedDetail(detail)
      probeAttempts.push({
        device,
        exitCode: null,
        timedOut: false,
        ...(bounded ? { detail: bounded } : {}),
      })
      const fallbackReason = `Intel QSV probe could not start: ${bounded}`
      logger.warn(`${fallbackReason}; using software transcoding`)
      return softwareFallback(
        options,
        fallbackReason,
        deviceCandidates,
        probeAttempts
      )
    }
  }

  const fallbackReason = multipleProbeFailureReason(probeAttempts)
  logger.warn(`${fallbackReason}; using software transcoding`)
  return softwareFallback(
    options,
    fallbackReason,
    deviceCandidates,
    probeAttempts
  )
}

function softwareFallback(
  options: FfmpegTranscodingBackendOptions,
  fallbackReason: string,
  deviceCandidates: readonly string[],
  probeAttempts: readonly FfmpegTranscodingProbeAttempt[]
): FfmpegTranscodingStatus {
  const device = deviceCandidates.length === 1 ? deviceCandidates[0] : undefined
  return {
    configuredMode: options.mode,
    activeBackend: 'software',
    hardwareAcceleration: false,
    requestedDevice: options.qsvDevice,
    ...(device ? { device } : {}),
    deviceCandidates,
    probeAttempts,
    fallbackReason,
  }
}

export async function discoverQsvDeviceCandidates(
  requestedDevice: string
): Promise<readonly string[]> {
  try {
    const entries = await readdir(requestedDevice, { withFileTypes: true })
    return entries
      .map((entry) => entry.name)
      .filter((name) => /^renderD\d+$/.test(name))
      .sort(compareRenderNodes)
      .map((name) => joinDevicePath(requestedDevice, name))
  } catch (error) {
    const code = errorCode(error)
    const normalized = stripTrailingSeparators(requestedDevice)
    // An existing character device cannot be read as a directory. Remove an
    // accidental trailing slash before passing that concrete node to FFmpeg.
    if (code === 'ENOTDIR') return [normalized]
    if (code === 'ENOENT') {
      // Do not pass a missing directory-shaped value to VAAPI as though it were
      // a render node. Preserve a missing explicit renderD path so FFmpeg can
      // still return its actionable "No such file" device diagnostic.
      if (looksLikeRenderNode(normalized)) return [normalized]
      if (looksLikeDeviceDirectory(requestedDevice)) return []
      return [requestedDevice]
    }
    throw error
  }
}

function compareRenderNodes(left: string, right: string): number {
  return (
    Number(left.slice('renderD'.length)) -
    Number(right.slice('renderD'.length))
  )
}

function joinDevicePath(directory: string, name: string): string {
  const normalized = stripTrailingSeparators(directory)
  if (!normalized) return `/${name}`
  const separator =
    directory.includes('\\') && !directory.includes('/') ? '\\' : '/'
  return `${normalized}${separator}${name}`
}

function stripTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/, '')
}

function basename(value: string): string {
  return stripTrailingSeparators(value).split(/[\\/]/).at(-1) ?? ''
}

function looksLikeRenderNode(value: string): boolean {
  return /^renderD\d+$/.test(basename(value))
}

function looksLikeDeviceDirectory(value: string): boolean {
  return (
    basename(value) === 'dri' ||
    (/[\\/]$/.test(value) && !looksLikeRenderNode(value))
  )
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function probeAttempt(
  device: string,
  result: FfmpegProbeResult
): FfmpegTranscodingProbeAttempt {
  const detail = boundedDetail(result.stderr)
  return {
    device,
    exitCode: result.code,
    timedOut: result.timedOut === true,
    ...(detail ? { detail } : {}),
  }
}

function multipleProbeFailureReason(
  attempts: readonly FfmpegTranscodingProbeAttempt[]
): string {
  const summaries = attempts.map((attempt) => {
    if (attempt.timedOut) return `${attempt.device} (timed out)`
    const code = attempt.exitCode ?? 'unknown'
    const detail = attempt.detail ? `: ${attempt.detail}` : ''
    return `${attempt.device} (code ${code}${detail})`
  })
  return `Intel QSV probe failed for all discovered render nodes: ${summaries.join('; ')}`
    .slice(0, 1_500)
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
