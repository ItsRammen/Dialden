import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  discoverQsvDeviceCandidates,
  resolveFfmpegTranscodingBackend,
  type FfmpegProbeRunner,
} from '../src/services/FfmpegTranscodingBackend'

describe('resolveFfmpegTranscodingBackend', () => {
  test('keeps the compatibility-preserving software default without probing', async () => {
    let probes = 0
    const status = await resolveFfmpegTranscodingBackend(
      { mode: 'software', qsvDevice: '/dev/dri/renderD128' },
      async () => {
        probes += 1
        return { code: 0, stderr: '' }
      }
    )

    expect(probes).toBe(0)
    expect(status).toEqual({
      configuredMode: 'software',
      activeBackend: 'software',
      hardwareAcceleration: false,
    })
  })

  test('enables Intel QSV only after a real encode probe succeeds', async () => {
    let command: readonly string[] = []
    const runner: FfmpegProbeRunner = async (value) => {
      command = value
      return { code: 0, stderr: '' }
    }
    const status = await resolveFfmpegTranscodingBackend(
      {
        mode: 'auto',
        qsvDevice: '/dev/dri/renderD129',
        ffmpegPath: '/opt/ffmpeg',
      },
      runner
    )

    expect(command[0]).toBe('/opt/ffmpeg')
    expect(command).toContain('vaapi=va:/dev/dri/renderD129')
    expect(command).toContain('qsv=qs@va')
    expect(command).toContain('h264_qsv')
    expect(command).toContain('format=nv12')
    expect(status).toEqual({
      configuredMode: 'auto',
      activeBackend: 'intel-qsv',
      hardwareAcceleration: true,
      requestedDevice: '/dev/dri/renderD129',
      device: '/dev/dri/renderD129',
      deviceCandidates: ['/dev/dri/renderD129'],
      probeAttempts: [
        {
          device: '/dev/dri/renderD129',
          exitCode: 0,
          timedOut: false,
        },
      ],
    })
  })

  test('discovers render nodes in numeric order from a DRM directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'toasttv-qsv-'))
    try {
      await Promise.all([
        writeFile(join(directory, 'renderD130'), ''),
        writeFile(join(directory, 'card0'), ''),
        writeFile(join(directory, 'renderD128'), ''),
        writeFile(join(directory, 'renderD9-not-a-node'), ''),
      ])

      const candidates = await discoverQsvDeviceCandidates(directory)
      expect(candidates.map((candidate) => basename(candidate))).toEqual([
        'renderD128',
        'renderD130',
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('distinguishes a missing DRM directory from a missing concrete node', async () => {
    expect(
      await discoverQsvDeviceCandidates('/toasttv-test-missing/dev/dri')
    ).toEqual([])
    expect(
      await discoverQsvDeviceCandidates('/toasttv-test-missing/dev/dri/')
    ).toEqual([])
    expect(
      await discoverQsvDeviceCandidates(
        '/toasttv-test-missing/dev/dri/renderD128/'
      )
    ).toEqual(['/toasttv-test-missing/dev/dri/renderD128'])
  })

  test('probes every discovered render node until an Intel device succeeds', async () => {
    const commands: Array<readonly string[]> = []
    const status = await resolveFfmpegTranscodingBackend(
      { mode: 'auto', qsvDevice: '/dev/dri/' },
      async (command) => {
        commands.push(command)
        return command.includes('vaapi=va:/dev/dri/renderD129')
          ? { code: 0, stderr: '' }
          : {
              code: 234,
              stderr: 'No VA display found for device /dev/dri/renderD128.',
            }
      },
      async () => ['/dev/dri/renderD128', '/dev/dri/renderD129']
    )

    expect(commands).toHaveLength(2)
    expect(status.activeBackend).toBe('intel-qsv')
    expect(status.requestedDevice).toBe('/dev/dri/')
    expect(status.device).toBe('/dev/dri/renderD129')
    expect(status.deviceCandidates).toEqual([
      '/dev/dri/renderD128',
      '/dev/dri/renderD129',
    ])
    expect(status.probeAttempts).toEqual([
      {
        device: '/dev/dri/renderD128',
        exitCode: 234,
        timedOut: false,
        detail: 'No VA display found for device /dev/dri/renderD128.',
      },
      {
        device: '/dev/dri/renderD129',
        exitCode: 0,
        timedOut: false,
      },
    ])
  })

  test('reports an empty DRM directory without passing it to FFmpeg', async () => {
    let probes = 0
    const status = await resolveFfmpegTranscodingBackend(
      { mode: 'auto', qsvDevice: '/dev/dri/' },
      async () => {
        probes += 1
        return { code: 0, stderr: '' }
      },
      async () => []
    )

    expect(probes).toBe(0)
    expect(status.activeBackend).toBe('software')
    expect(status.requestedDevice).toBe('/dev/dri/')
    expect(status.deviceCandidates).toEqual([])
    expect(status.probeAttempts).toEqual([])
    expect(status.fallbackReason).toContain('contains no renderD devices')
  })

  test('falls back to software and exposes a bounded diagnostic', async () => {
    const status = await resolveFfmpegTranscodingBackend(
      { mode: 'intel-qsv', qsvDevice: '/dev/dri/renderD128' },
      async () => ({
        code: 1,
        stderr: `first line\n${'driver unavailable '.repeat(80)}`,
      })
    )

    expect(status.activeBackend).toBe('software')
    expect(status.hardwareAcceleration).toBe(false)
    expect(status.configuredMode).toBe('intel-qsv')
    expect(status.device).toBe('/dev/dri/renderD128')
    expect(status.fallbackReason).toContain('exited with code 1')
    expect(status.fallbackReason!.length).toBeLessThanOrEqual(540)
  })

  test('keeps the actionable device error instead of FFmpeg wrapper noise', async () => {
    const status = await resolveFfmpegTranscodingBackend(
      { mode: 'auto', qsvDevice: '/dev/dri/renderD128' },
      async () => ({
        code: 234,
        stderr: [
          '[VAAPI @ 0x123] No VA display found for device /dev/dri/renderD128.',
          'Device creation failed: -22.',
          "Failed to set value 'vaapi=va:/dev/dri/renderD128' for option 'init_hw_device': Invalid argument",
          'Error parsing global options: Invalid argument',
        ].join('\n'),
      })
    )

    expect(status.fallbackReason).toContain(
      'No VA display found for device /dev/dri/renderD128.'
    )
    expect(status.fallbackReason).not.toContain('Error parsing global options')
    expect(status.requestedDevice).toBe('/dev/dri/renderD128')
    expect(status.deviceCandidates).toEqual(['/dev/dri/renderD128'])
    expect(status.probeAttempts).toEqual([
      {
        device: '/dev/dri/renderD128',
        exitCode: 234,
        timedOut: false,
        detail: 'No VA display found for device /dev/dri/renderD128.',
      },
    ])
  })

  test('falls back cleanly when ffmpeg cannot be spawned', async () => {
    const status = await resolveFfmpegTranscodingBackend(
      { mode: 'auto', qsvDevice: '/dev/dri/renderD128' },
      async () => {
        throw new Error('ffmpeg was not found')
      }
    )

    expect(status.activeBackend).toBe('software')
    expect(status.fallbackReason).toContain('could not start')
    expect(status.fallbackReason).toContain('ffmpeg was not found')
  })

  test('reports a probe timeout without surfacing process noise', async () => {
    const status = await resolveFfmpegTranscodingBackend(
      { mode: 'auto', qsvDevice: '/dev/dri/renderD128' },
      async () => ({ code: null, stderr: 'killed', timedOut: true })
    )

    expect(status.activeBackend).toBe('software')
    expect(status.fallbackReason).toBe('Intel QSV probe timed out after 8000ms')
  })
})
