/**
 * ToastTV Main Entry Point
 *
 * Starts both the daemon (media player control) and the web server (admin UI).
 */

import { ToastTVDaemon } from './daemon'
import { createServer } from './server'
import { loadRuntimeConfig } from './config/runtime'

async function main(): Promise<void> {
  const runtime = loadRuntimeConfig()
  const profile = process.env.TOASTTV_PROFILE
  const profileSuffix = profile ? ` [profile: ${profile}]` : ''
  const modeSuffix = runtime.headless ? ' [headless]' : ''
  console.log(`🍞 ToastTV starting...${profileSuffix}${modeSuffix}`)

  const daemon = new ToastTVDaemon(runtime.configPath, {
    localPlaybackEnabled: !runtime.headless,
    mediaReadOnly: runtime.mediaReadOnly,
  })

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('Received SIGTERM, shutting down...')
    await daemon.stop()
    process.exit(0)
  })

  process.on('SIGINT', async () => {
    console.log('Received SIGINT, shutting down...')
    await daemon.stop()
    process.exit(0)
  })

  try {
    // 1. Initialize daemon components (Sync/Fast)
    await daemon.init()

    // 2. Start background services (Scanning, MPV connection, creates services)
    console.log('Starting background services...')
    await daemon.start()

    // 3. Create web server (requires services from daemon.start())
    const { app, playbackService } = createServer(daemon)

    console.log(`🌐 Admin UI: http://localhost:${runtime.port}`)

    // 4. Start listening
    Bun.serve({
      port: runtime.port,
      hostname: runtime.hostname,
      fetch: app.fetch,
      idleTimeout: 0, // Disable timeout for SSE connections
    })

    // 5. Run the legacy local-player loop only when MPV is enabled.
    if (daemon.isLocalPlaybackEnabled) {
      playbackService.startLoop()
    }
  } catch (error) {
    console.error('Fatal error:', error)
    await daemon.stop()
    process.exit(1)
  }
}

main()
