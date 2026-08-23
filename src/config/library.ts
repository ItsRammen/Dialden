import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { LibraryKind, MediaRootConfig } from '../types'

export interface LibraryPolicyCollection {
  readonly name: string
  readonly groups?: readonly string[]
}

export interface LibraryPolicyRoot {
  readonly collections: readonly LibraryPolicyCollection[]
}

export type ScheduleDay =
  | 'sun'
  | 'mon'
  | 'tue'
  | 'wed'
  | 'thu'
  | 'fri'
  | 'sat'

export interface ChannelScheduleSlot {
  readonly days: readonly ScheduleDay[]
  readonly start: string
  readonly end: string
  readonly groups: readonly string[]
}

export interface LibraryChannelPolicy {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly timezone: string
  readonly slots: readonly ChannelScheduleSlot[]
}

export interface LibraryPolicyDocument {
  readonly version: 1
  readonly profile?: {
    readonly id: string
    readonly name: string
    readonly age?: number
  }
  readonly roots: Readonly<Record<string, LibraryPolicyRoot>>
  readonly channels?: readonly LibraryChannelPolicy[]
}

export interface ResolvedLibraryConfig {
  readonly roots: readonly MediaRootConfig[]
  readonly policy: LibraryPolicyDocument | null
  readonly policyPath: string | null
}

function readPolicy(path: string): LibraryPolicyDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Unable to read library policy at ${path}: ${String(error)}`)
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Library policy must be a JSON object')
  }

  const candidate = parsed as {
    version?: unknown
    profile?: unknown
    roots?: unknown
    channels?: unknown
  }
  if (candidate.version !== 1) {
    throw new Error(`Unsupported library policy version: ${String(candidate.version)}`)
  }
  if (!candidate.roots || typeof candidate.roots !== 'object') {
    throw new Error('Library policy must define a roots object')
  }

  const roots: Record<string, LibraryPolicyRoot> = {}
  for (const [rootId, rawRoot] of Object.entries(
    candidate.roots as Record<string, unknown>
  )) {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(rootId)) {
      throw new Error(`Invalid library policy root ID: ${rootId}`)
    }
    if (!rawRoot || typeof rawRoot !== 'object') {
      throw new Error(`Library policy root ${rootId} must be an object`)
    }

    const rawCollections = (rawRoot as { collections?: unknown }).collections
    if (!Array.isArray(rawCollections)) {
      throw new Error(`Library policy root ${rootId} must define collections`)
    }

    const seen = new Set<string>()
    const collections = rawCollections.map((rawCollection, index) => {
      if (!rawCollection || typeof rawCollection !== 'object') {
        throw new Error(
          `Library policy ${rootId}.collections[${index}] must be an object`
        )
      }
      const collection = rawCollection as { name?: unknown; groups?: unknown }
      const name =
        typeof collection.name === 'string' ? collection.name.trim() : ''
      if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
        throw new Error(
          `Library policy ${rootId}.collections[${index}] has an invalid name`
        )
      }
      const normalizedName = name.toLocaleLowerCase('en-US')
      if (seen.has(normalizedName)) {
        throw new Error(`Duplicate collection ${name} in policy root ${rootId}`)
      }
      seen.add(normalizedName)

      const groups = Array.isArray(collection.groups)
        ? collection.groups.map((group) => {
            if (typeof group !== 'string' || !group.trim()) {
              throw new Error(`Collection ${name} contains an invalid group`)
            }
            return group.trim()
          })
        : undefined

      return { name, groups }
    })

    roots[rootId] = { collections }
  }

  const rawProfile = candidate.profile
  let profile: LibraryPolicyDocument['profile']
  if (rawProfile !== undefined) {
    if (!rawProfile || typeof rawProfile !== 'object') {
      throw new Error('Library policy profile must be an object')
    }
    const value = rawProfile as { id?: unknown; name?: unknown; age?: unknown }
    if (typeof value.id !== 'string' || typeof value.name !== 'string') {
      throw new Error('Library policy profile requires string id and name')
    }
    if (
      value.age !== undefined &&
      (!Number.isInteger(value.age) || (value.age as number) < 0)
    ) {
      throw new Error('Library policy profile age must be a non-negative integer')
    }
    profile = {
      id: value.id,
      name: value.name,
      age: value.age as number | undefined,
    }
  }

  let channels: LibraryChannelPolicy[] | undefined
  if (candidate.channels !== undefined) {
    if (!Array.isArray(candidate.channels)) {
      throw new Error('Library policy channels must be an array')
    }
    const channelIds = new Set<string>()
    channels = candidate.channels.map((rawChannel, channelIndex) => {
      if (!rawChannel || typeof rawChannel !== 'object') {
        throw new Error(`channels[${channelIndex}] must be an object`)
      }
      const value = rawChannel as {
        id?: unknown
        name?: unknown
        enabled?: unknown
        timezone?: unknown
        slots?: unknown
      }
      const id = typeof value.id === 'string' ? value.id.trim() : ''
      const name = typeof value.name === 'string' ? value.name.trim() : ''
      const timezone =
        typeof value.timezone === 'string' ? value.timezone.trim() : ''
      if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id) || !name || !timezone) {
        throw new Error(`channels[${channelIndex}] has invalid identity fields`)
      }
      if (channelIds.has(id)) throw new Error(`Duplicate channel ID: ${id}`)
      channelIds.add(id)
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
      } catch {
        throw new Error(`Channel ${id} has invalid timezone: ${timezone}`)
      }
      if (!Array.isArray(value.slots)) {
        throw new Error(`Channel ${id} must define slots`)
      }

      const slots = value.slots.map((rawSlot, slotIndex) => {
        if (!rawSlot || typeof rawSlot !== 'object') {
          throw new Error(`Channel ${id} slot ${slotIndex} must be an object`)
        }
        const slot = rawSlot as {
          days?: unknown
          start?: unknown
          end?: unknown
          groups?: unknown
        }
        if (
          !Array.isArray(slot.days) ||
          !Array.isArray(slot.groups) ||
          typeof slot.start !== 'string' ||
          typeof slot.end !== 'string'
        ) {
          throw new Error(`Channel ${id} slot ${slotIndex} is incomplete`)
        }
        const days = slot.days.map((day) => {
          if (
            typeof day !== 'string' ||
            !['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].includes(day)
          ) {
            throw new Error(`Channel ${id} slot ${slotIndex} has invalid day`)
          }
          return day as ScheduleDay
        })
        const groups = slot.groups.map((group) => {
          if (typeof group !== 'string' || !group.trim()) {
            throw new Error(`Channel ${id} slot ${slotIndex} has invalid group`)
          }
          return group.trim()
        })
        const startMinutes = parseScheduleTime(slot.start)
        const endMinutes = parseScheduleTime(slot.end)
        if (endMinutes <= startMinutes) {
          throw new Error(`Channel ${id} slots cannot cross midnight`)
        }
        return {
          days,
          start: slot.start,
          end: slot.end,
          groups,
        }
      })

      return {
        id,
        name,
        enabled: value.enabled !== false,
        timezone,
        slots,
      }
    })
  }

  return { version: 1, profile, roots, channels }
}

function parseScheduleTime(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) throw new Error(`Invalid schedule time: ${value}`)
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) {
    throw new Error(`Invalid schedule time: ${value}`)
  }
  return hour * 60 + minute
}

/**
 * Resolve independently mounted TV/movie roots. When those managed roots are
 * configured they fail closed: a missing collection in the policy approves
 * nothing. The single-root legacy configuration remains unrestricted.
 */
export function loadLibraryConfig(
  fallbackMediaDirectory: string,
  environment: Record<string, string | undefined> = process.env
): ResolvedLibraryConfig {
  const tvDirectory = environment.TOASTTV_TV_MEDIA?.trim()
  const movieDirectory = environment.TOASTTV_MOVIE_MEDIA?.trim()
  const policyPathValue = environment.TOASTTV_LIBRARY_POLICY?.trim()
  const policyPath = policyPathValue ? resolve(policyPathValue) : null
  const policy = policyPath ? readPolicy(policyPath) : null

  if (!tvDirectory && !movieDirectory) {
    return {
      roots: [
        {
          id: 'media',
          directory: fallbackMediaDirectory,
          kind: 'other',
        },
      ],
      policy,
      policyPath,
    }
  }

  const roots: MediaRootConfig[] = []
  const addRoot = (
    id: string,
    directory: string | undefined,
    kind: LibraryKind
  ) => {
    if (!directory) return
    const policyRoot = policy?.roots[id]
    roots.push({
      id,
      directory,
      kind,
      // Managed roots are default-deny, including when no policy was supplied.
      approvedCollections: policyRoot?.collections.map((item) => item.name) ?? [],
    })
  }

  addRoot('tv', tvDirectory, 'tv')
  addRoot('movies', movieDirectory, 'movie')

  const resolvedDirectories: Array<{ id: string; path: string }> = []
  for (const root of roots) {
    const resolvedPath = resolve(root.directory)
    for (const previous of resolvedDirectories) {
      const fromPrevious = relative(previous.path, resolvedPath)
      const fromCurrent = relative(resolvedPath, previous.path)
      const overlaps =
        fromPrevious === '' ||
        (!fromPrevious.startsWith('..') && !isAbsolute(fromPrevious)) ||
        (!fromCurrent.startsWith('..') && !isAbsolute(fromCurrent))
      if (overlaps) {
        throw new Error(
          `Media roots ${previous.id} and ${root.id} overlap: ${previous.path} / ${resolvedPath}`
        )
      }
    }
    resolvedDirectories.push({ id: root.id, path: resolvedPath })
  }

  return { roots, policy, policyPath }
}
