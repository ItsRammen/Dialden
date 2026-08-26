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
      version: '0.3.4',
      type: 'web',
      main: 'index.html',
      title: 'ToastTV',
      icon: 'icon.png',
      largeIcon: 'largeIcon.png',
      resolution: '1920x1080',
      disableBackHistoryAPI: true,
    })

    const html = readFileSync(join(root, manifest.main), 'utf8')
    expect(html).toContain('href="styles.css"')
    expect(html).toContain('src="app.js"')
    expect(html).toContain('src="playback-policy.js"')
    expect(html).not.toMatch(/<(?:script|link|img)[^>]+(?:src|href)="https?:\/\//i)
  })

  test('uses LG-sized PNG launcher icons', () => {
    expect(pngDimensions('icon.png')).toEqual({ width: 80, height: 80 })
    expect(pngDimensions('largeIcon.png')).toEqual({ width: 130, height: 130 })
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

  test('uses a TV-readable EPG scrollbar and animated remote focus', () => {
    const styles = readFileSync(join(root, 'styles.css'), 'utf8')

    expect(styles).toContain('.guide-list::-webkit-scrollbar { width: 12px; }')
    expect(styles).toContain('.guide-list::-webkit-scrollbar-track')
    expect(styles).toContain('.guide-list::-webkit-scrollbar-thumb')
    expect(styles).toContain('min-height: 58px')
    expect(styles).toContain('.guide-list::-webkit-scrollbar-button')
    expect(styles).toContain('transition: background-color 130ms ease')
    expect(styles).toContain('transform: translateX(4px)')
    expect(styles).toContain('.channel-preview__upcoming p.hidden { display: block !important; visibility: hidden; }')
    expect(styles).toMatch(/\.catalog-channel \{[^}]*transition: background-color 130ms ease/)
    expect(styles).toMatch(/\.catalog-day \{[^}]*transition: background-color 130ms ease/)
  })
})
