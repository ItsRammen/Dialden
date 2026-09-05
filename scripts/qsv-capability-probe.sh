#!/usr/bin/env bash
#
# QSV capability probe for the full hardware pipeline plan (step 2).
#
# Must run where the real media engine is: on the Unraid host, or inside the
# Dialden container. It cannot tell you anything useful from a development
# machine, because it is measuring one specific ffmpeg build against one
# specific GPU.
#
#   docker exec -it <dialden-container> bash /app/scripts/qsv-capability-probe.sh
#
# Writes nothing outside a temporary directory and touches no library file.
# Every test is a few frames of synthetic video.

set -uo pipefail

FFMPEG="${FFMPEG:-ffmpeg}"
DEVICE="${DEVICE:-/dev/dri/renderD128}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass + 1)); }
no()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail + 1)); }

run() { "$FFMPEG" -v error -y "$@" >/dev/null 2>"$WORK/err"; }

say "Environment"
echo "  ffmpeg:  $("$FFMPEG" -version 2>/dev/null | head -1)"
echo "  device:  $DEVICE $([ -e "$DEVICE" ] && echo '(present)' || echo '(MISSING)')"
echo "  cpu:     $(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ //')"
ls -1 /dev/dri 2>/dev/null | sed 's/^/  dri:     /'

say "Filters and encoders present"
# Captured to variables first. Piping into `grep -q` under `set -o pipefail`
# reports a *successful* match as a failure: grep exits at the first hit, the
# pipe closes, ffmpeg dies of SIGPIPE and pipefail propagates that status.
FILTERS="$("$FFMPEG" -hide_banner -filters 2>/dev/null || true)"
ENCODERS="$("$FFMPEG" -hide_banner -encoders 2>/dev/null || true)"
DECODERS="$("$FFMPEG" -hide_banner -decoders 2>/dev/null || true)"
for f in vpp_qsv scale_qsv overlay_qsv hwupload hwdownload; do
  case "$FILTERS" in *" $f "*|*" $f"*) ok "filter $f" ;; *) no "filter $f" ;; esac
done
case "$ENCODERS" in *h264_qsv*) ok "encoder h264_qsv" ;; *) no "encoder h264_qsv" ;; esac

# A short 4:3 SD clip, the shape that forces pillarboxing in the real graph.
"$FFMPEG" -v error -y -f lavfi -i testsrc=size=640x480:rate=30:duration=2 \
  -c:v libx264 -pix_fmt yuv420p "$WORK/sd.mp4" 2>/dev/null
"$FFMPEG" -v error -y -f lavfi -i testsrc=size=1920x1080:rate=30:duration=2 \
  -c:v libx264 -pix_fmt yuv420p "$WORK/hd.mp4" 2>/dev/null

say "Q1 — can vpp_qsv scale AND pad in one pass?"
# This is the question that decides the graph shape. Stock vpp_qsv scales but
# does not letterbox; jellyfin-ffmpeg may carry a patch that does.
if run -init_hw_device "vaapi=va:$DEVICE" -init_hw_device qsv=qs@va -filter_hw_device qs \
     -i "$WORK/sd.mp4" -vf 'format=nv12,hwupload=extra_hw_frames=16,vpp_qsv=w=1920:h=1080' \
     -c:v h264_qsv -frames:v 10 -f null -; then
  ok "vpp_qsv scale to 1920x1080"
else
  no "vpp_qsv scale to 1920x1080  -> $(tail -1 "$WORK/err")"
fi

for expr in 'vpp_qsv=w=1920:h=1080:mode=hq' 'vpp_qsv=w=1920:h=1080:scale_mode=hq'; do
  if run -init_hw_device "vaapi=va:$DEVICE" -init_hw_device qsv=qs@va -filter_hw_device qs \
       -i "$WORK/sd.mp4" -vf "format=nv12,hwupload=extra_hw_frames=16,$expr" \
       -c:v h264_qsv -frames:v 10 -f null -; then
    ok "$expr"
  else
    no "$expr  -> $(tail -1 "$WORK/err")"
  fi
done

# Aspect-preserving pad. If none of these work, the graph needs
# scale_qsv + overlay_qsv onto a generated background instead.
# A genuine pillarbox: 640x480 must land as 1440x1080 centred on a 1920x1080
# black field. Scaling twice is not padding -- it stretches -- so this composites.
if run -init_hw_device "vaapi=va:$DEVICE" -init_hw_device qsv=qs@va -filter_hw_device qs \
     -f lavfi -i color=black:size=1920x1080:rate=30:duration=2 -i "$WORK/sd.mp4" \
     -filter_complex '[0:v]format=nv12,hwupload=extra_hw_frames=16[bg];[1:v]format=nv12,hwupload=extra_hw_frames=16,vpp_qsv=w=1440:h=1080[fg];[bg][fg]overlay_qsv=x=240:y=0' \
     -c:v h264_qsv -frames:v 10 -f null -; then
  ok "pillarbox via overlay_qsv onto a generated background"
else
  no "pillarbox via overlay_qsv  -> $(tail -1 "$WORK/err")"
fi

# vpp_qsv's own aspect handling, for completeness -- absent on this build.
if run -init_hw_device "vaapi=va:$DEVICE" -init_hw_device qsv=qs@va -filter_hw_device qs \
     -i "$WORK/sd.mp4" -vf 'format=nv12,hwupload=extra_hw_frames=16,vpp_qsv=w=1920:h=1080:scale_mode=hq' \
     -c:v h264_qsv -frames:v 10 -f null -; then
  ok "vpp_qsv scale_mode=hq (stretches; does not preserve aspect)"
else
  no "vpp_qsv scale_mode=hq  -> $(tail -1 "$WORK/err")"
fi

say "Q2 — hardware decode per codec"
# 92%+ of the library is HEVC or H.264. AV1/VP9/MPEG-2/VC-1 are the tail that
# would need a software fallback if unsupported.
# Listing decoders is not the question; whether -hwaccel qsv actually decodes a
# file of that codec is. Each sample is two seconds of synthetic video.
probe_codec() {
  local label="$1" encoder="$2"; shift 2
  # Matroska, not a codec-named extension: ffmpeg picks the muxer from the
  # suffix, and .av1 / .vp9 / .hevc10 name no format, which previously read as
  # a missing encoder when the encoder was present all along.
  if ! "$FFMPEG" -v error -y -f lavfi -i testsrc=size=640x480:rate=30:duration=2 \
       -c:v "$encoder" "$@" -f matroska "$WORK/s_$label.mkv" >/dev/null 2>"$WORK/err"; then
    printf '  \033[33mSKIP\033[0m  %s (cannot build a sample: %s)\n' "$label" "$(tail -1 "$WORK/err")"
    return
  fi
  if run -hwaccel qsv -hwaccel_output_format qsv -i "$WORK/s_$label.mkv" \
       -vf 'vpp_qsv=w=1920:h=1080' -c:v h264_qsv -frames:v 20 -f null -; then
    ok "hw decode $label"
  else
    no "hw decode $label (software fallback needed)  -> $(tail -1 "$WORK/err")"
  fi
}
probe_codec h264  libx264 -pix_fmt yuv420p
probe_codec hevc  libx265 -pix_fmt yuv420p
probe_codec hevc10 libx265 -pix_fmt yuv420p10le
probe_codec av1   libsvtav1 -pix_fmt yuv420p
probe_codec vp9   libvpx-vp9 -pix_fmt yuv420p
probe_codec mpeg2 mpeg2video -pix_fmt yuv420p -b:v 2M

if run -hwaccel qsv -hwaccel_output_format qsv -i "$WORK/hd.mp4" \
     -vf 'vpp_qsv=w=1920:h=1080' -c:v h264_qsv -frames:v 10 -f null -; then
  ok "end-to-end: hw decode -> vpp_qsv -> h264_qsv, frames never leave the GPU"
else
  no "end-to-end hw path  -> $(tail -1 "$WORK/err")"
fi

say "Q3 — concurrent QSV session ceiling"
# The previous attempt died with exit 218 under lineup contention. Six channels
# each hold several lookahead inputs open, so the ceiling matters more than raw
# throughput. Find where it actually breaks.
for n in 1 2 4 6 8 12 16 24 32 48; do
  pids=()
  for _ in $(seq "$n"); do
    "$FFMPEG" -v error -hwaccel qsv -hwaccel_output_format qsv -i "$WORK/hd.mp4" \
      -vf 'vpp_qsv=w=1920:h=1080' -c:v h264_qsv -frames:v 60 -f null - >/dev/null 2>&1 &
    pids+=($!)
  done
  bad=0
  for pid in "${pids[@]}"; do wait "$pid" || bad=$((bad + 1)); done
  if [ "$bad" -eq 0 ]; then
    ok "$n concurrent full-hardware sessions"
  else
    no "$n concurrent sessions: $bad failed  <-- ceiling is below $n"
    break
  fi
done

say "Summary"
printf '  %d passed, %d failed\n' "$pass" "$fail"
cat <<'NOTE'

  What the results mean for the plan:

  Q1 decides the graph shape. If a pad path passes, the hardware graph can
     letterbox the 41% of the library that is not 16:9 1080p. If none passes,
     the pipeline needs scale_qsv + overlay_qsv onto a generated background.

  Q2 decides the eligibility gate. Every codec that fails needs a software
     decode fallback, and concat cannot mix hardware and software frames in
     one window -- so the pipeline must keep each append window uniform.

  Q3 sets the concurrency ceiling. Six channels, each with several lookahead
     inputs, is what produced exit-218 before. The ceiling here is the budget
     the new pipeline must enforce.
NOTE
