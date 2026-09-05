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
  /** Optional station identity for this programming window. */
  readonly branding?: ChannelScheduleBrandingPolicy
}

export interface ChannelScheduleBrandingPolicy {
  /** `channel` keeps the channel-wide setting; custom selects an uploaded variant. */
  readonly mode: 'channel' | 'inherit' | 'custom' | 'off'
  readonly logoId?: string
}

export type ChannelBrandingMode = 'inherit' | 'custom' | 'off'

export interface ChannelBrandingPolicy {
  readonly mode: ChannelBrandingMode
  /**
   * Missing/false keeps the logo as client UI metadata only. `true` also burns
   * the selected logo into the normalized HLS video for legacy presentation.
   */
  readonly burnIn?: boolean
  readonly opacity: number
  readonly position: 0 | 2 | 6 | 8
  readonly x: number
  readonly y: number
  readonly sizePercent: number
}

export interface ChannelMarathonPolicy {
  readonly enabled: boolean
  /** Start a marathon after this many ordinary programme selections. */
  readonly frequency: number
  /** Maximum consecutive episodes in one marathon, including its first item. */
  readonly episodeCount: number
}

export type ChannelAutomationNetworkId =
  | 'cartoon-network'
  | 'nickelodeon'
  | 'nick-jr'
  | 'disney-channel'
  | 'disney-junior'
  | 'toon-disney'
  | 'jetix'
  | 'toonami'
  | 'abc3-abc-me'
  | 'abc-family-au'
  | 'abc-kids-au'
  | 'cbbc'
  | 'cbeebies'
  | 'pbs-kids'

export interface ChannelAutomationHandoffPolicy {
  /** The after-hours identity is deliberately locked until profile/PIN support exists. */
  readonly identity: 'adult-swim'
  readonly mode: 'locked-off-air'
  /** Local station time when the daytime network signs off. */
  readonly start: string
  /** Local station time when the daytime network returns. */
  readonly end: string
}

/** Deterministic namespace owned by one generated channel. */
export function channelAutomationGroup(channelId: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < channelId.length; index++) {
    hash ^= channelId.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `toasttv-auto-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function automationLockedHandoffGroup(group: string): string {
  return `${group}-locked-after-hours`
}

export function channelLockedHandoffGroup(channelId: string): string {
  return automationLockedHandoffGroup(channelAutomationGroup(channelId))
}

export function isChannelLockedHandoffGroup(group: string): boolean {
  return /^toasttv-auto-[0-9a-f]{8}-locked-after-hours$/.test(group)
}

export interface ChannelAutomationCollectionRef {
  readonly rootId: string
  readonly libraryKind: Extract<LibraryKind, 'tv' | 'movie'>
  readonly identityKey: string
}

export interface ChannelAutomationPolicy {
  /** Preset/template identifier used to reconstruct the modal Auto editor. */
  readonly preset: string
  readonly airtime:
    | 'all-day'
    | 'school-day'
    | 'evening'
    | 'weekend-mornings'
  readonly networkId?: ChannelAutomationNetworkId
  readonly eraStartYear?: number
  readonly eraEndYear?: number
  readonly selectionMode?: 'automatic' | 'explicit'
  /** Durable identities survive rescans that assign new numeric collection IDs. */
  readonly collectionRefs?: readonly ChannelAutomationCollectionRef[]
  /** Optional time-shared identity. It never grants adult-content eligibility. */
  readonly handoff?: ChannelAutomationHandoffPolicy
}

export interface LibraryChannelPolicy {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly timezone: string
  readonly slots: readonly ChannelScheduleSlot[]
  /** Absent is backwards-compatible and means inherit the global logo. */
  readonly branding?: ChannelBrandingPolicy
  /** Absent/disabled preserves the ordinary deterministic programme order. */
  readonly marathon?: ChannelMarathonPolicy
  /** Optional provenance for an Auto-built station; legacy/manual channels omit it. */
  readonly automation?: ChannelAutomationPolicy
}

export interface LibraryPolicyDocument {
  readonly version: 1
  readonly profile?: {
    readonly id: string
    readonly name: string
    readonly age?: number
    readonly rules?: {
      readonly allow: readonly string[]
      readonly review: readonly string[]
      readonly block: readonly string[]
    }
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
            return normalizeProgrammingGroup(
              group,
              `Collection ${name} contains an invalid group`
            )
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
    const value = rawProfile as {
      id?: unknown
      name?: unknown
      age?: unknown
      rules?: unknown
    }
    if (typeof value.id !== 'string' || typeof value.name !== 'string') {
      throw new Error('Library policy profile requires string id and name')
    }
    if (
      value.age !== undefined &&
      (!Number.isInteger(value.age) || (value.age as number) < 0)
    ) {
      throw new Error('Library policy profile age must be a non-negative integer')
    }
    let rules:
      | { allow: string[]; review: string[]; block: string[] }
      | undefined
    if (value.rules !== undefined) {
      if (!value.rules || typeof value.rules !== 'object') {
        throw new Error('Library policy profile rules must be an object')
      }
      const rawRules = value.rules as Record<string, unknown>
      const readRatings = (key: 'allow' | 'review' | 'block') => {
        const bucket = rawRules[key]
        if (
          !Array.isArray(bucket) ||
          bucket.some((rating) => typeof rating !== 'string' || !rating.trim())
        ) {
          throw new Error(`Library policy profile ${key} rules are invalid`)
        }
        return bucket.map((rating) => (rating as string).trim())
      }
      rules = {
        allow: readRatings('allow'),
        review: readRatings('review'),
        block: readRatings('block'),
      }
    }
    profile = {
      id: value.id,
      name: value.name,
      age: value.age as number | undefined,
      ...(rules ? { rules } : {}),
    }
  }

  const channels =
    candidate.channels === undefined
      ? undefined
      : validateLibraryChannels(candidate.channels)

  return { version: 1, profile, roots, channels }
}

/**
 * Validate the user-editable portion of a library policy. Keeping this parser
 * shared means channel edits can be applied live without accepting a looser
 * schema than the startup policy loader.
 */
export function validateLibraryChannels(input: unknown): LibraryChannelPolicy[] {
  if (!Array.isArray(input)) {
    throw new Error('Channels must be an array')
  }
  if (input.length > 100) {
    throw new Error('At most 100 channels may be configured')
  }

  const channelIds = new Set<string>()
  return input.map((rawChannel, channelIndex) => {
    if (!rawChannel || typeof rawChannel !== 'object') {
      throw new Error(`channels[${channelIndex}] must be an object`)
    }
    const value = rawChannel as {
      id?: unknown
      name?: unknown
      enabled?: unknown
      timezone?: unknown
      slots?: unknown
      branding?: unknown
      marathon?: unknown
      automation?: unknown
    }
    const id = typeof value.id === 'string' ? value.id.trim() : ''
    const name = typeof value.name === 'string' ? value.name.trim() : ''
    const timezone =
      typeof value.timezone === 'string' ? value.timezone.trim() : ''
    if (
      !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id) ||
      !name ||
      name.length > 100 ||
      !timezone ||
      timezone.length > 100
    ) {
      throw new Error(`channels[${channelIndex}] has invalid identity fields`)
    }
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
      throw new Error(`Channel ${id} enabled must be a boolean`)
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
    if (value.slots.length > 200) {
      throw new Error(`Channel ${id} has too many schedule slots`)
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
        branding?: unknown
      }
      if (
        !Array.isArray(slot.days) ||
        !Array.isArray(slot.groups) ||
        typeof slot.start !== 'string' ||
        typeof slot.end !== 'string'
      ) {
        throw new Error(`Channel ${id} slot ${slotIndex} is incomplete`)
      }
      if (slot.days.length === 0 || slot.groups.length === 0) {
        throw new Error(`Channel ${id} slot ${slotIndex} needs days and groups`)
      }
      const days = [
        ...new Set(
          slot.days.map((day) => {
            if (
              typeof day !== 'string' ||
              !['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].includes(day)
            ) {
              throw new Error(`Channel ${id} slot ${slotIndex} has invalid day`)
            }
            return day as ScheduleDay
          })
        ),
      ]
      const groups = [
        ...new Set(
          slot.groups.map((group) => {
            return normalizeProgrammingGroup(
              group,
              `Channel ${id} slot ${slotIndex} has invalid group`
            )
          })
        ),
      ]
      const startMinutes = parseScheduleTime(slot.start)
      const endMinutes = parseScheduleTime(slot.end, true)
      if (endMinutes <= startMinutes) {
        throw new Error(`Channel ${id} slots cannot cross midnight`)
      }
      return {
        days,
        start: slot.start,
        end: slot.end,
        groups,
        ...(slot.branding === undefined
          ? {}
          : { branding: validateScheduleBranding(slot.branding, id, slotIndex) }),
      }
    })

    for (let leftIndex = 0; leftIndex < slots.length; leftIndex++) {
      const left = slots[leftIndex] as ChannelScheduleSlot
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < slots.length;
        rightIndex++
      ) {
        const right = slots[rightIndex] as ChannelScheduleSlot
        const sharesDay = left.days.some((day) => right.days.includes(day))
        const overlaps =
          parseScheduleTime(left.start) < parseScheduleTime(right.end, true) &&
          parseScheduleTime(right.start) < parseScheduleTime(left.end, true)
        if (sharesDay && overlaps) {
          throw new Error(
            `Channel ${id} slots ${leftIndex} and ${rightIndex} overlap`
          )
        }
      }
    }

    const automation =
      value.automation === undefined
        ? undefined
        : validateChannelAutomation(value.automation, id)
    validateLockedHandoffSchedule(slots, id, automation?.handoff)

    return {
      id,
      name,
      enabled: value.enabled !== false,
      timezone,
      slots,
      ...(value.branding === undefined
        ? {}
        : { branding: validateChannelBranding(value.branding, id) }),
      ...(value.marathon === undefined
        ? {}
        : { marathon: validateChannelMarathon(value.marathon, id) }),
      ...(automation === undefined ? {} : { automation }),
    }
  })
}

function validateChannelAutomation(
  input: unknown,
  channelId: string
): ChannelAutomationPolicy {
  if (!input || typeof input !== 'object') {
    throw new Error(`Channel ${channelId} automation must be an object`)
  }
  const value = input as Record<string, unknown>
  const preset = typeof value.preset === 'string' ? value.preset.trim() : ''
  const airtime = typeof value.airtime === 'string' ? value.airtime.trim() : ''
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(preset)) {
    throw new Error(`Channel ${channelId} automation preset is invalid`)
  }
  if (
    !['all-day', 'school-day', 'evening', 'weekend-mornings'].includes(airtime)
  ) {
    throw new Error(`Channel ${channelId} automation airtime is invalid`)
  }
  const networkId =
    typeof value.networkId === 'string' ? value.networkId.trim() : ''
  const networkIds = new Set<ChannelAutomationNetworkId>([
    'cartoon-network',
    'nickelodeon',
    'nick-jr',
    'disney-channel',
    'disney-junior',
    'toon-disney',
    'jetix',
    'toonami',
    'abc3-abc-me',
    'abc-family-au',
    'abc-kids-au',
    'cbbc',
    'cbeebies',
    'pbs-kids',
  ])
  const eraStartYear = value.eraStartYear
  const eraEndYear = value.eraEndYear
  const selectionMode = value.selectionMode
  const hasStrictNetworkFields =
    networkId !== '' ||
    eraStartYear !== undefined ||
    eraEndYear !== undefined ||
    value.handoff !== undefined
  if (preset === 'network-copy') {
    if (!networkIds.has(networkId as ChannelAutomationNetworkId)) {
      throw new Error(`Channel ${channelId} automation network is invalid`)
    }
    if (
      !Number.isInteger(eraStartYear) ||
      !Number.isInteger(eraEndYear) ||
      (eraStartYear as number) < 1900 ||
      (eraEndYear as number) > 2100 ||
      (eraStartYear as number) > (eraEndYear as number)
    ) {
      throw new Error(`Channel ${channelId} automation era range is invalid`)
    }
    const networkYearBounds: Readonly<
      Record<ChannelAutomationNetworkId, readonly [number, number]>
    > = {
      'cartoon-network': [1992, 2026],
      nickelodeon: [1979, 2026],
      'nick-jr': [1988, 2026],
      'disney-channel': [1983, 2026],
      'disney-junior': [1997, 2026],
      'toon-disney': [1998, 2009],
      jetix: [2004, 2009],
      toonami: [1997, 2008],
      'abc3-abc-me': [2009, 2024],
      'abc-family-au': [2024, 2026],
      'abc-kids-au': [2009, 2026],
      cbbc: [2002, 2026],
      cbeebies: [2002, 2026],
      'pbs-kids': [1994, 2026],
    }
    const [minimumYear, maximumYear] =
      networkYearBounds[networkId as ChannelAutomationNetworkId]
    if (
      (eraStartYear as number) < minimumYear ||
      (eraEndYear as number) > maximumYear
    ) {
      throw new Error(
        `Channel ${channelId} automation era is outside the selected network's available years`
      )
    }
    if (!['automatic', 'explicit'].includes(String(selectionMode))) {
      throw new Error(`Channel ${channelId} automation selection mode is invalid`)
    }
  } else if (hasStrictNetworkFields) {
    throw new Error(
      `Channel ${channelId} network-copy settings require the network-copy preset`
    )
  }
  if (
    preset !== 'network-copy' &&
    selectionMode !== undefined &&
    !['automatic', 'explicit'].includes(String(selectionMode))
  ) {
    throw new Error(`Channel ${channelId} automation selection mode is invalid`)
  }
  const collectionRefs =
    value.collectionRefs === undefined
      ? undefined
      : validateAutomationCollectionRefs(value.collectionRefs, channelId)
  if (
    preset === 'network-copy' &&
    selectionMode === 'explicit' &&
    (!collectionRefs || collectionRefs.length === 0)
  ) {
    throw new Error(
      `Channel ${channelId} explicit network selection requires collection references`
    )
  }
  if (preset === 'network-copy' && selectionMode === 'automatic' && collectionRefs) {
    throw new Error(
      `Channel ${channelId} automatic network selection cannot store collection references`
    )
  }
  if (
    preset !== 'network-copy' &&
    collectionRefs &&
    selectionMode !== 'explicit'
  ) {
    throw new Error(
      `Channel ${channelId} automatic recipe cannot store collection references`
    )
  }
  if (preset === 'custom' && selectionMode === 'automatic') {
    throw new Error(`Channel ${channelId} custom automation must be explicit`)
  }
  if (
    preset !== 'network-copy' &&
    selectionMode === 'explicit' &&
    (!collectionRefs || collectionRefs.length === 0)
  ) {
    throw new Error(
      `Channel ${channelId} explicit selection requires collection references`
    )
  }
  const handoff =
    value.handoff === undefined
      ? undefined
      : validateAutomationHandoff(value.handoff, channelId)
  if (
    handoff &&
    (preset !== 'network-copy' ||
      networkId !== 'cartoon-network' ||
      airtime !== 'all-day')
  ) {
    throw new Error(
      `Channel ${channelId} after-hours handoff requires an all-day Cartoon Network copy`
    )
  }
  return {
    preset,
    airtime: airtime as ChannelAutomationPolicy['airtime'],
    ...(preset === 'network-copy'
      ? {
          networkId: networkId as ChannelAutomationNetworkId,
          eraStartYear: eraStartYear as number,
          eraEndYear: eraEndYear as number,
          selectionMode: selectionMode as 'automatic' | 'explicit',
          ...(collectionRefs ? { collectionRefs } : {}),
          ...(handoff ? { handoff } : {}),
        }
      : {
          ...(selectionMode === undefined
            ? {}
            : { selectionMode: selectionMode as 'automatic' | 'explicit' }),
          ...(collectionRefs ? { collectionRefs } : {}),
        }),
  }
}

function validateAutomationHandoff(
  input: unknown,
  channelId: string
): ChannelAutomationHandoffPolicy {
  if (!input || typeof input !== 'object') {
    throw new Error(`Channel ${channelId} after-hours handoff must be an object`)
  }
  const value = input as Record<string, unknown>
  if (value.identity !== 'adult-swim' || value.mode !== 'locked-off-air') {
    throw new Error(`Channel ${channelId} after-hours handoff is invalid`)
  }
  if (typeof value.start !== 'string' || typeof value.end !== 'string') {
    throw new Error(`Channel ${channelId} after-hours handoff needs sign-off and return times`)
  }
  let startMinutes: number
  let endMinutes: number
  try {
    startMinutes = parseScheduleTime(value.start)
    endMinutes = parseScheduleTime(value.end)
  } catch {
    throw new Error(`Channel ${channelId} after-hours handoff has an invalid time`)
  }
  if (
    startMinutes < 17 * 60 ||
    endMinutes > 10 * 60 ||
    startMinutes <= endMinutes
  ) {
    throw new Error(
      `Channel ${channelId} after-hours handoff must start between 17:00 and 23:59 and return between 00:00 and 10:00`
    )
  }
  return {
    identity: 'adult-swim',
    mode: 'locked-off-air',
    start: value.start,
    end: value.end,
  }
}

function validateLockedHandoffSchedule(
  slots: readonly ChannelScheduleSlot[],
  channelId: string,
  handoff: ChannelAutomationHandoffPolicy | undefined
): void {
  const reservedSlots = slots.filter((slot) =>
    slot.groups.some(isChannelLockedHandoffGroup)
  )
  if (!handoff) {
    if (reservedSlots.length > 0) {
      throw new Error(
        `Channel ${channelId} uses the reserved after-hours group without a handoff`
      )
    }
    return
  }

  const lockedGroup = channelLockedHandoffGroup(channelId)
  const signOn = parseScheduleTime(handoff.end)
  const expectedRanges = [
    ...(signOn > 0 ? [{ start: '00:00', end: handoff.end }] : []),
    { start: handoff.start, end: '24:00' },
  ]
  const everyDay: readonly ScheduleDay[] = [
    'sun',
    'mon',
    'tue',
    'wed',
    'thu',
    'fri',
    'sat',
  ]
  const matchesLockedRange = (
    slot: ChannelScheduleSlot,
    range: { readonly start: string; readonly end: string }
  ): boolean =>
    slot.start === range.start &&
    slot.end === range.end &&
    slot.groups.length === 1 &&
    slot.groups[0] === lockedGroup &&
    slot.days.length === everyDay.length &&
    everyDay.every((day) => slot.days.includes(day)) &&
    slot.branding?.mode === 'custom' &&
    slot.branding.logoId === handoff.identity

  if (
    reservedSlots.length !== expectedRanges.length ||
    !expectedRanges.every((range) =>
      reservedSlots.some((slot) => matchesLockedRange(slot, range))
    )
  ) {
    throw new Error(
      `Channel ${channelId} after-hours handoff schedule must keep every overnight minute locked off-air`
    )
  }
}

function validateAutomationCollectionRefs(
  input: unknown,
  channelId: string
): ChannelAutomationCollectionRef[] {
  if (!Array.isArray(input) || input.length > 5_000) {
    throw new Error(`Channel ${channelId} automation collection references are invalid`)
  }
  const seen = new Set<string>()
  return input.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(
        `Channel ${channelId} automation collection reference ${index} is invalid`
      )
    }
    const value = raw as Record<string, unknown>
    const rootId = typeof value.rootId === 'string' ? value.rootId.trim() : ''
    const libraryKind = value.libraryKind
    const identityKey =
      typeof value.identityKey === 'string' ? value.identityKey.trim() : ''
    if (
      !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(rootId) ||
      !['tv', 'movie'].includes(String(libraryKind)) ||
      !identityKey ||
      identityKey.length > 500 ||
      /[\r\n\0]/.test(identityKey)
    ) {
      throw new Error(
        `Channel ${channelId} automation collection reference ${index} is invalid`
      )
    }
    const key = `${rootId}\0${String(libraryKind)}\0${identityKey}`
    if (seen.has(key)) {
      throw new Error(
        `Channel ${channelId} automation collection references contain a duplicate`
      )
    }
    seen.add(key)
    return {
      rootId,
      libraryKind: libraryKind as Extract<LibraryKind, 'tv' | 'movie'>,
      identityKey,
    }
  })
}

function validateChannelMarathon(
  input: unknown,
  channelId: string
): ChannelMarathonPolicy {
  if (!input || typeof input !== 'object') {
    throw new Error(`Channel ${channelId} marathon must be an object`)
  }
  const value = input as Record<string, unknown>
  if (typeof value.enabled !== 'boolean') {
    throw new Error(`Channel ${channelId} marathon enabled must be a boolean`)
  }
  if (
    !Number.isInteger(value.frequency) ||
    (value.frequency as number) < 2 ||
    (value.frequency as number) > 100
  ) {
    throw new Error(`Channel ${channelId} marathon frequency must be from 2 to 100`)
  }
  if (
    !Number.isInteger(value.episodeCount) ||
    (value.episodeCount as number) < 2 ||
    (value.episodeCount as number) > 20
  ) {
    throw new Error(`Channel ${channelId} marathon episode count must be from 2 to 20`)
  }
  return {
    enabled: value.enabled,
    frequency: value.frequency as number,
    episodeCount: value.episodeCount as number,
  }
}

function validateScheduleBranding(
  input: unknown,
  channelId: string,
  slotIndex: number
): ChannelScheduleBrandingPolicy {
  if (!input || typeof input !== 'object') {
    throw new Error(`Channel ${channelId} slot ${slotIndex} branding must be an object`)
  }
  const value = input as Record<string, unknown>
  const mode = String(value.mode ?? '')
  if (!['channel', 'inherit', 'custom', 'off'].includes(mode)) {
    throw new Error(`Channel ${channelId} slot ${slotIndex} branding mode is invalid`)
  }
  const logoId = typeof value.logoId === 'string' ? value.logoId.trim() : ''
  if (mode === 'custom' && !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(logoId)) {
    throw new Error(`Channel ${channelId} slot ${slotIndex} custom branding needs a safe logo ID`)
  }
  if (mode !== 'custom' && logoId) {
    throw new Error(`Channel ${channelId} slot ${slotIndex} logo ID requires custom branding`)
  }
  return {
    mode: mode as ChannelScheduleBrandingPolicy['mode'],
    ...(mode === 'custom' ? { logoId } : {}),
  }
}

function validateChannelBranding(
  input: unknown,
  channelId: string
): ChannelBrandingPolicy {
  if (!input || typeof input !== 'object') {
    throw new Error(`Channel ${channelId} branding must be an object`)
  }
  const value = input as Record<string, unknown>
  const mode = value.mode
  const burnIn = value.burnIn
  const opacity = value.opacity
  const position = value.position
  const x = value.x
  const y = value.y
  const sizePercent = value.sizePercent
  if (!['inherit', 'custom', 'off'].includes(String(mode))) {
    throw new Error(`Channel ${channelId} branding mode is invalid`)
  }
  if (burnIn !== undefined && typeof burnIn !== 'boolean') {
    throw new Error(`Channel ${channelId} branding burn-in must be a boolean`)
  }
  if (mode === 'off' && burnIn === true) {
    throw new Error(`Channel ${channelId} cannot burn in disabled branding`)
  }
  if (!Number.isInteger(opacity) || (opacity as number) < 0 || (opacity as number) > 255) {
    throw new Error(`Channel ${channelId} branding opacity is invalid`)
  }
  if (![0, 2, 6, 8].includes(position as number)) {
    throw new Error(`Channel ${channelId} branding position is invalid`)
  }
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    (x as number) < 0 ||
    (y as number) < 0 ||
    (x as number) > 500 ||
    (y as number) > 500
  ) {
    throw new Error(`Channel ${channelId} branding offsets are invalid`)
  }
  if (
    !Number.isInteger(sizePercent) ||
    (sizePercent as number) < 5 ||
    (sizePercent as number) > 30
  ) {
    throw new Error(`Channel ${channelId} branding size is invalid`)
  }
  return {
    mode: mode as ChannelBrandingMode,
    ...(burnIn === true ? { burnIn: true } : {}),
    opacity: opacity as number,
    position: position as ChannelBrandingPolicy['position'],
    x: x as number,
    y: y as number,
    sizePercent: sizePercent as number,
  }
}

function normalizeProgrammingGroup(value: unknown, errorMessage: string): string {
  const group = typeof value === 'string' ? value.trim() : ''
  if (!group || group.length > 64 || /[|,\r\n]/.test(group)) {
    throw new Error(errorMessage)
  }
  return group
}

function parseScheduleTime(value: string, allowDayEnd = false): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) throw new Error(`Invalid schedule time: ${value}`)
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (
    minute > 59 ||
    hour > 24 ||
    (hour === 24 && (!allowDayEnd || minute !== 0))
  ) {
    throw new Error(`Invalid schedule time: ${value}`)
  }
  return hour * 60 + minute
}

/**
 * Resolve independently mounted TV/movie roots. When those managed roots are
 * configured they fail closed: a missing collection in the policy approves
 * nothing. Legacy single-root mode is also review-only until an explicit
 * parent or policy decision exists.
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
