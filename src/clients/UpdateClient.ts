/**
 * Update Client
 *
 * Fetches the latest version from toasttv.eu.
 * Stateless HTTP wrapper — no business logic.
 */

import { logger } from '../utils/logger'

const VERSION_URL = 'https://toasttv.eu/version.txt'
const FETCH_TIMEOUT_MS = 10_000

export interface IUpdateClient {
  fetchLatestVersion(): Promise<string | null>
}

export class UpdateClient implements IUpdateClient {
  /**
   * Fetch the latest version string from the version endpoint.
   * Returns null on network failure (never throws).
   */
  async fetchLatestVersion(): Promise<string | null> {
    // Dev override: skip network fetch
    const devVersion = process.env['DEV_LATEST_VERSION']
    if (devVersion) {
      logger.debug('Update', `Using dev override version: ${devVersion}`)
      return devVersion.trim()
    }

    try {
      const response = await fetch(VERSION_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })

      if (!response.ok) {
        logger.warn('Update', `Version check failed: HTTP ${response.status}`)
        return null
      }

      const text = await response.text()
      const version = text.trim()

      if (!version) {
        logger.warn('Update', 'Empty version response')
        return null
      }

      return version
    } catch (error) {
      logger.debug('Update', `Version check failed: ${error}`)
      return null
    }
  }
}
