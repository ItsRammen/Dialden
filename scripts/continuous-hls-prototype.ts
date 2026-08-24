import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const [episodeA, bumper, episodeB, rawOutput = './data/prototype-live'] = Bun.argv.slice(2)
if (!episodeA || !bumper || !episodeB) {
  throw new Error('Usage: bun scripts/continuous-hls-prototype.ts <episode-a> <bumper> <episode-b> [output-directory]')
}

const sourceA: string = episodeA
const sourceBumper: string = bumper
const sourceB: string = episodeB

const output = resolve(rawOutput)
mkdirSync(output, { recursive: true })
const filters = [0, 1, 2]
  .map(
    (index) =>
      `[${index}:v:0]scale=1920:1080:force_original_aspect_ratio=decrease,` +
      `pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${index}];` +
      `[${index}:a:0]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
      `aresample=async=1:first_pts=0[a${index}]`
  )
  .join(';')
const concat =
  '[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[joinedv][joineda];' +
  '[joinedv]realtime=speed=1[outv];[joineda]arealtime=speed=1[outa]'

const child = Bun.spawn(
  [
    'ffmpeg', '-hide_banner', '-y',
    '-i', sourceA, '-i', sourceBumper, '-i', sourceB,
    '-filter_complex', `${filters};${concat}`,
    '-map', '[outv]', '-map', '[outa]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '20',
    '-hls_flags', 'delete_segments+independent_segments+omit_endlist+program_date_time',
    '-hls_segment_filename', `${output}/segment-%09d.ts`,
    `${output}/index.m3u8`,
  ],
  { stdout: 'inherit', stderr: 'inherit' }
)

console.log(`Prototype playlist: ${output}/index.m3u8`)
console.log('This prototype expects all three inputs to have an audio stream.')
process.exit(await child.exited)
