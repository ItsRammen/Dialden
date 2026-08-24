import type { MiddlewareHandler } from 'hono'
import { CLIENT_HEARTBEAT_ROUTE } from '../controllers/ClientPresenceController'
import { CLIENT_CHANNEL_WARM_ROUTE } from '../controllers/ChannelStreamController'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Prevent a hostile web page from submitting unauthenticated admin forms to a
 * trusted-LAN ToastTV server. Direct CLI requests without browser origin
 * headers remain possible; the credentialless TV heartbeat is separately
 * validated and explicitly exempt.
 */
export const mutationOriginGuard: MiddlewareHandler = async (c, next) => {
  if (
    SAFE_METHODS.has(c.req.method) ||
    c.req.path === CLIENT_HEARTBEAT_ROUTE ||
    c.req.path === CLIENT_CHANNEL_WARM_ROUTE
  ) {
    await next()
    return
  }

  const fetchSite = c.req.header('sec-fetch-site')?.toLowerCase()
  if (fetchSite === 'cross-site') {
    return c.json({ error: 'Cross-site mutation rejected' }, 403)
  }

  const origin = c.req.header('origin')
  if (origin) {
    let expectedOrigin: string
    try {
      expectedOrigin = new URL(c.req.url).origin
    } catch {
      return c.json({ error: 'Invalid request URL' }, 400)
    }
    if (origin !== expectedOrigin) {
      return c.json({ error: 'Cross-origin mutation rejected' }, 403)
    }
  }

  await next()
}
