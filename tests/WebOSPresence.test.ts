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
    expect(script).toContain('var LIVE_EDGE_TOLERANCE_SECONDS = 3')
    expect(script).toContain('scheduleLiveRetry(failedUrl, channel.id)')
    expect(script).toContain('state.failedLiveUrl = null')
    expect(script).toContain("beginTuning('Retrying the live channel…')")
    expect(script).toContain('seekHlsLiveEdge()')
    expect(script).toContain("'tune=' + encodeURIComponent(String(state.tuneGeneration))")
    expect(script).toContain('liveEdge - elements.video.currentTime > DRIFT_LIMIT_SECONDS')
    expect(script).toContain('detachVideoForTune();')
    expect(script).toContain('window.ToastTVPlaybackPolicy.resetMediaElement(elements.video)')
    expect(script).toContain('window.ToastTVPlaybackPolicy.loadMediaElement(elements.video, source.url)')
    expect(script).toContain('window.ToastTVPlaybackPolicy.isPlaybackStable(video)')
    expect(script).toContain('event.currentTarget !== elements.video')
    expect(script).toContain('elements.video.muted = false')
    expect(script).toContain('if (!state.hlsSeekPending)')
    expect(script).toContain('generation !== state.tuneGeneration')
    expect(script).toContain('video !== elements.video')
    expect(script).not.toContain('LIVE_EDGE_LOCK_TIMEOUT_MS')
    expect(script).not.toContain("retryLiveStream('Tuning — reacquiring the live position…')")
    expect(script).not.toContain('cloneNode(false)')
    expect(script).not.toContain('Tuning — refreshing the live edge')
    expect(script).not.toContain('Live channel unavailable — trying direct playback')
  })

  test('toggles the existing player chrome with OK without opening Now Playing', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )
    const markup = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'index.html'),
      'utf8'
    )

    expect(script).toContain("if (state.view === 'player' && code !== 13) showChrome();")
    expect(script).toContain('function toggleChrome()')
    expect(script).toContain("elements.playerScreen.classList.contains('chrome-hidden')")
    expect(script).toContain('else hideChrome();')
    expect(script).toContain('toggleChrome();')
    expect(script).not.toContain('else openNowOverlay()')
    expect(markup).toContain('<b class="remote-key">OK</b> show / hide info')
  })

  test('shows only server-advertised effective channel branding in player chrome', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )
    const markup = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'index.html'),
      'utf8'
    )
    const styles = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'styles.css'),
      'utf8'
    )

    expect(markup).toContain('id="playerChannelLogo"')
    expect(markup).toContain('class="player-channel-logo hidden"')
    expect(script).toContain('var branding = data && data.branding;')
    expect(script).toContain("branding.enabled !== true")
    expect(script).toContain("typeof branding.logoUrl !== 'string'")
    expect(script).toContain(
      'window.ToastTVPlaybackPolicy.resolveUrl(branding.logoUrl, state.serverUrl)'
    )
    expect(script).toContain("elements.playerChannelLogo.classList.add('hidden')")
    expect(script).toContain('renderChannelLogo(data, channel);')
    expect(styles).toContain('.player-channel-logo')
    expect(styles).toContain('object-fit: contain')
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
    expect(script).toContain('warmChannelIds(ids.slice(0, 2))')
    expect(script).toContain('ADJACENT_WARM_REFRESH_MS = 12000')
    expect(script).toContain('scheduleAdjacentWarm()')
    expect(script).toContain('{ clientId: state.clientId, channelIds: [] }')
  })

  test('auto-starts the last channel and prepares zaps before replacing video', () => {
    const script = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'app.js'),
      'utf8'
    )
    const markup = readFileSync(
      join(import.meta.dir, '..', 'clients', 'webos', 'index.html'),
      'utf8'
    )

    expect(script).toContain("'/api/client/v1/channels/startup'")
    expect(script).toContain("'/api/client/v1/channels/' + encodeURIComponent(channel.id) + '/prepare'")
    expect(script).toContain('var ZAP_DEBOUNCE_MS = 200')
    expect(script).toContain('function commitPreparedChannel(')
    expect(script.indexOf('function prepareChannel(')).toBeLessThan(
      script.indexOf('function commitPreparedChannel(')
    )
    expect(script).toContain('writeStorage(STORAGE_CHANNEL, currentChannel().id)')
    expect(script).toContain("console.log('[ToastTV Tune]")
    expect(script).toContain('function nextAvailableChannelIndex(')
    expect(markup).toContain('id="bootScreen"')
    expect(markup).toContain('id="channelOsd"')
  })
})
