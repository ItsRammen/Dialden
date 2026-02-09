/**
 * Hardware Profiles
 *
 * Hardcoded capability presets for known Raspberry Pi models.
 * Used to determine media compatibility at indexing time.
 */

export interface HardwareProfile {
  readonly name: string
  readonly codecs: {
    readonly h264: 'hardware' | 'software' | 'none'
    readonly h265: 'hardware' | 'software' | 'none'
  }
  /** Max decode height for H.264 (0 = unsupported) */
  readonly maxHeightH264: 0 | 720 | 1080 | 2160
  /** Max decode height for H.265/HEVC (0 = unsupported) */
  readonly maxHeightH265: 0 | 720 | 1080 | 2160
  readonly maxFps1080p: 30 | 60
  readonly maxBitrateMbps: number
}

export type ProfileKey = 'pi-zero-2w' | 'pi-3' | 'pi-4' | 'pi-5' | 'unknown'

/**
 * Capability presets for each known device.
 * Conservative thresholds to avoid false negatives.
 */
export const HARDWARE_PROFILES: Record<ProfileKey, HardwareProfile> = {
  'pi-zero-2w': {
    name: 'Raspberry Pi Zero 2 W',
    codecs: { h264: 'hardware', h265: 'none' },
    maxHeightH264: 1080,
    maxHeightH265: 0,
    maxFps1080p: 30,
    maxBitrateMbps: 15,
  },
  'pi-3': {
    name: 'Raspberry Pi 3',
    codecs: { h264: 'hardware', h265: 'none' },
    maxHeightH264: 1080,
    maxHeightH265: 0,
    maxFps1080p: 60,
    maxBitrateMbps: 20,
  },
  'pi-4': {
    name: 'Raspberry Pi 4',
    codecs: { h264: 'hardware', h265: 'hardware' },
    maxHeightH264: 1080,
    maxHeightH265: 2160,
    maxFps1080p: 60,
    maxBitrateMbps: 50,
  },
  'pi-5': {
    name: 'Raspberry Pi 5',
    codecs: { h264: 'software', h265: 'hardware' },
    maxHeightH264: 2160,
    maxHeightH265: 2160,
    maxFps1080p: 60,
    maxBitrateMbps: 80,
  },
  unknown: {
    name: 'Unknown Device',
    codecs: { h264: 'software', h265: 'none' },
    maxHeightH264: 720,
    maxHeightH265: 0,
    maxFps1080p: 30,
    maxBitrateMbps: 10,
  },
}

/**
 * Maps device model strings to profile keys.
 * Matches are partial — "Raspberry Pi Zero 2 W Rev 1.0" matches "Zero 2 W".
 */
export const MODEL_PATTERNS: Array<{ pattern: string; profile: ProfileKey }> = [
  { pattern: 'Zero 2 W', profile: 'pi-zero-2w' },
  { pattern: 'Pi 5', profile: 'pi-5' },
  { pattern: 'Pi 4', profile: 'pi-4' },
  { pattern: 'Pi 3', profile: 'pi-3' },
  // Note: Pi Zero (non-2) and Pi 1/2 would fall through to 'unknown'
]

/**
 * Resolve a device model string to a profile key.
 */
export function resolveProfile(modelString: string): ProfileKey {
  for (const { pattern, profile } of MODEL_PATTERNS) {
    if (modelString.includes(pattern)) {
      return profile
    }
  }
  return 'unknown'
}

/**
 * Get the full profile for a given key.
 */
export function getProfile(key: ProfileKey): HardwareProfile {
  return HARDWARE_PROFILES[key]
}
