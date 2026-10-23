/** Isolated prototype. No production routes, database, or channel changes. */
import { createHash } from 'node:crypto'
import { mkdir, stat, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { FfmpegContinuousHlsPipelineFactory } from '../src/services/FfmpegContinuousHlsPipelineFactory'
import type { ChannelTimelinePosition, ChannelPipelineRequest } from '../src/services/ContinuousChannelWorkerManager'

export interface Clip { path: string; seconds: number; offset?: number; label: string }
export interface Segment { name: string; seconds: number; start: number }
export interface Index { version: 1; key: string; duration: number; segments: Segment[]; clips: Clip[] }
const PROFILE = { videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2, segmentSeconds: 1, playlistWindowSegments: 8, maximumWidth: 1920, maximumHeight: 1080 } as const
export async function run(command: string[], timeout = 120_000): Promise<string> {
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
  try {
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (code !== 0) throw new Error(`${command[0]} exited ${code}: ${error.slice(-4000)}`)
    return out
  } finally { clearTimeout(timer) }
}
export function parseSegments(text: string): Segment[] {
  const rows = text.split(/\r?\n/), result: Segment[] = []
  let duration: number | undefined, start = 0
  for (const row of rows) {
    if (row.startsWith('#EXTINF:')) { if (duration !== undefined) throw new Error('Torn segment entry'); duration = Number(row.slice(8).split(',')[0]) }
    else if (row && !row.startsWith('#')) {
      if (!/^segment-\d+\.ts$/.test(row) || !duration || !Number.isFinite(duration) || duration <= 0) throw new Error('Invalid segment index')
      result.push({ name: row, seconds: duration, start }); start += duration; duration = undefined
    }
  }
  if (duration !== undefined || result.length < 2) throw new Error('Incomplete prepared block')
  return result
}
export async function commandFor(clips: Clip[], output: string, paced: boolean): Promise<string[]> {
  const sequence: ChannelTimelinePosition[] = []
  for (const [i, clip] of clips.entries()) {
    if (!Number.isFinite(clip.seconds) || clip.seconds <= 0 || !Number.isFinite(clip.offset ?? 0) || (clip.offset ?? 0) < 0) throw new Error('Invalid clip range')
    const info = JSON.parse(await run(['ffprobe','-v','error','-show_streams','-show_format','-of','json',clip.path],30_000))
    if (!info.streams.some((s: { codec_type: string }) => s.codec_type === 'video')) throw new Error('Clip has no video')
    if (Number(info.format.duration) + 0.05 < (clip.offset ?? 0) + clip.seconds) throw new Error('Clip range exceeds source duration')
    sequence.push({ scheduleItemId: String(i), sourcePath: clip.path, sourceOffsetSeconds: clip.offset ?? 0, sourceDurationSeconds: clip.seconds, hasAudio: info.streams.some((s: { codec_type: string }) => s.codec_type === 'audio'), audioStreamIndex: 0, timelineRevision: 'prototype', type: i === 1 ? 'bumper' : 'program' })
  }
  if (!sequence.length) throw new Error('No clips')
  const request: ChannelPipelineRequest = { channelId:'prepared-prototype',outputDirectory:output,playlistPath:join(output,'index.m3u8'),playlistUrl:'/live/index.m3u8',position:sequence[0]!,sequence,profile:PROFILE,appendToExistingPlaylist:false }
  const command = new FfmpegContinuousHlsPipelineFactory().command(request)
  // Same normalization and encoder as the production software path. Only
  // pacing and finite cache retention differ in the ahead-of-time render.
  command.splice(1,0,'-filter_complex_threads','2')
  command.splice(command.indexOf('-c:v'),0,'-threads','2')
  if (!paced) {
    const graph = command.indexOf('-filter_complex') + 1
    command[graph] = command[graph]!.replaceAll('arealtime=speed=1','anull').replaceAll('realtime=speed=1','null')
    command[command.indexOf('-hls_list_size')+1] = '0'
    command[command.indexOf('-hls_flags')+1] = 'independent_segments+temp_file'
  } else command[command.indexOf('-hls_flags')+1] = 'independent_segments+omit_endlist+temp_file'
  return command
}
export async function prepare(clips: Clip[], root: string): Promise<{ directory: string; index: Index; reused: boolean }> {
  const stamps = await Promise.all(clips.map(async c => { const s = await stat(c.path); return [resolve(c.path),s.size,s.mtimeMs,c.offset ?? 0,c.seconds] }))
  const ffmpeg = (await run(['ffmpeg','-version'])).split('\n')[0]
  const key = createHash('sha256').update(JSON.stringify([1,PROFILE,stamps,ffmpeg])).digest('hex')
  const directory = join(root,key), manifest = join(directory,'prepared.json')
  if (await Bun.file(manifest).exists()) {
    const index: Index = await Bun.file(manifest).json()
    if (index.key !== key || !index.segments.length) throw new Error('Invalid cache index')
    for (const segment of index.segments) if (!(await Bun.file(join(directory,segment.name)).size)) throw new Error('Incomplete cache; prepare in a new directory')
    return { directory, index, reused:true }
  }
  await mkdir(root,{recursive:true})
  const stage = join(root,`.pending-${crypto.randomUUID()}`)
  await mkdir(stage)
  try {
    await run(await commandFor(clips,stage,false),600_000)
    const segments = parseSegments(await Bun.file(join(stage,'index.m3u8')).text())
    const duration = segments.reduce((sum,s) => sum+s.seconds,0)
    const index: Index = { version:1,key,duration,segments,clips }
    await Bun.write(join(stage,'prepared.json'),JSON.stringify(index,null,2))
    await rename(stage,directory)
    return { directory,index,reused:false }
  } finally { await rm(stage,{recursive:true,force:true}) }
}
/** Only completed segments are visible, never the whole future schedule. */
export function liveManifest(index: Index, epoch: number, now: number): string | null {
  const elapsed = (now-epoch)/1000
  if (elapsed < 0) return null
  const cycle = Math.floor(elapsed/index.duration), local = elapsed-cycle*index.duration
  const count = index.segments.length
  const completed = index.segments.filter(s => s.start+s.seconds <= local+1e-7).length
  const end = cycle*count+completed, first = Math.max(0,end-8)
  if (end-first < 2) return null
  const lines = ['#EXTM3U','#EXT-X-VERSION:6',`#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...index.segments.map(s=>s.seconds)))}`,`#EXT-X-MEDIA-SEQUENCE:${first}`,`#EXT-X-DISCONTINUITY-SEQUENCE:${Math.floor(first/count)}`,'#EXT-X-INDEPENDENT-SEGMENTS','#EXT-X-START:TIME-OFFSET=-2.0,PRECISE=YES']
  for (let n=first;n<end;n++) {
    const segment = index.segments[n%count]!
    if (n>first && n%count===0) lines.push('#EXT-X-DISCONTINUITY')
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(epoch+(Math.floor(n/count)*index.duration+segment.start)*1000).toISOString()}`,`#EXTINF:${segment.seconds.toFixed(6)},`,`/segments/${index.key}/${segment.name}`)
  }
  return lines.join('\n')+'\n'
}
export function serve(directory: string, index: Index, epoch: number, port=0, hostname='127.0.0.1') {
  const names = new Set(index.segments.map(s=>s.name))
  return Bun.serve({ hostname,port,fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/live/index.m3u8') {
      const text = liveManifest(index,epoch,Date.now())
      return new Response(text ?? 'Preparing clock window',{status:text?200:503,headers:{'Content-Type':'application/vnd.apple.mpegurl','Cache-Control':'no-store','Retry-After':'1'}})
    }
    const prefix = `/segments/${index.key}/`, name = url.pathname.slice(prefix.length)
    if (url.pathname.startsWith(prefix) && names.has(name)) return new Response(Bun.file(join(directory,name)),{headers:{'Content-Type':'video/mp2t','Cache-Control':'public,max-age=31536000,immutable'}})
    return new Response('Not found',{status:404})
  }})
}
if (import.meta.main) {
  const [mode,config,root] = Bun.argv.slice(2)
  if (mode==='prepare' && config && root) console.log(JSON.stringify(await prepare(await Bun.file(config).json(),resolve(root)),null,2))
  else if (mode==='serve' && config) {
    const directory = resolve(config), index: Index = await Bun.file(join(directory,'prepared.json')).json()
    const epoch = Number(process.env.PROTOTYPE_EPOCH_MS ?? Date.now()-3000)
    const server = serve(directory,index,epoch,Number(process.env.PORT ?? 1994),process.env.HOST ?? '127.0.0.1')
    console.log(`Prepared prototype: ${server.url}live/index.m3u8; epoch=${epoch}`)
  } else throw new Error('Usage: bun scripts/prepared-hls-prototype.ts prepare clips.json cache-dir | serve prepared-dir')
}
