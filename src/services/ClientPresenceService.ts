export const CLIENT_PLAYBACK_MODES = [
  'idle',
  'direct-play',
  'transcode',
  'buffering',
  'paused',
  'error',
] as const

export type ClientPlaybackMode = (typeof CLIENT_PLAYBACK_MODES)[number]
export type ClientPresenceStatus = 'connected' | 'offline'

export interface ClientHeartbeatInput {
  readonly clientId: string
  readonly name: string
  readonly channelId?: string | null
  readonly playbackMode: ClientPlaybackMode
}

export interface ClientPresenceRecord {
  readonly clientId: string
  readonly name: string
  readonly channelId: string | null
  readonly playbackMode: ClientPlaybackMode
  readonly status: ClientPresenceStatus
  readonly connected: boolean
  readonly firstSeenAt: string
  readonly lastSeenAt: string
  readonly expiresAt: string
}

export interface ClientPresenceSnapshot {
  readonly generatedAt: string
  readonly ttlMs: number
  readonly connectedClients: number
  readonly activeViewers: number
  readonly viewersByChannel: Record<string, number>
  readonly clients: ClientPresenceRecord[]
}

export interface ClientPresenceServiceOptions {
  /** A client is offline when it has not reported within this window. */
  readonly ttlMs?: number
  /** Offline clients remain visible this long before their in-memory row expires. */
  readonly offlineRetentionMs?: number
  readonly now?: () => number
}

interface StoredClientPresence {
  readonly clientId: string
  name: string
  channelId: string | null
  playbackMode: ClientPlaybackMode
  readonly firstSeenAtMs: number
  lastSeenAtMs: number
}

const DEFAULT_TTL_MS = 45_000
const DEFAULT_OFFLINE_RETENTION_MS = 24 * 60 * 60 * 1000
const MAX_CLIENT_ID_LENGTH = 64
const MAX_NAME_LENGTH = 80
const MAX_CHANNEL_ID_LENGTH = 64
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
const ACTIVE_VIEWER_MODES: ReadonlySet<ClientPlaybackMode> = new Set([
  'direct-play',
  'transcode',
  'buffering',
])
const PLAYBACK_MODE_SET: ReadonlySet<string> = new Set(CLIENT_PLAYBACK_MODES)

export class ClientPresenceValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClientPresenceValidationError'
  }
}

/**
 * Ephemeral, best-effort telemetry for TV/browser clients.
 *
 * Presence is intentionally not persisted: after a server restart the honest
 * state is "no clients have checked in yet", rather than a stale viewer count.
 * Offline transitions and retention are calculated lazily from an injectable
 * clock, so this service does not leave an interval running during shutdown.
 */
export class ClientPresenceService {
  readonly ttlMs: number
  readonly offlineRetentionMs: number

  private readonly now: () => number
  private readonly clients = new Map<string, StoredClientPresence>()

  constructor(options: ClientPresenceServiceOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.offlineRetentionMs =
      options.offlineRetentionMs ?? DEFAULT_OFFLINE_RETENTION_MS
    this.now = options.now ?? Date.now

    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error('Client presence TTL must be a positive number')
    }
    if (
      !Number.isFinite(this.offlineRetentionMs) ||
      this.offlineRetentionMs < this.ttlMs
    ) {
      throw new Error('Client presence retention must be at least the TTL')
    }
  }

  /** A conservative interval clients can use without racing the TTL. */
  get heartbeatIntervalMs(): number {
    return Math.max(1_000, Math.floor(this.ttlMs / 3))
  }

  recordHeartbeat(input: ClientHeartbeatInput): ClientPresenceRecord {
    const normalized = validateHeartbeat(input)
    const observedAtMs = this.now()
    this.prune(observedAtMs)

    const existing = this.clients.get(normalized.clientId)
    const stored: StoredClientPresence = existing ?? {
      clientId: normalized.clientId,
      name: normalized.name,
      channelId: normalized.channelId,
      playbackMode: normalized.playbackMode,
      firstSeenAtMs: observedAtMs,
      lastSeenAtMs: observedAtMs,
    }

    stored.name = normalized.name
    stored.channelId = normalized.channelId
    stored.playbackMode = normalized.playbackMode
    stored.lastSeenAtMs = observedAtMs
    this.clients.set(stored.clientId, stored)

    return this.toPublicRecord(stored, observedAtMs)
  }

  getSnapshot(): ClientPresenceSnapshot {
    const observedAtMs = this.now()
    this.prune(observedAtMs)

    const clients = Array.from(this.clients.values())
      .map((client) => this.toPublicRecord(client, observedAtMs))
      .sort(comparePresence)
    const connected = clients.filter((client) => client.connected)
    const viewersByChannel: Record<string, number> = {}
    let activeViewers = 0

    for (const client of connected) {
      if (
        client.channelId !== null &&
        ACTIVE_VIEWER_MODES.has(client.playbackMode)
      ) {
        activeViewers += 1
        viewersByChannel[client.channelId] =
          (viewersByChannel[client.channelId] ?? 0) + 1
      }
    }

    return {
      generatedAt: new Date(observedAtMs).toISOString(),
      ttlMs: this.ttlMs,
      connectedClients: connected.length,
      activeViewers,
      viewersByChannel,
      clients,
    }
  }

  private prune(observedAtMs: number): void {
    for (const [clientId, client] of this.clients) {
      if (observedAtMs - client.lastSeenAtMs >= this.offlineRetentionMs) {
        this.clients.delete(clientId)
      }
    }
  }

  private toPublicRecord(
    client: StoredClientPresence,
    observedAtMs: number
  ): ClientPresenceRecord {
    const expiresAtMs = client.lastSeenAtMs + this.ttlMs
    const connected = observedAtMs < expiresAtMs
    return {
      clientId: client.clientId,
      name: client.name,
      channelId: client.channelId,
      playbackMode: client.playbackMode,
      status: connected ? 'connected' : 'offline',
      connected,
      firstSeenAt: new Date(client.firstSeenAtMs).toISOString(),
      lastSeenAt: new Date(client.lastSeenAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    }
  }
}

function validateHeartbeat(input: ClientHeartbeatInput): {
  clientId: string
  name: string
  channelId: string | null
  playbackMode: ClientPlaybackMode
} {
  if (!input || typeof input !== 'object') {
    throw new ClientPresenceValidationError('Heartbeat body must be an object')
  }

  const clientId = validateIdentifier(
    input.clientId,
    'clientId',
    MAX_CLIENT_ID_LENGTH
  )
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (
    name.length === 0 ||
    name.length > MAX_NAME_LENGTH ||
    CONTROL_CHARACTER.test(name)
  ) {
    throw new ClientPresenceValidationError(
      `name must be 1-${MAX_NAME_LENGTH} printable characters`
    )
  }

  const rawChannelId = input.channelId
  const channelId =
    rawChannelId === undefined || rawChannelId === null
      ? null
      : validateIdentifier(rawChannelId, 'channelId', MAX_CHANNEL_ID_LENGTH)

  if (
    typeof input.playbackMode !== 'string' ||
    !PLAYBACK_MODE_SET.has(input.playbackMode)
  ) {
    throw new ClientPresenceValidationError(
      `playbackMode must be one of: ${CLIENT_PLAYBACK_MODES.join(', ')}`
    )
  }

  return {
    clientId,
    name,
    channelId,
    playbackMode: input.playbackMode,
  }
}

function validateIdentifier(
  value: unknown,
  field: string,
  maximumLength: number
): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (
    normalized.length === 0 ||
    normalized.length > maximumLength ||
    !SAFE_IDENTIFIER.test(normalized)
  ) {
    throw new ClientPresenceValidationError(
      `${field} must be 1-${maximumLength} letters, numbers, dots, colons, underscores, or hyphens`
    )
  }
  return normalized
}

function comparePresence(
  left: ClientPresenceRecord,
  right: ClientPresenceRecord
): number {
  if (left.connected !== right.connected) return left.connected ? -1 : 1
  const nameOrder = left.name.localeCompare(right.name)
  return nameOrder !== 0 ? nameOrder : left.clientId.localeCompare(right.clientId)
}
