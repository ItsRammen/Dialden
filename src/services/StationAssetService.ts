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
  /** Full distinguishing slug: 'purple-dolls-mat' never collapses to 'mat'. */
  readonly subject: string
  readonly part: 'A' | 'B' | 'C'
}

/*
 * Where a piece sits in a break. 'break-out' leads, straight off the end of the
 * programme; 'break-in' closes, immediately before programming resumes; anything
 * unmarked is standalone and safe to place anywhere.
 */
export type StationAssetRole = 'break-out' | 'break-in' | 'standalone'

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
  /** Position within a break; absent means standalone. */
  readonly role?: StationAssetRole
  /* Carries a generic tune-in such as "weekdays on Nick". Evergreen, unlike the
     dated premiere material the importer rejects outright. */
  readonly scheduleCta?: boolean
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
  /*
   * Which end of the break this is for. 'break-out' wants the piece that leaves
   * the show -- "we'll be right back" -- and 'break-in' the piece that hands
   * over to what follows. Omitted, every kind is considered, which is the right
   * behaviour for a single sting standing in for a whole break.
   */
  readonly position?: 'break-out' | 'break-in'
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
      sequence: {
        family: 'play-with-us',
        id: `${station}-play-with-us-${subject}`,
        subject,
        part,
      },
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

  /* The tune-in marker rides on the production code, alongside the show it
     names -- 'show-team-umizoomi-schedule-cta-N14785-01' -- not on the semantic
     field where the break position lives. */
  return label.includes('schedule-cta') ? { scheduleCta: true } : {}
}

/*
 * Long-form pieces name their position in the break at the end of the semantic
 * field, and the older short filler exports already use the same suffixes.
 * 'standalone' is stated outright rather than left to be inferred.
 */
function parseAssetRole(label: string): { role?: StationAssetRole } {
  /* Matched as a whole token anywhere in the field rather than only at the end,
     because a seasonal piece appends its season after the position:
     'generic-break-out-summer' is still a break-out. */
  const token = (value: string): RegExp =>
    new RegExp(`(?:^|-)${value}(?:-|$)`)
  if (token('break-out').test(label)) return { role: 'break-out' }
  if (token('break-in').test(label)) return { role: 'break-in' }
  if (token('standalone').test(label)) return { role: 'standalone' }
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
  /* Hosted themed-night and stunt packaging needs an event context this
     scheduler does not model, so it is never an ordinary station asset. The
     exporter quarantines it outside the active tree; this is the backstop for
     a copy that predates that, or one filed by hand. */
  if (type === 'event-packaging') return null
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
  if (!kind) return null
  /* The semantic field carries the break position and the tune-in marker; the
     production code carries sequence and UGC metadata. Long-form pieces use the
     same suffixes as the older short exports, so both read the same way. */
  return {
    ...base,
    kind,
    ...parseAssetRole(value),
  }
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
  type Entry = typeof described[number]
  /* "We'll be right back" only makes sense when there is a back to be right
     back to, so it is offered when the same show resumes after the break. */
  const more = (entry: Entry): boolean =>
    sameShow &&
    entry.descriptor.kind === 'bumper-more' &&
    sameStationShow(entry.descriptor.show, context.nextShow)
  const nowNext = (entry: Entry): boolean =>
    entry.descriptor.kind === 'bumper-now-next' &&
    sameStationShow(entry.descriptor.now, context.nextShow) &&
    sameStationShow(entry.descriptor.next, context.followingShow)
  const upNext = (entry: Entry): boolean =>
    entry.descriptor.kind === 'bumper-up-next' &&
    sameStationShow(entry.descriptor.next, context.nextShow)
  const ident = (entry: Entry): boolean =>
    entry.descriptor.kind === 'ident-general'
  const priorities: Array<(entry: Entry) => boolean> =
    context.position === 'break-out'
      ? /* Nothing generic here: an ident leaving the show would just be another
           sting, and the break already opens with one if any exist. */
        [more]
      : context.position === 'break-in'
        ? [nowNext, upNext, ident]
        : [nowNext, more, upNext, ident]
  for (const matches of priorities) {
    const candidates = described.filter(matches).map((entry) => entry.item)
    if (candidates.length > 0) return deterministicCandidate(candidates, context.seed)
  }
  /* Unnamed assets stand in for a handover, which every break needs, but never
     for the leaving bumper, which is optional. Without this an unparsed sting
     is emitted at both ends of every pod. */
  if (context.position === 'break-out') return undefined
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

/*
 * How short an asset may be, relative to the longest that fits, and still count
 * as "long enough" for the gap. Picking only the longest is what made a
 * fourteen minute hole play one 28s clip thirty times in a row: exactly one
 * asset in the library is 28s, so the seed never got a choice.
 *
 * The value is measured, not guessed. Against a real 190-filler library
 * filling the real 14m21s gap, a band of 0.6 still leans on seven clips with
 * one of them playing ten times, because that library's durations are bimodal:
 * a handful near 20s and a mass at 10s and 5s. Widening to 0.3 brings in the
 * 10s assets and gives 45 distinct clips with nothing playing more than three
 * times, at the cost of 76 pieces instead of 43 -- which is what a real
 * commercial break looks like anyway.
 */
const FILLER_LENGTH_BAND = 0.3

/* How many pieces must pass before the same one may play again. The seasonal
   window is much wider because a season has an order of magnitude fewer pieces
   than the evergreen pool -- thirteen for autumn against five hundred -- and
   preferring them without spacing them would wear them out in an afternoon. */
const FILLER_SPACING = 8
const SEASONAL_SPACING = 40

/* How much history a caller should keep and pass back. Exported so the two
   cannot drift: keep less than this and seasonal spacing quietly shrinks. */
export const STATION_ASSET_HISTORY = SEASONAL_SPACING

/* A piece the importer gave a date window to. Out-of-season ones are already
   gone by the time selection runs -- the schedule filters the pool by date
   first -- so anything still carrying a window is in season now. */
function isSeasonal(item: MediaItem): boolean {
  return item.dateStart !== null || item.dateEnd !== null
}

export function selectStationFillerAsset(
  items: readonly MediaItem[],
  station: string,
  remainingSeconds: number,
  seed: string,
  /** Filenames just played in this gap, so the same clip is not repeated. */
  recentlyPlayed: readonly string[] = [],
  /*
   * Restricts the pool to one break position. Omitted, positional pieces are
   * held back: a break-out belongs against the end of a programme and a
   * break-in against the start of the next, so neither should turn up loose in
   * the middle of a pod. They are still used rather than wasted if a station
   * has nothing else.
   */
  role?: StationAssetRole
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
  const placeable = described.filter((entry) => !entry.descriptor.sequence)
  /* An unmarked piece and one the exporter marks 'standalone' are the same
     thing: safe anywhere. Long-form assets state it outright, older short
     exports leave it off. */
  const positionOf = (entry: (typeof placeable)[number]): StationAssetRole =>
    entry.descriptor.role ?? 'standalone'
  const wanted = role ?? 'standalone'
  const positioned = placeable.filter((entry) => positionOf(entry) === wanted)
  const standalone = positioned.length > 0 || role ? positioned : placeable
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
  if (fitting.length === 0) {
    /* Nothing fits, so whatever is chosen gets truncated to the remainder.
       The shortest asset loses the least of itself doing that. */
    const shortest = Math.min(...candidates.map((entry) => entry.item.durationSeconds))
    return deterministicCandidate(
      candidates
        .filter((entry) => entry.item.durationSeconds === shortest)
        .map((entry) => entry.item),
      seed
    )
  }

  /* Having a date window is only worth anything if the piece actually airs
     while it holds, so an in-season piece is taken ahead of the evergreen
     rotation -- but only one that has not played for a good while. Both of the
     ways this can run out lead back to the ordinary pool on their own: a
     station with nothing for the current season never has a candidate here,
     and one whose seasonal pieces have all played recently stops having one
     until they age out. */
  const spacedSeasonal = fitting.filter(
    (entry) =>
      isSeasonal(entry.item) &&
      !recentlyPlayed.slice(-SEASONAL_SPACING).includes(entry.item.filename)
  )
  if (spacedSeasonal.length > 0) {
    return deterministicCandidate(
      spacedSeasonal.map((entry) => entry.item),
      seed
    )
  }

  const longest = Math.max(...fitting.map((entry) => entry.item.durationSeconds))
  const longEnough = fitting.filter(
    (entry) => entry.item.durationSeconds >= longest * FILLER_LENGTH_BAND
  )
  /* Skip what has just played, unless that would leave nothing -- a station
     with one usable filler still has to fill the gap with it. */
  const recent = new Set(recentlyPlayed.slice(-FILLER_SPACING))
  const unplayed = longEnough.filter((entry) => !recent.has(entry.item.filename))
  const choices = unplayed.length > 0 ? unplayed : longEnough
  return deterministicCandidate(
    choices.map((entry) => entry.item),
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
