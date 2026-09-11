import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
const app = readFileSync(new URL('../clients/webos/app.js', import.meta.url), 'utf8')
test('TV retains failed reports, retries, and removes only acknowledged reports', () => {
  const requests: any[] = []
  const storage: Record<string, string> = {}
  const context: any = {
    readStorage: (key: string) => storage[key], writeStorage: (key: string, value: string) => { storage[key] = value },
    CLIENT_VERSION: '0.7.5', state: { serverUrl: 'http://server', clientId: 'tv', clientName: 'TV', view: 'player', clockOffsetMs: 0, activeSource: {}, currentNow: { program: { id: 'program-1' } } },
    activeVideo: () => ({ currentTime: 12, readyState: 2, networkState: 2, buffered: { length: 0 } }),
    currentChannel: () => ({ id: 'nick' }), currentPlaybackMode: () => 'buffering', queuePresenceHeartbeat: () => {},
    XMLHttpRequest: function (this: any) { requests.push(this); this.open = () => {}; this.setRequestHeader = () => {}; this.send = (text: string) => { this.body = JSON.parse(text) } },
  }
  runInNewContext(app.slice(app.indexOf('  var playbackIncidentQueue ='), app.indexOf('  function currentPlaybackMode()')), context)
  context.reportPlaybackIncident('stall')
  context.sendPresenceHeartbeat()
  expect(requests[0].body.incidents[0]).toMatchObject({ event: 'stall', programId: 'program-1', channelId: 'nick' })
  requests[0].onerror()
  context.sendPresenceHeartbeat()
  expect(requests[1].body.incidents[0].id).toBe(requests[0].body.incidents[0].id)
  requests[1].status = 200; requests[1].responseText = '{"ok":true}'; requests[1].onload()
  context.sendPresenceHeartbeat()
  expect(requests[2].body.incidents[0].id).toBe(requests[0].body.incidents[0].id)
  // A restarted app restores the unsent event from local storage.
  runInNewContext(app.slice(app.indexOf('  var playbackIncidentQueue ='), app.indexOf('  function currentPlaybackMode()')), context)
  context.sendPresenceHeartbeat()
  expect(requests[3].body.incidents[0].id).toBe(requests[0].body.incidents[0].id)
  requests[3].status = 200
  requests[3].responseText = JSON.stringify({ acceptedIncidentIds: [requests[3].body.incidents[0].id] })
  requests[3].onload()
  context.sendPresenceHeartbeat()
  expect(requests[4].body.incidents).toEqual([])
  expect(requests[4].body.appVersion).toBe('0.7.5')
})

test('stuck tuning is reported even when internal recovery generations keep changing', () => {
  const events: string[] = []
  const policy = require('../clients/webos/playback-policy.js')
  let now = 1000
  const context: any = {
    window: { ToastTVPlaybackPolicy: policy }, Date: { now: () => now }, document: { hidden: false },
    state: { view: 'player', tuning: true, tuneGeneration: 0 }, pendingPlaybackIncident: null,
    activeVideo: () => ({ currentTime: 0 }), currentChannel: () => ({ id: 'nick' }),
    reportPlaybackIncident: (event: string) => events.push(event),
  }
  runInNewContext(app.slice(app.indexOf('  var playbackProgressWatchdog ='), app.indexOf('  function tickClock()')), context)
  for (let i = 0; i < 47; i++) { context.state.tuneGeneration++; context.checkPlaybackProgress(); now += 1000 }
  expect(events).toEqual(['tuning-timeout'])
  context.document.hidden = true
  now += 60000; context.checkPlaybackProgress()
  expect(events).toEqual(['tuning-timeout'])
})

test('active buffering reports immediately but seeking and paused playback do not', () => {
  const events: unknown[] = []
  const video = { seeking: false }
  const context: any = { state: { view: 'player', tuning: false, localPaused: false }, document: { hidden: false }, tuneVideo: () => video, reportPlaybackIncident: (...args: unknown[]) => events.push(args), scheduleBufferingRecovery: () => {}, queuePresenceHeartbeat: () => {} }
  runInNewContext(app.slice(app.indexOf('  function handleVideoWaiting('), app.indexOf('  function activeVideo(')), context)
  context.handleVideoWaiting({ currentTarget: video, type: 'waiting' })
  expect(events).toEqual([['stall', undefined, 'waiting']])
  video.seeking = true
  context.handleVideoWaiting({ currentTarget: video, type: 'waiting' })
  video.seeking = false; context.state.localPaused = true
  context.handleVideoWaiting({ currentTarget: video, type: 'stalled' })
  expect(events).toHaveLength(1)
})

test('silent stalls are reported at five seconds without triggering early recovery', () => {
  const events: unknown[] = []
  let now = 1000
  const context: any = { window: { ToastTVPlaybackPolicy: require('../clients/webos/playback-policy.js') }, Date: { now: () => now }, document: { hidden: false }, state: { view: 'player', tuning: false, activeSource: { mode: 'channel-hls', url: '/live' }, tuneGeneration: 1 }, pendingPlaybackIncident: null, activeVideo: () => ({ currentTime: 12 }), currentChannel: () => ({ id: 'nick' }), reportPlaybackIncident: (...args: unknown[]) => events.push(args) }
  runInNewContext(app.slice(app.indexOf('  var playbackProgressWatchdog ='), app.indexOf('  function tickClock()')), context)
  context.checkPlaybackProgress()
  now += 4999; context.checkPlaybackProgress(); expect(events).toEqual([])
  now++; context.checkPlaybackProgress(); expect(events).toEqual([['stall', undefined, 'no-progress']])
})
