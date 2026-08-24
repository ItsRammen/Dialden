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
    })

    expect(html).not.toContain('<script>socket()</script>')
    expect(html).not.toContain('<img src=x onerror=media()>')
    expect(html).not.toContain('<script>profile()</script>')
    expect(html).not.toContain('<script>version()</script>')
    expect(html).not.toContain('<script>latest()</script>')
    expect(html).toContain('&lt;script&gt;profile()&lt;/script&gt;')
  })
})
