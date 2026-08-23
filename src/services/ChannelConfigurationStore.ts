import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import {
  validateLibraryChannels,
  type LibraryChannelPolicy,
} from '../config/library'

export interface ChannelConfigurationSnapshot {
  readonly channels: readonly LibraryChannelPolicy[]
  readonly manuallyOffAir: readonly string[]
}

interface StoredChannelConfiguration {
  readonly version: 1
  readonly channels: unknown
  readonly manuallyOffAir?: unknown
}

/**
 * A small, appdata-backed overlay for channel administration. The library
 * policy remains the source of approval rules and collection group membership;
 * this file contains only channel schedules and their operational off-air
 * switches.
 */
export class ChannelConfigurationStore {
  constructor(
    private readonly path: string,
    private readonly defaults: readonly LibraryChannelPolicy[] = []
  ) {}

  load(): ChannelConfigurationSnapshot {
    if (!existsSync(this.path)) {
      return { channels: validateLibraryChannels(this.defaults), manuallyOffAir: [] }
    }

    let parsed: StoredChannelConfiguration
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StoredChannelConfiguration
    } catch (error) {
      throw new Error(`Unable to read channel configuration: ${safeMessage(error)}`)
    }
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) {
      throw new Error('Channel configuration must be a version 1 JSON object')
    }

    const channels = validateLibraryChannels(parsed.channels)
    const channelIds = new Set(channels.map((channel) => channel.id))
    const rawOffAir = parsed.manuallyOffAir ?? []
    if (
      !Array.isArray(rawOffAir) ||
      rawOffAir.some(
        (channelId) => typeof channelId !== 'string' || !channelIds.has(channelId)
      )
    ) {
      throw new Error('Channel configuration contains an invalid off-air state')
    }

    return {
      channels,
      manuallyOffAir: [...new Set(rawOffAir as string[])],
    }
  }

  save(snapshot: ChannelConfigurationSnapshot): void {
    const channels = validateLibraryChannels(snapshot.channels)
    const channelIds = new Set(channels.map((channel) => channel.id))
    const manuallyOffAir = [...new Set(snapshot.manuallyOffAir)]
    if (manuallyOffAir.some((channelId) => !channelIds.has(channelId))) {
      throw new Error('Cannot save off-air state for an unknown channel')
    }

    mkdirSync(dirname(this.path), { recursive: true })
    const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(
        temporaryPath,
        `${JSON.stringify({ version: 1, channels, manuallyOffAir }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' }
      )
      renameSync(temporaryPath, this.path)
    } catch (error) {
      try {
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
      } catch {
        // Preserve the original write error.
      }
      throw new Error(`Unable to save channel configuration: ${safeMessage(error)}`)
    }
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
