import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', 'clients', 'webos')

function pngDimensions(name: string): { width: number; height: number } {
  const image = readFileSync(join(root, name))
  expect(image.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) }
}

describe('LG webOS package assets', () => {
  test('has valid TV manifest identity and required local entry points', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'appinfo.json'), 'utf8'))
    expect(manifest).toMatchObject({
      id: 'com.itsrammen.app.toasttv',
      version: '0.6.3',
      type: 'web',
      main: 'index.html',
      title: 'ToastTV',
      icon: 'icon.png',
      largeIcon: 'largeIcon.png',
      resolution: '1920x1080',
      disableBackHistoryAPI: true,
    })

    const html = readFileSync(join(root, manifest.main), 'utf8')
    const app = readFileSync(join(root, 'app.js'), 'utf8')
    expect(html).toContain('href="styles.css"')
    expect(html).toContain('src="app.js"')
    expect(html).toContain('src="playback-policy.js"')
    expect(html).not.toMatch(/<(?:script|link|img)[^>]+(?:src|href)="https?:\/\//i)
    expect(app).toContain(`var CLIENT_VERSION = '${manifest.version}'`)
  })

  test('uses LG-sized PNG launcher icons', () => {
    expect(pngDimensions('icon.png')).toEqual({ width: 80, height: 80 })
    expect(pngDimensions('largeIcon.png')).toEqual({ width: 130, height: 130 })
  })

  test('packages the launch-owned stable tuner client without remote playback code', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8')
    const app = readFileSync(join(root, 'app.js'), 'utf8')
    const policy = readFileSync(join(root, 'playback-policy.js'), 'utf8')

    expect(html.indexOf('src="playback-policy.js"')).toBeLessThan(html.indexOf('src="app.js"'))
    expect(app).toContain('state.sessionOwnerId = createSessionOwnerId()')
    expect(app).toContain("mode: 'stable-hls'")
    expect(app).toContain("state.serverUrl + '/api/client/v1/session/tune'")
    expect(policy).toContain('function nextTunerRequestId(')
    expect(policy).toContain('function withTunerRevision(')
    expect(html).toContain('id="playerChannelLogo"')
    expect(html).toContain('id="tuningFreezeFrame"')
    // Channel branding remains DOM-only. The one fixed canvas is reserved for
    // a transient decoder handoff frame and must never be created dynamically.
    expect(app).not.toMatch(/createElement\(['"]canvas['"]\)/)
    expect(html).not.toMatch(/<(?:script|link)[^>]+(?:src|href)="https?:\/\//i)
  })

  test('keeps the client compatible with the Chromium 53 baseline', () => {
    const script = readFileSync(join(root, 'playback-policy.js'), 'utf8') +
      readFileSync(join(root, 'app.js'), 'utf8')
    const styles = readFileSync(join(root, 'styles.css'), 'utf8')
    expect(script).not.toMatch(/\b(?:const|let)\b/)
    expect(script).not.toContain('=>')
    expect(script).not.toMatch(/\?\.|\?\?/)
    expect(script).toContain("var DEFAULT_SERVER = 'http://TOWER:1993'")
    expect(styles).not.toMatch(/display:\s*grid/i)
    expect(styles).not.toMatch(/(?:^|[;{])\s*(?:gap|inset):/im)
    expect(styles).not.toMatch(
      /(?:scroll-behavior|scrollbar-width|scroll-snap(?:-type)?|overscroll-behavior)\s*:/i
    )
  })

  test('replaces the browser scrollbar rather than showing it', () => {
    /* The previous version of this test used a regular expression whose
       escapes were lost when it was generated, so it searched for a literal
       letter and could never fail. Plain strings cannot rot that way. */
    const styles = readFileSync(join(root, 'styles.css'), 'utf8')

    // A catch-all, so a surface that becomes scrollable later cannot show
    // Chromium's own bar unnoticed.
    expect(styles).toContain('*::-webkit-scrollbar { width: 6px; height: 6px; }')
    expect(styles).toContain('*::-webkit-scrollbar-thumb { background: var(--line-hot)')
    // Stepper arrows cannot be clicked with a remote and shorten the track.
    expect(styles).toContain('*::-webkit-scrollbar-button { width: 0; height: 0; display: none; }')
  })

  test('lights the thumb on the lists that are actually read', () => {
    const styles = readFileSync(join(root, 'styles.css'), 'utf8')

    expect(styles).toContain('.channel-grid::-webkit-scrollbar-thumb,')
    expect(styles).toContain('.guide-list::-webkit-scrollbar-thumb { background: var(--orange-dark); }')
  })

  test('hides the bar under the horizontal strips', () => {
    // Stepped through with the remote, always showing the focused chip, so
    // a bar reports nothing worth the pixels.
    const styles = readFileSync(join(root, 'styles.css'), 'utf8')

    expect(styles).toContain('.catalog-days::-webkit-scrollbar { width: 0; height: 0; }')
  })

  test('fits more of the lineup on screen', () => {
    const styles = readFileSync(join(root, 'styles.css'), 'utf8')

    // The bar took 108px of a 1080 line screen before a channel appeared.
    expect(styles).toContain('height: 76px;')
    expect(styles).toContain('.channel-browser { position: absolute; top: 76px;')
    expect(styles).toContain('.channel-card__topline { font-size: 17px')
    expect(styles).not.toContain('.channel-card__topline { font-size: 24px')
  })

  test('keeps the guide and dock legible without filling the screen', () => {
    const styles = readFileSync(join(root, 'styles.css'), 'utf8')

    // Rows were 58px and the title 58px; both crowded a 1080 line panel.
    expect(styles).toContain('min-height: 41px')
    expect(styles).toMatch(/#playerTitle {[^}]*font-size: 41px/)
    expect(styles).not.toMatch(/#playerTitle {[^}]*font-size: 58px/)
  })

  test('animates remote focus', () => {
    const styles = readFileSync(join(root, 'styles.css'), 'utf8')

    expect(styles).toContain('transition: background-color 130ms ease')
    expect(styles).toContain('transform: translateX(4px)')
    expect(styles).toContain('.channel-preview__upcoming p.hidden { display: block !important; visibility: hidden; }')
    expect(styles).toMatch(/\.catalog-channel \{[^}]*transition: background-color 130ms ease/)
    expect(styles).toMatch(/\.catalog-day \{[^}]*transition: background-color 130ms ease/)
  })

})
