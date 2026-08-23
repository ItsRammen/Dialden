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
import type { LibraryKind } from '../types'

export interface ChannelConfigurationSnapshot {
  readonly channels: readonly LibraryChannelPolicy[]
  readonly manuallyOffAir: readonly string[]
  readonly collectionGroups?: readonly CollectionProgrammingGroups[]
}

/** Appdata-backed group membership used by generated and hand-built stations. */
export interface CollectionProgrammingGroups {
  /** Stable SQLite collection identity; absent on legacy version-1 snapshots. */
  readonly collectionId?: number
  /** Durable identity used across SQLite rebuilds and numeric ID reuse. */
  readonly collectionIdentityKey?: string
  readonly libraryKind?: LibraryKind
  readonly rootId: string
  readonly collectionTitle: string
  readonly groups: readonly string[]
}

interface StoredChannelConfiguration {
  readonly version: 1
  readonly channels: unknown
  readonly manuallyOffAir?: unknown
  readonly collectionGroups?: unknown
}

/**
 * A small, appdata-backed overlay for channel administration. The library
 * policy remains the source of approval rules and its original groups. This
 * file contains live channel schedules, operational off-air switches, and the
 * extra collection-group memberships created by station automation.
 */
export class ChannelConfigurationStore {
  constructor(
    private readonly path: string,
    private readonly defaults: readonly LibraryChannelPolicy[] = []
  ) {}

  load(): ChannelConfigurationSnapshot {
    if (!existsSync(this.path)) {
      return {
        channels: validateLibraryChannels(this.defaults),
        manuallyOffAir: [],
        collectionGroups: [],
      }
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
      collectionGroups: validateCollectionGroups(parsed.collectionGroups ?? []),
    }
  }

  save(snapshot: ChannelConfigurationSnapshot): void {
    const channels = validateLibraryChannels(snapshot.channels)
    const channelIds = new Set(channels.map((channel) => channel.id))
    const manuallyOffAir = [...new Set(snapshot.manuallyOffAir)]
    if (manuallyOffAir.some((channelId) => !channelIds.has(channelId))) {
      throw new Error('Cannot save off-air state for an unknown channel')
    }
    const collectionGroups = validateCollectionGroups(
      snapshot.collectionGroups ?? []
    )

    mkdirSync(dirname(this.path), { recursive: true })
    const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(
        temporaryPath,
        `${JSON.stringify(
          { version: 1, channels, manuallyOffAir, collectionGroups },
          null,
          2
        )}\n`,
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

export function validateCollectionGroups(
  input: unknown
): CollectionProgrammingGroups[] {
  if (!Array.isArray(input) || input.length > 10_000) {
    throw new Error('Collection programming groups must be an array of at most 10000 items')
  }
  const seen = new Set<string>()
  return input.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Collection group ${index} must be an object`)
    }
    const value = raw as {
      collectionId?: unknown
      collectionIdentityKey?: unknown
      libraryKind?: unknown
      rootId?: unknown
      collectionTitle?: unknown
      groups?: unknown
    }
    const rootId = typeof value.rootId === 'string' ? value.rootId.trim() : ''
    const collectionId =
      value.collectionId === undefined
        ? undefined
        : typeof value.collectionId === 'number' &&
            Number.isSafeInteger(value.collectionId) &&
            value.collectionId > 0
          ? value.collectionId
          : null
    const collectionTitle =
      typeof value.collectionTitle === 'string'
        ? value.collectionTitle.trim()
        : ''
    const collectionIdentityKey =
      value.collectionIdentityKey === undefined
        ? undefined
        : typeof value.collectionIdentityKey === 'string'
          ? value.collectionIdentityKey.trim()
          : null
    const libraryKind =
      value.libraryKind === undefined
        ? undefined
        : value.libraryKind === 'tv' ||
            value.libraryKind === 'movie' ||
            value.libraryKind === 'other'
          ? value.libraryKind
          : null
    if (
      collectionId === null ||
      collectionIdentityKey === null ||
      libraryKind === null ||
      (collectionIdentityKey === undefined) !== (libraryKind === undefined) ||
      (collectionIdentityKey !== undefined &&
        (!collectionIdentityKey ||
          collectionIdentityKey.length > 500 ||
          /[\r\n\0]/.test(collectionIdentityKey))) ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(rootId) ||
      !collectionTitle ||
      collectionTitle.length > 500 ||
      /[\r\n\0]/.test(collectionTitle) ||
      !Array.isArray(value.groups) ||
      value.groups.length > 100
    ) {
      throw new Error(`Collection group ${index} is invalid`)
    }
    const groups = [
      ...new Set(
        value.groups.map((rawGroup) => {
          const group = typeof rawGroup === 'string' ? rawGroup.trim() : ''
          if (!group || group.length > 64 || /[|,\r\n]/.test(group)) {
            throw new Error(`Collection group ${index} contains an invalid group`)
          }
          return group
        })
      ),
    ]
    if (groups.length === 0) {
      throw new Error(`Collection group ${index} must contain a group`)
    }
    const key =
      collectionIdentityKey !== undefined && libraryKind !== undefined
        ? `identity\0${rootId.toLocaleLowerCase('en-US')}\0${libraryKind}\0${collectionIdentityKey.toLocaleLowerCase('en-US')}`
        : collectionId === undefined
          ? `title\0${rootId.toLocaleLowerCase('en-US')}\0${collectionTitle.toLocaleLowerCase('en-US')}`
          : `id\0${collectionId}`
    if (seen.has(key)) {
      throw new Error(`Duplicate collection group assignment for ${collectionTitle}`)
    }
    seen.add(key)
    return {
      ...(collectionId === undefined ? {} : { collectionId }),
      ...(collectionIdentityKey === undefined
        ? {}
        : { collectionIdentityKey, libraryKind: libraryKind! }),
      rootId,
      collectionTitle,
      groups,
    }
  })
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
