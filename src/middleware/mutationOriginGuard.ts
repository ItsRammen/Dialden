import type { MiddlewareHandler } from 'hono'
import { CLIENT_HEARTBEAT_ROUTE } from '../controllers/ClientPresenceController'
import {
  CLIENT_CHANNEL_STARTUP_ROUTE,
  CLIENT_CHANNEL_WARM_ROUTE,
  CLIENT_SESSION_CLOSE_ROUTE,
  CLIENT_SESSION_ROUTE,
  CLIENT_SESSION_TUNE_ROUTE,
} from '../controllers/ChannelStreamController'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const CLIENT_CHANNEL_PREPARE_PATH =
  /^\/api\/client\/v1\/channels\/[a-zA-Z0-9._-]{1,100}\/prepare$/

function isCredentiallessClientMutation(path: string): boolean {
  return (
    path === CLIENT_HEARTBEAT_ROUTE ||
    path === CLIENT_CHANNEL_WARM_ROUTE ||
    path === CLIENT_CHANNEL_STARTUP_ROUTE ||
    path === CLIENT_SESSION_ROUTE ||
    path === CLIENT_SESSION_TUNE_ROUTE ||
    path === CLIENT_SESSION_CLOSE_ROUTE ||
    CLIENT_CHANNEL_PREPARE_PATH.test(path)
  )
}

/**
 * Prevent a hostile web page from submitting unauthenticated admin forms to a
 * trusted-LAN ToastTV server. Direct CLI requests without browser origin
 * headers remain possible; the credentialless TV routes are separately
 * validated and explicitly exempt.
 */
export const mutationOriginGuard: MiddlewareHandler = async (c, next) => {
  if (
    SAFE_METHODS.has(c.req.method) ||
    isCredentiallessClientMutation(c.req.path)
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
