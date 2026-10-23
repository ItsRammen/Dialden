#!/usr/bin/env bash
# Build the separate native TV package with LG HLS playback; no desktop mpv decoder.
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
: "${WEBOS_SDK:?Set WEBOS_SDK to the relocated official arm-webos-linux-gnueabi SDK}"
: "${DIALDEN_SERVER:?Set DIALDEN_SERVER to the server URL for this private test package}"
# ARMv7 TVs support VFP/NEON. Keep the eabi calling convention, but do not
# emulate every floating-point operation in the CPU-heavy UI/font code.
export CARGO_TARGET_ARMV7_UNKNOWN_LINUX_GNUEABI_RUSTFLAGS="-C target-feature=-soft-float,+vfp3,+neon ${CARGO_TARGET_ARMV7_UNKNOWN_LINUX_GNUEABI_RUSTFLAGS:-}"
export CC_armv7_unknown_linux_gnueabi="$WEBOS_SDK/bin/arm-webos-linux-gnueabi-gcc"
export AR_armv7_unknown_linux_gnueabi="$WEBOS_SDK/bin/arm-webos-linux-gnueabi-ar"
export CARGO_TARGET_ARMV7_UNKNOWN_LINUX_GNUEABI_LINKER="$CC_armv7_unknown_linux_gnueabi"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$project_dir/target}"
package_output="${DIALDEN_PACKAGE_OUTPUT:-$project_dir/dist}"
mkdir -p "$package_output"
package_output="$(cd "$package_output" && pwd)"
cd "$project_dir"
cargo build --locked --release --target armv7-unknown-linux-gnueabi --no-default-features --features webos
stage="$(mktemp -d "${TMPDIR:-/tmp}/dialden-native-package.XXXXXX")"
trap 'rm -rf -- "$stage"' EXIT
cp webos/appinfo.json webos/icon.png webos/largeIcon.png "$stage/"
cp "$CARGO_TARGET_DIR/armv7-unknown-linux-gnueabi/release/dialden-native" "$stage/"
python3 - "$DIALDEN_SERVER" "$stage/server.txt" <<'PY'
import sys,urllib.parse,pathlib
u=urllib.parse.urlsplit(sys.argv[1])
if u.scheme not in ('http','https') or not u.hostname or u.username or u.password or u.path not in ('','/') or u.query or u.fragment:
    raise SystemExit('DIALDEN_SERVER must be a server origin without credentials, path, query or fragment')
pathlib.Path(sys.argv[2]).write_text(sys.argv[1].rstrip('/')+'\n')
PY
"$WEBOS_SDK/bin/arm-webos-linux-gnueabi-strip" "$stage/dialden-native"
"$WEBOS_SDK/bin/arm-webos-linux-gnueabi-readelf" -d "$stage/dialden-native" > "$package_output/native-dependencies.txt"
"$WEBOS_SDK/bin/arm-webos-linux-gnueabi-readelf" --version-info "$stage/dialden-native" > "$package_output/native-symbol-versions.txt"
ares-package --no-minify --outdir "$package_output" "$stage"
printf '%s\n' 'Built a native TV playback preview. Validated on webOS 6.5.3; check firmware compatibility before other TV installs.'
