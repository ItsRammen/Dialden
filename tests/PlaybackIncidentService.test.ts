import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { PlaybackIncidentService } from '../src/services/PlaybackIncidentService'
import { ClientPresenceService } from '../src/services/ClientPresenceService'
import { createClientPresenceController } from '../src/controllers/ClientPresenceController'

test('deduplicates retried reports, strips unexpected fields, and persists through restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'playback-incidents-'))
  try {
    const path = join(dir, 'incidents.json')
    const service = new PlaybackIncidentService(path, () => ({ workerStatusAtReceipt: 'running' }))
    const event = { id: '1', event: 'stall', channelId: 'nick', mediaTime: 123, url: 'secret', frames: Infinity }
    await Promise.all([service.record('tv', [event]), service.record('tv', [event])])
    const rows = new PlaybackIncidentService(path).snapshot()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ event: 'stall', mediaTime: 123, workerStatusAtReceipt: 'running' })
    expect(rows[0]).not.toHaveProperty('url')
    expect(rows[0]).not.toHaveProperty('frames')
    await service.record('tv', [{ id: 'bad', event: 'unknown' }])
    expect(service.snapshot()).toHaveLength(1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('retains only the latest 500 reports', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'playback-ring-'))
  try {
    const service = new PlaybackIncidentService(join(dir, 'events.json'))
    for (let i = 0; i < 502; i += 2) await service.record('tv', [{ id: String(i), event: 'stall' }, { id: String(i+1), event: 'recovered' }])
    expect(service.snapshot()).toHaveLength(500)
    expect(service.snapshot()[0]!.id).toBe('501')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('heartbeat acknowledges persisted incidents and exposes escaped admin diagnostics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'playback-api-'))
  try {
    const app = new Hono().route('/', createClientPresenceController({ presence: new ClientPresenceService(), incidents: new PlaybackIncidentService(join(dir, 'events.json')) }))
    const response = await app.request('/api/client/v1/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: 'tv', name: 'TV', playbackMode: 'buffering', channelId: 'nick', incidents: [{ id: '1', event: 'stall', channelId: '<script>bad</script>' }] }) })
    expect(response.status).toBe(200)
    const json = await (await app.request('/api/admin/v1/playback-incidents')).json() as { incidents: unknown[] }
    expect(json.incidents).toHaveLength(1)
    const html = await (await app.request('/diagnostics/playback')).text()
    expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;')
    expect(html).not.toContain('<script>bad</script>')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
