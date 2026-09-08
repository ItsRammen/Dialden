import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
const app = readFileSync(new URL('../clients/webos/app.js', import.meta.url), 'utf8')
test('TV retains failed reports, retries, and removes only acknowledged reports', () => {
  const requests: any[] = []
  const context: any = {
    CLIENT_VERSION: '0.7.3', state: { serverUrl: 'http://server', clientId: 'tv', clientName: 'TV', view: 'player', clockOffsetMs: 0, activeSource: {}, currentNow: { program: { id: 'program-1' } } },
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
  requests[1].status = 200; requests[1].onload()
  context.sendPresenceHeartbeat()
  expect(requests[2].body.incidents).toEqual([])
})
