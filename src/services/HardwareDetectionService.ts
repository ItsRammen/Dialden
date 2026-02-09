/**
 * Hardware Detection Service
 *
 * Detects the current device's hardware capabilities and resolves
 * to a known profile. Runs once on first boot and stores the result.
 */

import { readFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import {
  type ProfileKey,
  type HardwareProfile,
  HARDWARE_PROFILES,
  resolveProfile,
  getProfile,
} from '../config/hardwareProfiles'
import { logger } from '../utils/logger'

export interface DetectedHardware {
  readonly modelString: string
  readonly profileKey: ProfileKey
  readonly profile: HardwareProfile
  readonly ramMb: number
}

export interface IHardwareDetectionService {
  detect(): DetectedHardware
  getProfile(): HardwareProfile
  getProfileKey(): ProfileKey
}

export class HardwareDetectionService implements IHardwareDetectionService {
  private cachedResult: DetectedHardware | null = null

  /**
   * Detect hardware capabilities.
   * Result is cached after first call.
   * Can be overridden via TOASTTV_PROFILE env var for testing.
   */
  detect(): DetectedHardware {
    if (this.cachedResult) {
      return this.cachedResult
    }

    // Allow forcing a profile via env var for testing
    const envProfile = process.env.TOASTTV_PROFILE
    if (envProfile && envProfile in HARDWARE_PROFILES) {
      const profile = getProfile(envProfile as ProfileKey)
      this.cachedResult = {
        modelString: `Forced via TOASTTV_PROFILE=${envProfile}`,
        profileKey: envProfile as ProfileKey,
        profile,
        ramMb: this.readRamMb(),
      }
      logger.info(`Hardware profile forced: ${profile.name} (${envProfile})`)
      return this.cachedResult
    }

    const modelString = this.readModelString()
    const profileKey = resolveProfile(modelString)
    const profile = getProfile(profileKey)
    const ramMb = this.readRamMb()

    this.cachedResult = {
      modelString,
      profileKey,
      profile,
      ramMb,
    }

    logger.info(
      `Hardware detected: ${profile.name} (${profileKey}), ${ramMb}MB RAM`
    )

    return this.cachedResult
  }

  getProfile(): HardwareProfile {
    return this.detect().profile
  }

  getProfileKey(): ProfileKey {
    return this.detect().profileKey
  }

  /**
   * Read device model from /proc/device-tree/model
   */
  private readModelString(): string {
    const modelPath = '/proc/device-tree/model'

    if (!existsSync(modelPath)) {
      logger.warn('Device model file not found, assuming unknown hardware')
      return 'Unknown'
    }

    try {
      // File contains null-terminated string
      const raw = readFileSync(modelPath, 'utf-8')
      return raw.replace(/\0/g, '').trim()
    } catch {
      logger.warn('Failed to read device model, assuming unknown hardware')
      return 'Unknown'
    }
  }

  /**
   * Read total RAM in MB from /proc/meminfo
   */
  private readRamMb(): number {
    try {
      const output = execSync('free -m', { encoding: 'utf-8' })
      const match = output.match(/Mem:\s+(\d+)/)
      if (match?.[1]) {
        return parseInt(match[1], 10)
      }
    } catch {
      // Fallback for non-Linux systems
    }
    return 512 // Conservative default
  }
}
