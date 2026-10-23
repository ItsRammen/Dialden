import { randomUUID } from 'node:crypto'
import { copyFile, link, mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChannelPipelineFactory, ChannelPipelineHandle, ChannelPipelineExit, ChannelPipelineRequest, ChannelTimelineResolver } from './ContinuousChannelWorkerManager'
import { parseSourcePlaylist, renderVirtualPlaylist } from './VirtualTunerService'

interface Batch {
  directory: string
  request: ChannelPipelineRequest
  handle: ChannelPipelineHandle
  exit?: ChannelPipelineExit
  lastSourceSequence: number
  boundary: boolean
}

/** One public manifest writer; encoders only ever write into private batches. */
export class LookaheadChannelPipelineFactory implements ChannelPipelineFactory {
  constructor(
    private readonly encoder: ChannelPipelineFactory,
    private readonly timeline: ChannelTimelineResolver,
    private readonly options: { leadMs?: number; pollMs?: number; readyTimeoutMs?: number } = {}
  ) {}

  async start(request: ChannelPipelineRequest): Promise<ChannelPipelineHandle> {
    if (!this.timeline.resolveWindow || request.timelineStartMs === undefined ||
        !request.sequence.length || request.sequence.some(item => !item.sourceDurationSeconds || item.sourceDurationSeconds <= 0 || !Number.isFinite(item.sourceDurationSeconds))) {
      return this.encoder.start(request)
    }
    const root = join(request.outputDirectory, `.lookahead-${randomUUID()}`)
    await mkdir(root, { recursive: true })
    let stopped = false
    let batchNumber = 0
    let active: Batch | undefined
    let preparing: Promise<Batch | null> | undefined
    const batches = new Set<Batch>()
    const pollMs = this.options.pollMs ?? 100
    const sleep = () => new Promise<void>(resolve => setTimeout(resolve, pollMs))
    const entries: { sequence: number; outputName: string; durationSeconds: number; discontinuityBefore: boolean }[] = []
    const retired: string[] = []
    let sequence = Date.now()
    let discontinuities = 0
    let targetDuration = Math.max(1, Math.ceil(request.profile.segmentSeconds))
    if (request.appendToExistingPlaylist) {
      try {
        const previous = await readFile(request.playlistPath, 'utf8')
        const parsed = parseSourcePlaylist(previous)
        discontinuities = Number(previous.match(/#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/)?.[1] ?? 0)
        targetDuration = Math.max(targetDuration, parsed.targetDurationSeconds)
        for (const item of parsed.segments) entries.push({
          sequence: item.sourceSequence, outputName: item.sourceName,
          durationSeconds: item.durationSeconds, discontinuityBefore: item.discontinuityBefore,
        })
        if (entries.length) sequence = entries.at(-1)!.sequence + 1
      } catch { /* No usable prior output on a cold recovery. */ }
    }
    const spawn = async (next: ChannelPipelineRequest): Promise<Batch> => {
      const directory = join(root, String(batchNumber++))
      await mkdir(directory, { recursive: true })
      if (stopped) throw new Error('Channel stopped during preparation')
      const handle = await this.encoder.start({ ...next, outputDirectory: directory,
        playlistPath: join(directory, 'index.m3u8'), appendToExistingPlaylist: false })
      const batch: Batch = { directory, request: next, handle, lastSourceSequence: -1,
        boundary: entries.length > 0 }
      batches.add(batch)
      void handle.completed.then(exit => { batch.exit = exit })
      if (stopped) { await handle.stop(); throw new Error('Channel stopped during preparation') }
      return batch
    }
    const publish = async (batch: Batch) => {
      let parsed
      try { parsed = parseSourcePlaylist(await readFile(join(batch.directory, 'index.m3u8'), 'utf8')) }
      catch { return }
      let changed = false
      for (const item of parsed.segments) {
        if (item.sourceSequence <= batch.lastSourceSequence) continue
        const source = join(batch.directory, item.sourceName)
        const info = await stat(source)
        if (!info.isFile() || info.size === 0) throw new Error('Prepared segment is empty')
        const outputName = `segment-${String(sequence).padStart(13, '0')}.ts`
        const destination = join(request.outputDirectory, outputName)
        try { await link(source, destination) }
        catch (error) {
          if (!['EXDEV', 'EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
          await copyFile(source, destination)
        }
        entries.push({ sequence: sequence++, outputName, durationSeconds: item.durationSeconds,
          discontinuityBefore: batch.boundary || item.discontinuityBefore ||
            (batch.lastSourceSequence >= 0 && item.sourceSequence !== batch.lastSourceSequence + 1) })
        batch.boundary = false
        batch.lastSourceSequence = item.sourceSequence
        changed = true
      }
      if (!changed || stopped) return
      while (entries.length > request.profile.playlistWindowSegments) {
        const removed = entries.shift()!
        if (removed.discontinuityBefore) discontinuities++
        retired.push(removed.outputName)
      }
      targetDuration = Math.max(targetDuration, parsed.targetDurationSeconds,
        ...entries.map(item => Math.ceil(item.durationSeconds)))
      const temporary = join(root, 'public.m3u8.tmp')
      await writeFile(temporary, renderVirtualPlaylist(entries, discontinuities, targetDuration))
      if (!stopped) await rename(temporary, request.playlistPath)
      // The wrapper can run indefinitely: public hard links must not retain
      // every old segment after FFmpeg deletes its private copy. Keep a grace
      // window for clients still fetching the preceding manifest.
      while (retired.length > Math.max(32, request.profile.playlistWindowSegments * 2)) {
        await unlink(join(request.outputDirectory, retired.shift()!)).catch(() => {})
      }
    }
    const prepare = async (current: Batch): Promise<Batch | null> => {
      let candidate: Batch | undefined
      try {
        const duration = current.request.sequence.reduce((sum, item) => sum + item.sourceDurationSeconds!, 0)
        const at = current.request.timelineStartMs! + Math.round(duration * 1000)
        const next = await this.timeline.resolveWindow!(request.channelId, new Date(at), 3)
        if (stopped || !next.length || next.some(item => !item.sourceDurationSeconds || item.sourceDurationSeconds <= 0 ||
          !Number.isFinite(item.sourceDurationSeconds) || item.timelineRevision !== request.position.timelineRevision)) return null
        candidate = await spawn({ ...request, timelineStartMs: at, position: next[0]!, sequence: next })
        if (!candidate.handle.suspend || !candidate.handle.resume) throw new Error('Encoder cannot stage output')
        const deadline = Date.now() + (this.options.readyTimeoutMs ?? 30000)
        while (!stopped && Date.now() < deadline) {
          if (candidate.exit && candidate.exit.code !== 0) throw new Error('Prepared encoder failed')
          try {
            const parsed = parseSourcePlaylist(await readFile(join(candidate.directory, 'index.m3u8'), 'utf8'))
            if (parsed.segments.length >= 3 || (candidate.exit?.code === 0 && parsed.segments.length > 0)) {
              for (const segment of parsed.segments) {
                if ((await stat(join(candidate.directory, segment.sourceName))).size === 0) throw new Error('Empty prepared segment')
              }
              candidate.handle.suspend()
              console.info('Channel handoff prepared', JSON.stringify({ channelId: request.channelId, at, segments: parsed.segments.length }))
              return candidate
            }
          } catch { /* A playlist can be observed during a muxer rewrite. */ }
          await sleep()
        }
      } catch (error) {
        if (!stopped) console.warn('Channel handoff preparation failed', JSON.stringify({
          channelId: request.channelId, error: error instanceof Error ? error.message : 'failed',
        }))
      }
      if (candidate) {
        await Promise.allSettled([Promise.resolve().then(() => candidate!.handle.stop())])
        batches.delete(candidate)
        await rm(candidate.directory, { recursive: true, force: true }).catch(() => {})
      }
      return null
    }
    try { active = await spawn(request) }
    catch (error) { await rm(root, { recursive: true, force: true }); throw error }
    const run = async (): Promise<ChannelPipelineExit> => {
      let started = Date.now()
      try {
        while (!stopped && active) {
          await publish(active)
          const durationMs = active.request.sequence.reduce((sum, item) => sum + item.sourceDurationSeconds! * 1000, 0)
          if (!preparing && Date.now() - started >= Math.max(0, durationMs - (this.options.leadMs ?? 30000))) {
            preparing = prepare(active)
          }
          if (active.exit) {
            if (active.exit.code !== 0) return active.exit
            // Publish the completed batch's last segment before its successor.
            await publish(active)
            const next = await (preparing ?? prepare(active))
            if (stopped || !next) return { code: 0 }
            if (next.exit && next.exit.code !== 0) return next.exit
            const previous = active
            active = next
            active.boundary = entries.length > 0
            preparing = undefined
            started = Date.now()
            active.handle.resume!()
            await publish(active)
            batches.delete(previous)
            await rm(previous.directory, { recursive: true, force: true })
            console.info('Channel handoff committed', JSON.stringify({ channelId: request.channelId }))
            continue
          }
          await sleep()
        }
        return { code: 0 }
      } catch (error) {
        return { code: 1, error: `Channel handoff publisher: ${error instanceof Error ? error.message : 'failed'}` }
      } finally {
        stopped = true
        await Promise.allSettled([...batches].map(batch => batch.handle.stop()))
        await preparing?.catch(() => {})
        await rm(root, { recursive: true, force: true }).catch(() => {})
      }
    }
    const completed = run()
    return {
      get pid() { return active?.handle.pid },
      completed,
      stop: async () => {
        stopped = true
        await Promise.allSettled([...batches].map(batch => batch.handle.stop()))
        await completed
      },
    }
  }
}
