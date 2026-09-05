import { describe, expect, test } from 'bun:test'
import {
  ResourceMonitorService,
  parseCgroupCpuUsec,
  parseProcessCpuTicks,
  type ChannelProcess,
  type ResourceReaders,
} from '../src/services/ResourceMonitorService'

/*
 * The readers are injected, so the arithmetic is tested without /proc. What is
 * being pinned is that a percentage means what it says: whole-box CPU is a
 * share of all cores, and a channel's figure is a share of one core, so a
 * pipeline using two cores reads as 200 rather than as 100 or as 25.
 */

function readers(over: Partial<ResourceReaders> = {}): ResourceReaders {
  return {
    readCgroupCpu: () => null,
    readProcessStat: () => null,
    readGpuBusyPercent: () => null,
    cores: () => 4,
    nowMs: () => 0,
    ...over,
  }
}

const channel = (id: string, pid: number, hardware = true): ChannelProcess => ({
  channelId: id,
  pid,
  hardware,
})

/*
 * A /proc/<pid>/stat line, numbered as the kernel numbers it. Field 1 is the
 * pid, field 2 the name in parentheses, field 3 the state, and utime and stime
 * are fields 14 and 15. Building it by field number rather than by counting
 * spaces keeps the fixture honest about the layout it is standing in for.
 */
function statLine(utime: number, stime: number, name = 'ffmpeg', pid = 123): string {
  const after: string[] = Array.from({ length: 30 }, () => '0')
  after[0] = 'S' // field 3, state
  after[11] = String(utime) // field 14
  after[12] = String(stime) // field 15
  return `${pid} (${name}) ${after.join(' ')}`
}

describe('parsing', () => {
  test('reads cgroup v2 and v1 alike', () => {
    expect(
      parseCgroupCpuUsec('usage_usec 73199857028\nuser_usec 56428669347\n')
    ).toBe(73199857028)
    // v1 is bare nanoseconds.
    expect(parseCgroupCpuUsec('7319985702800\n')).toBe(7319985702.8)
    expect(parseCgroupCpuUsec(null)).toBeNull()
    expect(parseCgroupCpuUsec('nothing useful')).toBeNull()
  })

  test('reads utime and stime past an executable name containing spaces', () => {
    /* Field two is the process name in parentheses and can contain spaces and
       brackets. Splitting the whole line on whitespace is the classic way to
       read the wrong fields, so the parser counts from the last ')'. */
    expect(parseProcessCpuTicks(statLine(400, 200))).toBe(600)
    expect(parseProcessCpuTicks(statLine(400, 200, 'odd name (with) parens'))).toBe(600)
    expect(parseProcessCpuTicks(null)).toBeNull()
    expect(parseProcessCpuTicks('malformed')).toBeNull()
  })
})

describe('ResourceMonitorService', () => {
  test('reports nothing on the first sample, because every figure is a delta', () => {
    const monitor = new ResourceMonitorService(readers())
    const first = monitor.sample([])

    expect(first.cpuPercent).toBeNull()
    expect(first.intervalMs).toBeNull()
    expect(first.channels).toEqual([])
  })

  test('whole-box CPU is a share of every core', () => {
    let now = 0
    let usec = 0
    const monitor = new ResourceMonitorService(
      readers({
        nowMs: () => now,
        cores: () => 4,
        readCgroupCpu: () => `usage_usec ${usec}`,
      })
    )
    monitor.sample([])

    // Two cores' worth of one second, over one second, on a four-core box.
    now = 1000
    usec = 2_000_000
    expect(monitor.sample([]).cpuPercent).toBe(50)
  })

  test('a channel figure is a share of one core, so two cores reads as 200', () => {
    /* This is the distinction that matters when comparing a hardware pipeline
       against a software one: per-channel cost is not diluted by core count. */
    let now = 0
    let ticks = 0
    const monitor = new ResourceMonitorService(
      readers({
        nowMs: () => now,
        readProcessStat: () => statLine(ticks, 0, 'ffmpeg', 9),
      })
    )
    monitor.sample([channel('nick-jr', 9)])

    now = 1000
    ticks = 200 // 200 ticks = 2s of CPU in 1s of wall clock
    const sample = monitor.sample([channel('nick-jr', 9)])

    expect(sample.channels).toHaveLength(1)
    expect(sample.channels[0]?.cpuPercent).toBe(200)
    expect(sample.channels[0]?.channelId).toBe('nick-jr')
  })

  test('a channel that appeared since the last sample is skipped, not guessed', () => {
    let now = 0
    const monitor = new ResourceMonitorService(
      readers({
        nowMs: () => now,
        readProcessStat: (pid) => statLine(5, 0, 'ffmpeg', pid),
      })
    )
    monitor.sample([channel('a', 1)])

    now = 1000
    const sample = monitor.sample([channel('a', 1), channel('b', 2)])

    expect(sample.channels.map((item) => item.channelId)).toEqual(['a'])
  })

  test('counts hardware and software pipelines, which is knowable even when the GPU is not', () => {
    const monitor = new ResourceMonitorService(readers())
    const sample = monitor.sample([
      channel('a', 1, true),
      channel('b', 2, true),
      channel('c', 3, false),
    ])

    expect(sample.gpu.hardwarePipelines).toBe(2)
    expect(sample.gpu.softwarePipelines).toBe(1)
  })

  test('says why there is no GPU figure rather than reporting a zero', () => {
    /* i915 does not publish busy in sysfs and the PMU needs privileges a
       container rarely has. A zero would read as an idle GPU. */
    const sample = new ResourceMonitorService(readers()).sample([])

    expect(sample.gpu.available).toBe(false)
    expect(sample.gpu.busyPercent).toBeUndefined()
    expect(sample.gpu.reason).toContain('perf counter')
  })

  test('uses a published GPU busy figure where the kernel has one', () => {
    const sample = new ResourceMonitorService(
      readers({ readGpuBusyPercent: () => '37\n' })
    ).sample([])

    expect(sample.gpu.available).toBe(true)
    expect(sample.gpu.busyPercent).toBe(37)
  })

  test('a clock that does not advance cannot produce a percentage', () => {
    const monitor = new ResourceMonitorService(
      readers({ nowMs: () => 5000, readCgroupCpu: () => 'usage_usec 10' })
    )
    monitor.sample([])
    const second = monitor.sample([])

    expect(second.cpuPercent).toBeNull()
    expect(second.intervalMs).toBeNull()
  })
})
