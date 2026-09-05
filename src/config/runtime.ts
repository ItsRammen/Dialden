/**
 * 'intel-qsv-full' puts the whole graph on the media engine -- hardware decode,
 * scale and letterbox as well as the encode -- instead of decoding and
 * filtering on the CPU and using QSV for the encode alone. Opt-in while it
 * proves itself; every other value behaves exactly as before.
 */
export type TranscodingMode = 'software' | 'auto' | 'intel-qsv' | 'intel-qsv-full'

export interface RuntimeConfig {
  readonly port: number
  readonly hostname: string
  readonly configPath: string
  readonly headless: boolean
  readonly mediaReadOnly: boolean
  readonly transcodingMode: TranscodingMode
  readonly qsvDevice: string
}

const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on'])

function transcodingMode(value: string | undefined): TranscodingMode {
  const normalized = value?.trim().toLowerCase()
  if (
    normalized === 'auto' ||
    normalized === 'intel-qsv' ||
    normalized === 'intel-qsv-full'
  ) {
    return normalized
  }
  return 'software'
}

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
  const mediaReadOnly = TRUTHY_VALUES.has(
    (environment.TOASTTV_MEDIA_READ_ONLY ?? '').trim().toLowerCase()
  )

  return {
    port,
    hostname: environment.TOASTTV_HOST?.trim() || '0.0.0.0',
    configPath: environment.TOASTTV_CONFIG?.trim() || './data/config.json',
    headless: TRUTHY_VALUES.has(
      (environment.TOASTTV_HEADLESS ?? '').trim().toLowerCase()
    ),
    mediaReadOnly,
    // Software remains the default so an upgrade never silently changes the
    // output encoder. `auto` and `intel-qsv` both probe the configured render
    // node and fall back safely when the device or driver is unavailable.
    transcodingMode: transcodingMode(environment.TOASTTV_TRANSCODING_MODE),
    qsvDevice:
      environment.TOASTTV_QSV_DEVICE?.trim() || '/dev/dri/renderD128',
  }
}
