#!/bin/sh
set -eu

toasttv_uid="${PUID:-1000}"
toasttv_gid="${PGID:-1000}"

case "$toasttv_uid" in
  '' | *[!0-9]*)
    echo "PUID must be numeric" >&2
    exit 1
    ;;
esac

case "$toasttv_gid" in
  '' | *[!0-9]*)
    echo "PGID must be numeric" >&2
    exit 1
    ;;
esac

if [ "$toasttv_uid" -eq 0 ] || [ "$toasttv_gid" -eq 0 ]; then
  echo "PUID and PGID must be non-zero so ToastTV does not run as root" >&2
  exit 1
fi

requested_owner="$toasttv_uid:$toasttv_gid"
mkdir -p /app/data /app/data/thumbnails /app/data/artwork /app/data/transcode /app/data/streams

# Bind-mounted appdata starts empty on a fresh Unraid installation. Seed only
# missing immutable defaults so upgrades never overwrite user configuration.
for seed_name in config.json kids-7.library.json logo.png mpv.conf user.conf; do
  if [ -f "/app/defaults/$seed_name" ] && [ ! -e "/app/data/$seed_name" ]; then
    cp "/app/defaults/$seed_name" "/app/data/$seed_name"
    chown "$requested_owner" "/app/data/$seed_name"
  fi
done

current_owner="$(stat -c '%u:%g' /app/data 2>/dev/null || true)"
if [ "$current_owner" != "$requested_owner" ]; then
  chown -R "$requested_owner" /app/data
else
  chown "$requested_owner" /app/data/thumbnails /app/data/artwork /app/data/transcode /app/data/streams
fi

# Preserve numeric supplemental groups injected with Docker `group_add`. A
# privilege-drop helper that rebuilds groups from /etc/group would silently
# discard host/NAS media-share GIDs because those groups need not have names in
# the image.
supplemental_groups=""
append_supplemental_group() {
  candidate_gid="$1"
  case "$candidate_gid" in
    '' | *[!0-9]* | 0) return 0 ;;
  esac
  [ "$candidate_gid" = "$toasttv_gid" ] && return 0
  case ",$supplemental_groups," in
    *",$candidate_gid,"*) return 0 ;;
  esac
  if [ -n "$supplemental_groups" ]; then
    supplemental_groups="$supplemental_groups,$candidate_gid"
  else
    supplemental_groups="$candidate_gid"
  fi
  return 0
}

for inherited_gid in $(id -G 2>/dev/null || true); do
  append_supplemental_group "$inherited_gid"
done

# A mapped DRM directory can contain multiple render nodes, potentially backed
# by different GPUs and numeric host groups. Grant every exact renderD<number>
# candidate when ToastTV is configured to probe a directory; the backend will
# select the first node that passes its Intel QSV encode test. A concrete device
# setting grants only that node's group.
qsv_device="${TOASTTV_QSV_DEVICE:-/dev/dri/renderD128}"
qsv_mode="${TOASTTV_TRANSCODING_MODE:-software}"
qsv_nodes=""
append_qsv_node() {
  candidate_node="$1"
  [ -c "$candidate_node" ] || return 0
  candidate_node_gid="$(stat -c '%g' "$candidate_node" 2>/dev/null || true)"
  append_supplemental_group "$candidate_node_gid"
  if [ -n "$qsv_nodes" ]; then
    qsv_nodes="$qsv_nodes, $candidate_node"
  else
    qsv_nodes="$candidate_node"
  fi
  return 0
}

if [ "$qsv_mode" = "auto" ] || [ "$qsv_mode" = "intel-qsv" ]; then
  if [ -d "$qsv_device" ]; then
    qsv_directory="${qsv_device%/}"
    [ -n "$qsv_directory" ] || qsv_directory="/"
    for candidate_node in "$qsv_directory"/renderD*; do
      candidate_name="${candidate_node##*/}"
      candidate_suffix="${candidate_name#renderD}"
      case "$candidate_suffix" in
        '' | *[!0-9]*) continue ;;
        *) append_qsv_node "$candidate_node" ;;
      esac
    done
  else
    qsv_concrete_device="$qsv_device"
    while [ "$qsv_concrete_device" != "/" ] && [ "$qsv_concrete_device" != "${qsv_concrete_device%/}" ]; do
      qsv_concrete_device="${qsv_concrete_device%/}"
    done
    append_qsv_node "$qsv_concrete_device"
  fi

  if [ -n "$qsv_nodes" ]; then
    echo "ToastTV: Intel QSV render access prepared for $qsv_nodes"
  else
    echo "ToastTV: Intel QSV requested, but no render node is available at $qsv_device; the startup probe will use CPU fallback" >&2
  fi
fi

echo "ToastTV: starting as $requested_owner with supplemental groups ${supplemental_groups:-none}"
if [ -n "$supplemental_groups" ]; then
  exec setpriv \
    --reuid "$toasttv_uid" \
    --regid "$toasttv_gid" \
    --groups "$supplemental_groups" \
    -- "$@"
fi

exec setpriv \
  --reuid "$toasttv_uid" \
  --regid "$toasttv_gid" \
  --clear-groups \
  -- "$@"
