# Prepared HLS startup prototype

An isolated experiment, not enabled in production. The native app and normal channel routes have not been pointed at it. No go2rtc dependency is needed: the serving path reads cached MPEG-TS segments and computes a small clock-driven playlist.

## Measured result — 2026-10-22

Three trials per mode on the development desktop, reading episode excerpts and a complete Nickelodeon bumper from the NAS. Both paths use the existing software pipeline's 1080p/30 H.264 + stereo 48 kHz AAC normalization and encoder. The prepared path removes realtime pacing and retains all segments. The baseline starts a new paced encoder and waits for two completed segments, matching the normal readiness requirement.

| Median | Prepared block, fresh serving process | Fresh paced software encoder |
|---|---:|---:|
| Playable playlist | 9.4 ms | 3,001 ms |
| Boot/request through first decoded frame | 81 ms | 3,123 ms |

The first-frame metric includes an HTTP manifest/segment check followed by a fresh FFmpeg client's first video frame. It is not LG startup, remote-button latency, a full host reboot, or an OS page-cache-cold benchmark. The server serving process was restarted for each prepared trial; media and OS caches were retained. The production Unraid hardware encoder was not benchmarked here. Three trials establish feasibility, not a latency guarantee.

Preparing this 21.133-second block took 3.68 seconds ahead of time and used 16.0 MB. That particular sample extrapolates to about 2.73 GB per channel-hour; actual storage and render speed depend on content. Preparation cost is excluded from tune time and is paid before a viewer arrives.

Raw timings: [startup report](benchmarks/prepared-hls-startup-2026-10-22.json).

## Playback checks and known boundary issue

- Eight seconds of an episode, the complete 5.141-second bumper, and eight seconds of the next episode were decoded, totaling 634 frames after 30 fps conversion. Video had no frame gap beyond 33.334 ms. Audio timestamps were continuous to sub-microsecond rounding within that block.
- The manifest uses actual encoded segment durations, rather than assuming source durations survived frame-rate conversion exactly. It exposes only completed segments, advances sequence numbers and program-date-times, and emits discontinuities at a repeated block boundary.
- An eight-second live HTTP capture spanning a repeat decoded 240 frames with a maximum 34 ms video gap. Audio at the wrap contains an approximately 21.33 ms timestamp overlap (one AAC packet). This is a production blocker for seamless looping. The loop-check script reports it explicitly; successful video decoding alone is insufficient.
- Unit tests cover clock positioning after process restart, no future segment publication, fractional final segments, discontinuity sequence advancement, and unsafe/incomplete segment indexes. Combined with existing software-pipeline tests, 22 tests passed.
- TV SSH at 192.168.86.198 timed out. LG buffering, channel switching and audio behavior have not been tested with this prototype.

## Reproduce

Use a JSON array of local source ranges. Sources are read only. The first prototype selects audio stream zero; it does not yet apply the production language selection or stored audio-normalization measurements.

```json
[
  {"path":"/media/episode-a.mkv","offset":60,"seconds":8,"label":"Episode A excerpt"},
  {"path":"/media/bumper.mp4","seconds":5.141,"label":"Complete bumper"},
  {"path":"/media/episode-b.mkv","offset":60,"seconds":8,"label":"Episode B excerpt"}
]
```

Use the actual source duration for your bumper. Requires Bun, FFmpeg and ffprobe. All output goes in the explicitly selected cache/benchmark directory.

```sh
bun scripts/prepared-hls-benchmark.ts /tmp/clips.json /tmp/prepared-benchmark
bun scripts/prepared-hls-loop-check.ts /tmp/prepared-benchmark
bun test tests/PreparedHlsPrototype.test.ts tests/FfmpegContinuousHlsPipelineFactory.test.ts

# Or prepare without benchmarking, then serve the directory printed in the result:
bun scripts/prepared-hls-prototype.ts prepare /tmp/clips.json /tmp/prepared-cache
bun scripts/prepared-hls-prototype.ts serve /tmp/prepared-cache/<cache-key>
```

The default server binds only 127.0.0.1:1994; the playlist is `/live/index.m3u8`. `HOST` and `PORT` allow an explicitly requested LAN test. There is no authentication in this isolated test server, so it must not be exposed publicly. `PROTOTYPE_EPOCH_MS` fixes the schedule start across restarts; without it the demonstration starts three seconds into a repeating block. The benchmark starts eight seconds into already prepared content to simulate tuning into an established schedule.

## Before production integration

Resolve AAC priming/end padding at block boundaries and verify LG's handling of discontinuities. Then add schedule-aware block selection, atomic schedule revision switching, cache quota/eviction, preparation prioritization, persistent clock mapping, metadata/approval eligibility, language/audio normalization, and live-encoder fallback for cache misses. The prototype caches an entire continuous block, so editing that block rebuilds it; reusable per-episode caches are a separate design and need boundary validation.

Keep generated media outside Git. Cache identity includes source path, size, modification time, ranges, profile, prototype revision and FFmpeg version. Complete blocks publish atomically. Serving does not invoke an encoder, and existing prepared blocks survive serving-process restarts.
