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
for f in vpp_qsv scale_qsv overlay_qsv hwupload hwdownload; do
  if "$FFMPEG" -hide_banner -filters 2>/dev/null | grep -qw "$f"; then ok "filter $f"; else no "filter $f"; fi
done
if "$FFMPEG" -hide_banner -encoders 2>/dev/null | grep -qw h264_qsv; then ok "encoder h264_qsv"; else no "encoder h264_qsv"; fi

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
for expr in \
  'vpp_qsv=w=1920:h=1080:force_original_aspect_ratio=decrease' \
  'scale_qsv=w=1440:h=1080,vpp_qsv=w=1920:h=1080' ; do
  if run -init_hw_device "vaapi=va:$DEVICE" -init_hw_device qsv=qs@va -filter_hw_device qs \
       -i "$WORK/sd.mp4" -vf "format=nv12,hwupload=extra_hw_frames=16,$expr" \
       -c:v h264_qsv -frames:v 10 -f null -; then
    ok "pad path: $expr"
  else
    no "pad path: $expr  -> $(tail -1 "$WORK/err")"
  fi
done

say "Q2 — hardware decode per codec"
# 92%+ of the library is HEVC or H.264. AV1/VP9/MPEG-2/VC-1 are the tail that
# would need a software fallback if unsupported.
for codec in h264 hevc av1 vp9 mpeg2video vc1; do
  if "$FFMPEG" -hide_banner -decoders 2>/dev/null | grep -qE "${codec}_qsv"; then
    ok "decoder ${codec}_qsv present"
  else
    no "decoder ${codec}_qsv absent (software fallback needed for this codec)"
  fi
done

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
for n in 1 2 4 6 8 12 16; do
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
