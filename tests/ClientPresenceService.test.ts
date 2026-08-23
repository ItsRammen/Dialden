import { describe, expect, test } from 'bun:test'
import {
  ClientPresenceService,
  ClientPresenceValidationError,
  type ClientHeartbeatInput,
} from '../src/services/ClientPresenceService'

describe('ClientPresenceService', () => {
  test('derives connected, offline, and active-viewer state from real heartbeats', () => {
    let now = Date.parse('2026-08-23T10:00:00.000Z')
    const presence = new ClientPresenceService({
      ttlMs: 45_000,
      offlineRetentionMs: 120_000,
      now: () => now,
    })

    presence.recordHeartbeat({
      clientId: 'living-room-lg',
      name: 'Living Room LG',
      channelId: 'kids',
      playbackMode: 'direct-play',
    })
    presence.recordHeartbeat({
      clientId: 'bedroom-lg',
      name: 'Bedroom LG',
      channelId: null,
      playbackMode: 'idle',
    })

    expect(presence.getSnapshot()).toMatchObject({
      connectedClients: 2,
      activeViewers: 1,
      viewersByChannel: { kids: 1 },
      clients: [
        { clientId: 'bedroom-lg', status: 'connected', connected: true },
        { clientId: 'living-room-lg', status: 'connected', connected: true },
      ],
    })

    now += 45_000
    const expired = presence.getSnapshot()
    expect(expired.connectedClients).toBe(0)
    expect(expired.activeViewers).toBe(0)
    expect(expired.viewersByChannel).toEqual({})
    expect(expired.clients.every((client) => client.status === 'offline')).toBe(
      true
    )

    now += 75_000
    expect(presence.getSnapshot().clients).toEqual([])
  })

  test('updates one stable client row without losing its first-seen time', () => {
    let now = 1_700_000_000_000
    const presence = new ClientPresenceService({ now: () => now })
    const first = presence.recordHeartbeat({
      clientId: 'webos-1234',
      name: 'LG webOS TV',
      channelId: 'kids',
      playbackMode: 'buffering',
    })

    now += 10_000
    const updated = presence.recordHeartbeat({
      clientId: 'webos-1234',
      name: 'Living Room LG',
      channelId: 'family-movies',
      playbackMode: 'paused',
    })

    expect(updated.firstSeenAt).toBe(first.firstSeenAt)
    expect(updated.lastSeenAt).not.toBe(first.lastSeenAt)
    expect(presence.getSnapshot()).toMatchObject({
      connectedClients: 1,
      activeViewers: 0,
      clients: [
        {
          clientId: 'webos-1234',
          name: 'Living Room LG',
          channelId: 'family-movies',
          playbackMode: 'paused',
        },
      ],
    })
  })

  test('rejects malformed identifiers, names, channels, and playback modes', () => {
    const presence = new ClientPresenceService()
    const valid: ClientHeartbeatInput = {
      clientId: 'webos-safe',
      name: 'LG webOS TV',
      channelId: 'kids',
      playbackMode: 'direct-play',
    }
    const invalid: unknown[] = [
      { ...valid, clientId: '../living-room' },
      { ...valid, name: 'TV\nforged' },
      { ...valid, channelId: 'kids/../../admin' },
      { ...valid, playbackMode: 'playing-ish' },
      { ...valid, channelId: 7 },
      null,
    ]

    for (const heartbeat of invalid) {
      expect(() =>
        presence.recordHeartbeat(heartbeat as ClientHeartbeatInput)
      ).toThrow(ClientPresenceValidationError)
    }
    expect(presence.getSnapshot().clients).toEqual([])
  })

  test('requires retention to cover the online TTL', () => {
    expect(
      () => new ClientPresenceService({ ttlMs: 10_000, offlineRetentionMs: 9_999 })
    ).toThrow('retention must be at least the TTL')
  })
})
