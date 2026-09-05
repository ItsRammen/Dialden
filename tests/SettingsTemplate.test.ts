import { describe, expect, test } from 'bun:test'
import type { AppConfig } from '../src/repositories/ConfigRepository'
import { renderSettings } from '../src/templates/settings'

const config: AppConfig = {
  server: { port: 1993 },
  session: {
    limitMinutes: 60,
    resetHour: 6,
    offAirAssetId: null,
    introVideoId: null,
    outroVideoId: null,
  },
  interlude: { enabled: true, frequency: 2 },
  mpv: { ipcSocket: '/tmp/toasttv.sock' },
  logo: {
    enabled: true,
    imagePath: '/data/logo.png',
    opacity: 192,
    position: 2,
    x: 12,
    y: 16,
  },
  detection: { cecEnabled: true, heartbeatIntervalMs: 30_000 },
  playback: { safeMode: true },
  library: { safetyScanIntervalMinutes: 15 },
}

describe('settings template', () => {
  test('groups every existing setting into responsive page sections', () => {
    const html = renderSettings({
      config,
      mediaDirectory: '/media',
      hardwareProfileName: 'WebOS television',
      currentVersion: '0.8.1',
    })

    expect(html).toContain('class="settings settings-page"')
    expect(html).toContain('id="branding"')
    expect(html).toContain('id="playback"')
    expect(html).toContain('id="library-services"')
    expect(html).toContain('id="server-system"')
    expect(html).toContain('name="logoEnabled"')
    expect(html).toContain('name="sessionLimit"')
    expect(html).toContain('name="interludeFrequency"')
    expect(html).toContain('name="safeMode"')
    expect(html).toContain('name="mpvSocket"')
    expect(html).toContain('name="serverPort"')
    expect(html).toContain('href="/settings/metadata"')
  })

  test('hides the legacy MPV socket control on a headless administration server', () => {
    const html = renderSettings({
      config,
      mediaDirectory: '/media',
      localPlaybackEnabled: false,
    })

    expect(html).not.toContain('MPV connection')
    expect(html).not.toContain('name="mpvSocket"')
    expect(html).toContain('name="serverPort"')
  })

  test('escapes host-provided status and path values', () => {
    const html = renderSettings({
      config: {
        ...config,
        mpv: { ipcSocket: '&quot;><script>socket()</script>' },
      },
      mediaDirectory: '<img src=x onerror=media()>',
      hardwareProfileName: '<script>profile()</script>',
      currentVersion: '<script>version()</script>',
      latestVersion: '<script>latest()</script>',
      updateAvailable: true,
      transcodingStatus: {
        configuredMode: 'intel-qsv',
        activeBackend: 'software',
        hardwareAcceleration: false,
        requestedDevice: '<svg onload=requested()>',
        device: '<img src=x onerror=device()>',
        deviceCandidates: ['<script>candidate()</script>'],
        probeAttempts: [
          {
            device: '<script>attemptDevice()</script>',
            exitCode: 1,
            timedOut: false,
            detail: '<img src=x onerror=attemptDetail()>',
          },
        ],
        fallbackReason: '<script>fallback()</script>',
      },
    })

    expect(html).not.toContain('<script>socket()</script>')
    expect(html).not.toContain('<img src=x onerror=media()>')
    expect(html).not.toContain('<script>profile()</script>')
    expect(html).not.toContain('<script>version()</script>')
    expect(html).not.toContain('<script>latest()</script>')
    expect(html).not.toContain('<img src=x onerror=device()>')
    expect(html).not.toContain('<svg onload=requested()>')
    expect(html).not.toContain('<script>candidate()</script>')
    expect(html).not.toContain('<script>attemptDevice()</script>')
    expect(html).not.toContain('<img src=x onerror=attemptDetail()>')
    expect(html).not.toContain('<script>fallback()</script>')
    expect(html).toContain('&lt;script&gt;profile()&lt;/script&gt;')
  })

  test('shows Intel QSV as enabled only when it is the active backend', () => {
    const html = renderSettings({
      config,
      mediaDirectory: '/media',
      transcodingStatus: {
        configuredMode: 'auto',
        activeBackend: 'intel-qsv',
        hardwareAcceleration: true,
        requestedDevice: '/dev/dri',
        device: '/dev/dri/renderD128',
        deviceCandidates: ['/dev/dri/renderD128'],
        probeAttempts: [
          {
            device: '/dev/dri/renderD128',
            exitCode: 0,
            timedOut: false,
          },
        ],
      },
    })

    expect(html).toContain('id="transcoding-status"')
    expect(html).toContain('Hardware transcoding is enabled and active.')
    expect(html).toContain('Automatic (Intel QSV with CPU fallback)')
    expect(html).toContain('Intel Quick Sync (QSV)')
    expect(html).toContain('Requested path')
    expect(html).toContain('Resolved render node')
    expect(html).toContain('/dev/dri/renderD128')
    expect(html).toContain('1 probe attempt')
    expect(html).toContain('Passed')
    expect(html).toContain('browser developer console stays empty')
    expect(html).toContain('TOASTTV_TRANSCODING_MODE')
  })

  test('shows the actual CPU fallback and its reason', () => {
    const html = renderSettings({
      config,
      mediaDirectory: '/media',
      transcodingStatus: {
        configuredMode: 'intel-qsv',
        activeBackend: 'software',
        hardwareAcceleration: false,
        requestedDevice: '/dev/dri',
        device: '/dev/dri/renderD128',
        deviceCandidates: ['/dev/dri/renderD128'],
        probeAttempts: [
          {
            device: '/dev/dri/renderD128',
            exitCode: 234,
            timedOut: false,
            detail: 'No VA display found',
          },
        ],
        fallbackReason: 'QSV smoke test failed',
      },
    })

    expect(html).toContain('Hardware transcoding is unavailable; CPU fallback is active.')
    expect(html).toContain('Hardware Unavailable')
    expect(html).toContain('Active encoder</dt><dd>CPU software encoding')
    expect(html).toContain('Fallback reason: QSV smoke test failed')
    expect(html).toContain('Exit 234')
    expect(html).toContain('No VA display found')
    expect(html).toContain('Docker → your container → Logs')
  })

  test('explains when the container has no mapped render nodes', () => {
    const html = renderSettings({
      config,
      mediaDirectory: '/media',
      transcodingStatus: {
        configuredMode: 'auto',
        activeBackend: 'software',
        hardwareAcceleration: false,
        requestedDevice: '/dev/dri',
        deviceCandidates: [],
        probeAttempts: [],
        fallbackReason: 'No DRM render nodes found under /dev/dri',
      },
    })

    expect(html).toContain('Requested path')
    expect(html).toContain('Render nodes found</dt><dd>None')
    expect(html).toContain('Map the host /dev/dri directory')
    expect(html).toContain('0 probe attempts')
  })

  test('shows concise CPU status when hardware transcoding is disabled', () => {
    const html = renderSettings({
      config,
      mediaDirectory: '/media',
      transcodingStatus: {
        configuredMode: 'software',
        activeBackend: 'software',
        hardwareAcceleration: false,
      },
    })

    expect(html).toContain('Hardware transcoding is disabled; CPU software encoding is active.')
    expect(html).not.toContain('Fallback reason:')
  })
})
