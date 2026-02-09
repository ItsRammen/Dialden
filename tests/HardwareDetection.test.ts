/**
 * Hardware Detection Tests
 *
 * Tests for hardware profile resolution and compatibility checking.
 */

import { describe, it, expect } from 'bun:test'
import { mock } from 'jest-mock-extended'
import type {
  IFileSystem,
  IMediaProbe,
  MediaConfig,
  InterludeConfig,
} from '../src/types'
import type { IMediaRepository } from '../src/repositories/IMediaRepository'
import { MediaIndexer } from '../src/services/MediaIndexer'
import type { IHardwareDetectionService } from '../src/services/HardwareDetectionService'
import {
  HARDWARE_PROFILES,
  resolveProfile,
} from '../src/config/hardwareProfiles'

/**
 * Builder function for media metadata
 */
const createMetadataBuilder = (
  override?: Partial<{
    durationSeconds: number
    codec: string | null
    width: number | null
    height: number | null
    fps: number | null
    bitrateMbps: number | null
  }>
) => ({
  durationSeconds: 120,
  codec: 'h264',
  width: 1920,
  height: 1080,
  fps: 30,
  bitrateMbps: 10,
  ...override,
})

const mediaConfig: MediaConfig = {
  directory: '/media/videos',
  supportedExtensions: ['.mp4', '.mkv'],
  databasePath: ':memory:',
}

const interludeConfig: InterludeConfig = {
  enabled: true,
  frequency: 2,
  directory: '/media/interludes',
}

describe('HardwareProfiles', () => {
  it('should resolve Pi Zero 2 W from model string', () => {
    const key = resolveProfile('Raspberry Pi Zero 2 W Rev 1.0')
    expect(key).toBe('pi-zero-2w')
  })

  it('should resolve Pi 3 from model string', () => {
    const key = resolveProfile('Raspberry Pi 3 Model B Plus Rev 1.3')
    expect(key).toBe('pi-3')
  })

  it('should resolve Pi 4 from model string', () => {
    const key = resolveProfile('Raspberry Pi 4 Model B Rev 1.4')
    expect(key).toBe('pi-4')
  })

  it('should resolve Pi 5 from model string', () => {
    const key = resolveProfile('Raspberry Pi 5 Model B Rev 1.0')
    expect(key).toBe('pi-5')
  })

  it('should fallback to unknown for unrecognized model', () => {
    const key = resolveProfile('Some Other Device')
    expect(key).toBe('unknown')
  })

  it('should have correct limits for Pi Zero 2 W', () => {
    const profile = HARDWARE_PROFILES['pi-zero-2w']
    expect(profile.maxResolution).toBe(1080)
    expect(profile.maxFps1080p).toBe(30)
    expect(profile.codecs.h265).toBe('none')
  })

  it('should have correct limits for Pi 4', () => {
    const profile = HARDWARE_PROFILES['pi-4']
    expect(profile.maxResolution).toBe(2160)
    expect(profile.maxFps1080p).toBe(60)
    expect(profile.codecs.h265).toBe('hardware')
  })
})

describe('MediaIndexer.checkCompatibility', () => {
  it('should return compatible for standard h264 1080p30 on Pi Zero 2 W', () => {
    const repo = mock<IMediaRepository>()
    const fs = mock<IFileSystem>()
    const probe = mock<IMediaProbe>()
    const hardware = mock<IHardwareDetectionService>()

    hardware.getProfile.mockReturnValue(HARDWARE_PROFILES['pi-zero-2w'])

    const indexer = new MediaIndexer(
      mediaConfig,
      interludeConfig,
      repo,
      fs,
      probe,
      undefined, // thumbnails
      hardware
    )

    const metadata = createMetadataBuilder({
      codec: 'h264',
      height: 1080,
      fps: 30,
      bitrateMbps: 10,
    })

    // @ts-ignore - accessing private method for testing
    const result = indexer.checkCompatibility(metadata)

    expect(result).toBe('compatible')
  })

  it('should return incompatible for HEVC on device without hardware decode', () => {
    const repo = mock<IMediaRepository>()
    const fs = mock<IFileSystem>()
    const probe = mock<IMediaProbe>()
    const hardware = mock<IHardwareDetectionService>()

    hardware.getProfile.mockReturnValue(HARDWARE_PROFILES['pi-zero-2w'])

    const indexer = new MediaIndexer(
      mediaConfig,
      interludeConfig,
      repo,
      fs,
      probe,
      undefined,
      hardware
    )

    const metadata = createMetadataBuilder({
      codec: 'hevc',
      height: 1080,
      fps: 30,
      bitrateMbps: 10,
    })

    // @ts-ignore - accessing private method for testing
    const result = indexer.checkCompatibility(metadata)

    expect(result).toBe('incompatible')
  })

  it('should return incompatible for resolution exceeding device max', () => {
    const repo = mock<IMediaRepository>()
    const fs = mock<IFileSystem>()
    const probe = mock<IMediaProbe>()
    const hardware = mock<IHardwareDetectionService>()

    hardware.getProfile.mockReturnValue(HARDWARE_PROFILES['pi-zero-2w'])

    const indexer = new MediaIndexer(
      mediaConfig,
      interludeConfig,
      repo,
      fs,
      probe,
      undefined,
      hardware
    )

    // Pi Zero 2 W max is 1080p, 4K should be incompatible
    const metadata = createMetadataBuilder({
      codec: 'h264',
      height: 2160,
      fps: 30,
      bitrateMbps: 20,
    })

    // @ts-ignore - accessing private method for testing
    const result = indexer.checkCompatibility(metadata)

    expect(result).toBe('incompatible')
  })

  it('should return marginal for 1080p60 on device limited to 1080p30', () => {
    const repo = mock<IMediaRepository>()
    const fs = mock<IFileSystem>()
    const probe = mock<IMediaProbe>()
    const hardware = mock<IHardwareDetectionService>()

    hardware.getProfile.mockReturnValue(HARDWARE_PROFILES['pi-zero-2w'])

    const indexer = new MediaIndexer(
      mediaConfig,
      interludeConfig,
      repo,
      fs,
      probe,
      undefined,
      hardware
    )

    const metadata = createMetadataBuilder({
      codec: 'h264',
      height: 1080,
      fps: 60,
      bitrateMbps: 10,
    })

    // @ts-ignore - accessing private method for testing
    const result = indexer.checkCompatibility(metadata)

    expect(result).toBe('marginal')
  })

  it('should return marginal for bitrate exceeding device max', () => {
    const repo = mock<IMediaRepository>()
    const fs = mock<IFileSystem>()
    const probe = mock<IMediaProbe>()
    const hardware = mock<IHardwareDetectionService>()

    hardware.getProfile.mockReturnValue(HARDWARE_PROFILES['pi-zero-2w'])

    const indexer = new MediaIndexer(
      mediaConfig,
      interludeConfig,
      repo,
      fs,
      probe,
      undefined,
      hardware
    )

    // Pi Zero 2 W max is 25 Mbps
    const metadata = createMetadataBuilder({
      codec: 'h264',
      height: 1080,
      fps: 30,
      bitrateMbps: 40,
    })

    // @ts-ignore - accessing private method for testing
    const result = indexer.checkCompatibility(metadata)

    expect(result).toBe('marginal')
  })

  it('should return compatible for HEVC on Pi 4 with hardware decode', () => {
    const repo = mock<IMediaRepository>()
    const fs = mock<IFileSystem>()
    const probe = mock<IMediaProbe>()
    const hardware = mock<IHardwareDetectionService>()

    hardware.getProfile.mockReturnValue(HARDWARE_PROFILES['pi-4'])

    const indexer = new MediaIndexer(
      mediaConfig,
      interludeConfig,
      repo,
      fs,
      probe,
      undefined,
      hardware
    )

    const metadata = createMetadataBuilder({
      codec: 'hevc',
      height: 1080,
      fps: 60,
      bitrateMbps: 20,
    })

    // @ts-ignore - accessing private method for testing
    const result = indexer.checkCompatibility(metadata)

    expect(result).toBe('compatible')
  })

  it('should return compatible when no hardware service is provided', () => {
    const repo = mock<IMediaRepository>()
    const fs = mock<IFileSystem>()
    const probe = mock<IMediaProbe>()

    const indexer = new MediaIndexer(
      mediaConfig,
      interludeConfig,
      repo,
      fs,
      probe
      // No thumbnails, no hardware service
    )

    const metadata = createMetadataBuilder({
      codec: 'hevc',
      height: 2160,
      fps: 60,
      bitrateMbps: 100,
    })

    // @ts-ignore - accessing private method for testing
    const result = indexer.checkCompatibility(metadata)

    expect(result).toBe('compatible')
  })
})
