import { join } from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { ChannelService } from '../services/ChannelService'
import {
  isStreamableChannelWorkerState,
  type ContinuousChannelWorkerManager,
} from '../services/ContinuousChannelWorkerManager'
import {
  CHANNEL_SEGMENT_NAME,
  localChannelSegmentName,
  parseHlsMediaPlaylist,
} from '../services/HlsPlaylistReadiness'
import type {
  LineupSessionService,
  LineupSessionSnapshotEntry,
} from '../services/LineupSessionService'
import type { VirtualTunerService } from '../services/VirtualTunerService'
import {
  VirtualTunerSessionNotFoundError,
  VirtualTunerStaleRequestError,
  VirtualTunerUnavailableError,
} from '../services/VirtualTunerService'

interface ChannelStreamControllerDeps {
  channels: Pick<ChannelService, 'list'> & Partial<Pick<ChannelService, 'getNow'>>
  workers: Pick<ContinuousChannelWorkerManager, 'touch' | 'warm' | 'getState'> &
    Partial<Pick<ContinuousChannelWorkerManager, 'restart'>>
  outputRoot: string
  lineup?: Pick<LineupSessionService, 'open' | 'close' | 'snapshot'>
  tuners?: Pick<
    VirtualTunerService,
    'open' | 'tune' | 'closeByClient' | 'descriptorForClient'
  >
}

export const CLIENT_CHANNEL_WARM_ROUTE = '/api/client/v1/channels/warm'
export const CLIENT_CHANNEL_STARTUP_ROUTE = '/api/client/v1/channels/startup'
export const CLIENT_CHANNEL_PREPARE_ROUTE =
  '/api/client/v1/channels/:id/prepare'
export const CLIENT_SESSION_ROUTE = '/api/client/v1/session'
export const CLIENT_SESSION_TUNE_ROUTE = '/api/client/v1/session/tune'
export const CLIENT_SESSION_CLOSE_ROUTE = '/api/client/v1/session/close'

/** Serves the one stable, rolling HLS representation for each channel. */
export function createChannelStreamController({
  channels,
  workers,
  outputRoot,
  lineup,
  tuners,
}: ChannelStreamControllerDeps) {
  const controller = new Hono()
  const playlistRecoveries = new Map<string, Promise<unknown>>()
  // clientId persists across app restarts. ownerId is a per-launch epoch that
  // prevents a delayed sendBeacon from an old webOS process closing the new
  // launch's lineup or tuner.
  const clientSessionOwners = new Map<
    string,
    { ownerId: string; ownerEpoch: number; channelId: string; claimedAt: number }
  >()
  const rememberOwner = (
    clientId: string,
    ownerId: string,
    ownerEpoch: number,
    channelId: string
  ): boolean => {
    const now = Date.now()
    if (!clientSessionOwners.has(clientId) && clientSessionOwners.size >= 128) {
      const liveLineups = new Set(
        lineup?.snapshot().sessions.map((session) => session.clientId) ?? []
      )
      for (const [trackedClientId, owner] of clientSessionOwners) {
        if (
          now - owner.claimedAt > 5 * 60_000 &&
          !liveLineups.has(trackedClientId) &&
          !tuners?.descriptorForClient(trackedClientId)
        ) {
          clientSessionOwners.delete(trackedClientId)
        }
      }
    }
    if (!clientSessionOwners.has(clientId) && clientSessionOwners.size >= 128) {
      return false
    }
    clientSessionOwners.delete(clientId)
    clientSessionOwners.set(clientId, {
      ownerId,
      ownerEpoch,
      channelId,
      claimedAt: now,
    })
    return true
  }

  const clientCors = cors({
    origin: '*',
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    maxAge: 300,
  })
  for (const path of [
    '/api/client/v1/channels/*',
    CLIENT_SESSION_ROUTE,
    CLIENT_SESSION_TUNE_ROUTE,
    CLIENT_SESSION_CLOSE_ROUTE,
  ]) {
    controller.use(path, clientCors)
  }

  controller.post(CLIENT_CHANNEL_STARTUP_ROUTE, async (c) => {
    c.header('Cache-Control', 'no-store')
    const parsed = await parseClientRequest(c)
    if ('response' in parsed) return parsed.response
    const request = parsed.input as {
      clientId?: unknown
      lastChannelId?: unknown
      warmAdjacent?: unknown
    }
    if (
      typeof request.clientId !== 'string' ||
      !SAFE_CLIENT_SESSION_ID.test(request.clientId) ||
      (request.lastChannelId !== undefined &&
        request.lastChannelId !== null &&
        typeof request.lastChannelId !== 'string')
    ) {
      return c.json({ error: 'Startup requires a clientId' }, 400)
    }
    const available = availableChannels(channels)
    if (available.length === 0) {
      return c.json({ error: 'No channels are currently on air' }, 404)
    }
    const selected =
      available.find((channel) => channel.id === request.lastChannelId) ??
      available[0]!
    const fellBack =
      typeof request.lastChannelId === 'string' &&
      request.lastChannelId !== selected.id
    try {
      const state = await workers.touch(selected.id, request.clientId)
      // Adjacent warming retired: lineup sessions hold every channel hot for
      // session clients, and speculative encoders starved software boxes.
      // The legacy response shape is preserved for sideloaded clients.
      return c.json({
        channel: selected,
        status: state.status === 'error' ? 'unavailable' : 'ready',
        error: state.status === 'error' ? state.lastError ?? 'Channel encoder failed' : null,
        streamUrl: `/api/v1/channels/${encodeURIComponent(selected.id)}/live/index.m3u8`,
        warmed: [],
        serverTimeMs: Date.now(),
        fallbackReason: fellBack
          ? 'The last channel is no longer available; the first on-air channel was selected.'
          : null,
      })
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Channel could not be started' },
        503
      )
    }
  })

  controller.post(CLIENT_SESSION_ROUTE, async (c) => {
    c.header('Cache-Control', 'no-store')
    const parsed = await parseClientRequest(c)
    if ('response' in parsed) return parsed.response
    const request = parsed.input as {
      clientId?: unknown
      lastChannelId?: unknown
      lineup?: unknown
      tuner?: unknown
      ownerId?: unknown
      ownerEpoch?: unknown
    }
    if (
      typeof request.clientId !== 'string' ||
      !SAFE_CLIENT_SESSION_ID.test(request.clientId) ||
      (request.lastChannelId !== undefined &&
        request.lastChannelId !== null &&
        typeof request.lastChannelId !== 'string')
    ) {
      return c.json({ error: 'Session requires a clientId' }, 400)
    }
    if (!lineup || request.lineup === false) {
      return c.json({ error: 'Lineup sessions are not available' }, 501)
    }
    const available = availableChannels(channels)
    if (available.length === 0) {
      return c.json({ error: 'No channels are currently on air' }, 404)
    }
    const selected =
      available.find((channel) => channel.id === request.lastChannelId) ??
      available[0]!
    const fellBack =
      typeof request.lastChannelId === 'string' &&
      request.lastChannelId !== selected.id
    const requestedOwner =
      typeof request.ownerId === 'string' &&
      SAFE_SESSION_OWNER_ID.test(request.ownerId)
        ? request.ownerId
        : null
    if (request.tuner === true && requestedOwner === null) {
      return c.json(
        { error: 'Stable tuner sessions require a safe ownerId' },
        400
      )
    }
    const requestedOwnerEpoch =
      typeof request.ownerEpoch === 'number' &&
      Number.isSafeInteger(request.ownerEpoch) &&
      request.ownerEpoch >= 0
        ? request.ownerEpoch
        : null
    if (requestedOwner && requestedOwnerEpoch === null) {
      return c.json({ error: 'Session ownerEpoch is required' }, 400)
    }
    const existingOwner = clientSessionOwners.get(request.clientId)
    if (
      existingOwner &&
      requestedOwner === null
    ) {
      return c.json(
        { error: 'An ownerId is required for this active session', code: 'SESSION_SUPERSEDED' },
        409
      )
    }
    if (
      existingOwner &&
      requestedOwner &&
      requestedOwnerEpoch !== null &&
      ((existingOwner.ownerId === requestedOwner &&
        existingOwner.ownerEpoch !== requestedOwnerEpoch) ||
        (existingOwner.ownerId !== requestedOwner &&
          requestedOwnerEpoch <= existingOwner.ownerEpoch))
    ) {
      return c.json(
        { error: 'A newer app launch owns this session', code: 'SESSION_SUPERSEDED' },
        409
      )
    }
    let claimedOwner = false
    if (requestedOwner && requestedOwnerEpoch !== null) {
      // Register the launch epoch before either asynchronous open. A late
      // completion from an older launch can then be identified before it opens
      // or replaces the newer owner's tuner.
      if (
        !rememberOwner(
          request.clientId,
          requestedOwner,
          requestedOwnerEpoch,
          selected.id
        )
      ) {
        return c.json({ error: 'Client session capacity is full' }, 503)
      }
      claimedOwner = true
    }
    try {
      const entry: LineupSessionSnapshotEntry = await lineup.open(
        request.clientId,
        selected.id,
        requestedOwner ?? undefined
      )
      if (
        requestedOwner &&
        (clientSessionOwners.get(request.clientId)?.ownerId !== requestedOwner ||
          clientSessionOwners.get(request.clientId)?.ownerEpoch !==
            requestedOwnerEpoch)
      ) {
        const latest = clientSessionOwners.get(request.clientId)
        if (latest) {
          void lineup
            .open(request.clientId, latest.channelId, latest.ownerId)
            .catch(() => undefined)
        }
        return c.json(
          { error: 'A newer app launch superseded this session', code: 'SESSION_SUPERSEDED' },
          409
        )
      }
      let tuner
      let tunerError: { code: string; message: string } | undefined
      if (request.tuner === true) {
        const validOwner = requestedOwner!
        if (!tuners) {
          tunerError = {
            code: 'TUNER_UNAVAILABLE',
            message: 'Stable tuner sessions are not available',
          }
        } else {
          try {
            tuner = await tuners.open(
              request.clientId,
              validOwner,
              selected.id,
              requestedOwnerEpoch!
            )
            if (
              clientSessionOwners.get(request.clientId)?.ownerId !== validOwner ||
              clientSessionOwners.get(request.clientId)?.ownerEpoch !==
                requestedOwnerEpoch
            ) {
              await tuners.closeByClient(
                request.clientId,
                validOwner,
                tuner.sessionId
              )
              const latest = clientSessionOwners.get(request.clientId)
              if (latest) {
                void lineup
                  .open(request.clientId, latest.channelId, latest.ownerId)
                  .catch(() => undefined)
              }
              return c.json(
                {
                  error: 'A newer app launch superseded this session',
                  code: 'SESSION_SUPERSEDED',
                },
                409
              )
            }
          } catch (error) {
            if (
              clientSessionOwners.get(request.clientId)?.ownerId !== validOwner ||
              clientSessionOwners.get(request.clientId)?.ownerEpoch !==
                requestedOwnerEpoch
            ) {
              return c.json(
                {
                  error: 'A newer app launch superseded this session',
                  code: 'SESSION_SUPERSEDED',
                },
                409
              )
            }
            const tunerMessage =
              error instanceof Error
                ? error.message
                : 'Stable tuner session could not be opened'
            console.warn(
              `[Tuner] Stable session staging failed for channel ${selected.id}: ${tunerMessage}`
            )
            // The relay is an additive capability. A TV must always retain the
            // proven per-channel HLS startup path when staging cannot complete.
            tunerError = {
              code: 'TUNER_UNAVAILABLE',
              message: tunerMessage,
            }
          }
        }
      }
      const state = workers.getState(selected.id)
      const fallbackStreamable =
        state !== null && isStreamableChannelWorkerState(state)
      const sessionStatus =
        tuner || fallbackStreamable
          ? 'ready'
          : state?.status === 'error'
            ? 'unavailable'
            : 'pending'
      return c.json({
        channel: selected,
        status: sessionStatus,
        error:
          state && state.status === 'error'
            ? state.lastError ?? 'Channel encoder failed'
            : null,
        streamUrl: `/api/v1/channels/${encodeURIComponent(selected.id)}/live/index.m3u8`,
        serverTimeMs: Date.now(),
        fallbackReason: fellBack
          ? 'The last channel is no longer available; the first on-air channel was selected.'
          : null,
        lineup: {
          total: entry.channelIds.length,
          ready: entry.ready,
          pending: entry.pending,
        },
        ...(tuner ? { tuner } : {}),
        ...(tunerError ? { tunerError } : {}),
      })
    } catch (error) {
      if (
        claimedOwner &&
        requestedOwner &&
        clientSessionOwners.get(request.clientId)?.ownerId === requestedOwner &&
        clientSessionOwners.get(request.clientId)?.ownerEpoch ===
          requestedOwnerEpoch
      ) {
        if (existingOwner) clientSessionOwners.set(request.clientId, existingOwner)
        else clientSessionOwners.delete(request.clientId)
      }
      return c.json(
        { error: error instanceof Error ? error.message : 'Session could not be opened' },
        503
      )
    }
  })

  controller.post(CLIENT_SESSION_TUNE_ROUTE, async (c) => {
    c.header('Cache-Control', 'no-store')
    const parsed = await parseClientRequest(c)
    if ('response' in parsed) return parsed.response
    const request = parsed.input as {
      clientId?: unknown
      ownerId?: unknown
      ownerEpoch?: unknown
      sessionId?: unknown
      channelId?: unknown
      requestId?: unknown
    }
    if (
      typeof request.clientId !== 'string' ||
      !SAFE_CLIENT_SESSION_ID.test(request.clientId) ||
      typeof request.ownerId !== 'string' ||
      !SAFE_SESSION_OWNER_ID.test(request.ownerId) ||
      typeof request.ownerEpoch !== 'number' ||
      !Number.isSafeInteger(request.ownerEpoch) ||
      request.ownerEpoch < 0 ||
      typeof request.sessionId !== 'string' ||
      typeof request.channelId !== 'string' ||
      typeof request.requestId !== 'number' ||
      !Number.isSafeInteger(request.requestId) ||
      request.requestId < 0
    ) {
      return c.json(
        {
          error:
            'Tune requires clientId, ownerId, ownerEpoch, sessionId, channelId, and a non-negative requestId',
        },
        400
      )
    }
    if (!tuners) {
      return c.json({ error: 'Stable tuner sessions are not available' }, 501)
    }
    const available = availableChannels(channels)
    const selected = available.find(
      (channel) => channel.id === request.channelId
    )
    if (!selected) return c.json({ error: 'Channel not found' }, 404)
    const currentOwner = clientSessionOwners.get(request.clientId)
    if (
      currentOwner?.ownerId !== request.ownerId ||
      currentOwner?.ownerEpoch !== request.ownerEpoch
    ) {
      return c.json(
        { error: 'A newer app launch owns this session', code: 'TUNER_SESSION_NOT_FOUND' },
        404
      )
    }
    try {
      const eligibleNow = await channels.getNow?.(selected.id)
      if (!eligibleNow?.program) {
        return c.json(
          {
            error: 'Channel has no playable current program',
            code: 'TUNER_UNAVAILABLE',
          },
          503
        )
      }
      const tuner = await tuners.tune(
        request.clientId,
        request.ownerId,
        request.sessionId,
        selected.id,
        request.requestId
      )
      const ownerAfterTune = clientSessionOwners.get(request.clientId)
      if (
        ownerAfterTune?.ownerId !== request.ownerId ||
        ownerAfterTune?.ownerEpoch !== request.ownerEpoch
      ) {
        await tuners.closeByClient(
          request.clientId,
          request.ownerId,
          request.sessionId
        )
        return c.json(
          { error: 'A newer app launch owns this session', code: 'TUNE_SUPERSEDED' },
          409
        )
      }
      // Staging may span a schedule boundary. The committed feed must never be
      // labelled with the preflight program snapshot.
      const committedNow = await channels.getNow?.(selected.id).catch(() => null)
      const ownerAfterMetadata = clientSessionOwners.get(request.clientId)
      if (
        ownerAfterMetadata?.ownerId !== request.ownerId ||
        ownerAfterMetadata?.ownerEpoch !== request.ownerEpoch
      ) {
        await tuners.closeByClient(
          request.clientId,
          request.ownerId,
          request.sessionId
        )
        const latest = clientSessionOwners.get(request.clientId)
        if (latest) {
          void lineup
            ?.open(request.clientId, latest.channelId, latest.ownerId)
            .catch(() => undefined)
        }
        return c.json(
          { error: 'A newer app launch owns this session', code: 'TUNE_SUPERSEDED' },
          409
        )
      }
      rememberOwner(
        request.clientId,
        request.ownerId,
        ownerAfterMetadata.ownerEpoch,
        selected.id
      )
      // Only a committed tune may change the speculative lineup preference;
      // failed or superseded requests leave the last-viewed warm order intact.
      void lineup
        ?.open(request.clientId, selected.id, request.ownerId)
        .catch(() => undefined)
      return c.json({
        channel: selected,
        channelId: selected.id,
        status: 'ready',
        streamUrl: tuner.manifestUrl,
        requestId: tuner.requestId,
        tuner,
        now: committedNow ?? null,
        serverTimeMs: Date.now(),
      })
    } catch (error) {
      if (error instanceof VirtualTunerStaleRequestError) {
        return c.json({ error: error.message, code: 'TUNE_SUPERSEDED' }, 409)
      }
      if (error instanceof VirtualTunerSessionNotFoundError) {
        return c.json({ error: error.message, code: 'TUNER_SESSION_NOT_FOUND' }, 404)
      }
      if (error instanceof VirtualTunerUnavailableError) {
        console.warn(
          `[Tuner] Live switch failed for channel ${selected.id}: ${error.message}`
        )
        return c.json({ error: error.message, code: 'TUNER_UNAVAILABLE' }, 503)
      }
      console.warn(
        `[Tuner] Live switch failed for channel ${selected.id}: ${
          error instanceof Error ? error.message : 'Unknown tuner error'
        }`
      )
      return c.json(
        {
          error:
            error instanceof Error ? error.message : 'Channel could not be tuned',
        },
        400
      )
    }
  })

  controller.post(CLIENT_SESSION_CLOSE_ROUTE, async (c) => {
    c.header('Cache-Control', 'no-store')
    const parsed = await parseClientRequest(c)
    if ('response' in parsed) return parsed.response
    const request = parsed.input as {
      clientId?: unknown
      ownerId?: unknown
      ownerEpoch?: unknown
      sessionId?: unknown
      tunerOnly?: unknown
    }
    if (
      typeof request.clientId !== 'string' ||
      !SAFE_CLIENT_SESSION_ID.test(request.clientId) ||
      (request.ownerId !== undefined &&
        (typeof request.ownerId !== 'string' ||
          !SAFE_SESSION_OWNER_ID.test(request.ownerId))) ||
      (request.ownerEpoch !== undefined &&
        (typeof request.ownerEpoch !== 'number' ||
          !Number.isSafeInteger(request.ownerEpoch) ||
          request.ownerEpoch < 0)) ||
      (request.sessionId !== undefined &&
        (typeof request.sessionId !== 'string' ||
          !SAFE_TUNER_SESSION_ID.test(request.sessionId))) ||
      (request.tunerOnly !== undefined &&
        typeof request.tunerOnly !== 'boolean')
    ) {
      return c.json({ error: 'Close requires a clientId' }, 400)
    }
    const knownOwner = clientSessionOwners.get(request.clientId)
    if (request.ownerId === undefined && knownOwner !== undefined) {
      return c.json({ ok: true, ignored: true, serverTimeMs: Date.now() })
    }
    if (
      typeof request.ownerId === 'string' &&
      knownOwner !== undefined &&
      (knownOwner.ownerId !== request.ownerId ||
        (request.ownerEpoch !== undefined &&
          knownOwner.ownerEpoch !== request.ownerEpoch))
    ) {
      return c.json({ ok: true, ignored: true, serverTimeMs: Date.now() })
    }
    const tunerResult = tuners
      ? await tuners.closeByClient(
          request.clientId,
          request.ownerId as string | undefined,
          request.sessionId as string | undefined
        )
      : 'none'
    const ownerAfterTunerClose = clientSessionOwners.get(request.clientId)
    if (
      typeof request.ownerId === 'string' &&
      ownerAfterTunerClose !== undefined &&
      (ownerAfterTunerClose.ownerId !== request.ownerId ||
        (request.ownerEpoch !== undefined &&
          ownerAfterTunerClose.ownerEpoch !== request.ownerEpoch))
    ) {
      return c.json({ ok: true, ignored: true, serverTimeMs: Date.now() })
    }
    if (tunerResult === 'ignored') {
      return c.json({ ok: true, ignored: true, serverTimeMs: Date.now() })
    }
    if (request.tunerOnly !== true) {
      await lineup?.close(
        request.clientId,
        request.ownerId as string | undefined
      )
      const ownerAfterLineupClose = clientSessionOwners.get(request.clientId)
      if (
        typeof request.ownerId === 'string' &&
        ownerAfterLineupClose !== undefined &&
        (ownerAfterLineupClose.ownerId !== request.ownerId ||
          (request.ownerEpoch !== undefined &&
            ownerAfterLineupClose.ownerEpoch !== request.ownerEpoch))
      ) {
        return c.json({ ok: true, ignored: true, serverTimeMs: Date.now() })
      }
      if (
        request.ownerId === undefined ||
        clientSessionOwners.get(request.clientId)?.ownerId === request.ownerId
      ) {
        clientSessionOwners.delete(request.clientId)
      }
    }
    return c.json({
      ok: true,
      tunerOnly: request.tunerOnly === true,
      serverTimeMs: Date.now(),
    })
  })

  controller.post(CLIENT_CHANNEL_PREPARE_ROUTE, async (c) => {
    c.header('Cache-Control', 'no-store')
    const parsed = await parseClientRequest(c)
    if ('response' in parsed) return parsed.response
    const request = parsed.input as { clientId?: unknown }
    const channelId = c.req.param('id')
    if (typeof request.clientId !== 'string') {
      return c.json({ error: 'Prepare requires a clientId' }, 400)
    }
    if (!hasChannel(channels, channelId)) {
      return c.json({ error: 'Channel not found' }, 404)
    }
    try {
      const state = await workers.touch(channelId, request.clientId)
      const ready = isStreamableChannelWorkerState(state)
      return c.json({
        channelId,
        status:
          state.status === 'error'
            ? 'unavailable'
            : ready
              ? 'ready'
              : 'pending',
        error: state.status === 'error' ? state.lastError ?? 'Channel encoder failed' : null,
        streamUrl: `/api/v1/channels/${encodeURIComponent(channelId)}/live/index.m3u8`,
        serverTimeMs: Date.now(),
      })
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Channel could not be prepared' },
        503
      )
    }
  })

  controller.post(CLIENT_CHANNEL_WARM_ROUTE, async (c) => {
    c.header('Cache-Control', 'no-store')
    const parsed = await parseClientRequest(c)
    if ('response' in parsed) return parsed.response
    const request = parsed.input as { clientId?: unknown; channelIds?: unknown }
    if (
      typeof request.clientId !== 'string' ||
      !Array.isArray(request.channelIds) ||
      request.channelIds.length > 2 ||
      request.channelIds.some((id) => typeof id !== 'string')
    ) {
      return c.json(
        { error: 'Warm request requires a clientId and at most two channel IDs' },
        400
      )
    }
    const available = new Set(
      channels
        .list()
        .channels.filter((channel) => channel.enabled && channel.onAir)
        .map((channel) => channel.id)
    )
    const channelIds = [
      ...new Set(
        (request.channelIds as string[]).filter((channelId) =>
          available.has(channelId)
        )
      ),
    ]
    try {
      const states = await workers.warm(channelIds, request.clientId)
      return c.json({ warmed: states.map((state) => state.channelId) })
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Channels could not be warmed' },
        400
      )
    }
  })

  controller.on(
    ['GET', 'HEAD'],
    '/api/v1/channels/:id/live/index.m3u8',
    async (c) => {
      const channelId = c.req.param('id')
      if (!hasChannel(channels, channelId)) {
        return c.json({ error: 'Channel not found' }, 404)
      }
      const clientId =
        c.req.query('clientId') ??
        `anonymous-${stableHash(c.req.header('User-Agent') ?? 'hls')}`
      let workerState
      try {
        workerState = await workers.touch(channelId, clientId)
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : 'Stream unavailable' },
          400
        )
      }

      const path = join(outputRoot, channelId, 'live', 'index.m3u8')
      const minimumModifiedAt = workerState.startedAt
        ? Date.parse(workerState.startedAt)
        : 0
      let file = await waitForOutput(
        path,
        minimumModifiedAt,
        () => workers.getState(channelId)?.status === 'error'
      )
      if (!file) {
        const state = workers.getState(channelId)
        return c.json(
          { error: state?.lastError ?? 'Channel stream is starting' },
          503,
          { 'Retry-After': '1', 'Cache-Control': 'no-store' }
        )
      }
      // FFmpeg rewrites the muxer-owned playlist in place, so a reader can
      // observe a torn write. One short retry covers that window; a still
      // incomplete response must never masquerade as a playable HTTP 200.
      let text = await readPlaylistText(file)
      let presentationReady =
        isWellFormedPlaylist(text, 2) &&
        (await livePlaylistFilesReady(
          text,
          join(outputRoot, channelId, 'live'),
          minimumModifiedAt
        ))
      if (!presentationReady) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        file = await waitForOutput(
          path,
          minimumModifiedAt,
          () => workers.getState(channelId)?.status === 'error'
        )
        if (file) {
          text = await readPlaylistText(file)
          presentationReady =
            isWellFormedPlaylist(text, 2) &&
            (await livePlaylistFilesReady(
              text,
              join(outputRoot, channelId, 'live'),
              minimumModifiedAt
            ))
        }
      }
      if (!file || !presentationReady) {
        const state = workers.getState(channelId)
        if (
          !presentationReady &&
          state &&
          isStreamableChannelWorkerState(state) &&
          workers.restart &&
          !playlistRecoveries.has(channelId)
        ) {
          const recovery = workers.restart(
            channelId,
            'Published HLS live edge is stale or incomplete'
          )
          playlistRecoveries.set(channelId, recovery)
          void recovery.finally(() => {
            if (playlistRecoveries.get(channelId) === recovery) {
              playlistRecoveries.delete(channelId)
            }
          }).catch(() => undefined)
        }
        return c.json(
          {
            error:
              state?.lastError ??
              'Channel playlist is incomplete; retry when the live edge is ready',
          },
          503,
          { 'Retry-After': '1', 'Cache-Control': 'no-store' }
        )
      }
      const headers = hlsHeaders('application/vnd.apple.mpegurl', 'no-store')
      return new Response(
        c.req.method === 'HEAD' ? null : augmentLivePlaylist(text),
        { headers }
      )
    }
  )

  controller.on(
    ['GET', 'HEAD'],
    '/api/v1/channels/:id/live/:segment',
    async (c) => {
      const channelId = c.req.param('id')
      const segment = c.req.param('segment')
      if (!hasChannel(channels, channelId)) {
        return c.json({ error: 'Channel not found' }, 404)
      }
      if (!CHANNEL_SEGMENT_NAME.test(segment)) {
        return c.json({ error: 'Segment not found' }, 404)
      }
      const file = Bun.file(join(outputRoot, channelId, 'live', segment))
      if (!(await file.exists())) {
        return c.json({ error: 'Segment not found' }, 404)
      }
      const headers = hlsHeaders('video/mp2t', 'public, max-age=120, immutable')
      return new Response(c.req.method === 'HEAD' ? null : file, { headers })
    }
  )

  return controller
}

const MAX_CLIENT_BODY_BYTES = 4_096
const SAFE_CLIENT_SESSION_ID = /^[a-zA-Z0-9._:-]{1,160}$/
const SAFE_SESSION_OWNER_ID = /^[a-zA-Z0-9._:-]{1,160}$/
const SAFE_TUNER_SESSION_ID = /^[a-f0-9-]{36}$/

async function parseClientRequest(c: any): Promise<
  | { input: unknown }
  | { response: Response }
> {
  try {
    const declaredLength = Number(c.req.header('content-length'))
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_CLIENT_BODY_BYTES
    ) {
      return { response: c.json({ error: 'Request body is too large' }, 413) }
    }
    const stream = c.req.raw.body as ReadableStream<Uint8Array> | null
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    if (stream) {
      const reader = stream.getReader()
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          if (!next.value) continue
          totalBytes += next.value.byteLength
          if (totalBytes > MAX_CLIENT_BODY_BYTES) {
            await reader.cancel().catch(() => undefined)
            return {
              response: c.json({ error: 'Request body is too large' }, 413),
            }
          }
          chunks.push(next.value)
        }
      } finally {
        reader.releaseLock()
      }
    }
    const bytes = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const text = new TextDecoder().decode(bytes)
    return { input: JSON.parse(text) }
  } catch {
    return {
      response: c.json({ error: 'Request must be valid JSON' }, 400),
    }
  }
}

function availableChannels(channels: Pick<ChannelService, 'list'>) {
  return channels
    .list()
    .channels.filter((channel) => channel.enabled && channel.onAir)
}

function hasChannel(
  channels: Pick<ChannelService, 'list'>,
  channelId: string
): boolean {
  return channels
    .list()
    .channels.some(
      (channel) =>
        channel.id === channelId && channel.enabled && channel.onAir
    )
}

async function waitForOutput(
  path: string,
  minimumModifiedAt: number,
  shouldStop: () => boolean
): Promise<ReturnType<typeof Bun.file> | null> {
  const file = Bun.file(path)
  for (let attempt = 0; attempt < 120; attempt++) {
    if (shouldStop()) return null
    if (
      (await file.exists()) &&
      (!Number.isFinite(minimumModifiedAt) ||
        minimumModifiedAt <= 0 ||
        file.lastModified >= minimumModifiedAt)
    ) {
      return file
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return null
}

async function readPlaylistText(
  file: ReturnType<typeof Bun.file>
): Promise<string> {
  try {
    return await file.text()
  } catch {
    // A concurrent muxer rewrite can invalidate the handle; treated as torn.
    return ''
  }
}

/** A streamable snapshot has complete, local EXTINF/URI media entries. */
export function isWellFormedPlaylist(
  text: string,
  minimumSegmentCount = 1
): boolean {
  const playlist = parseHlsMediaPlaylist(text)
  return (
    playlist.wellFormed &&
    playlist.segmentUris.length >= Math.max(1, minimumSegmentCount) &&
    playlist.segmentUris.every((uri) => localChannelSegmentName(uri) !== null)
  )
}

/** Verifies that a syntactically valid live manifest references a recent edge. */
export async function livePlaylistFilesReady(
  text: string,
  liveDirectory: string,
  minimumModifiedAt = 0,
  nowMs = Date.now()
): Promise<boolean> {
  const playlist = parseHlsMediaPlaylist(text)
  if (!playlist.wellFormed) return false
  const names = playlist.segmentUris
    .map(localChannelSegmentName)
    .filter((name): name is string => name !== null)
  const newest = [...new Set(names.slice(-2))]
  if (newest.length < 2) return false
  const durations = [...text.matchAll(/^#EXTINF:([0-9.]+)/gm)]
    .map((match) => Number(match[1]))
    .filter((duration) => Number.isFinite(duration) && duration > 0)
  const targetMatch = /^#EXT-X-TARGETDURATION:([0-9.]+)/m.exec(text)
  const targetDuration = targetMatch ? Number(targetMatch[1]) : 0
  const maximumAgeMs = Math.max(
    5_000,
    Math.ceil(Math.max(targetDuration, ...durations, 1)) * 3_000
  )
  const freshAfter = Math.max(
    Number.isFinite(minimumModifiedAt) ? minimumModifiedAt : 0,
    nowMs - maximumAgeMs
  )
  const playlistFile = Bun.file(join(liveDirectory, 'index.m3u8'))
  if (
    !(await playlistFile.exists()) ||
    playlistFile.size <= 0 ||
    playlistFile.lastModified < freshAfter
  ) {
    return false
  }
  for (const name of newest) {
    const segment = Bun.file(join(liveDirectory, name))
    if (
      !(await segment.exists()) ||
      segment.size <= 0 ||
      segment.lastModified < freshAfter
    ) {
      return false
    }
  }
  return true
}

const LIVE_START_TAG = '#EXT-X-START:TIME-OFFSET=-2.0,PRECISE=YES'

/**
 * Joins native players two seconds before the published live edge. FFmpeg's
 * HLS muxer cannot emit this tag itself, so it is injected at serve time and
 * stays idempotent for playlists that already carry one.
 */
export function augmentLivePlaylist(text: string): string {
  if (!isWellFormedPlaylist(text)) return text
  if (text.includes('#EXT-X-START')) return text
  if (/^#EXTM3U\r?\n/.test(text)) {
    return text.replace(/^#EXTM3U\r?\n/, `#EXTM3U\n${LIVE_START_TAG}\n`)
  }
  const newline = text.endsWith('\n') ? '' : '\n'
  return `${text}${newline}${LIVE_START_TAG}\n`
}

function hlsHeaders(contentType: string, cacheControl: string): Headers {
  return new Headers({
    'Cache-Control': cacheControl,
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
  })
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}
