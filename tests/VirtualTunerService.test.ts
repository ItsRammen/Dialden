import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BunVirtualTunerFiles } from '../src/services/BunVirtualTunerFiles'
import { MpegTsTransportIncompatibleError } from '../src/services/MpegTsTransportSplicer'
import type {
  ChannelWorkerClock,
  ContinuousChannelWorkerState,
} from '../src/services/ContinuousChannelWorkerManager'
import {
  parseSourcePlaylist,
  VirtualTunerService,
  VirtualTunerSessionNotFoundError,
  VirtualTunerStaleRequestError,
  VirtualTunerUnavailableError,
  type VirtualTunerFiles,
  type VirtualTunerServiceOptions,
} from '../src/services/VirtualTunerService'

const OWNER_ID = 'launch-a'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const settle = async () => {
  for (let index = 0; index < 100; index += 1) await Promise.resolve()
}

class FakeClock implements ChannelWorkerClock {
  time = Date.parse('2026-08-26T12:00:00.000Z')
  timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = []
  now = () => new Date(this.time)
  setTimeout(callback: () => void, delayMs: number) {
    const timer = { at: this.time + delayMs, callback, cancelled: false }
    this.timers.push(timer)
    return timer
  }
  clearTimeout(handle: unknown) {
    if (handle) (handle as { cancelled: boolean }).cancelled = true
  }
  advance(ms: number) {
    this.time += ms
    let due = this.timers.filter(
      (timer) => !timer.cancelled && timer.at <= this.time
    )
    while (due.length > 0) {
      for (const timer of due) {
        timer.cancelled = true
        timer.callback()
      }
      due = this.timers.filter(
        (timer) => !timer.cancelled && timer.at <= this.time
      )
    }
  }
}

function state(channelId: string): ContinuousChannelWorkerState {
  return {
    channelId,
    status: 'live',
    viewerCount: 0,
    outputUrl: `/api/v1/channels/${channelId}/live/index.m3u8`,
    transcoding: true,
    usingFallback: false,
  }
}

function discontinuityAdapter(files: BunVirtualTunerFiles): VirtualTunerFiles {
  return {
    prepareSession: (sessionId) => files.prepareSession(sessionId),
    readChannelPlaylist: (channelId) => files.readChannelPlaylist(channelId),
    preserveSegment: (...args) => files.preserveSegment(...args),
    removeSegment: (...args) => files.removeSegment(...args),
    removeSession: (...args) => files.removeSession(...args),
    segmentPath: (...args) => files.segmentPath(...args),
    segmentExists: (...args) => files.segmentExists(...args),
    sourcePresentationIsFresh: (...args) =>
      files.sourcePresentationIsFresh(...args),
  }
}

/** Counts real discontinuity markers, never the -SEQUENCE header. */
function discontinuityCount(playlist: string): number {
  return playlist
    .split(/\r?\n/)
    .filter((line) => line === '#EXT-X-DISCONTINUITY').length
}

/**
 * Stands in for a working MPEG-TS splice. `reject` decides, per call, whether
 * the transport is compatible; `attempts` records every call so a test can
 * prove when the relay does and does not retry.
 */
function seamlessAdapter(
  files: BunVirtualTunerFiles,
  reject: () => boolean = () => false,
  attempts: string[] = []
): VirtualTunerFiles {
  return {
    ...discontinuityAdapter(files),
    async spliceSegment(
      channelId,
      sourceName,
      sessionId,
      outputName,
      durationSeconds,
      transport
    ) {
      attempts.push(`${channelId}:${sourceName}`)
      if (reject()) {
        throw new MpegTsTransportIncompatibleError('changed program map')
      }
      await files.preserveSegment(channelId, sourceName, sessionId, outputName)
      return {
        programSignature: transport.programSignature ?? 'normalized-program',
        nextTimestamp90k:
          (transport.nextTimestamp90k ?? 0) +
          Math.round(durationSeconds * 90_000),
        continuityCounters: transport.continuityCounters,
      }
    },
  }
}

describe('VirtualTunerService', () => {
  let root: string
  let sourceRoot: string
  let tunerRoot: string
  let files: BunVirtualTunerFiles
  let clock: FakeClock
  let holds: Array<{ channelId: string; leaseId: string }>
  let releases: Array<{ channelId: string; leaseId: string }>
  let refreshes: Array<{ channelId: string; leaseId: string }>
  let service: VirtualTunerService

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'toasttv-virtual-tuner-'))
    sourceRoot = join(root, 'channels')
    tunerRoot = join(root, 'tuners')
    files = new BunVirtualTunerFiles(sourceRoot, tunerRoot)
    clock = new FakeClock()
    holds = []
    releases = []
    refreshes = []
    for (const [index, channelId] of ['kids', 'cartoons', 'nature'].entries()) {
      writeChannel(sourceRoot, channelId, index * 10 + 1)
    }
    service = createService(discontinuityAdapter(files))
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function createService(
    fileAdapter: VirtualTunerFiles,
    overrides: Partial<VirtualTunerServiceOptions> = {}
  ) {
    return new VirtualTunerService(
      {
        async holdSession(channelId, leaseId) {
          holds.push({ channelId, leaseId })
          return state(channelId)
        },
        async whenReady(channelId) {
          return state(channelId)
        },
        refreshSession(channelId, leaseId) {
          refreshes.push({ channelId, leaseId })
          return true
        },
        async releaseSession(channelId, leaseId) {
          releases.push({ channelId, leaseId })
        },
      },
      fileAdapter,
      () => ['kids', 'cartoons', 'nature'],
      {
        ttlMs: 30_000,
        playlistWindowSegments: 4,
        retainedSegmentCount: 8,
        readinessAttempts: 1,
        clock,
        sleep: async () => {},
        ...overrides,
      }
    )
  }

  test('opens one stable manifest over preserved shared-worker segments', async () => {
    const descriptor = await service.open('living-room', OWNER_ID, 'kids')
    expect(descriptor).toMatchObject({
      mode: 'stable-hls',
      channelId: 'kids',
      revision: 1,
    })
    expect(descriptor.manifestUrl).toContain(descriptor.sessionId)
    expect(holds).toHaveLength(1)
    expect(holds[0]?.leaseId).toBe(`tuner:${descriptor.sessionId}`)

    const playlist = await service.playlist(descriptor.sessionId)
    expect(playlist).toContain('#EXT-X-MEDIA-SEQUENCE:1')
    expect(playlist).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:0')
    expect(playlist.match(/#EXTINF:/g)).toHaveLength(2)
    const firstPath = await service.segmentPath(
      descriptor.sessionId,
      'segment-0000000000001.ts'
    )
    expect(firstPath).not.toBeNull()
    expect(await readFile(firstPath!, 'utf8')).toBe('kids-1')
  })

  test('does not append older source-window segments after joining its live edge', async () => {
    writeChannel(sourceRoot, 'kids', 100, 8)
    const opened = await service.open('living-room', OWNER_ID, 'kids')

    const playlist = await service.playlist(opened.sessionId)

    expect(playlist.match(/#EXTINF:/g)).toHaveLength(4)
    const firstPath = await service.segmentPath(
      opened.sessionId,
      'segment-0000000000001.ts'
    )
    const secondPath = await service.segmentPath(
      opened.sessionId,
      'segment-0000000000002.ts'
    )
    expect(await readFile(firstPath!, 'utf8')).toBe('kids-104')
    expect(await readFile(secondPath!, 'utf8')).toBe('kids-105')
  })

  test('publishes an already-complete four-segment target cushion at tune commit', async () => {
    writeChannel(sourceRoot, 'cartoons', 100, 8)
    const opened = await service.open('living-room', OWNER_ID, 'kids')

    const tuned = await service.tune(
      'living-room',
      OWNER_ID,
      opened.sessionId,
      'cartoons',
      1
    )

    expect(tuned).toMatchObject({
      channelId: 'cartoons',
      revision: 2,
      switchBoundary: {
        revision: 2,
        firstMediaSequence: 3,
        lastMediaSequence: 6,
        segmentCount: 4,
        targetDurationSeconds: 1,
        durationSeconds: 4,
      },
    })
    const committedNames = [3, 4, 5, 6].map(
      (value) => `segment-${String(value).padStart(13, '0')}.ts`
    )
    // The tune response is the public commit boundary. Every URI that the
    // replacement window will advertise must already be registered and
    // nonempty before the caller receives that response.
    for (const segment of committedNames) {
      const path = await service.segmentPath(opened.sessionId, segment)
      expect(path).not.toBeNull()
      expect(await readFile(path!, 'utf8')).toStartWith('cartoons-')
    }
    const playlist = await service.playlist(opened.sessionId)
    const advertised = playlist
      .split(/\r?\n/)
      .filter((line) => /^segment-\d{13}\.ts$/.test(line))
    expect(advertised).toEqual(committedNames)
  })

  test('switches to a target-only advertised edge while retaining outgoing segments', async () => {
    const opened = await service.open('living-room', OWNER_ID, 'kids')
    const tuned = await service.tune(
      'living-room',
      OWNER_ID,
      opened.sessionId,
      'cartoons',
      1
    )
    expect(tuned.manifestUrl).toBe(opened.manifestUrl)
    expect(tuned).toMatchObject({
      channelId: 'cartoons',
      revision: 2,
      requestId: 1,
      switchBoundary: {
        revision: 2,
        firstMediaSequence: 3,
        lastMediaSequence: 4,
        segmentCount: 2,
        targetDurationSeconds: 1,
        durationSeconds: 2,
      },
    })
    const playlist = await service.playlist(opened.sessionId)
    expect(discontinuityCount(playlist)).toBe(1)
    expect(playlist).toContain('#EXT-X-MEDIA-SEQUENCE:3')
    expect(playlist.match(/#EXTINF:/g)).toHaveLength(2)
    expect(playlist).not.toContain('segment-0000000000001.ts')
    expect(playlist).not.toContain('segment-0000000000002.ts')
    expect(releases.some((release) => release.channelId === 'kids')).toBe(true)

    const outgoingSegment = await service.segmentPath(
      opened.sessionId,
      'segment-0000000000001.ts'
    )
    expect(outgoingSegment).not.toBeNull()
    expect(await readFile(outgoingSegment!, 'utf8')).toBe('kids-1')

    const newSegment = await service.segmentPath(
      opened.sessionId,
      'segment-0000000000003.ts'
    )
    expect(await readFile(newSegment!, 'utf8')).toBe('cartoons-11')
  })

  test('keeps the outgoing window sliding across a seamless cross-channel cut', async () => {
    service = createService(seamlessAdapter(files))
    const opened = await service.open('living-room', OWNER_ID, 'kids')
    const tuned = await service.tune(
      'living-room',
      OWNER_ID,
      opened.sessionId,
      'cartoons',
      1
    )

    expect(tuned.switchBoundary.transportMode).toBe('seamless')
    const playlist = await service.playlist(opened.sessionId)
    expect(discontinuityCount(playlist)).toBe(0)
    // The target shares the outgoing decoder timeline, so the entries a native
    // reader is positioned in must stay advertised. Cutting them would show an
    // unexplained media-sequence jump with nothing marking it.
    expect(playlist).toContain('#EXT-X-MEDIA-SEQUENCE:1')
    expect(tuned.switchBoundary.firstMediaSequence).toBe(1)
    expect(tuned.switchBoundary.lastMediaSequence).toBe(4)

    const advertised = playlist
      .split(/\r?\n/)
      .filter((line) => /^segment-\d+\.ts$/.test(line))
    expect(advertised).toHaveLength(4)
    const newest = await service.segmentPath(opened.sessionId, advertised[3]!)
    expect(await readFile(newest!, 'utf8')).toBe('cartoons-12')
  })

  test('retries transport splicing at the next channel switch after a rejection', async () => {
    const attempts: string[] = []
    let rejecting = true
    service = createService(seamlessAdapter(files, () => rejecting, attempts))
    const opened = await service.open('living-room', OWNER_ID, 'kids')
    expect(attempts).toHaveLength(1)

    // Steady-state polling must not retry a latched incompatibility: it would
    // rewrite and discard every segment for the life of the session.
    writeChannel(sourceRoot, 'kids', 3)
    await service.playlist(opened.sessionId)
    expect(attempts).toHaveLength(1)

    // A channel switch already publishes a guarded discontinuity, so it is the
    // one safe place to find out whether the transport became compatible again.
    const first = await service.tune(
      'living-room',
      OWNER_ID,
      opened.sessionId,
      'cartoons',
      1
    )
    expect(first.switchBoundary.transportMode).toBe('discontinuity')
    expect(attempts).toHaveLength(2)
    expect(
      discontinuityCount(await service.playlist(opened.sessionId))
    ).toBe(1)
  })

  test('marks a discontinuity when a mid-channel splice failure falls back to source bytes', async () => {
    let rejecting = false
    service = createService(seamlessAdapter(files, () => rejecting))
    const opened = await service.open('living-room', OWNER_ID, 'kids')
    expect(
      discontinuityCount(await service.playlist(opened.sessionId))
    ).toBe(0)

    // Everything published so far sits on the rewritten session clock. A torn
    // segment read drops the relay back to raw source timestamps, which is a
    // real timestamp reset even though the channel never changed.
    rejecting = true
    writeChannel(sourceRoot, 'kids', 3)
    expect(
      discontinuityCount(await service.playlist(opened.sessionId))
    ).toBe(1)
  })

  test('marks a discontinuity when seamless output re-arms on a new clock', async () => {
    let rejecting = true
    service = createService(seamlessAdapter(files, () => rejecting))
    const opened = await service.open('living-room', OWNER_ID, 'kids')

    rejecting = false
    const tuned = await service.tune(
      'living-room',
      OWNER_ID,
      opened.sessionId,
      'cartoons',
      1
    )

    // Seamless output only omits the marker when it continues an established
    // clock. This batch starts one, so its join off raw source bytes is still a
    // reset and has to stay marked.
    expect(tuned.switchBoundary.transportMode).toBe('seamless')
    expect(
      discontinuityCount(await service.playlist(opened.sessionId))
    ).toBe(1)
  })

  test('returns the original committed switch boundary for an idempotent retry after the window slides', async () => {
    const opened = await service.open('living-room', OWNER_ID, 'kids')
    const committed = await service.tune(
      'living-room',
      OWNER_ID,
      opened.sessionId,
      'cartoons',
      1
    )
    expect(committed.switchBoundary.firstMediaSequence).toBe(3)
    expect(committed.switchBoundary.lastMediaSequence).toBe(4)

    writeChannel(sourceRoot, 'cartoons', 13)
    await service.playlist(opened.sessionId)
    writeChannel(sourceRoot, 'cartoons', 15)
    const slid = await service.playlist(opened.sessionId)
    expect(slid).toContain('#EXT-X-MEDIA-SEQUENCE:5')

    const retried = await service.tune(
      'living-room',
      OWNER_ID,
      opened.sessionId,
      'cartoons',
      1
    )
    expect(retried).toEqual(committed)
    expect(retried.switchBoundary).toEqual({
      revision: 2,
      firstMediaSequence: 3,
      lastMediaSequence: 4,
      segmentCount: 2,
      targetDurationSeconds: 1,
      durationSeconds: 2,
      transportMode: 'discontinuity',
    })
  })

  test('does not replay an old committed boundary after a background retarget', async () => {
    const opened = await service.open('living-room', OWNER_ID, 'kids')
    await service.tune(
      'living-room',
      OWNER_ID,
      opened.sessionId,
      'cartoons',
      1
    )
    const retargeted = await service.open('living-room', OWNER_ID, 'nature')
    expect(retargeted).toMatchObject({ channelId: 'nature', revision: 3 })

    await expect(
      Promise.resolve().then(() =>
        service.tune(
          'living-room',
          OWNER_ID,
          opened.sessionId,
          'cartoons',
          1
        )
      )
    ).rejects.toBeInstanceOf(VirtualTunerStaleRequestError)
  })

  test('reserves request IDs before staging so a newer zap supersedes the old one', async () => {
    const gate = deferred<void>()
    const gatedFiles: VirtualTunerFiles = {
      prepareSession: (sessionId) => files.prepareSession(sessionId),
      async readChannelPlaylist(channelId) {
        if (channelId === 'cartoons') await gate.promise
        return files.readChannelPlaylist(channelId)
      },
      preserveSegment: (...args) => files.preserveSegment(...args),
      removeSegment: (...args) => files.removeSegment(...args),
      removeSession: (...args) => files.removeSession(...args),
      segmentPath: (...args) => files.segmentPath(...args),
      segmentExists: (...args) => files.segmentExists(...args),
    }
    service = createService(gatedFiles)
    const opened = await service.open('living-room', OWNER_ID, 'kids')
    const first = service.tune(
      'living-room',
      OWNER_ID,
      opened.sessionId,
      'cartoons',
      1
    )
    await settle()
    const second = service.tune(
      'living-room',
      OWNER_ID,
      opened.sessionId,
      'nature',
      2
    )
    gate.resolve()

    await expect(first).rejects.toBeInstanceOf(VirtualTunerStaleRequestError)
    const committed = await second
    expect(committed.channelId).toBe('nature')
    expect(committed.revision).toBe(2)
    expect(committed.switchBoundary).toMatchObject({
      revision: 2,
      firstMediaSequence: 3,
      lastMediaSequence: 4,
      segmentCount: 2,
    })
    expect(service.descriptorForClient('living-room')?.channelId).toBe('nature')
    const playlist = await service.playlist(opened.sessionId)
    expect(playlist.match(/#EXTINF:/g)).toHaveLength(2)
    const advertised = playlist
      .split(/\r?\n/)
      .filter((line) => /^segment-\d{13}\.ts$/.test(line))
    expect(advertised).toHaveLength(2)
    for (const segment of advertised) {
      const path = await service.segmentPath(opened.sessionId, segment)
      expect(path).not.toBeNull()
      expect(await readFile(path!, 'utf8')).toStartWith('nature-')
    }
  })

  test('never reuses segment names after superseded cleanup fails', async () => {
    const preserveGate = deferred<void>()
    const firstPreserved = deferred<void>()
    let gated = false
    let failedCleanup = false
    const faultingFiles: VirtualTunerFiles = {
      prepareSession: (sessionId) => files.prepareSession(sessionId),
      readChannelPlaylist: (channelId) => files.readChannelPlaylist(channelId),
      async preserveSegment(...args) {
        await files.preserveSegment(...args)
        if (args[0] === 'cartoons' && !gated) {
          gated = true
          firstPreserved.resolve()
          await preserveGate.promise
        }
      },
      async removeSegment(sessionId, outputName) {
        if (!failedCleanup && outputName === 'segment-0000000000003.ts') {
          failedCleanup = true
          throw new Error('simulated unlink failure')
        }
        return files.removeSegment(sessionId, outputName)
      },
      removeSession: (...args) => files.removeSession(...args),
      segmentPath: (...args) => files.segmentPath(...args),
      segmentExists: (...args) => files.segmentExists(...args),
    }
    service = createService(faultingFiles)
    const opened = await service.open('living-room', OWNER_ID, 'kids')
    const stale = service.tune(
      'living-room',
      OWNER_ID,
      opened.sessionId,
      'cartoons',
      1
    )
    await firstPreserved.promise
    const latest = service.tune(
      'living-room',
      OWNER_ID,
      opened.sessionId,
      'nature',
      2
    )
    preserveGate.resolve()

    await expect(stale).rejects.toBeInstanceOf(VirtualTunerStaleRequestError)
    expect((await latest).channelId).toBe('nature')
    const playlist = await service.playlist(opened.sessionId)
    expect(playlist).not.toContain('segment-0000000000003.ts')
    expect(playlist).not.toContain('segment-0000000000004.ts')
    expect(playlist).toContain('segment-0000000000005.ts')
    expect(
      await files.segmentExists(
        opened.sessionId,
        'segment-0000000000003.ts'
      )
    ).toBe(false)
    const firstNature = await service.segmentPath(
      opened.sessionId,
      'segment-0000000000005.ts'
    )
    expect(await readFile(firstNature!, 'utf8')).toBe('nature-21')
  })

  test('keeps publishing the outgoing edge while a candidate is still starting', async () => {
    const gate = deferred<void>()
    const gatedFiles: VirtualTunerFiles = {
      prepareSession: (sessionId) => files.prepareSession(sessionId),
      async readChannelPlaylist(channelId) {
        if (channelId === 'cartoons') await gate.promise
        return files.readChannelPlaylist(channelId)
      },
      preserveSegment: (...args) => files.preserveSegment(...args),
      removeSegment: (...args) => files.removeSegment(...args),
      removeSession: (...args) => files.removeSession(...args),
      segmentPath: (...args) => files.segmentPath(...args),
      segmentExists: (...args) => files.segmentExists(...args),
    }
    service = createService(gatedFiles)
    const opened = await service.open('living-room', OWNER_ID, 'kids')
    const tuning = service.tune(
      'living-room',
      OWNER_ID,
      opened.sessionId,
      'cartoons',
      1
    )
    await settle()

    // Simulate the shared kids worker advancing while cartoons is gated.
    writeChannel(sourceRoot, 'kids', 3)
    const outgoing = service.playlist(opened.sessionId)
    const outcome = await Promise.race([
      outgoing.then(() => 'resolved' as const),
      new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), 500)
      ),
    ])
    expect(outcome).toBe('resolved')
    expect((await outgoing).match(/#EXTINF:/g)).toHaveLength(4)

    gate.resolve()
    expect((await tuning).channelId).toBe('cartoons')
  })

  test('a pending public zap supersedes a background same-channel reopen without closing the tuner', async () => {
    const gate = deferred<void>()
    const gatedFiles: VirtualTunerFiles = {
      prepareSession: (sessionId) => files.prepareSession(sessionId),
      async readChannelPlaylist(channelId) {
        if (channelId === 'cartoons') await gate.promise
        return files.readChannelPlaylist(channelId)
      },
      preserveSegment: (...args) => files.preserveSegment(...args),
      removeSegment: (...args) => files.removeSegment(...args),
      removeSession: (...args) => files.removeSession(...args),
      segmentPath: (...args) => files.segmentPath(...args),
      segmentExists: (...args) => files.segmentExists(...args),
    }
    service = createService(gatedFiles)
    const opened = await service.open('living-room', OWNER_ID, 'kids')
    const staleTune = service.tune(
      'living-room',
      OWNER_ID,
      opened.sessionId,
      'cartoons',
      1
    )
    await settle()
    writeChannel(sourceRoot, 'kids', 3)

    await expect(
      service.open('living-room', OWNER_ID, 'kids')
    ).rejects.toBeInstanceOf(VirtualTunerStaleRequestError)

    gate.resolve()
    expect((await staleTune).channelId).toBe('cartoons')
    expect(service.descriptorForClient('living-room')).toMatchObject({
      sessionId: opened.sessionId,
      channelId: 'cartoons',
      requestIdFloor: 1,
    })
  })

  test('a newer same-owner open wins when an older channel retarget finishes late', async () => {
    const oldGate = deferred<void>()
    const oldStarted = deferred<void>()
    const gatedFiles: VirtualTunerFiles = {
      prepareSession: (sessionId) => files.prepareSession(sessionId),
      async readChannelPlaylist(channelId) {
        if (channelId === 'cartoons') {
          oldStarted.resolve()
          await oldGate.promise
        }
        return files.readChannelPlaylist(channelId)
      },
      preserveSegment: (...args) => files.preserveSegment(...args),
      removeSegment: (...args) => files.removeSegment(...args),
      removeSession: (...args) => files.removeSession(...args),
      segmentPath: (...args) => files.segmentPath(...args),
      segmentExists: (...args) => files.segmentExists(...args),
    }
    service = createService(gatedFiles)
    const initial = await service.open('living-room', OWNER_ID, 'kids')
    const older = service.open('living-room', OWNER_ID, 'cartoons')
    await oldStarted.promise
    const latest = await service.open('living-room', OWNER_ID, 'nature')
    expect(latest).toMatchObject({
      sessionId: initial.sessionId,
      channelId: 'nature',
      requestIdFloor: -1,
    })

    oldGate.resolve()
    await expect(older).rejects.toBeInstanceOf(VirtualTunerStaleRequestError)
    expect(service.descriptorForClient('living-room')?.channelId).toBe('nature')
  })

  test('uses a stable target duration for every reload in one session', async () => {
    writeCustomChannel(sourceRoot, 'kids', 20, [1.2, 1.1], 4)
    const opened = await service.open('living-room', OWNER_ID, 'kids')
    expect(await service.playlist(opened.sessionId)).toContain(
      '#EXT-X-TARGETDURATION:4'
    )

    writeCustomChannel(sourceRoot, 'kids', 22, [0.8, 0.9], 1)
    const reloaded = await service.playlist(opened.sessionId)
    expect(reloaded).toContain('#EXT-X-TARGETDURATION:4')
    expect(reloaded).not.toContain('#EXT-X-TARGETDURATION:1\n')
  })

  test('marks a missed source window and rejects a regressed old manifest', async () => {
    const opened = await service.open('living-room', OWNER_ID, 'kids')
    writeChannel(sourceRoot, 'kids', 5)
    const missed = await service.playlist(opened.sessionId)
    expect(missed).toContain(
      '#EXT-X-DISCONTINUITY\n#EXTINF:1,\nsegment-0000000000003.ts'
    )

    writeChannel(sourceRoot, 'kids', 1)
    const restarted = await service.playlist(opened.sessionId)
    expect(restarted).toBe(missed)
    expect(restarted).not.toContain('segment-0000000000005.ts')
  })

  test('keeps media and discontinuity sequences monotonic across hard switch cuts', async () => {
    const opened = await service.open('living-room', OWNER_ID, 'kids')
    await service.tune(
      'living-room',
      OWNER_ID,
      opened.sessionId,
      'cartoons',
      1
    )
    const first = await service.playlist(opened.sessionId)
    expect(first).toContain('#EXT-X-MEDIA-SEQUENCE:3')
    expect(first).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:0')
    await service.tune(
      'living-room',
      OWNER_ID,
      opened.sessionId,
      'nature',
      2
    )
    const second = await service.playlist(opened.sessionId)
    expect(second).toContain('#EXT-X-MEDIA-SEQUENCE:5')
    expect(second).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:1')
    await service.tune(
      'living-room',
      OWNER_ID,
      opened.sessionId,
      'kids',
      3
    )
    const third = await service.playlist(opened.sessionId)
    expect(third).toContain('#EXT-X-MEDIA-SEQUENCE:7')
    expect(third).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:2')
  })

  test('uses the same target-only cut for a cross-channel reopen', async () => {
    const opened = await service.open('living-room', OWNER_ID, 'kids')
    const reopened = await service.open('living-room', OWNER_ID, 'cartoons')

    expect(reopened).toMatchObject({
      sessionId: opened.sessionId,
      channelId: 'cartoons',
      revision: 2,
    })
    const playlist = await service.playlist(opened.sessionId)
    expect(playlist).toContain('#EXT-X-MEDIA-SEQUENCE:3')
    expect(playlist.match(/#EXTINF:/g)).toHaveLength(2)
    expect(playlist).not.toContain('segment-0000000000001.ts')
    expect(await service.segmentPath(
      opened.sessionId,
      'segment-0000000000001.ts'
    )).not.toBeNull()
  })

  test('replaces app owners and ignores an exact close from the old launch', async () => {
    const first = await service.open('living-room', 'launch-old', 'kids', 1)
    const second = await service.open('living-room', 'launch-new', 'cartoons', 2)
    expect(second.sessionId).not.toBe(first.sessionId)
    await expect(
      Promise.resolve().then(() =>
        service.tune(
          'living-room',
          'launch-old',
          first.sessionId,
          'nature',
          1
        )
      )
    ).rejects.toBeInstanceOf(VirtualTunerSessionNotFoundError)

    expect(
      await service.closeByClient(
        'living-room',
        'launch-old',
        first.sessionId
      )
    ).toBe('ignored')
    expect(service.descriptorForClient('living-room')?.sessionId).toBe(
      second.sessionId
    )
    expect(
      await service.closeByClient(
        'living-room',
        'launch-new',
        second.sessionId
      )
    ).toBe('closed')
  })

  test('orders owner takeovers by persisted launch epoch even across skipped launches', async () => {
    await service.open('living-room', 'launch-a', 'kids', 100)
    await service.open('living-room', 'launch-b', 'cartoons', 102)
    await expect(
      Promise.resolve().then(() =>
        service.open('living-room', 'launch-delayed', 'nature', 101)
      )
    ).rejects.toBeInstanceOf(VirtualTunerStaleRequestError)
    const latest = await service.open(
      'living-room',
      'launch-offline-skip',
      'nature',
      105
    )
    expect(latest.channelId).toBe('nature')
  })

  test('cancels and cleans an in-flight open closed by its exact owner', async () => {
    const gate = deferred<void>()
    const gatedFiles: VirtualTunerFiles = {
      prepareSession: (sessionId) => files.prepareSession(sessionId),
      async readChannelPlaylist(channelId) {
        await gate.promise
        return files.readChannelPlaylist(channelId)
      },
      preserveSegment: (...args) => files.preserveSegment(...args),
      removeSegment: (...args) => files.removeSegment(...args),
      removeSession: (...args) => files.removeSession(...args),
      segmentPath: (...args) => files.segmentPath(...args),
      segmentExists: (...args) => files.segmentExists(...args),
    }
    service = createService(gatedFiles)
    const opening = service.open('living-room', OWNER_ID, 'kids')
    await settle()
    const closing = service.closeByClient('living-room', OWNER_ID)
    gate.resolve()

    await expect(opening).rejects.toBeInstanceOf(VirtualTunerStaleRequestError)
    expect(await closing).toBe('closed')
    expect(service.descriptorForClient('living-room')).toBeNull()
    expect(releases.some((release) => release.channelId === 'kids')).toBe(true)
  })

  test('never returns ready when close races a tune after manifest commit begins', async () => {
    const removeGate = deferred<void>()
    const removeStarted = deferred<void>()
    let gateRemovals = false
    const gatedFiles: VirtualTunerFiles = {
      prepareSession: (sessionId) => files.prepareSession(sessionId),
      readChannelPlaylist: (channelId) => files.readChannelPlaylist(channelId),
      preserveSegment: (...args) => files.preserveSegment(...args),
      async removeSegment(...args) {
        if (gateRemovals) {
          removeStarted.resolve()
          await removeGate.promise
        }
        return files.removeSegment(...args)
      },
      removeSession: (...args) => files.removeSession(...args),
      segmentPath: (...args) => files.segmentPath(...args),
      segmentExists: (...args) => files.segmentExists(...args),
    }
    service = createService(gatedFiles, { retainedSegmentCount: 4 })
    const opened = await service.open('living-room', OWNER_ID, 'kids')
    for (const first of [3, 5, 7]) {
      writeChannel(sourceRoot, 'kids', first)
      await service.playlist(opened.sessionId)
    }
    gateRemovals = true
    const tuning = service.tune(
      'living-room',
      OWNER_ID,
      opened.sessionId,
      'cartoons',
      1
    )
    await removeStarted.promise
    const closing = service.closeByClient(
      'living-room',
      OWNER_ID,
      opened.sessionId
    )
    removeGate.resolve()

    await expect(tuning).rejects.toBeInstanceOf(
      VirtualTunerSessionNotFoundError
    )
    expect(await closing).toBe('closed')
    expect(service.descriptorForClient('living-room')).toBeNull()
  })

  test('stops serving a permanently stale edge and verifies same-channel health', async () => {
    service = createService(discontinuityAdapter(files), {
      staleEdgeGraceMs: 1_000,
    })
    const opened = await service.open('living-room', OWNER_ID, 'kids')

    await expect(
      service.tune(
        'living-room',
        OWNER_ID,
        opened.sessionId,
        'kids',
        1
      )
    ).rejects.toBeInstanceOf(VirtualTunerUnavailableError)

    clock.advance(1_001)
    await expect(service.playlist(opened.sessionId)).rejects.toBeInstanceOf(
      VirtualTunerUnavailableError
    )
  })

  test('restarts one hung live worker before accepting a recovered edge', async () => {
    let fresh = false
    let restarts = 0
    const recoveryFiles: VirtualTunerFiles = {
      prepareSession: (sessionId) => files.prepareSession(sessionId),
      readChannelPlaylist: (channelId) => files.readChannelPlaylist(channelId),
      preserveSegment: (...args) => files.preserveSegment(...args),
      removeSegment: (...args) => files.removeSegment(...args),
      removeSession: (...args) => files.removeSession(...args),
      segmentPath: (...args) => files.segmentPath(...args),
      segmentExists: (...args) => files.segmentExists(...args),
      sourcePresentationIsFresh: async () => fresh,
    }
    service = new VirtualTunerService(
      {
        async holdSession(channelId, leaseId) {
          holds.push({ channelId, leaseId })
          return state(channelId)
        },
        async whenReady(channelId) {
          return state(channelId)
        },
        refreshSession: () => true,
        async releaseSession() {},
        async restart(channelId) {
          restarts += 1
          fresh = true
          return state(channelId)
        },
      },
      recoveryFiles,
      () => ['kids'],
      {
        ttlMs: 30_000,
        playlistWindowSegments: 4,
        retainedSegmentCount: 8,
        readinessAttempts: 1,
        clock,
        sleep: async () => {},
      }
    )

    const opened = await service.open('living-room', OWNER_ID, 'kids')
    expect(opened.channelId).toBe('kids')
    expect(restarts).toBe(1)
  })

  test('caps unique sessions while allowing the existing client to replace its owner', async () => {
    service = createService(discontinuityAdapter(files), {
      maximumSessions: 1,
    })
    const first = await service.open('living-room', 'launch-old', 'kids', 1)
    await expect(
      Promise.resolve().then(() =>
        service.open('bedroom', 'launch-bedroom', 'cartoons')
      )
    ).rejects.toBeInstanceOf(VirtualTunerUnavailableError)
    const replacement = await service.open(
      'living-room',
      'launch-new',
      'cartoons',
      2
    )
    expect(replacement.sessionId).not.toBe(first.sessionId)
    expect(() => service.open('unsafe client!', OWNER_ID, 'kids')).toThrow(
      'not a safe virtual tuner identifier'
    )
  })

  test('rejects a stale app epoch and expires an idle session', async () => {
    const opened = await service.open('living-room', OWNER_ID, 'kids')
    await expect(
      Promise.resolve().then(() =>
        service.tune(
          'living-room',
          OWNER_ID,
          '00000000-0000-4000-8000-000000000000',
        'cartoons',
        1
        )
      )
    ).rejects.toBeInstanceOf(VirtualTunerSessionNotFoundError)

    clock.advance(30_001)
    await settle()
    expect(service.descriptorForClient('living-room')).toBeNull()
    expect(releases.some((release) => release.channelId === 'kids')).toBe(true)
    expect(await service.segmentPath(opened.sessionId, '../index.m3u8')).toBeNull()
  })

  test('an obsolete expiry callback cannot close a heartbeat-refreshed tuner', async () => {
    await service.open('living-room', OWNER_ID, 'kids')
    const obsolete = clock.timers.at(-1)!
    clock.advance(1_000)
    expect(service.refreshByClient('living-room')).toBe(true)

    obsolete.callback()
    await settle()
    expect(service.descriptorForClient('living-room')).not.toBeNull()

    clock.advance(30_001)
    await settle()
    expect(service.descriptorForClient('living-room')).toBeNull()
  })

  test('carries source discontinuities and rejects incomplete entries', () => {
    const parsed = parseSourcePlaylist(
      '#EXTM3U\n#EXT-X-TARGETDURATION:2\n' +
        '#EXT-X-MEDIA-SEQUENCE:42\n' +
        '#EXT-X-DISCONTINUITY\n#EXTINF:1.5,\nsegment-0000000000001.ts\n'
    )
    expect(parsed.targetDurationSeconds).toBe(2)
    expect(parsed.segments).toEqual([
      {
        sourceName: 'segment-0000000000001.ts',
        sourceSequence: 42,
        durationSeconds: 1.5,
        discontinuityBefore: true,
      },
    ])
    expect(() => parseSourcePlaylist('not an hls playlist')).toThrow(
      'torn or malformed'
    )
    expect(() =>
      parseSourcePlaylist(
        '#EXTM3U\n#EXTINF:1,\nsegment-0000000000001.ts\n#EXTINF:1,\n'
      )
    ).toThrow('dangling EXTINF')
    expect(() =>
      parseSourcePlaylist('#EXTM3U\n#EXTINF:1,\nmissing-or-unsafe.ts\n')
    ).toThrow('unsafe media URI')
  })

  test('removes only validated orphan session directories on startup', async () => {
    const orphan = '11111111-1111-4111-8111-111111111111'
    const unrelated = join(tunerRoot, 'keep-me')
    mkdirSync(join(tunerRoot, orphan), { recursive: true })
    mkdirSync(unrelated, { recursive: true })
    writeFileSync(join(tunerRoot, orphan, 'old'), 'old')
    await files.cleanupOrphanSessions()
    await expect(stat(join(tunerRoot, orphan))).rejects.toThrow()
    expect((await stat(unrelated)).isDirectory()).toBe(true)
  })
})

function writeChannel(
  root: string,
  channelId: string,
  first: number,
  count = 2
): void {
  const directory = join(root, channelId, 'live')
  mkdirSync(directory, { recursive: true })
  const names = Array.from({ length: count }, (_, index) => first + index).map(
    (value) => `segment-${String(value).padStart(13, '0')}.ts`
  )
  for (const [index, name] of names.entries()) {
    writeFileSync(join(directory, name), `${channelId}-${first + index}`)
  }
  writeFileSync(
    join(directory, 'index.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:1\n' +
      names.map((name) => `#EXTINF:1.0,\n${name}\n`).join('')
  )
}

function writeCustomChannel(
  root: string,
  channelId: string,
  first: number,
  durations: readonly number[],
  targetDuration: number
): void {
  const directory = join(root, channelId, 'live')
  mkdirSync(directory, { recursive: true })
  const names = durations.map(
    (_, index) =>
      `segment-${String(first + index).padStart(13, '0')}.ts`
  )
  for (const [index, name] of names.entries()) {
    writeFileSync(join(directory, name), `${channelId}-${first + index}`)
  }
  writeFileSync(
    join(directory, 'index.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:6\n' +
      `#EXT-X-TARGETDURATION:${targetDuration}\n` +
      `#EXT-X-MEDIA-SEQUENCE:${first}\n` +
      names
        .map((name, index) => `#EXTINF:${durations[index]},\n${name}\n`)
        .join('')
  )
}
