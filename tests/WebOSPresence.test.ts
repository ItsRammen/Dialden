import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('LG webOS presence telemetry', () => {
  test('uses a stable local identity and sends only the public heartbeat fields', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )

    expect(script).toContain("var STORAGE_CLIENT_ID = 'toasttv.clientId.v1'")
    expect(script).toContain("'/api/client/v1/heartbeat'")
    expect(script).toContain("xhr.open('POST'")
    expect(script).toContain('clientId: state.clientId')
    expect(script).toContain('name: state.clientName')
    expect(script).toContain('channelId: channel ? channel.id : null')
    expect(script).toContain('playbackMode: mode')
    expect(script).not.toMatch(/(?:apiKey|authorization|password):\s*state\./i)
  })

  test('reports state changes as well as periodic liveness', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )

    expect(script).toContain('window.setInterval(sendPresenceHeartbeat, PRESENCE_INTERVAL_MS)')
    expect(script).toContain("return 'direct-play'")
    expect(script).toContain("return 'buffering'")
    expect(script).toContain("return 'paused'")
    expect(script).toContain("return 'error'")
  })
})
