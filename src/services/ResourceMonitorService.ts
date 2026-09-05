import { readFileSync } from 'node:fs'

/**
 * Samples what the machine is actually spending on the lineup.
 *
 * The question this exists to answer is narrow and practical: after switching a
 * pipeline to the media engine, did CPU fall, and on which channel? A single
 * whole-box percentage cannot answer that, so this attributes CPU per channel
 * from each pipeline's own process.
 *
 * CPU is measured, not estimated. GPU is reported only where the kernel exposes
 * it: amdgpu publishes `gpu_busy_percent`, i915 generally does not, and the PMU
 * that `intel_gpu_top` reads needs privileges a container is unlikely to hold.
 * Rather than invent a number, an unreadable GPU reports `available: false` and
 * says why, and the honest hardware signal — how many channels are running on
 * the media engine versus in software — comes from the pipeline itself, which
 * knows for certain.
 *
 * Every reader is injected so the arithmetic can be tested without /proc.
 */

/** Clock ticks per second. Constant on Linux for every architecture we target. */
const USER_HZ = 100

export interface ResourceReaders {
  /** cgroup v2 cpu.stat, or v1 cpuacct.usage. */
  readCgroupCpu(): string | null
  /** /proc/<pid>/stat for one pipeline process. */
  readProcessStat(pid: number): string | null
  /** A GPU busy percentage where the kernel publishes one. amdgpu does. */
  readGpuBusyPercent(): string | null
  /** Current and maximum engine frequency, which i915 does publish. */
  readGpuFrequency(): { currentMhz: number; maxMhz: number } | null
  cores(): number
  nowMs(): number
}

export interface ChannelProcess {
  readonly channelId: string
  readonly pid: number
  /** Whether this channel's pipeline is running on the media engine. */
  readonly hardware: boolean
}

export interface ChannelCpuSample {
  readonly channelId: string
  readonly hardware: boolean
  /** Percent of one core. 250 means two and a half cores' worth. */
  readonly cpuPercent: number
}

export interface ResourceSample {
  /** Percent of all cores, 0-100, for everything in this container. */
  readonly cpuPercent: number | null
  readonly cores: number
  readonly channels: readonly ChannelCpuSample[]
  readonly gpu: {
    readonly available: boolean
    readonly busyPercent?: number
    /** Why no busy figure is shown, when there is none. */
    readonly reason?: string
    /**
     * i915 publishes no busy percentage, but it does publish engine frequency,
     * which idles low and climbs under load. Not a utilisation figure, and not
     * presented as one -- but it does answer "is the media engine doing
     * anything", which is the question after switching a pipeline to it.
     */
    readonly frequencyMhz?: number
    readonly maxFrequencyMhz?: number
    /** Channels currently decoding and encoding on the media engine. */
    readonly hardwarePipelines: number
    readonly softwarePipelines: number
  }
  /** Null on the first sample: every figure here is a delta over time. */
  readonly intervalMs: number | null
}

interface Previous {
  readonly atMs: number
  readonly cgroupUsec: number | null
  readonly processTicks: Map<number, number>
}

/** cgroup v2 reports usage_usec; v1 reports nanoseconds in a bare file. */
export function parseCgroupCpuUsec(raw: string | null): number | null {
  if (!raw) return null
  const v2 = /(?:^|\n)usage_usec\s+(\d+)/.exec(raw)
  if (v2?.[1]) return Number(v2[1])
  const v1 = raw.trim()
  return /^\d+$/.test(v1) ? Number(v1) / 1000 : null
}

/**
 * utime + stime from /proc/<pid>/stat, in clock ticks.
 *
 * Field 2 is the executable name in parentheses and may itself contain spaces
 * or brackets, so the fields are counted from the last ')' rather than by
 * splitting the whole line — which is the classic way to misread this file.
 */
export function parseProcessCpuTicks(raw: string | null): number | null {
  if (!raw) return null
  const close = raw.lastIndexOf(')')
  if (close < 0) return null
  const fields = raw.slice(close + 2).split(/\s+/)
  // After the name, field 1 is state, so utime is index 11 and stime 12.
  const utime = Number(fields[11])
  const stime = Number(fields[12])
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null
  return utime + stime
}

export class ResourceMonitorService {
  private previous: Previous | null = null

  constructor(private readonly readers: ResourceReaders) {}

  /**
   * One sample. The first call after construction establishes a baseline and
   * reports no percentages, because there is nothing to compare against yet.
   */
  sample(processes: readonly ChannelProcess[]): ResourceSample {
    const atMs = this.readers.nowMs()
    const cores = Math.max(1, this.readers.cores())
    const cgroupUsec = parseCgroupCpuUsec(this.readers.readCgroupCpu())

    const processTicks = new Map<number, number>()
    for (const item of processes) {
      const ticks = parseProcessCpuTicks(this.readers.readProcessStat(item.pid))
      if (ticks !== null) processTicks.set(item.pid, ticks)
    }

    const previous = this.previous
    const intervalMs = previous ? atMs - previous.atMs : null
    this.previous = { atMs, cgroupUsec, processTicks }

    const gpu = this.readGpu(processes)
    if (!previous || intervalMs === null || intervalMs <= 0) {
      return { cpuPercent: null, cores, channels: [], gpu, intervalMs: null }
    }

    let cpuPercent: number | null = null
    if (cgroupUsec !== null && previous.cgroupUsec !== null) {
      const usedMs = (cgroupUsec - previous.cgroupUsec) / 1000
      cpuPercent = round((usedMs / (intervalMs * cores)) * 100)
    }

    const channels: ChannelCpuSample[] = []
    for (const item of processes) {
      const now = processTicks.get(item.pid)
      const before = previous.processTicks.get(item.pid)
      if (now === undefined || before === undefined) continue
      const usedMs = ((now - before) / USER_HZ) * 1000
      channels.push({
        channelId: item.channelId,
        hardware: item.hardware,
        cpuPercent: round((usedMs / intervalMs) * 100),
      })
    }

    return { cpuPercent, cores, channels, gpu, intervalMs }
  }

  private readGpu(processes: readonly ChannelProcess[]): ResourceSample['gpu'] {
    const hardwarePipelines = processes.filter((item) => item.hardware).length
    const counts = {
      hardwarePipelines,
      softwarePipelines: processes.length - hardwarePipelines,
    }
    const frequency = this.readers.readGpuFrequency()
    const clock =
      frequency && frequency.maxMhz > 0
        ? {
            frequencyMhz: Math.round(frequency.currentMhz),
            maxFrequencyMhz: Math.round(frequency.maxMhz),
          }
        : {}
    const raw = this.readers.readGpuBusyPercent()
    if (raw === null) {
      return {
        available: false,
        reason:
          'the kernel does not publish a GPU busy figure here; ' +
          'i915 exposes it only through a perf counter a container cannot usually read',
        ...clock,
        ...counts,
      }
    }
    const value = Number(raw.trim())
    if (!Number.isFinite(value)) {
      return { available: false, reason: 'unreadable GPU busy value', ...clock, ...counts }
    }
    return { available: true, busyPercent: round(value), ...clock, ...counts }
  }
}

function round(value: number): number {
  return Math.max(0, Math.round(value * 10) / 10)
}


/*
 * Readers for a Linux container, using only paths confirmed readable on the
 * deployed box: cgroup v2 cpu.stat, /proc/<pid>/stat, and the i915 frequency
 * files. GPU busy is deliberately absent -- i915 publishes none, and the probe
 * confirmed the PMU intel_gpu_top would use is gated by perf_event_paranoid.
 */
export function createLinuxResourceReaders(
  readFile: (path: string) => string | null = defaultReadFile,
  cpuCount: () => number = () => navigator.hardwareConcurrency || 1
): ResourceReaders {
  const firstReadable = (paths: readonly string[]): string | null => {
    for (const path of paths) {
      const value = readFile(path)
      if (value !== null) return value
    }
    return null
  }
  return {
    readCgroupCpu: () =>
      firstReadable([
        '/sys/fs/cgroup/cpu.stat',
        '/sys/fs/cgroup/cpuacct/cpuacct.usage',
      ]),
    readProcessStat: (pid) => readFile(`/proc/${pid}/stat`),
    readGpuBusyPercent: () =>
      firstReadable([
        '/sys/class/drm/card0/device/gpu_busy_percent',
        '/sys/class/drm/card1/device/gpu_busy_percent',
      ]),
    readGpuFrequency: () => {
      for (const card of ['card0', 'card1']) {
        const current = firstReadable([
          `/sys/class/drm/${card}/gt_act_freq_mhz`,
          `/sys/class/drm/${card}/gt/gt0/rps_act_freq_mhz`,
          `/sys/class/drm/${card}/gt_cur_freq_mhz`,
        ])
        const max = firstReadable([`/sys/class/drm/${card}/gt_max_freq_mhz`])
        const currentMhz = Number(current?.trim())
        const maxMhz = Number(max?.trim())
        if (Number.isFinite(currentMhz) && Number.isFinite(maxMhz) && maxMhz > 0) {
          return { currentMhz, maxMhz }
        }
      }
      return null
    },
    cores: cpuCount,
    nowMs: () => Date.now(),
  }
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
