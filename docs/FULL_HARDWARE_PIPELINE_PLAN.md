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

## What stopped it before — solved

`decodeHint` recorded the history as *"per-input QSV decode produced exit-218
failures under lineup contention"*. Contention was not it. The probe ran 48
concurrent full-hardware sessions clean, far past what six channels need.

**Exit 218 is an input `-t` on a hardware input in a graph that has other
hardware inputs.** FFmpeg reconciles the streams through a software scaler it
cannot apply to qsv frames and fails with *"Impossible to convert between the
formats supported by the filter 'graph 0 input from stream N:0' and the filter
'auto_scale_N'"*. Nothing is written; the exit code is 218.

A single hardware input with `-t` is fine, which is exactly why this hid for so
long: every isolated test passes. Every scheduled item carries a duration, so
every real window had `-t` on several hardware inputs and failed nearly always
— and more channels meant more failures, which is indistinguishable from load
from the outside. That is how it came to be written down as contention.

The fix is to bound each item with `trim`/`atrim` inside the graph instead.
`-ss` is unaffected and stays on the input.

Two normalisers from the software chain also have to be carried over, and both
were missed at first for the same reason — the software graph is
`scale,pad,setsar=1,fps=30,format,setpts` and only the scaling and format were
ported:

- **`format=nv12` on every `vpp_qsv`.** A 10-bit source otherwise reaches the
  encoder as P010 and the run writes zero packets with no error at all.
- **`framerate` on every `vpp_qsv`, and `-r` at the output.** Without it the
  graph carries no frame rate to the muxer, FFmpeg assumes 25, and a 60-frame
  GOP produces 2.4s segments against a 2s target — enough to skew the live edge.

A lesson worth keeping: diff the two filter chains filter by filter before
reasoning about what each one ought to do. Both omissions were visible that way
from the start.

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

## Measured answers

All three questions are settled, on the real box: `jellyfin-ffmpeg 8.1.2`,
Raptor Lake-P / Iris Xe, `/dev/dri/renderD128`. `scripts/qsv-capability-probe.sh`
reproduces this.

**The full-hardware graph works, pillarbox included.** Frames never need to
leave the GPU, even for the 41% of the library that is not 16:9 1080p:

```text
-hwaccel qsv -hwaccel_output_format qsv
  → vpp_qsv=w=…:h=…:scale_mode=hq:format=nv12
  → overlay_qsv onto a generated background
  → h264_qsv
```

`vpp_qsv` has no `force_original_aspect_ratio`, so letterboxing is a composite
onto a background rather than one filter. `mode=hq` does not exist; the option
is `scale_mode=hq`.

**`format=nv12` is mandatory, not an optimisation.** A 10-bit source decodes to
P010, and handing that to `h264_qsv` produces *zero packets and no error
message* — the run simply reports that nothing was written. Adding
`format=nv12` to `vpp_qsv` fixes it outright. This silent-empty-output failure
is the most likely explanation for exit-218: a graph missing the conversion
looks like an inexplicable crash rather than a missing option.

**Hardware decode covers effectively the whole library:**

| Codec | Hardware decode |
| --- | --- |
| H.264 | yes |
| HEVC 8-bit | yes |
| HEVC 10-bit | yes, with `format=nv12` |
| AV1 | yes |
| VP9 | yes |
| MPEG-2 | yes |

Only H.264 Hi10P stays software — Intel has no Hi10P decoder, which the
existing gate already gets right. VC-1 (45 files) and MPEG-4 part 2 (167) were
not probed and should fall back until they are.

**There is no session ceiling to budget for.** 1, 2, 4, 6, 8, 12, 16, 24, 32
and 48 concurrent full-hardware sessions all ran clean. Six channels with a
few lookahead inputs each is nowhere near that, so exit-218 was not contention
— it was graph construction. The pipeline needs a *uniform, correct* graph far
more than it needs a concurrency limit.

**The hybrid is worse than the full path.** Hardware decode with frames
downloaded to system memory *failed* on 10-bit where the all-GPU graph passed,
so the "keep the software filters, only replace the decoder" compromise is not
the safe option it appeared to be.

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

### 2. Capability probe on the real box — done

`scripts/qsv-capability-probe.sh`, run inside the container. Results above.
It must be side-loaded with `docker cp`: `.dockerignore` excludes `scripts`,
so the image never carries it.

### 3. The pipeline, behind the flag — built, and not yet working on a live channel

`FfmpegHardwareHlsPipelineFactory`, selected by
`TOASTTV_TRANSCODING_MODE=intel-qsv-full`. Verified on the deployed box against
real library files: 11 segments in 20 seconds, exactly 2.000s each, segments
decode cleanly, repeatable, `-ss` unaffected.

`scripts/hardware-pipeline-dry-run.ts` regenerates the command from the real
factory and emits a script that runs it and checks the output. Use it after any
change to the graph.

**But a live channel did not come up under `intel-qsv-full`.** The dry run
passes on real files and the channel does not, so something the worker does
differs from what the dry run builds and is not yet identified. Candidates,
none of which the dry run exercises:

- append windows (`appendToExistingPlaylist`), which the dry run never sets
- `loopSource` items, used for off-air and emergency loops
- a window made entirely of station assets — those are the only rows with a
  pixel format today, so they are the only windows that reach the hardware path
  at all, and every mixed window silently falls back to software
- many more items per window than the three the dry run uses

`auto` is the working configuration and the flag is opt-in, so nothing is at
risk by leaving it there. Before trying again, capture the worker's own error:

```bash
docker logs ToastTV --tail 300 2>&1 | grep -viE "failed to probe|ffprobe failed|matroska|EBML"
```

An `Impossible to convert` line means the graph; anything else means the worker.

- new `ChannelPipelineFactory` implementation: `-hwaccel qsv` decode →
  `vpp_qsv` scale/pad/fps → `h264_qsv` encode, frames never leaving the GPU
- selected by a new `TOASTTV_TRANSCODING_MODE` value; the existing pipeline
  stays untouched and the flag is the rollback
- `format=nv12` on every `vpp_qsv`, without exception — its absence is silent
- per-codec eligibility replacing the H.264-only gate: everything except
  H.264 Hi10P, with VC-1 and MPEG-4 part 2 left on software until probed
- uniform frames per append window, since `concat` cannot mix hardware and
  software frames — this is the rule the whole design rests on
- the factory finally **reads `decodeHint`**
- no concurrency ceiling: none was found at 48 sessions, so one would be
  guesswork that hides the real failure mode

### 4. Result — measured

Six channels on air, all on the media engine, none falling back:

| | Before | After |
| --- | --- | --- |
| Server CPU | 50-90% of cores | **19.7% of 16 cores** |

Per channel, as a share of one core: disney_channel 63, Nickelodeon 55,
pbs-kids 52, cartoon_network 47, nick-jr 45, nature-discovery 32. That sums to
294% -- about 2.9 cores, or 18.4% of sixteen -- and the remainder is the server
itself, so the whole-box figure and the per-channel figures agree.

The media engine reports 550MHz against a 350MHz idle and a 1300MHz maximum,
which is the confirmation available on i915: not a utilisation figure, but it
does not sit at idle while the work is happening.

## What it took

Nine hypotheses were wrong before the cause was found: a session ceiling, input
`-t` (the right mechanism, dismissed two rounds early because it was tested
with a single input), multiple overlays, mixed codecs, SAR, frame rate,
degenerate durations, audio in the graph, and `-ss` alone.

What actually worked was unglamorous and should have come first:

1. **Print the whole error.** The cause was being captured and then discarded --
   the tail was 2KB, and "Impossible to convert" is followed by thousands of
   bytes of pixel-format lists, so the reported line was always the cascade.
2. **Print the command that failed.** Every hand-written probe differed from the
   real command in ways that were not being controlled, so each pass proved
   nothing and was read as evidence anyway.
3. **Reproduce the failure standalone, then bisect one variable at a time.**
   Once the failing command ran outside the app, the cause took one pass.

The general lesson: a passing test that was not derived from the failing case
is not evidence. Diffing the two filter chains filter by filter at the outset
would have found both missing normalisers -- `format=nv12` and the frame
rate -- in the first hour rather than the sixth round.

## Cheap wins available regardless

Independent of the above, and worth doing whichever way the probe lands:

- **skip `fps=30`** when the source is already 30fps (needs step 1's fps column)
- **skip `scale`/`pad`** when the source is already exactly 1920×1080 — 13,229
  files currently pay for a geometric no-op
- **run fewer channels hot**; six concurrent pipelines multiplies everything
- **720p tier** — `ChannelQualityTierService` already supports it globally
