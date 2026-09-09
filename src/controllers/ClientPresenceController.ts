import type { PlaybackIncidentService } from '../services/PlaybackIncidentService'
import { renderLayout } from '../templates/layout'
import { escapeHtml } from '../templates/utils'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  ClientPresenceValidationError,
  type ClientHeartbeatInput,
  type ClientPresenceRecord,
  type ClientPresenceService,
} from '../services/ClientPresenceService'

export const CLIENT_HEARTBEAT_ROUTE = '/api/client/v1/heartbeat'
export const ADMIN_CLIENT_PRESENCE_ROUTE = '/api/admin/v1/clients'

const MAX_HEARTBEAT_BODY_BYTES = 2_048

interface ClientPresenceControllerDeps {
  readonly incidents?: PlaybackIncidentService
  readonly presence: Pick<
    ClientPresenceService,
    'recordHeartbeat' | 'getSnapshot' | 'heartbeatIntervalMs'
  >
  readonly onPresenceChanged?: (
    current: ClientPresenceRecord,
    previous: ClientPresenceRecord | undefined
  ) => Promise<void> | void
}

/**
 * Client presence routes have their own narrow CORS policy. The credentialless
 * POST is intentionally outside the broadly readable /api/v1 namespace, while
 * the admin snapshot receives no cross-origin headers.
 */
export function createClientPresenceController(
  deps: ClientPresenceControllerDeps
): Hono {
  const controller = new Hono()

  controller.use(
    CLIENT_HEARTBEAT_ROUTE,
    cors({
      origin: '*',
      allowMethods: ['POST', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
      maxAge: 300,
    })
  )

  controller.post(CLIENT_HEARTBEAT_ROUTE, async (c) => {
    c.header('Cache-Control', 'no-store')

    const contentType = c.req.header('content-type') ?? ''
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      return c.json({ error: 'Content-Type must be application/json' }, 415)
    }

    const declaredLength = Number(c.req.header('content-length'))
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_HEARTBEAT_BODY_BYTES
    ) {
      return c.json({ error: 'Heartbeat body is too large' }, 413)
    }

    let body: unknown
    try {
      const text = await c.req.text()
      if (new TextEncoder().encode(text).byteLength > MAX_HEARTBEAT_BODY_BYTES) {
        return c.json({ error: 'Heartbeat body is too large' }, 413)
      }
      body = JSON.parse(text)
    } catch {
      return c.json({ error: 'Heartbeat body must be valid JSON' }, 400)
    }

    try {
      const clientId = (body as ClientHeartbeatInput)?.clientId
      const previous = deps.presence
        .getSnapshot()
        .clients.find((client) => client.clientId === clientId)
      const presence = deps.presence.recordHeartbeat(body as ClientHeartbeatInput)
      const acceptedIncidentIds = await deps.incidents?.record(presence.clientId, (body as { incidents?: unknown }).incidents) ?? []
      await deps.onPresenceChanged?.(presence, previous)
      return c.json({
        ok: true,
        acceptedIncidentIds,
        clientId: presence.clientId,
        serverTimeMs: Date.parse(presence.lastSeenAt),
        heartbeatIntervalMs: deps.presence.heartbeatIntervalMs,
      })
    } catch (error) {
      if (error instanceof ClientPresenceValidationError) {
        return c.json({ error: error.message }, 400)
      }
      throw error
    }
  })

  controller.get(ADMIN_CLIENT_PRESENCE_ROUTE, (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(deps.presence.getSnapshot())
  })

  controller.get('/api/admin/v1/playback-incidents', (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json({ incidents: deps.incidents?.snapshot() ?? [] })
  })
  controller.get('/diagnostics/playback', (c) => {
    c.header('Cache-Control', 'no-store')
    const rows = deps.incidents?.snapshot() ?? []
    return c.html(renderLayout('Playback incidents', `<main style="padding:24px;max-width:1100px;margin:auto"><h1>Playback incidents</h1><p>Latest 500 TV reports, retained for up to seven days. Refresh to see new reports. Reported times include the TV’s estimated server clock; receipt time records when the report arrived.</p><p><a href="/diagnostics/playback">Refresh</a> · <a href="/api/admin/v1/playback-incidents" download="playback-incidents.json">Download JSON</a></p>${rows.length ? rows.map((row) => `<details style="padding:12px;border-bottom:1px solid #334155"><summary>${escapeHtml(row.receivedAt)} · ${escapeHtml(row.event)} · ${escapeHtml(String(row.channelId ?? 'No channel'))} · ${escapeHtml(row.clientId)}</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(JSON.stringify(row, null, 2))}</pre></details>`).join('') : '<p>No playback incidents reported. Requires webOS app 0.7.3 or later.</p>'}</main>`))
  })

  return controller
}
