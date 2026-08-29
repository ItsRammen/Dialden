import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', 'clients', 'webos')

function pngDimensions(name: string): { width: number; height: number } {
  const image = readFileSync(join(root, name))
  expect(image.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) }
}

/**
 * Blanks comments, string and template bodies, and regex literals while keeping
 * every byte offset intact, so line numbers still point at real source.
 */
function stripNonCode(source: string): string {
  const out = source.split('')
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to && index < out.length; index += 1) {
      if (out[index] !== '\n') out[index] = ' '
    }
  }
  let index = 0
  let previous = ''
  while (index < source.length) {
    const character = source[index]!
    const next = source[index + 1]
    if (character === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2)
      const end = close === -1 ? source.length : close + 2
      blank(index, end)
      index = end
      continue
    }
    if (character === '/' && next === '/') {
      const close = source.indexOf('\n', index)
      const end = close === -1 ? source.length : close
      blank(index, end)
      index = end
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      let cursor = index + 1
      while (cursor < source.length) {
        if (source[cursor] === '\\') {
          cursor += 2
          continue
        }
        if (source[cursor] === character) break
        cursor += 1
      }
      blank(index + 1, cursor)
      index = cursor + 1
      previous = character
      continue
    }
    if (character === '/' && '(,=:[!&|?{};'.includes(previous)) {
      let cursor = index + 1
      let inClass = false
      while (cursor < source.length) {
        if (source[cursor] === '\\') {
          cursor += 2
          continue
        }
        if (source[cursor] === '[') inClass = true
        else if (source[cursor] === ']') inClass = false
        else if (source[cursor] === '/' && !inClass) break
        else if (source[cursor] === '\n') break
        cursor += 1
      }
      blank(index + 1, cursor)
      index = cursor + 1
      previous = '/'
      continue
    }
    if (!/\s/.test(character)) previous = character
    index += 1
  }
  return out.join('')
}

const CALL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
  'new', 'do', 'else', 'in', 'of', 'delete', 'void', 'throw', 'case', 'with',
  'instanceof', 'yield', 'await',
])

/** Browser globals the bundle calls bare rather than through `window`. */
const CALL_GLOBALS = new Set([
  'encodeURIComponent', 'decodeURIComponent', 'isFinite', 'isNaN', 'parseInt',
  'parseFloat', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'fetch', 'alert', 'requestAnimationFrame', 'cancelAnimationFrame',
])

/**
 * Reports bare `name(` call targets the bundle never declares. Property calls
 * (`foo.bar()`) are excluded, so this only sees free identifiers.
 */
function undefinedCallTargets(sources: readonly string[]): string[] {
  const code = stripNonCode(sources.join('\n'))
  const declared = new Set<string>()
  for (const match of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    declared.add(match[1]!)
  }
  for (const match of code.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=/g)) {
    declared.add(match[1]!)
  }
  // Callback parameters are called by name inside their own scope.
  for (const match of code.matchAll(/\bfunction\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) {
    for (const parameter of match[1]!.split(',')) {
      const name = parameter.trim()
      if (name) declared.add(name)
    }
  }

  const missing: string[] = []
  code.split('\n').forEach((line, offset) => {
    for (const match of line.matchAll(/(?<![.\w$])([a-z][\w$]*)\s*\(/g)) {
      const name = match[1]!
      if (CALL_KEYWORDS.has(name)) continue
      if (CALL_GLOBALS.has(name)) continue
      if (declared.has(name)) continue
      missing.push(`${name} (line ${offset + 1})`)
    }
  })
  return [...new Set(missing)]
}

describe('LG webOS package assets', () => {
  test('has valid TV manifest identity and required local entry points', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'appinfo.json'), 'utf8'))
    expect(manifest).toMatchObject({
      id: 'com.itsrammen.app.toasttv',
      version: '0.3.16',
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

  /* The TV bundle has no module system and no build step, so a helper that is
     called but never declared parses cleanly and only fails as a ReferenceError
     on the device — silently aborting whatever handler invoked it. */
  test('calls no helper the bundle never declares', () => {
    const found = undefinedCallTargets([
      readFileSync(join(root, 'app.js'), 'utf8'),
      readFileSync(join(root, 'playback-policy.js'), 'utf8'),
    ])

    expect(found).toEqual([])
  })
})
