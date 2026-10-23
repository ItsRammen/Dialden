import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MediaStillService } from '../src/services/MediaStillService'
import { createMediaStillController } from '../src/controllers/MediaStillController'
import type { MediaDeliveryService, ResolvedMediaFile } from '../src/services/MediaDeliveryService'
const dirs: string[]=[]
afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})))})
async function directory(){const dir=await mkdtemp(join(tmpdir(),'dialden-still-'));dirs.push(dir);return dir}
const file: ResolvedMediaFile={path:'/media/example.mp4',size:100,mimeType:'video/mp4',lastModified:new Date(1000)}

test('deduplicates generation, bounds concurrency and reuses disk cache',async()=>{
 const dir=await directory();let calls=0;let release!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve})
 const service=new MediaStillService(dir,async(_,output)=>{calls++;await gate;await writeFile(output,'jpeg');return true})
 expect(await service.request(file)).toBeNull()
 expect(await service.request(file)).toBeNull()
 expect(await service.request({...file,path:'/other.mp4'})).toBeNull()
 release();await service.idle();expect(calls).toBe(1)
 const first=await service.request(file);expect(first).not.toBeNull()
 const fresh=new MediaStillService(dir,async()=>{throw new Error('Should use disk cache')})
 expect(await fresh.request(file)).toEqual(first)
})

test('source changes invalidate the still; failures are cooled down',async()=>{
 const dir=await directory();let calls=0
 const service=new MediaStillService(dir,async(_,output)=>{calls++;await writeFile(output,'jpeg');return true})
 await service.request(file);await service.idle();const first=await service.request(file)
 const changed={...file,lastModified:new Date(2000)}
 expect(await service.request(changed)).toBeNull();await service.idle()
 expect((await service.request(changed))?.etag).not.toBe(first?.etag);expect(calls).toBe(2)
 let failures=0;const broken=new MediaStillService(await directory(),async()=>{failures++;return false})
 await broken.request(file);await broken.idle();await broken.request(file);await broken.idle();expect(failures).toBe(1)
})

test('endpoint checks eligibility, reports pending and supports conditional JPEG requests',async()=>{
 const service=new MediaStillService(await directory(),async(_,out)=>{await writeFile(out,Buffer.from([255,216,255,217]));return true})
 let allowed=true;let resolves=0
 const media={resolve:async()=>{resolves++;return allowed?file:null}} as unknown as MediaDeliveryService
 const app=createMediaStillController({media,stills:service})
 expect((await app.request('/api/v1/media/0/still')).status).toBe(400);expect(resolves).toBe(0)
 allowed=false;expect((await app.request('/api/v1/media/1/still')).status).toBe(404)
 allowed=true;const pending=await app.request('/api/v1/media/1/still');expect(pending.status).toBe(202);expect(pending.headers.get('Retry-After')).toBe('5')
 await service.idle();const image=await app.request('/api/v1/media/1/still');expect(image.status).toBe(200);expect(image.headers.get('Content-Type')).toBe('image/jpeg')
 expect((await app.request('/api/v1/media/1/still',{headers:{'If-None-Match':image.headers.get('ETag')!}})).status).toBe(304)
 allowed=false;expect((await app.request('/api/v1/media/1/still')).status).toBe(404)
})

test('real ffmpeg generates a JPEG for a clip shorter than the preferred seek',async()=>{
 const dir=await directory();const input=join(dir,'short.mp4')
 const proc=Bun.spawn(['ffmpeg','-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=160x90:d=1','-c:v','mpeg4','-y',input],{stdout:'ignore',stderr:'pipe'})
 expect(await proc.exited).toBe(0)
 const service=new MediaStillService(join(dir,'cache'))
 await service.request({...file,path:input});await service.idle()
 const result=await service.request({...file,path:input});expect(result).not.toBeNull()
 const bytes=new Uint8Array(await Bun.file(result!.path).arrayBuffer());expect([...bytes.slice(0,2)]).toEqual([255,216])
 const probe=Bun.spawn(['ffprobe','-v','error','-show_entries','stream=width,height','-of','csv=p=0',result!.path],{stdout:'pipe'})
 expect((await new Response(probe.stdout).text()).trim()).toBe('1920,1080');expect(await probe.exited).toBe(0)
},20000)
