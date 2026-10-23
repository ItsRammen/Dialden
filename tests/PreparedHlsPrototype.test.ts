import { expect, test } from 'bun:test'
import { liveManifest, parseSegments, type Index } from '../scripts/prepared-hls-prototype'
const index: Index = {version:1,key:'abc',duration:4,clips:[],segments:[
 {name:'segment-1.ts',seconds:1,start:0},{name:'segment-2.ts',seconds:1,start:1},
 {name:'segment-3.ts',seconds:1,start:2},{name:'segment-4.ts',seconds:1,start:3},
]}
test('only publishes completed media and retains two-segment readiness',()=>{
 expect(liveManifest(index,0,-1)).toBeNull()
 expect(liveManifest(index,0,1999)).toBeNull()
 const text=liveManifest(index,0,2000)!
 expect(text).toContain('#EXT-X-MEDIA-SEQUENCE:0\n')
 expect(text).toContain('/segments/abc/segment-2.ts')
 expect(text).not.toContain('/segments/abc/segment-3.ts')
 expect(text).not.toContain('#EXT-X-ENDLIST')
})
test('rolling sequence and discontinuity count survive the block boundary',()=>{
 const text=liveManifest(index,0,11000)!
 expect(text).toContain('#EXT-X-MEDIA-SEQUENCE:3\n')
 expect(text).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:0\n')
 expect(text.split('\n').filter(l=>l==='#EXT-X-DISCONTINUITY').length).toBe(2)
 expect(text).toContain('#EXT-X-PROGRAM-DATE-TIME:1970-01-01T00:00:10.000Z')
 const advanced=liveManifest(index,0,12000)!
 expect(advanced).toContain('#EXT-X-MEDIA-SEQUENCE:4\n')
 expect(advanced).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:1\n')
 expect(advanced.split('\n').filter(l=>l==='#EXT-X-DISCONTINUITY').length).toBe(1)
})
test('same schedule epoch produces identical playback position after a process restart',()=>{
 const text=liveManifest(JSON.parse(JSON.stringify(index)),100000,112000)!
 expect(text).toContain('#EXT-X-MEDIA-SEQUENCE:4\n')
 expect(text).toContain('#EXT-X-PROGRAM-DATE-TIME:1970-01-01T00:01:44.000Z')
})
test('fractional final segment keeps the cycle on the actual media duration',()=>{
 const fractional: Index={...index,duration:2.5,segments:index.segments.slice(0,3).map((s,i)=>({...s,seconds:i===2?0.5:1}))}
 const text=liveManifest(fractional,0,4500)!
 expect(text).toContain('#EXTINF:0.500000,')
 expect(text).toContain('#EXT-X-PROGRAM-DATE-TIME:1970-01-01T00:00:02.500Z')
 expect(text.split('\n').filter(l=>l.startsWith('/segments/')).length).toBe(5)
})
test('rejects incomplete or unsafe FFmpeg segment indexes',()=>{
 expect(()=>parseSegments('#EXTM3U\n#EXTINF:1,\n../escape.ts\n')).toThrow()
 expect(()=>parseSegments('#EXTM3U\n#EXTINF:1,\n#EXTINF:1,\nsegment-1.ts\n')).toThrow()
 expect(()=>parseSegments('#EXTM3U\n#EXTINF:NaN,\nsegment-1.ts\n')).toThrow()
 expect(()=>parseSegments('#EXTM3U\n#EXTINF:1,\nsegment-1.ts\n#EXTINF:1,\n')).toThrow()
 expect(parseSegments('#EXTM3U\n#EXTINF:1,\nsegment-1.ts\n#EXTINF:0.5,\nsegment-2.ts\n')).toEqual([{name:'segment-1.ts',seconds:1,start:0},{name:'segment-2.ts',seconds:0.5,start:1}])
})
