/**
 * Bumpers: the short pieces of station voice between programmes.
 *
 * A television channel does not cut from one programme straight into the
 * next. It tells you what you have been watching and what is coming, and that
 * announcement is what makes a playlist feel like a station.
 *
 * Two sources, in that order of preference:
 *
 *  - a file somebody made, assigned to a collection or to the channel
 *  - one generated from a template, so a channel has bumpers on the day it is
 *    created rather than after three hundred clips have been authored
 *
 * A generated bumper is rendered once and cached against the text it shows,
 * so the second airing of "Up next, SpongeBob" costs nothing.
 */

/** What the bumper is announcing. */
export type BumperKind =
  /** Only the programme about to start. */
  | 'up-next'
  /** What just finished and what follows it. */
  | 'now-next'
  /** The station itself; no programme text. */
  | 'ident'

export interface BumperText {
  /** Small line above, such as "UP NEXT" or the channel name. */
  readonly eyebrow?: string
  /** The programme being announced. */
  readonly headline: string
  /** Episode, time, or the programme that just ended. */
  readonly support?: string
}

/**
 * A file somebody authored. Assigned to a collection, or to a channel as its
 * house bumper. Always beats a generated one: if a person made something for
 * this moment, that is the answer.
 */
export interface BumperFileAssignment {
  /** Absolute path to a playable file. */
  readonly path: string
  readonly durationSeconds: number
  /** Present when the assignment is for one collection rather than a channel. */
  readonly collectionId?: number
  readonly kind?: BumperKind
}

export interface ChannelBumperConfig {
  readonly enabled: boolean
  /** How many programmes play between bumpers. */
  readonly frequency: number
  /** Seconds. Kept short: this is punctuation, not programming. */
  readonly durationSeconds: number
  /** Used when nothing more specific is assigned. */
  readonly defaultKind: BumperKind
  /** The channel's own clip, used when no collection assignment matches. */
  readonly channelFile?: BumperFileAssignment
  /** Keyed by collection id. */
  readonly collectionFiles?: Readonly<Record<number, BumperFileAssignment>>
  /** Overrides the palette taken from the channel, when set. */
  readonly background?: string
  readonly foreground?: string
  readonly accent?: string
}

export const DEFAULT_CHANNEL_BUMPER_CONFIG: ChannelBumperConfig = {
  enabled: true,
  frequency: 1,
  durationSeconds: 6,
  defaultKind: 'now-next',
}

/** What the schedule is asking about. */
export interface BumperContext {
  readonly channelId: string
  readonly channelName: string
  /** The programme that has just finished, when there is one. */
  readonly now?: {
    readonly title: string
    readonly collectionId?: number
    readonly collectionTitle?: string
  }
  /** The programme about to start. Absent at the end of a slot. */
  readonly next?: {
    readonly title: string
    readonly collectionId?: number
    readonly collectionTitle?: string
    /** Local clock time it begins, already formatted. */
    readonly startsAt?: string
  }
}

/** What the resolver decided to play, if anything. */
export type BumperPlan =
  | { readonly source: 'file'; readonly file: BumperFileAssignment }
  | {
      readonly source: 'generated'
      readonly kind: BumperKind
      readonly text: BumperText
      readonly durationSeconds: number
      /** Identifies the rendered file; stable for identical text. */
      readonly cacheKey: string
    }
  | { readonly source: 'none'; readonly reason: string }
