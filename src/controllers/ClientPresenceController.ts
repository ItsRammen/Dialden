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
      await deps.onPresenceChanged?.(presence, previous)
      return c.json({
        ok: true,
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

  return controller
}
