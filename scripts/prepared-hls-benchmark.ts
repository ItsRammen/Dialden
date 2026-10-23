import { mkdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { prepare, commandFor, run, parseSegments, type Clip } from './prepared-hls-prototype'
const [config,rawRoot] = Bun.argv.slice(2)
if (!config || !rawRoot) throw new Error('Usage: bun scripts/prepared-hls-benchmark.ts clips.json output-dir')
const root=resolve(rawRoot), clips: Clip[]=await Bun.file(config).json()
await mkdir(root,{recursive:true})
let start=performance.now()
const cache=await prepare(clips,join(root,'cache'))
const preparationMs=performance.now()-start
const bytes=(await Promise.all(cache.index.segments.map(s=>stat(join(cache.directory,s.name))))).reduce((sum,s)=>sum+s.size,0)
const results: object[]=[]
async function decode(url: string) {
 const begin=performance.now()
 await run(['ffmpeg','-nostdin','-hide_banner','-v','error','-threads','2','-i',url,'-map','0:v:0','-frames:v','1','-an','-f','null','-'],30_000)
 return performance.now()-begin
}
for(let trial=0;trial<3;trial++) {
 // New serving process each trial; cached files survive across app/server boots.
 start=performance.now()
 const proc=Bun.spawn([process.execPath,join(import.meta.dir,'prepared-hls-prototype.ts'),'serve',cache.directory],{env:{...process.env,PORT:'0',PROTOTYPE_EPOCH_MS:String(Date.now()-8000)},stdout:'pipe',stderr:'pipe'})
 const errors=new Response(proc.stderr).text()
 try {
  const reader=proc.stdout.getReader();let text=''
  const timer=setTimeout(()=>proc.kill('SIGKILL'),30_000)
  try {while(!text.includes('\n')) {const next=await reader.read();if(next.done)throw new Error('Server failed to boot');text+=new TextDecoder().decode(next.value)}} finally {clearTimeout(timer);reader.releaseLock()}
  const url=text.match(/http:\/\/[^\s;]+/)?.[0];if(!url)throw new Error(text)
  const body=await (await fetch(url)).text(),playlistMs=performance.now()-start
  const segment=body.split('\n').find(line=>line.startsWith('/segments/'));if(!segment)throw new Error(body)
  const response=await fetch(new URL(segment,url));if(!response.ok)throw new Error('Segment unavailable');await response.arrayBuffer()
  const firstSegmentMs=performance.now()-start
  const decodedMs=await decode(url)
  results.push({mode:'prepared-new-process',trial,playlistMs,firstSegmentMs,decoderOpenToFirstFrameMs:decodedMs,totalBootToFirstFrameMs:firstSegmentMs+decodedMs})
 } finally {proc.kill('SIGTERM');await proc.exited;const error=await errors;if(error)console.error(error)}
}
for(let trial=0;trial<3;trial++) {
 const directory=join(root,`paced-${crypto.randomUUID()}`);await mkdir(directory)
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  const name=new URL(request.url).pathname.slice(1)
  if(name!=='index.m3u8'&&!/^segment-\d+\.ts$/.test(name))return new Response(null,{status:404})
  if(name==='index.m3u8') {
   const deadline=Date.now()+20_000
   while(Date.now()<deadline) {try {const body=await Bun.file(join(directory,name)).text();if(parseSegments(body).length>=2)return new Response(body,{headers:{'Content-Type':'application/vnd.apple.mpegurl'}})} catch{}await Bun.sleep(20)}
   return new Response('Not ready',{status:503})
  }
  return new Response(Bun.file(join(directory,name)))
 }})
 start=performance.now()
 const command=await commandFor(clips,directory,true)
 const probeMs=performance.now()-start
 const proc=Bun.spawn(command,{stdout:'ignore',stderr:'pipe'});const errors=new Response(proc.stderr).text()
 try {
  const url=new URL('index.m3u8',server.url).href
  const response=await fetch(url);const text=await response.text();if(!response.ok)throw new Error(text)
  const playlistMs=performance.now()-start
  const name=parseSegments(text)[0]!.name
  await (await fetch(new URL(name,server.url))).arrayBuffer()
  const firstSegmentMs=performance.now()-start
  const decodedMs=await decode(url)
  results.push({mode:'paced-software-cold',trial,probeMs,playlistMs,firstSegmentMs,decoderOpenToFirstFrameMs:decodedMs,totalBootToFirstFrameMs:firstSegmentMs+decodedMs})
 } finally {proc.kill('SIGTERM');await proc.exited;await errors;server.stop(true)}
}
// Decode the complete prepared block and inspect timestamps through both cuts.
const streamInfo=JSON.parse(await run(['ffprobe','-v','error','-show_streams','-of','json',join(cache.directory,'index.m3u8')]))
await run(['ffmpeg','-nostdin','-v','error','-threads','2','-i',join(cache.directory,'index.m3u8'),'-f','null','-'])
const frames=JSON.parse(await run(['ffprobe','-v','error','-select_streams','v:0','-show_entries','frame=best_effort_timestamp_time','-of','json',join(cache.directory,'index.m3u8')])).frames
const times=frames.map((f: {best_effort_timestamp_time:string})=>Number(f.best_effort_timestamp_time))
let maxFrameGap=0
for(let i=1;i<times.length;i++){const gap=times[i]-times[i-1];if(gap<=0)throw new Error('Non-monotonic video');maxFrameGap=Math.max(maxFrameGap,gap)}
const audioFrames=JSON.parse(await run(['ffprobe','-v','error','-select_streams','a:0','-show_entries','frame=best_effort_timestamp_time,nb_samples,sample_rate','-of','json',join(cache.directory,'index.m3u8')])).frames
let maxAudioGap=0
for(let i=1;i<audioFrames.length;i++){const prev=audioFrames[i-1],now=audioFrames[i];maxAudioGap=Math.max(maxAudioGap,Math.abs(Number(now.best_effort_timestamp_time)-Number(prev.best_effort_timestamp_time)-Number(prev.nb_samples)/48000))}
if (maxFrameGap > 0.035 || maxAudioGap > 0.002) throw new Error('Unexpected decoded timestamp gap')
const report={note:'Local software FFmpeg/HTTP benchmark; process-cold, not OS page-cache-cold, not LG first-picture measurement. Timings exclude ahead-of-time preparation. No production channel changes.',preparationMs,cacheReused:cache.reused,cacheBytes:bytes,durationSeconds:cache.index.duration,clipBoundariesSeconds:clips.map((_,i)=>clips.slice(0,i+1).reduce((sum,c)=>sum+c.seconds,0)),streams:streamInfo.streams.map((s:any)=>({codec:s.codec_name,width:s.width,height:s.height,sampleRate:s.sample_rate,channels:s.channels})),videoFrames:times.length,maxFrameGapSeconds:maxFrameGap,maxAudioGapSeconds:maxAudioGap,results}
await Bun.write(join(root,'report.json'),JSON.stringify(report,null,2))
console.log(JSON.stringify(report,null,2))
