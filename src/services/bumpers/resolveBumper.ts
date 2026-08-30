/**
 * Deciding which bumper belongs to a moment in the schedule.
 *
 * Pure, so the precedence can be argued about without a channel, a database
 * or ffmpeg in the room. The order is the whole design:
 *
 *  1. a file assigned to the collection that is about to start
 *  2. a file assigned to the collection that just finished
 *  3. the channel's own house clip
 *  4. one generated from the now and next titles
 *  5. nothing, when there is nothing worth announcing
 *
 * Something a person made always beats something generated, and a bumper for
 * the programme starting beats one for the programme ending, because the
 * announcement is about what you are staying for.
 */
import { createHash } from 'node:crypto'
import type {
  BumperContext,
  BumperFileAssignment,
  BumperKind,
  BumperPlan,
  BumperText,
  ChannelBumperConfig,
} from './types'

/** Bumped when the wording changes, so old cached renders are not reused. */
export const BUMPER_TEXT_VERSION = 'bumper-1'

export function resolveBumper(
  context: BumperContext,
  config: ChannelBumperConfig
): BumperPlan {
  if (!config.enabled) return { source: 'none', reason: 'disabled' }

  const assigned = assignedFile(context, config)
  if (assigned) return { source: 'file', file: assigned }

  const kind = kindFor(context, config.defaultKind)
  const text = bumperText(context, kind)
  if (!text) return { source: 'none', reason: 'nothing to announce' }

  return {
    source: 'generated',
    kind,
    text,
    durationSeconds: config.durationSeconds,
    cacheKey: cacheKeyFor(kind, text, config),
  }
}

function assignedFile(
  context: BumperContext,
  config: ChannelBumperConfig
): BumperFileAssignment | undefined {
  const byCollection = config.collectionFiles ?? {}
  const nextId = context.next?.collectionId
  if (nextId !== undefined && byCollection[nextId]) return byCollection[nextId]
  const nowId = context.now?.collectionId
  if (nowId !== undefined && byCollection[nowId]) return byCollection[nowId]
  return config.channelFile
}

/**
 * A now-next bumper needs both halves. With only one, saying "now" about a
 * programme that has ended reads as a mistake, so it becomes an up-next; with
 * neither, the station announces itself instead.
 */
function kindFor(context: BumperContext, preferred: BumperKind): BumperKind {
  const hasNext = Boolean(context.next?.title)
  const hasNow = Boolean(context.now?.title)
  if (preferred === 'ident') return 'ident'
  if (preferred === 'now-next' && hasNow && hasNext) return 'now-next'
  if (hasNext) return 'up-next'
  return 'ident'
}

function bumperText(
  context: BumperContext,
  kind: BumperKind
): BumperText | null {
  if (kind === 'ident') {
    return { eyebrow: 'You are watching', headline: context.channelName }
  }

  const next = context.next
  if (!next?.title) return null

  if (kind === 'up-next') {
    return {
      eyebrow: 'Up next',
      headline: next.title,
      ...(next.startsAt ? { support: next.startsAt } : {}),
    }
  }

  const now = context.now
  return {
    eyebrow: now?.title ? 'That was ' + now.title : 'Up next',
    headline: next.title,
    ...(next.startsAt ? { support: 'Starting at ' + next.startsAt } : {}),
  }
}

/**
 * Identifies a rendered clip by everything that shows on screen. Two moments
 * announcing the same pair of programmes on the same channel share a file,
 * which is what keeps the render cost proportional to a lineup rather than to
 * a schedule.
 */
export function cacheKeyFor(
  kind: BumperKind,
  text: BumperText,
  config: ChannelBumperConfig
): string {
  const parts = [
    BUMPER_TEXT_VERSION,
    kind,
    text.eyebrow ?? '',
    text.headline,
    text.support ?? '',
    String(config.durationSeconds),
    config.background ?? '',
    config.foreground ?? '',
    config.accent ?? '',
  ]
  return createHash('sha1').update(parts.join(' ')).digest('hex').slice(0, 16)
}
