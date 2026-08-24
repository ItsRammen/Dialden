# Continuous channel worker architecture

## Decision

ToastTV's MVP should use **sequential normalized source workers feeding one
persistent channel HLS segmenter**, managed as one logical pipeline per active
channel. The public playlist remains:

```text
/api/v1/channels/:channelId/live/index.m3u8?clientId=:stableClientId
```

The lifecycle boundary is the channel, not a media file. A source decoder may
be replaced at a programme boundary, but the segmenter, media sequence, output
directory and URL must remain alive. All source workers produce a common
H.264/AAC transport profile with continuous timestamps before entering the
segmenter.

The new `ContinuousChannelWorkerManager` is the lifecycle/state layer for this
design. The FFmpeg graph is deliberately behind `ChannelPipelineFactory`: the
manager can be integrated and tested before committing server startup to an
unproven platform-specific process graph.

The checked-in production MVP factory uses a bounded current-plus-two-lookahead
FFmpeg concat graph. That single graph crosses episode -> bumper -> episode with
one encoder/muxer, then a newly resolved window appends to the same rolling
playlist with collision-safe sequence numbers. This is immediately deployable
and avoids per-item restarts; replacing bounded append windows with the feeder
topology below remains the next hardening step after LG hardware measurements.

The concat result is paced with FFmpeg's `realtime` and `arealtime` filters
*after* all inputs have joined one continuous PTS timeline. Do not place `-re`
on every input: lookahead input clocks may start together and a future input can
then be emitted rapidly when concat finally selects it, pushing the HLS live
edge ahead of the schedule.

The bounded graph opens up to three source files when it starts. FFmpeg may
prefetch a small, queue-limited amount from future inputs, so this is acceptable
for local/mounted libraries but is not equivalent to just-in-time source
opening. Keep the window bounded and do not enlarge input thread queues. The
persistent feeder design should eventually open/prewarm only the immediately
next source, particularly for remote media mounts.

## Options considered

| Concern | One persistent FFmpeg with replaceable inputs | Sequential source workers + persistent segmenter |
| --- | --- | --- |
| Dynamic input changes | FFmpeg has no clean runtime operation for replacing ordinary file inputs in a filter graph. FIFOs or a custom transport are still required. | Source readers are ordinary short-lived FFmpeg processes; their normalized MPEG-TS output can be switched upstream of one segmenter. |
| Heterogeneous codecs | A single concat demuxer is fragile when stream parameters/codecs change. | Every source is decoded/remuxed into the same H.264/AAC profile before switching. |
| Timestamp continuity | Excellent only after building a custom input feeder which owns timestamps. | The feeder assigns a monotonically increasing channel PTS; the persistent segmenter owns HLS sequence numbers. |
| HLS discontinuity | Normally unnecessary when output parameters and PTS remain continuous. | Normally unnecessary after normalization. Emit `EXT-X-DISCONTINUITY` only after an unavoidable segmenter restart/profile change. |
| Startup latency | Low between items after all inputs are known; dynamic inputs remain difficult. | The next source can be probed and started several seconds early, then held until the switch point. |
| Stream copy | Possible only where every adjacent input exactly matches. | Possible into the normalized transport only after strict probe validation; otherwise transcode. MVP should transcode for reliability. |
| Audio normalization | One filter graph, but replacing missing/different layouts is awkward. | Each source maps or synthesizes stereo 48 kHz AAC and applies async resampling before the join. |
| Resource use | One encoder if all processing is in one process. | One segmenter plus normally one source worker; briefly two around a pre-roll transition. |
| Crash recovery | One crash loses the whole graph. | A failed source can be replaced with emergency filler without changing the public stream; segmenter failure is separately restartable. |

A new FFmpeg process that directly rewrites `index.m3u8` for every episode was
rejected. `append_list` keeps the filename but does not guarantee an atomic,
gap-free transition, continuous timestamps, or reliable client behaviour.

## MVP process topology

```text
schedule resolver (now + lookahead)
       |
       +--> source FFmpeg A -- H.264/AAC MPEG-TS --+
       |                                            |
       +--> prewarmed source FFmpeg B --------------+--> timestamped feeder
                                                         |
                                                         v
                                              persistent HLS segmenter
                                                         |
                                      live/index.m3u8 + rolling segments
```

Initial output profile:

- H.264, yuv420p, maximum 1920x1080
- AAC-LC, 48 kHz stereo
- closed GOP aligned to two-second HLS segments
- 2-second segments and a 20-segment (~40 second) live window
- `independent_segments`, `delete_segments`, `omit_endlist`, and program date
  time
- monotonically increasing channel timestamps across every source change

The source process should seek to `sourceOffsetSeconds` before decoding. Near a
transition it should immediately prewarm the next source. Missing audio must be
replaced with stereo silence; differing aspect ratios must be scaled/padded,
not stretched.

## Lifecycle and state

`ContinuousChannelWorkerManager` provides:

- one record and one pipeline per channel, shared by all viewers;
- idempotent, expiring client leases: playlist polling calls `touch()` with the
  same client ID and never inflates viewer count; segment requests do not join;
- no process before the first viewer;
- a stable playlist URL/path for the lifetime of the channel configuration;
- 60–120 second (90 second default) warm idle shutdown;
- schedule resolution at every initial start and restart, so a crash resumes at
  the current broadcast position rather than the old programme offset;
- an explicit emergency-fallback resolver for missing files;
- H.264/AAC profile and rolling-cleanup requirements passed to the pipeline;
- state for dashboard/API integration: viewer count, source offset, schedule
  item IDs, revision, live/idle/error status, fallback use, and last error.

`channel on air` remains independent of `worker live`. Zero viewers should mean
zero FFmpeg workers while the deterministic schedule continues virtually.

## Required integration points

1. Adapt `ChannelService.getNow()` (and a short guide lookahead) to a
   `ChannelTimelineResolver`. It must return the file path, current offset,
   remaining range, next item, revision, and item type. Bumpers/interludes must
   be ordinary schedule entries rather than client-side events.
2. Implement a production `ChannelPipelineFactory` and `ChannelWorkerFiles`.
   The factory owns the persistent feeder/segmenter and source prewarming. The
   file adapter creates `<TOASTTV_DATA>/streams/:channelId/live`, atomically
   publishes playlists, and removes segments outside the rolling window.
3. Add an HLS controller route for the playlist and segments with strict
   channel/filename validation and correct HLS MIME/cache headers.
4. Call `touch(channelId, clientId)` when serving the playlist and
   `leave(channelId, clientId)` on an explicit tune-away. Repeated playlist
   requests refresh one expiring lease; segment requests never mutate leases.
5. Return the stable HLS URL in the channel playback descriptor and teach the
   webOS client to keep the same video source across schedule-item changes.
6. Publish manager state separately from on-air state in the dashboard and stop
   all pipelines during server shutdown.

## Recovery rules

- Scheduled source missing: resolve known-good emergency filler, set
  `usingFallback`, and continue to the following schedule boundary.
- Source worker failure: switch to filler in the existing segmenter, then
  resolve the authoritative timeline again.
- Segmenter failure: retain the public path, atomically recreate output, emit a
  discontinuity if sequence continuity cannot be restored, and resume from the
  schedule's current offset.
- Repeated failure: retain an explicit `error` state and bounded retry delay;
  never loop a failed episode from its beginning.

## Prototype and acceptance testing

Before production wiring, run a three-input prototype on actual media:

```text
Episode A -> Bumper -> Episode B
```

Keep a browser/LG player attached to one `index.m3u8`. Test compatible and mixed
codec inputs, then repeat with a source range (`00:00–03:00`, bumper, resume at
`03:00`). Record playlist errors, black frames, audio/video gap duration,
buffering, CPU, and switch latency. The checked-in prototype command accepts
paths but ships no fabricated or copyrighted media.
