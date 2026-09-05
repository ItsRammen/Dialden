import type { MediaItem } from '../types'

export type StationAssetKind =
  | 'bumper-more'
  | 'bumper-up-next'
  | 'bumper-now-next'
  | 'ident-general'
  | 'filler-general'
  | 'standby-loop'

/** One part of an ordered interactive bumper, such as Nick Jr's Play With Us. */
export interface StationAssetSequence {
  readonly family: 'play-with-us'
  /** Groups the parts. Stable across a rebuild of the library. */
  readonly id: string
  readonly part: 'A' | 'B' | 'C'
}

export interface StationAssetDescriptor {
  readonly station: string
  readonly kind: StationAssetKind
  readonly show?: string
  readonly now?: string
  readonly next?: string
  readonly targetSeconds?: number
  readonly variant?: number
  /** Present only on a part of an ordered sequence; see selectStationInteractiveSequence. */
  readonly sequence?: StationAssetSequence
  readonly sourceStyle?: 'ugc-navigation'
  /** Mentions a NickJr.com address that no longer exists. */
  readonly legacyWebCta?: boolean
  /** Says the show starts now, so it only works immediately before that show. */
  readonly rightNow?: boolean
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
  return filename.replace(/^.*[\\/]/, '').match(/__|--/) !== null
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
  if (filename.includes('--')) return parseNickstoryAssetFilename(filename)
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

/*
 * The five-part filename contract is unchanged; the exporter simply writes a
 * richer final code field, and everything before the production code is
 * metadata. Anything unrecognised is ignored, so an older export still parses.
 */
const PRODUCTION_CODE = /-n(?:hd)?\d+-\d+$/

function parseAssetCodeMetadata(
  station: string,
  code: string
): Partial<StationAssetDescriptor> {
  const label = code.replace(PRODUCTION_CODE, '')

  const sequence = /^play-with-us-([a-z0-9]+(?:-[a-z0-9]+)*)-part-([abc])$/.exec(label)
  if (sequence) {
    const subject = sequence[1] as string
    const part = (sequence[2] as string).toUpperCase() as 'A' | 'B' | 'C'
    return {
      sequence: { family: 'play-with-us', id: `${station}-play-with-us-${subject}`, part },
    }
  }

  if (label === 'ugc-navigation' || label.startsWith('ugc-navigation-')) {
    const rest = label.slice('ugc-navigation'.length).replace(/^-/, '')
    const legacyWebCta = rest === 'web-cta' || rest.startsWith('web-cta-')
    const cue = legacyWebCta ? rest.slice('web-cta'.length).replace(/^-/, '') : rest
    return {
      sourceStyle: 'ugc-navigation',
      ...(legacyWebCta ? { legacyWebCta: true } : {}),
      ...(cue === 'right-now' ? { rightNow: true } : {}),
    }
  }

  return {}
}

/** Canonical completed exports from nickstory_toasttv_combined_v5.py. */
export function parseNickstoryAssetFilename(filename: string): StationAssetDescriptor | null {
  const fields = filename.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').toLowerCase().split('--')
  const station = fields.shift()
  const type = fields.shift()
  const code = fields.pop()
  const year = fields.pop()
  if (!station || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(station) ||
      !year || !/^(19|20)\d{2}$/.test(year) || !code || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(code)) return null
  const resolved = station === 'nickelodeon' ? 'nick' : station
  const base = { station: resolved, ...parseAssetCodeMetadata(resolved, code) }
  const show = (value: string | undefined): value is string =>
    !!value && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value !== 'generic' && !value.startsWith('generic-')
  if (type === 'now-next' && fields.length === 2) {
    const now = fields[0]?.startsWith('now-') ? fields[0].slice(4) : undefined
    const next = fields[1]?.startsWith('next-') ? fields[1].slice(5) : undefined
    return show(now) && show(next) ? { ...base, kind: 'bumper-now-next', now, next } : null
  }
  if (fields.length !== 1) return null
  const value = fields[0]
  if (type === 'more' && show(value)) return { ...base, kind: 'bumper-more', show: value }
  if (type === 'up-next' && show(value)) return { ...base, kind: 'bumper-up-next', next: value }
  // A show-specific or ambiguous ID must never become a network-wide fallback.
  if (!value || !/^generic(?:-[a-z0-9]+)*$/.test(value)) return null
  const kinds = { ident: 'ident-general', filler: 'filler-general', standby: 'standby-loop' } as const
  const kind = type && Object.prototype.hasOwnProperty.call(kinds, type)
    ? kinds[type as keyof typeof kinds] : undefined
  return kind ? { ...base, kind } : null
}

function sameStationShow(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false
  // Library collection folders often append a release year; exports do not.
  const year = /-(?:19|20)\d{2}$/
  if (year.test(left) && year.test(right)) return left === right
  const normalize = (value: string) => value.replace(year, '')
  return normalize(left) === normalize(right)
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
  const sameShow = sameStationShow(context.currentShow, context.nextShow)
  const priorities: Array<(entry: typeof described[number]) => boolean> = [
    (entry) =>
      entry.descriptor.kind === 'bumper-now-next' &&
      sameStationShow(entry.descriptor.now, context.nextShow) &&
      sameStationShow(entry.descriptor.next, context.followingShow),
    (entry) =>
      sameShow &&
      entry.descriptor.kind === 'bumper-more' &&
      sameStationShow(entry.descriptor.show, context.nextShow),
    (entry) =>
      entry.descriptor.kind === 'bumper-up-next' &&
      sameStationShow(entry.descriptor.next, context.nextShow),
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
  /* A part of an ordered sequence is meaningless on its own -- an unanswered
     question, or an answer to one nobody heard -- so it never enters the
     independent rotation. selectStationInteractiveSequence places them. */
  const standalone = described.filter((entry) => !entry.descriptor.sequence)
  const fillers = standalone.filter((entry) => entry.descriptor.kind === 'filler-general')
  const standby = standalone.filter((entry) => entry.descriptor.kind === 'standby-loop')
  const idents = standalone.filter((entry) => entry.descriptor.kind === 'ident-general')
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

/**
 * Chooses one complete interactive sequence and returns its parts in order, or
 * an empty array when the station has none that can be played.
 *
 * The sequence is a single scheduling decision. A asks the question and C
 * reveals the answer, so a group is only usable when it has both: an A whose
 * answer never arrives is the bug this exists to prevent, and a C on its own
 * answers a question nobody was asked. B is a reminder and always optional --
 * `compact` drops it, which is what ToastTV's current one-asset transitions
 * want until there are real commercial-break blocks to spread the parts over.
 */
export function selectStationInteractiveSequence(
  items: readonly MediaItem[],
  station: string,
  seed: string,
  options: { compact?: boolean } = {}
): readonly MediaItem[] {
  const groups = new Map<string, Map<'A' | 'B' | 'C', MediaItem>>()
  for (const item of items) {
    if (item.durationSeconds <= 0) continue
    const descriptor = parseStationAssetFilename(item.filename)
    if (descriptor?.station !== station || !descriptor.sequence) continue
    const group = groups.get(descriptor.sequence.id) ?? new Map()
    /* Two files claiming the same part is an export fault, not a choice to
       make at scheduling time; the earlier filename wins so the timeline
       stays reproducible. */
    if (!group.has(descriptor.sequence.part)) group.set(descriptor.sequence.part, item)
    else {
      const held = group.get(descriptor.sequence.part) as MediaItem
      if (item.filename.localeCompare(held.filename, 'en-US') < 0) {
        group.set(descriptor.sequence.part, item)
      }
    }
    groups.set(descriptor.sequence.id, group)
  }

  const complete = [...groups.entries()]
    .filter(([, parts]) => parts.has('A') && parts.has('C'))
    .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
  if (complete.length === 0) return []

  const chosen = complete[hash(seed) % complete.length] as [string, Map<'A' | 'B' | 'C', MediaItem>]
  const parts = chosen[1]
  const order: Array<'A' | 'B' | 'C'> = options.compact ? ['A', 'C'] : ['A', 'B', 'C']
  const sequence: MediaItem[] = []
  for (const part of order) {
    const item = parts.get(part)
    if (item) sequence.push(item)
  }
  return sequence
}

/** The sequences a station could play, for diagnostics and admin listings. */
export function describeStationInteractiveSequences(
  items: readonly MediaItem[],
  station: string
): ReadonlyArray<{ id: string; parts: Array<'A' | 'B' | 'C'>; usable: boolean }> {
  const groups = new Map<string, Set<'A' | 'B' | 'C'>>()
  for (const item of items) {
    const descriptor = parseStationAssetFilename(item.filename)
    if (descriptor?.station !== station || !descriptor.sequence) continue
    const parts = groups.get(descriptor.sequence.id) ?? new Set<'A' | 'B' | 'C'>()
    parts.add(descriptor.sequence.part)
    groups.set(descriptor.sequence.id, parts)
  }
  return [...groups.entries()]
    .map(([id, parts]) => ({
      id,
      parts: (['A', 'B', 'C'] as const).filter((part) => parts.has(part)),
      usable: parts.has('A') && parts.has('C'),
    }))
    .sort((left, right) => left.id.localeCompare(right.id, 'en-US'))
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
