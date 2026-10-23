import {serve,run,type Index} from './prepared-hls-prototype'
const root=Bun.argv[2]
if(!root)throw new Error('Usage: bun scripts/prepared-hls-loop-check.ts benchmark-output-dir')
const glob=new Bun.Glob('cache/*/prepared.json')
const path=[...glob.scanSync(root)][0]!
const directory=root+'/'+path.replace('/prepared.json','')
const index: Index=await Bun.file(root+'/'+path).json()
const server=serve(directory,index,Date.now()-(index.duration-2)*1000)
try {
 const out=root+'/loop-capture.mkv'
 await run(['ffmpeg','-nostdin','-hide_banner','-v','error','-i',new URL('live/index.m3u8',server.url).href,'-t','8','-c','copy','-y',out],30_000)
 await run(['ffmpeg','-nostdin','-v','error','-xerror','-i',out,'-f','null','-'])
 const data=JSON.parse(await run(['ffprobe','-v','error','-select_streams','v:0','-show_entries','frame=best_effort_timestamp_time','-of','json',out]))
 const times=data.frames.map((f:any)=>Number(f.best_effort_timestamp_time));let maxGap=0
 for(let i=1;i<times.length;i++) {const gap=times[i]-times[i-1];if(gap<=0)throw new Error('Nonmonotonic wrap');maxGap=Math.max(gap,maxGap)}
 if(maxGap>0.04)throw new Error('Gap across loop: '+maxGap)
 const audio=JSON.parse(await run(['ffprobe','-v','error','-select_streams','a:0','-show_entries','frame=best_effort_timestamp_time,nb_samples','-of','json',out])).frames
 let audioGap=0,audioOverlap=0
 for(let i=1;i<audio.length;i++) {
  const delta=Number(audio[i].best_effort_timestamp_time)-Number(audio[i-1].best_effort_timestamp_time)-Number(audio[i-1].nb_samples)/48000
  audioGap=Math.max(audioGap,delta);audioOverlap=Math.max(audioOverlap,-delta)
 }
 const report={loopBoundaryDecoded:true,frames:times.length,maxVideoGapSeconds:maxGap,captureSeconds:8,maxAudioGapSeconds:audioGap,maxAudioOverlapSeconds:audioOverlap,productionReady:audioOverlap<0.002}

 await Bun.write(root+'/loop-report.json',JSON.stringify(report,null,2));console.log(report)
}finally{server.stop(true)}
