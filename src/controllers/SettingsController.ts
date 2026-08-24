/**
 * Settings Controller
 *
 * Handles settings page, configuration API, and update endpoints.
 */

import { Hono } from 'hono'
import { html } from 'hono/html'
import type { ConfigService } from '../services/ConfigService'
import type { AppConfig, DeepPartial } from '../repositories/ConfigRepository'
import { renderSettings } from '../templates/settings'
import type { MediaService } from '../services/MediaService'
import type { IHardwareDetectionService } from '../services/HardwareDetectionService'
import type { UpdateService } from '../services/UpdateService'
import type { ChannelInterludePolicy } from '../services/ChannelService'
import type { FfmpegTranscodingStatus } from '../services/FfmpegTranscodingBackend'

interface SettingsControllerDeps {
  config: ConfigService
  media: MediaService
  hardware?: IHardwareDetectionService
  update: UpdateService
  transcodingStatus?: FfmpegTranscodingStatus
  onInterludeUpdated?: (
    policy: ChannelInterludePolicy
  ) => Promise<void> | void
  onLogoUpdated?: () => Promise<void> | void
}

export function createSettingsController(deps: SettingsControllerDeps) {
  const { config, media, hardware, update } = deps
  const controller = new Hono()

  // --- Pages ---

  controller.get('/settings', async (c) => {
    const currentConfig = await config.get()
    const profile = hardware?.getProfile()
    const updateInfo = update.getUpdateInfo()
    return c.html(
      renderSettings({
        config: currentConfig,
        mediaDirectory: media.getMediaDirectory(),
        hardwareProfileName: profile?.name,
        updatesEnabled: update.isEnabled,
        updateAvailable: updateInfo?.updateAvailable,
        currentVersion: updateInfo?.currentVersion ?? update.currentVersion,
        latestVersion: updateInfo?.latestVersion,
        transcodingStatus: deps.transcodingStatus,
      })
    )
  })

  // --- API Endpoints ---

  // Get config
  controller.get('/api/config', async (c) => {
    return c.json(await config.get())
  })

  // Update config - parses flat form fields into nested config
  controller.post('/api/config', async (c) => {
    const body = await c.req.parseBody()

    // Parse form fields into config structure
    const sessionLimit = body['sessionLimit'] as string
    const resetHour = body['resetHour'] as string

    const partial: DeepPartial<AppConfig> = {
      server: {
        port: parseInt(body['serverPort'] as string, 10) || 1993,
      },
      session: {
        limitMinutes: sessionLimit ? parseInt(sessionLimit, 10) : 0,
        resetHour: parseInt(resetHour, 10) || 6,
      },
      interlude: {
        enabled: body['interludeEnabled'] === 'true',
        frequency: parseInt(body['interludeFrequency'] as string, 10) || 3,
      },
      mpv: {
        ipcSocket: (body['mpvSocket'] as string) || '/tmp/toasttv-mpv.sock',
      },
      logo: {
        enabled: body['logoEnabled'] === 'true',
        opacity: parseInt(body['logoOpacity'] as string, 10) || 200,
        position: Number.isNaN(parseInt(body['logoPosition'] as string, 10))
          ? 2
          : parseInt(body['logoPosition'] as string, 10),
        x: Number.isNaN(parseInt(body['logoX'] as string, 10))
          ? 8
          : parseInt(body['logoX'] as string, 10),
        y: Number.isNaN(parseInt(body['logoY'] as string, 10))
          ? 8
          : parseInt(body['logoY'] as string, 10),
      },
      playback: {
        safeMode: body['safeMode'] === 'true',
      },
    }

    await config.update(partial)
    await deps.onInterludeUpdated?.({
      enabled: partial.interlude?.enabled === true,
      frequency: partial.interlude?.frequency ?? 1,
    })
    await deps.onLogoUpdated?.()
    return c.html(html`<div class="toast success">Settings saved</div>`)
  })

  // Logo upload - returns updated logo section
  controller.post('/api/upload-logo', async (c) => {
    const body = await c.req.parseBody()
    const file = body['file']

    if (!(file instanceof File)) {
      return c.html(html`<div class="toast warning">No file uploaded</div>`)
    }

    const logoPath = await media.uploadLogo(file)
    await config.update({ logo: { imagePath: logoPath } })
    await deps.onLogoUpdated?.()

    const cacheBust = Date.now()
    return c.html(`
      <div class="form-group" id="logo-upload-section">
        <label>Logo Image</label>
        <div class="logo-picker">
          <img src="/logo?t=${cacheBust}" alt="Current logo" class="logo-preview">
          <label class="btn btn-primary btn-small">
            Choose
            <input type="file" 
                   id="logoFile"
                   accept="image/*"
                   style="display: none"
                   hx-post="/api/upload-logo"
                   hx-trigger="change"
                   hx-target="#logo-upload-section"
                   hx-swap="outerHTML"
                   hx-encoding="multipart/form-data"
                   name="file">
          </label>
        </div>
      </div>
      <div id="toast-container" hx-swap-oob="innerHTML">
        <div class="toast success">Logo uploaded</div>
      </div>
    `)
  })

  // Serve logo
  controller.get('/logo', async (c) => {
    const currentConfig = await config.get()
    const logoPath = currentConfig.logo.imagePath

    if (!logoPath) {
      return c.notFound()
    }

    try {
      const file = Bun.file(logoPath)
      return new Response(file)
    } catch {
      return c.notFound()
    }
  })

  // --- Update Endpoints ---

  // Check for updates - returns HTML fragment
  controller.get('/api/update/check', async (c) => {
    if (!update.isEnabled) {
      return c.html(`
        <div class="update-result">
          <span class="update-status">Container updates are managed by redeploying the Docker image.</span>
        </div>
      `)
    }

    const info = await update.checkForUpdate()

    if (!info) {
      return c.html(`
        <div class="update-result">
          <span class="update-status">⚠️ Could not check for updates</span>
        </div>
      `)
    }

    if (info.updateAvailable) {
      return c.html(`
        <div class="update-result update-available">
          <span class="update-status">🎉 Update available: ${info.latestVersion}</span>
          <button type="button" class="btn btn-primary" id="update-apply-btn"
                  onclick="startUpdate()">
            Update to ${info.latestVersion}
          </button>
        </div>
      `)
    }

    return c.html(`
      <div class="update-result">
        <span class="update-status">✅ You're up to date (${info.currentVersion})</span>
      </div>
    `)
  })

  // Apply update - SSE stream of update script output
  controller.post('/api/update/apply', (c) => {
    if (!update.isEnabled) {
      return c.json(
        { error: 'In-container updates are disabled; redeploy the Docker image' },
        409
      )
    }

    if (update.isUpdating) {
      return c.json({ error: 'Update already in progress' }, 409)
    }

    const stream = new ReadableStream({
      start: (controller) => {
        const encoder = new TextEncoder()

        const writeLine = (line: string) => {
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ line })}\n\n`)
            )
          } catch {
            // Stream closed
          }
        }

        const close = () => {
          try {
            writeLine('__DONE__')
            controller.close()
          } catch {
            // Already closed
          }
        }

        update.triggerUpdate(writeLine, close)
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  })

  // Get update log (post-restart retrieval)
  controller.get('/api/update/log', (c) => {
    const log = update.getUpdateLog()
    if (!log) {
      return c.notFound()
    }
    return c.text(log)
  })

  return controller
}
