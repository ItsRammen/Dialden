import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createChannelStreamController } from '../src/controllers/ChannelStreamController'
import { createVirtualTunerStreamController } from '../src/controllers/VirtualTunerStreamController'
import { mutationOriginGuard } from '../src/middleware/mutationOriginGuard'
import { VirtualTunerStaleRequestError } from '../src/services/VirtualTunerService'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const OWNER_ID = 'launch-a'
const OWNER_EPOCH = 100

function channels() {
  return {
    getNow: async (channelId: string) =>
      ({ channelId, program: { title: 'Current program' } } as never),
    list: () => ({
      serverTime: new Date(0).toISOString(),
      serverTimeMs: 0,
      channels: [
        {
          id: 'kids',
          name: 'Kids',
          enabled: true,
          timezone: 'UTC',
          onAir: true,
          manuallyOffAir: false,
        },
        {
          id: 'cartoons',
          name: 'Cartoons',
          enabled: true,
          timezone: 'UTC',
          onAir: true,
          manuallyOffAir: false,
        },
      ],
    }),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

function lineup() {
  return {
    open: async (clientId: string, preferredChannelId?: string) => ({
      clientId,
      channelIds: [preferredChannelId ?? 'kids'],
      ready: 1,
      pending: 0,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    close: async () => {},
    snapshot: () => ({ sessions: [], totalSessions: 0 }),
  }
}

const descriptor = (channelId = 'kids', revision = 1) => ({
  mode: 'stable-hls' as const,
  sessionId: SESSION_ID,
  manifestUrl: `/api/v1/tuner-sessions/${SESSION_ID}/live/index.m3u8`,
  channelId,
  revision,
  requestIdFloor: revision > 1 ? 1 : -1,
})

const tunedDescriptor = (
  channelId = 'kids',
  revision = 2,
  requestId = 1,
  firstMediaSequence = 3,
  segmentCount = 4
) => ({
  ...descriptor(channelId, revision),
  requestId,
  switchBoundary: {
    revision,
    firstMediaSequence,
    lastMediaSequence: firstMediaSequence + segmentCount - 1,
    segmentCount,
    targetDurationSeconds: 1,
    durationSeconds: segmentCount,
    transportMode: 'discontinuity' as const,
  },
})

async function claimOwner(
  controller: ReturnType<typeof createChannelStreamController>,
  ownerId = OWNER_ID,
  ownerEpoch = OWNER_EPOCH
) {
  return controller.request('/api/client/v1/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: 'tv', ownerId, ownerEpoch, lineup: true, tuner: true,
    }),
  })
}

describe('virtual tuner HTTP contract', () => {
  test('adds an opt-in stable tuner descriptor without replacing legacy fields', async () => {
    const controller = createChannelStreamController({
      channels: channels(),
      workers: {
        touch: async () => ({}) as never,
        warm: async () => [] as never,
        getState: () => null,
      },
      outputRoot: 'unused',
      lineup: lineup(),
      tuners: {
        open: async () => descriptor(),
        tune: async () => tunedDescriptor(),
        closeByClient: async () => 'closed' as const,
        descriptorForClient: () => descriptor(),
      },
    })
    const response = await controller.request('/api/client/v1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'tv',
        lastChannelId: 'kids',
        lineup: true,
        tuner: true,
        ownerId: OWNER_ID,
        ownerEpoch: OWNER_EPOCH,
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'ready',
      streamUrl: '/api/v1/channels/kids/live/index.m3u8',
      tuner: descriptor(),
    })
  })

  test('falls back to normal channel HLS when experimental tuner staging fails', async () => {
    const controller = createChannelStreamController({
      channels: channels(),
      workers: {
        touch: async () => ({}) as never,
        warm: async () => [] as never,
        getState: () => null,
      },
      outputRoot: 'unused',
      lineup: lineup(),
      tuners: {
        open: async () => {
          throw new Error('source window incomplete')
        },
        tune: async () => tunedDescriptor(),
        closeByClient: async () => 'closed' as const,
        descriptorForClient: () => null,
      },
    })
    const response = await controller.request('/api/client/v1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'tv',
        ownerId: OWNER_ID,
        ownerEpoch: OWNER_EPOCH,
        lineup: true,
        tuner: true,
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'pending',
      streamUrl: '/api/v1/channels/kids/live/index.m3u8',
      tunerError: {
        code: 'TUNER_UNAVAILABLE',
        message: 'source window incomplete',
      },
    })
  })

  test('tunes through the same manifest and rejects superseded requests with 409', async () => {
    let stale = false
    const controller = createChannelStreamController({
      channels: channels(),
      workers: {
        touch: async () => ({}) as never,
        warm: async () => [] as never,
        getState: () => null,
      },
      outputRoot: 'unused',
      lineup: lineup(),
      tuners: {
        open: async () => descriptor(),
        async tune(_clientId, _ownerId, _sessionId, channelId, requestId) {
          if (stale) throw new VirtualTunerStaleRequestError()
          return tunedDescriptor(channelId, 2, requestId)
        },
        closeByClient: async () => 'closed' as const,
        descriptorForClient: () => descriptor(),
      },
    })
    const body = {
      clientId: 'tv',
      ownerId: OWNER_ID,
      ownerEpoch: OWNER_EPOCH,
      sessionId: SESSION_ID,
      channelId: 'cartoons',
      requestId: 9,
    }
    expect((await claimOwner(controller)).status).toBe(200)
    const response = await controller.request('/api/client/v1/session/tune', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'ready',
      streamUrl: descriptor().manifestUrl,
      requestId: 9,
      tuner: {
        channelId: 'cartoons',
        revision: 2,
        switchBoundary: {
          revision: 2,
          firstMediaSequence: 3,
          lastMediaSequence: 6,
          segmentCount: 4,
          targetDurationSeconds: 1,
          durationSeconds: 4,
          transportMode: 'discontinuity',
        },
      },
      now: { channelId: 'cartoons', program: { title: 'Current program' } },
    })

    stale = true
    const rejected = await controller.request('/api/client/v1/session/tune', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({ code: 'TUNE_SUPERSEDED' })
  })

  test('allows only the exact credentialless tune mutation and CORS preflight', async () => {
    const guarded = new Hono()
    guarded.use('*', mutationOriginGuard)
    guarded.route(
      '/',
      createChannelStreamController({
        channels: channels(),
        workers: {
          touch: async () => ({}) as never,
          warm: async () => [] as never,
          getState: () => null,
        },
        outputRoot: 'unused',
        lineup: lineup(),
        tuners: {
          open: async () => descriptor(),
          tune: async (_client, _owner, _session, channelId, requestId) =>
            tunedDescriptor(channelId, 2, requestId),
          closeByClient: async () => 'closed' as const,
          descriptorForClient: () => descriptor(),
        },
      })
    )
    const headers = {
      'Content-Type': 'application/json',
      Origin: 'null',
      'Sec-Fetch-Site': 'cross-site',
    }
    const claimed = await guarded.request('/api/client/v1/session', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        clientId: 'tv', ownerId: OWNER_ID, ownerEpoch: OWNER_EPOCH, lineup: true, tuner: true,
      }),
    })
    expect(claimed.status).toBe(200)
    const response = await guarded.request('/api/client/v1/session/tune', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        clientId: 'tv',
        ownerId: OWNER_ID,
        ownerEpoch: OWNER_EPOCH,
        sessionId: SESSION_ID,
        channelId: 'cartoons',
        requestId: 1,
      }),
    })
    expect(response.status).toBe(200)
    const preflight = await guarded.request('/api/client/v1/session/tune', {
      method: 'OPTIONS',
      headers: {
        Origin: 'null',
        'Access-Control-Request-Method': 'POST',
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  test('does not mutate the tuner when authoritative now-playing is unavailable', async () => {
    const unavailableChannels = channels()
    unavailableChannels.getNow = async () =>
      ({ channelId: 'cartoons', program: null } as never)
    let tunes = 0
    const controller = createChannelStreamController({
      channels: unavailableChannels,
      workers: {
        touch: async () => ({}) as never,
        warm: async () => [] as never,
        getState: () => null,
      },
      outputRoot: 'unused',
      lineup: lineup(),
      tuners: {
        open: async () => descriptor(),
        tune: async (_client, _owner, _session, channelId, requestId) => {
          tunes += 1
          return tunedDescriptor(channelId, 2, requestId)
        },
        closeByClient: async () => 'closed' as const,
        descriptorForClient: () => descriptor(),
      },
    })
    expect((await claimOwner(controller)).status).toBe(200)
    const response = await controller.request('/api/client/v1/session/tune', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'tv',
        ownerId: OWNER_ID,
        ownerEpoch: OWNER_EPOCH,
        sessionId: SESSION_ID,
        channelId: 'cartoons',
        requestId: 1,
      }),
    })
    expect(response.status).toBe(503)
    expect(tunes).toBe(0)
  })

  test('returns a committed tune without waiting for lineup reprioritization', async () => {
    const gate = deferred<void>()
    let lineupOpens = 0
    const controller = createChannelStreamController({
      channels: channels(),
      workers: {
        touch: async () => ({}) as never,
        warm: async () => [] as never,
        getState: () => null,
      },
      outputRoot: 'unused',
      lineup: {
        open: async () => {
          lineupOpens += 1
          if (lineupOpens > 1) await gate.promise
          return {
            clientId: 'tv',
            channelIds: ['cartoons'],
            ready: 1,
            pending: 0,
            expiresAt: new Date().toISOString(),
          }
        },
        close: async () => {},
        snapshot: () => ({ sessions: [], totalSessions: 0 }),
      },
      tuners: {
        open: async () => descriptor(),
        tune: async (_client, _owner, _session, channelId, requestId) =>
          tunedDescriptor(channelId, 2, requestId),
        closeByClient: async () => 'closed' as const,
        descriptorForClient: () => descriptor(),
      },
    })
    expect((await claimOwner(controller)).status).toBe(200)
    const response = await Promise.race([
      controller.request('/api/client/v1/session/tune', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: 'tv',
          ownerId: OWNER_ID,
          ownerEpoch: OWNER_EPOCH,
          sessionId: SESSION_ID,
          channelId: 'cartoons',
          requestId: 1,
        }),
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
    ])
    expect(response).not.toBeNull()
    expect(response && response.status).toBe(200)
    gate.resolve()
  })

  test('uses exact launch ownership for close and supports tuner-only fallback', async () => {
    let lineupCloses = 0
    const tunerCloses: unknown[][] = []
    const controller = createChannelStreamController({
      channels: channels(),
      workers: {
        touch: async () => ({}) as never,
        warm: async () => [] as never,
        getState: () => null,
      },
      outputRoot: 'unused',
      lineup: {
        ...lineup(),
        close: async () => {
          lineupCloses += 1
        },
      },
      tuners: {
        open: async () => descriptor(),
        tune: async (_client, _owner, _session, channelId, requestId) =>
          tunedDescriptor(channelId, 2, requestId),
        closeByClient: async (...args) => {
          tunerCloses.push(args)
          return 'closed' as const
        },
        descriptorForClient: () => descriptor(),
      },
    })
    await controller.request('/api/client/v1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'tv',
        ownerId: OWNER_ID,
        ownerEpoch: OWNER_EPOCH,
        lineup: true,
        tuner: true,
      }),
    })

    const ownerless = await controller.request('/api/client/v1/session/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'tv' }),
    })
    expect(await ownerless.json()).toMatchObject({ ok: true, ignored: true })
    expect(tunerCloses).toHaveLength(0)
    expect(lineupCloses).toBe(0)

    const stale = await controller.request('/api/client/v1/session/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'tv',
        ownerId: 'launch-old',
        ownerEpoch: OWNER_EPOCH - 1,
        sessionId: '22222222-2222-4222-8222-222222222222',
      }),
    })
    expect(await stale.json()).toMatchObject({ ok: true, ignored: true })
    expect(tunerCloses).toHaveLength(0)
    expect(lineupCloses).toBe(0)

    const tunerOnly = await controller.request('/api/client/v1/session/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'tv',
        ownerId: OWNER_ID,
        ownerEpoch: OWNER_EPOCH,
        sessionId: SESSION_ID,
        tunerOnly: true,
      }),
    })
    expect(await tunerOnly.json()).toMatchObject({ ok: true, tunerOnly: true })
    expect(tunerCloses).toHaveLength(1)
    expect(lineupCloses).toBe(0)

    const invalid = await controller.request('/api/client/v1/session/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'tv', tunerOnly: 'yes' }),
    })
    expect(invalid.status).toBe(400)

    await controller.request('/api/client/v1/session/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'tv', ownerId: OWNER_ID, ownerEpoch: OWNER_EPOCH }),
    })
    expect(lineupCloses).toBe(1)
  })

  test('prevents an older launch from completing after a newer launch', async () => {
    const oldGate = deferred<void>()
    const oldStarted = deferred<void>()
    const lineupCalls: string[] = []
    const tunerOwners: string[] = []
    const baseLineup = lineup()
    const controller = createChannelStreamController({
      channels: channels(),
      workers: {
        touch: async () => ({}) as never,
        warm: async () => [] as never,
        getState: () => null,
      },
      outputRoot: 'unused',
      lineup: {
        ...baseLineup,
        async open(clientId, channelId) {
          lineupCalls.push(channelId ?? 'kids')
          if (channelId === 'kids') {
            oldStarted.resolve()
            await oldGate.promise
          }
          return baseLineup.open(clientId, channelId)
        },
      },
      tuners: {
        open: async (_client, ownerId, channelId) => {
          tunerOwners.push(ownerId)
          return descriptor(channelId)
        },
        tune: async (_client, _owner, _session, channelId, requestId) =>
          tunedDescriptor(channelId, 2, requestId),
        closeByClient: async () => 'closed' as const,
        descriptorForClient: () => descriptor(),
      },
    })
    const oldRequest = controller.request('/api/client/v1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'tv',
        ownerId: 'launch-old',
        ownerEpoch: 100,
        lastChannelId: 'kids',
        lineup: true,
        tuner: true,
      }),
    })
    await oldStarted.promise
    const newest = await controller.request('/api/client/v1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'tv',
        ownerId: 'launch-new',
        ownerEpoch: 102,
        lastChannelId: 'cartoons',
        lineup: true,
        tuner: true,
      }),
    })
    expect(newest.status).toBe(200)
    oldGate.resolve()
    expect((await oldRequest).status).toBe(409)
    expect(tunerOwners).toEqual(['launch-new'])
    expect(lineupCalls.at(-1)).toBe('cartoons')

    const staleRetarget = await controller.request('/api/client/v1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'tv',
        ownerId: 'launch-old',
        ownerEpoch: 100,
        lastChannelId: 'kids',
        lineup: true,
        tuner: false,
      }),
    })
    expect(staleRetarget.status).toBe(409)
    expect(lineupCalls.at(-1)).toBe('cartoons')
  })

  test('does not close a newly claimed lineup after an old close awaits', async () => {
    const closeGate = deferred<void>()
    const closeStarted = deferred<void>()
    let lineupCloses = 0
    const controller = createChannelStreamController({
      channels: channels(),
      workers: {
        touch: async () => ({}) as never,
        warm: async () => [] as never,
        getState: () => null,
      },
      outputRoot: 'unused',
      lineup: {
        ...lineup(),
        close: async () => {
          lineupCloses += 1
        },
      },
      tuners: {
        open: async (_client, _owner, channelId) => descriptor(channelId),
        tune: async (_client, _owner, _session, channelId, requestId) =>
          tunedDescriptor(channelId, 2, requestId),
        closeByClient: async (_client, ownerId) => {
          if (ownerId === 'launch-old') {
            closeStarted.resolve()
            await closeGate.promise
          }
          return 'closed' as const
        },
        descriptorForClient: () => descriptor(),
      },
    })
    await controller.request('/api/client/v1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'tv', ownerId: 'launch-old', ownerEpoch: 100, lineup: true, tuner: true,
      }),
    })
    const closing = controller.request('/api/client/v1/session/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'tv', ownerId: 'launch-old', ownerEpoch: 100 }),
    })
    await closeStarted.promise
    await controller.request('/api/client/v1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'tv', ownerId: 'launch-new', ownerEpoch: 102, lineup: true, tuner: true,
      }),
    })
    closeGate.resolve()
    expect(await (await closing).json()).toMatchObject({ ignored: true })
    expect(lineupCloses).toBe(0)
  })

  test('preserves a new owner that arrives while owner-aware lineup close awaits', async () => {
    const lineupCloseGate = deferred<void>()
    const lineupCloseStarted = deferred<void>()
    const baseLineup = lineup()
    const controller = createChannelStreamController({
      channels: channels(),
      workers: {
        touch: async () => ({}) as never,
        warm: async () => [] as never,
        getState: () => null,
      },
      outputRoot: 'unused',
      lineup: {
        ...baseLineup,
        close: async () => {
          lineupCloseStarted.resolve()
          await lineupCloseGate.promise
        },
      },
      tuners: {
        open: async (_client, _owner, channelId) => descriptor(channelId),
        tune: async (_client, _owner, _session, channelId, requestId) =>
          tunedDescriptor(channelId, 2, requestId),
        closeByClient: async () => 'closed' as const,
        descriptorForClient: () => descriptor(),
      },
    })
    await claimOwner(controller, 'launch-old', 100)
    const closing = controller.request('/api/client/v1/session/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'tv', ownerId: 'launch-old', ownerEpoch: 100 }),
    })
    await lineupCloseStarted.promise
    expect((await claimOwner(controller, 'launch-new', 102)).status).toBe(200)
    lineupCloseGate.resolve()
    expect(await (await closing).json()).toMatchObject({ ignored: true })

    const tuned = await controller.request('/api/client/v1/session/tune', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'tv',
        ownerId: 'launch-new',
        ownerEpoch: 102,
        sessionId: SESSION_ID,
        channelId: 'cartoons',
        requestId: 1,
      }),
    })
    expect(tuned.status).toBe(200)
  })

  test('rejects a tune whose launch ownership disappears while staging', async () => {
    const tuneGate = deferred<void>()
    const tuneStarted = deferred<void>()
    let lineupOpens = 0
    const baseLineup = lineup()
    const controller = createChannelStreamController({
      channels: channels(),
      workers: {
        touch: async () => ({}) as never,
        warm: async () => [] as never,
        getState: () => null,
      },
      outputRoot: 'unused',
      lineup: {
        ...baseLineup,
        async open(clientId, channelId) {
          lineupOpens += 1
          return baseLineup.open(clientId, channelId)
        },
      },
      tuners: {
        open: async () => descriptor(),
        async tune(_client, _owner, _session, channelId, requestId) {
          tuneStarted.resolve()
          await tuneGate.promise
          return tunedDescriptor(channelId, 2, requestId)
        },
        closeByClient: async () => 'closed' as const,
        descriptorForClient: () => descriptor(),
      },
    })
    await claimOwner(controller)
    const tuning = controller.request('/api/client/v1/session/tune', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'tv', ownerId: OWNER_ID, ownerEpoch: OWNER_EPOCH, sessionId: SESSION_ID,
        channelId: 'cartoons', requestId: 1,
      }),
    })
    await tuneStarted.promise
    await controller.request('/api/client/v1/session/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'tv', ownerId: OWNER_ID, ownerEpoch: OWNER_EPOCH }),
    })
    tuneGate.resolve()
    expect((await tuning).status).toBe(409)
    expect(lineupOpens).toBe(1)
  })

  test('serves tuner playlists and turns invalid segment paths into 404', async () => {
    const controller = createVirtualTunerStreamController({
      playlist: async () =>
        '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:1\n',
      segmentPath: async () => null,
    })
    const playlist = await controller.request(descriptor().manifestUrl)
    expect(playlist.status).toBe(200)
    expect(playlist.headers.get('Content-Type')).toContain(
      'application/vnd.apple.mpegurl'
    )
    const invalid = await controller.request(
      `/api/v1/tuner-sessions/${SESSION_ID}/live/not-a-segment`
    )
    expect(invalid.status).toBe(404)
    expect(invalid.headers.get('Cache-Control')).toBe('no-store')
  })
})
