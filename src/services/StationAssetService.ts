import type { MediaItem } from '../types'

export type StationAssetKind =
  | 'bumper-more'
  | 'bumper-up-next'
  | 'bumper-now-next'
  | 'ident-general'
  | 'filler-general'
  | 'standby-loop'

export interface StationAssetDescriptor {
  readonly station: string
  readonly kind: StationAssetKind
  readonly show?: string
  readonly now?: string
  readonly next?: string
  readonly targetSeconds?: number
  readonly variant?: number
}

export interface StationAssetConfiguration {
  readonly station: string
  readonly kind: StationAssetKind
  readonly show?: string
  readonly now?: string
  readonly next?: string
  readonly targetSeconds?: number
  readonly variant?: number
}

export interface StationTransitionContext {
  readonly station: string
  readonly currentShow: string
  readonly nextShow: string
  readonly followingShow?: string
  readonly seed: string
  readonly maximumDurationSeconds?: number
}

const KINDS = new Set<StationAssetKind>([
  'bumper-more',
  'bumper-up-next',
  'bumper-now-next',
  'ident-general',
  'filler-general',
  'standby-loop',
])

export function looksLikeStationAssetFilename(filename: string): boolean {
  return filename.replace(/^.*[\\/]/, '').includes('__')
}

export function buildStationAssetFilename(
  configuration: StationAssetConfiguration,
  extension = '.mp4'
): string {
  const station = stationShowKey(configuration.station)
  if (!station) throw new Error('Station is required')
  if (!KINDS.has(configuration.kind)) throw new Error('Choose a valid asset type')

  const slug = (value: string | undefined, label: string): string => {
    const result = stationShowKey(value ?? '')
    if (!result) throw new Error(`${label} is required for this asset type`)
    return result
  }
  const fields = [station, configuration.kind]
  if (configuration.kind === 'bumper-more') {
    fields.push(`show-${slug(configuration.show, 'Show')}`)
  } else if (configuration.kind === 'bumper-up-next') {
    fields.push(`next-${slug(configuration.next, 'Next show')}`)
  } else if (configuration.kind === 'bumper-now-next') {
    fields.push(`now-${slug(configuration.now, 'Now show')}`)
    fields.push(`next-${slug(configuration.next, 'Next show')}`)
  }

  const targetSeconds = positiveInteger(configuration.targetSeconds, 'Target seconds', 3600)
  const variant = positiveInteger(configuration.variant, 'Variant', 999)
  fields.push(`target-${String(targetSeconds).padStart(2, '0')}s`)
  fields.push(`v${String(variant).padStart(2, '0')}`)

  const normalizedExtension = extension.toLowerCase()
  if (!/^\.[a-z0-9]{1,8}$/.test(normalizedExtension)) {
    throw new Error('The source file extension is not supported')
  }
  return `${fields.join('__')}${normalizedExtension}`
}

function positiveInteger(
  value: number | undefined,
  label: string,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0 || (value ?? 0) > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum}`)
  }
  return value as number
}

export function parseStationAssetFilename(
  filename: string
): StationAssetDescriptor | null {
  const basename = filename.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
  const fields = basename.split('__').map((field) => field.trim().toLowerCase())
  const station = fields[0]
  const kind = fields[1] as StationAssetKind | undefined
  if (!station || !/^[a-z0-9][a-z0-9-]*$/.test(station) || !kind || !KINDS.has(kind)) {
    return null
  }
  const result: {
    station: string
    kind: StationAssetKind
    show?: string
    now?: string
    next?: string
    targetSeconds?: number
    variant?: number
  } = { station, kind }
  const seen = new Set<string>()
  for (const field of fields.slice(2)) {
    const match = /^(show|now|next)-([a-z0-9][a-z0-9-]*)$/.exec(field)
    if (match) {
      const semantic = match[1] as 'show' | 'now' | 'next'
      if (seen.has(semantic)) return null
      seen.add(semantic)
      result[semantic] = match[2]
      continue
    }
    const target = /^target-(\d{1,4})s$/.exec(field)
    if (target) {
      if (seen.has('target')) return null
      seen.add('target')
      const seconds = Number(target[1])
      if (seconds > 0) result.targetSeconds = seconds
      continue
    }
    const variant = /^v(\d{1,3})$/.exec(field)
    if (variant) {
      if (seen.has('variant')) return null
      seen.add('variant')
      const number = Number(variant[1])
      if (number > 0) result.variant = number
      continue
    }
    return null
  }
  if (kind === 'bumper-more' && !result.show) return null
  if (kind === 'bumper-up-next' && !result.next) return null
  if (kind === 'bumper-now-next' && (!result.now || !result.next)) return null
  const generalKind = (
    ['ident-general', 'filler-general', 'standby-loop'] as StationAssetKind[]
  ).includes(kind)
  if (
    (kind === 'bumper-more' && (result.now || result.next)) ||
    (kind === 'bumper-up-next' && (result.show || result.now)) ||
    (kind === 'bumper-now-next' && result.show) ||
    (generalKind && (result.show || result.now || result.next))
  ) {
    return null
  }
  return result
}

export function stationShowKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function selectStationTransitionAsset(
  items: readonly MediaItem[],
  context: StationTransitionContext
): MediaItem | undefined {
  const described = items
    .map((item) => ({ item, descriptor: parseStationAssetFilename(item.filename) }))
    .filter(
      (entry): entry is { item: MediaItem; descriptor: StationAssetDescriptor } =>
        entry.descriptor?.station === context.station &&
        entry.item.durationSeconds > 0 &&
        (context.maximumDurationSeconds === undefined ||
          entry.item.durationSeconds <= context.maximumDurationSeconds)
    )
  const sameShow = context.currentShow === context.nextShow
  const priorities: Array<(entry: typeof described[number]) => boolean> = [
    (entry) =>
      entry.descriptor.kind === 'bumper-now-next' &&
      entry.descriptor.now === context.nextShow &&
      entry.descriptor.next === context.followingShow,
    (entry) =>
      sameShow &&
      entry.descriptor.kind === 'bumper-more' &&
      entry.descriptor.show === context.nextShow,
    (entry) =>
      entry.descriptor.kind === 'bumper-up-next' &&
      entry.descriptor.next === context.nextShow,
    (entry) => entry.descriptor.kind === 'ident-general',
  ]
  for (const matches of priorities) {
    const candidates = described.filter(matches).map((entry) => entry.item)
    if (candidates.length > 0) return deterministicCandidate(candidates, context.seed)
  }
  const legacy = items.filter(
    (item) =>
      parseStationAssetFilename(item.filename) === null &&
      !looksLikeStationAssetFilename(item.filename) &&
      item.durationSeconds > 0 &&
      (context.maximumDurationSeconds === undefined ||
        item.durationSeconds <= context.maximumDurationSeconds)
  )
  return legacy.length > 0 ? deterministicCandidate(legacy, context.seed) : undefined
}

export function selectStationFillerAsset(
  items: readonly MediaItem[],
  station: string,
  remainingSeconds: number,
  seed: string
): MediaItem | undefined {
  const described = items
    .map((item) => ({ item, descriptor: parseStationAssetFilename(item.filename) }))
    .filter(
      (entry): entry is { item: MediaItem; descriptor: StationAssetDescriptor } =>
        entry.descriptor?.station === station &&
        entry.item.durationSeconds > 0 &&
        ['filler-general', 'standby-loop', 'ident-general'].includes(entry.descriptor.kind)
    )
  const fillers = described.filter((entry) => entry.descriptor.kind === 'filler-general')
  const standby = described.filter((entry) => entry.descriptor.kind === 'standby-loop')
  const idents = described.filter((entry) => entry.descriptor.kind === 'ident-general')
  const candidates =
    fillers.length > 0
      ? fillers
      : standby.length > 0
        ? standby
        : idents.some((entry) => entry.item.durationSeconds >= remainingSeconds)
          ? idents
          : []
  if (candidates.length === 0) return undefined
  const fitting = candidates.filter(
    (entry) => entry.item.durationSeconds <= remainingSeconds
  )
  const pool = fitting.length > 0 ? fitting : candidates
  const longest = Math.max(...pool.map((entry) => entry.item.durationSeconds))
  return deterministicCandidate(
    pool.filter((entry) => entry.item.durationSeconds === longest).map((entry) => entry.item),
    seed
  )
}

function deterministicCandidate(
  candidates: readonly MediaItem[],
  seed: string
): MediaItem {
  const ordered = [...candidates].sort(
    (left, right) => left.filename.localeCompare(right.filename, 'en-US') || left.id - right.id
  )
  return ordered[hash(seed) % ordered.length] as MediaItem
}

function hash(value: string): number {
  let result = 2166136261
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return result >>> 0
}
