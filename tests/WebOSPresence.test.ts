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
    expect(script).toContain("return 'transcode'")
    expect(script).toContain("return 'buffering'")
    expect(script).toContain("return 'paused'")
    expect(script).toContain("return 'error'")
  })

  test('bounds dense guide rendering and reports a truncated server window', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )

    expect(script).toContain('var GUIDE_RENDER_LIMIT = 250')
    expect(script).toContain('data.programs.slice(0, GUIDE_RENDER_LIMIT)')
    expect(script).toContain('data.truncated === true')
    expect(script).toContain('formatTime(data.coverageEnd)')
  })

  test('backs off then retries a recovered stable HLS channel automatically', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )

    expect(script).toContain('var LIVE_STREAM_RETRY_DELAYS = [750, 1500, 3000, 5000, 8000]')
    expect(script).toContain('var TUNING_STABLE_MS = 850')
    expect(script).toContain('scheduleLiveRetry(state.failedLiveUrl')
    expect(script).toContain('state.failedLiveUrl = null')
    expect(script).toContain("beginTuning('Retrying the live channel…')")
    expect(script).toContain('seekHlsLiveEdge()')
    expect(script).not.toContain('Live channel unavailable — trying direct playback')
  })

  test('uses OK to reveal the bottom time bar instead of opening Now Playing', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )
    expect(script).toContain(
      "} else {\n          showChrome();\n          scheduleChromeHide();\n        }"
    )
    expect(script).not.toContain('else openNowOverlay()')
  })

  test('reconciles channel lineup changes in the background without hidden video decoders', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )

    expect(script).toContain('var CHANNEL_REFRESH_INTERVAL_MS = 15000')
    expect(script).toContain('window.setInterval(refreshChannelList, CHANNEL_REFRESH_INTERVAL_MS)')
    expect(script).toContain('restoreChannelIndexById(priorChannelId, priorIndex)')
    expect(script).toContain("showToast('That channel left the lineup")
    expect(script).toContain("state.view === 'channels') hydrateChannelCards()")
    expect(script).not.toMatch(/createElement\(['"]video['"]\)/)
  })

  test('warms only the two neighboring server channels after playback stabilizes', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )

    expect(script).toContain("state.serverUrl + '/api/client/v1/channels/warm'")
    expect(script).toContain('{ clientId: state.clientId, channelIds: ids.slice(0, 2) }')
    expect(script).toContain('scheduleAdjacentWarm()')
    expect(script).toContain('{ clientId: state.clientId, channelIds: [] }')
  })
})
