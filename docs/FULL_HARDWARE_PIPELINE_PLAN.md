# Full hardware pipeline — plan

## Why

Six channels on air use 50–90% of CPU cores with Intel QSV enabled and working.
QSV is genuinely active — the render node probes clean and the one-frame encode
test passes — but it only covers the **final H.264 encode**. Everything before
it is software:

1. decode of every source
2. `scale` to 1920×1080
3. `pad` to letterbox/pillarbox
4. `fps=30` conversion, applied unconditionally
5. `format=yuv420p`, then `format=nv12` for the upload
6. `concat` across the lookahead window
7. `realtime` / `arealtime` pacing
8. `aformat` + `aresample` per input, and the AAC encode

There is no `-hwaccel` on any input anywhere in the codebase. That is
deliberate — see the comments in `FfmpegContinuousHlsPipelineFactory` — and it
is the cost being measured.

## What is already here

- `ChannelPipelineFactory` is a one-method interface (`start(request)`) injected
  into `ContinuousChannelWorkerManager`. A second implementation drops in
  beside `FfmpegContinuousHlsPipelineFactory` with no downstream changes.
- `TOASTTV_TRANSCODING_MODE` is already read in `src/config/runtime.ts` and
  shown read-only on the settings page. A new mode value needs no new plumbing.
- `ChannelTimelinePosition.decodeHint` is derived per item and threaded through
  the resolver — and **never read by the factory**. The hint is computed and
  discarded, which is why hardware decode is at 0% rather than the 3.4% the
  gate would allow.
- `MediaIndexer.backfillAudioProbes()` is an existing post-scan backfill to
  copy for the probe work below.

## What stopped it before

`decodeHint` carries the history: *"per-input QSV decode produced exit-218
failures under lineup contention"*. Six channels, each holding several
lookahead inputs open, is a lot of simultaneous QSV sessions. The limit is real
and independent of codec support, so any re-enable needs a concurrency ceiling
and a software fallback rather than a blanket flag.

## Library reality

22,546 indexed files.

| Codec | Files | Share |
| --- | ---: | ---: |
| HEVC | 12,210 | 54.2% |
| H.264 | 8,661 | 38.4% |
| AV1 | 1,040 | 4.6% |
| MPEG-2 | 271 | 1.2% |
| MPEG-4 pt2 | 167 | 0.7% |
| VP9 | 143 | 0.6% |
| VC-1 | 45 | 0.2% |

Resolutions are mixed: 13,229 files are 1920×1080, and the rest are 1440×1080,
1280×720, 960×720, 720×480, 624×480, 640×480 and similar. **41% needs padding**,
which is the single biggest constraint on a hardware filter graph.

The current eligibility gate accepts H.264, 8-bit, known pixel format only —
**760 files, 3.4%** — and `pixel_format` is missing on **21,358 rows (94.7%)**,
so almost everything fails closed regardless.

The server is 13th-gen (Raptor Lake, UHD 770), whose media engine decodes
HEVC 8/10-bit, VP9, AV1, MPEG-2 and VC-1 — so roughly 99% of the library is
hardware-decodable, not the 3.4% the gate allows. The H.264-only restriction is not a
hardware limit; it is caution left from the failed experiment. The 10-bit
exclusion **is** correct for H.264 — Intel has no Hi10P decode — so the gate
must become per-codec rather than being dropped.

## Open questions that shape the design

These are settled by step 2, before any pipeline code is written.

1. **Can `vpp_qsv` pad?** Stock `vpp_qsv` scales but does not letterbox the way
   software `pad` does. `jellyfin-ffmpeg8` carries extra QSV patches and may
   support scale+pad in one pass. If it cannot, the fallback is `scale_qsv`
   plus `overlay_qsv` onto a generated background — buildable, but more graph.
2. **`concat` with hardware frames.** The filter needs uniform frame types. One
   software-decoded item in a lookahead window poisons the whole graph, so the
   pipeline needs an explicit rule: all-hardware per append window, or
   `hwupload` the odd one out. This is the backbone of the design, not a detail.
3. **How many QSV sessions does the box sustain?** A full-hardware path uses
   *more* sessions per channel (decode + VPP + encode), not fewer. The ceiling
   must be measured, not assumed.
4. **10-bit HEVC → 8-bit H.264.** If any of that content is HDR, a straight
   format conversion without tone-mapping produces washed-out output.

## Steps

### 1. Backfill `pixel_format`, and capture `fps` while there

No pipeline risk, and a hard prerequisite for everything after it — both the
current gate and any replacement fail closed without a pixel format.

`ffprobe` already returns `pix_fmt` **and** `fps`; `FilesystemClient` captures
both, but the `media` table has a `pixel_format` column and **no fps column**,
so the frame rate is discarded. One probe pass yields both, and the frame rate
is what later allows `fps=30` to be skipped for sources already at 30.

- add an `fps` column and the migration, following the `pixel_format` migration
- add `backfillVideoProbes()` next to `backfillAudioProbes()`, bounded per run
- verify the counts fall on a real scan

### 2. Capability probe on the real box

**Must run on the Unraid host or inside the container** — it needs the actual
`jellyfin-ffmpeg8` build and `/dev/dri/renderD128`. It cannot be run from a
development machine.

Answers question 1 and part of 3: whether `vpp_qsv` scales and pads in one
pass, whether hardware decode works per codec, and how many concurrent
sessions the device sustains before it fails the way it did before.

Output is a short report that decides the graph shape.

### 3. The pipeline, behind the flag

Only once 1 and 2 are done.

- new `ChannelPipelineFactory` implementation: `-hwaccel qsv` decode →
  `vpp_qsv` scale/pad/fps → `h264_qsv` encode, frames never leaving the GPU
- selected by a new `TOASTTV_TRANSCODING_MODE` value; the existing pipeline
  stays untouched and the flag is the rollback
- an explicit concurrency ceiling with software fallback when exhausted
- per-codec eligibility replacing the H.264-only gate, keeping the Hi10P
  exclusion for H.264 only
- the factory finally **reads `decodeHint`**

### 4. Bring it up one channel at a time

The previous attempt died under six-channel contention. Prove it at
concurrency 1, measure, then raise the ceiling. Rolling it out to all six at
once is how the last attempt failed.

## Cheap wins available regardless

Independent of the above, and worth doing whichever way the probe lands:

- **skip `fps=30`** when the source is already 30fps (needs step 1's fps column)
- **skip `scale`/`pad`** when the source is already exactly 1920×1080 — 13,229
  files currently pay for a geometric no-op
- **run fewer channels hot**; six concurrent pipelines multiplies everything
- **720p tier** — `ChannelQualityTierService` already supports it globally
