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
mkdir -p /app/data /app/data/thumbnails /app/data/artwork /app/data/transcode

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
  chown "$requested_owner" /app/data/thumbnails /app/data/artwork /app/data/transcode
fi

exec gosu "$requested_owner" "$@"
