export interface RuntimeConfig {
  readonly port: number
  readonly hostname: string
  readonly configPath: string
  readonly headless: boolean
  readonly mediaReadOnly: boolean
}

const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on'])

/**
 * Resolve process-level settings that must be known before the database-backed
 * application configuration is available.
 */
export function loadRuntimeConfig(
  environment: Record<string, string | undefined> = process.env
): RuntimeConfig {
  const parsedPort = Number.parseInt(environment.PORT ?? '', 10)
  const port =
    Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
      ? parsedPort
      : 1993

  return {
    port,
    hostname: environment.TOASTTV_HOST?.trim() || '0.0.0.0',
    configPath: environment.TOASTTV_CONFIG?.trim() || './data/config.json',
    headless: TRUTHY_VALUES.has(
      (environment.TOASTTV_HEADLESS ?? '').trim().toLowerCase()
    ),
    mediaReadOnly: TRUTHY_VALUES.has(
      (environment.TOASTTV_MEDIA_READ_ONLY ?? '').trim().toLowerCase()
    ),
  }
}
