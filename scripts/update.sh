#!/bin/bash
#
# ToastTV Auto-Update Script
#
# Checks toasttv.eu for a newer version and runs install.sh if available.
# Designed to run unattended via systemd timer.
#
# Usage:
#   sudo bash /opt/toasttv/scripts/update.sh
#

set -euo pipefail

INSTALL_DIR="/opt/toasttv"
VERSION_URL="https://toasttv.eu/version.txt"
CONFIG_FILE="$INSTALL_DIR/data/config.json"
LOCAL_VERSION_FILE="$INSTALL_DIR/data/version.txt"
TAG="toasttv-update"

log()  { logger -t "$TAG" "$1"; }

# Check if auto-update is disabled in config
if [ -f "$CONFIG_FILE" ]; then
    if grep -q '"autoUpdate"[[:space:]]*:[[:space:]]*false' "$CONFIG_FILE" 2>/dev/null; then
        log "Auto-update disabled in config. Skipping."
        exit 0
    fi
fi

# Read local version
CURRENT="unknown"
if [ -f "$LOCAL_VERSION_FILE" ]; then
    CURRENT=$(cat "$LOCAL_VERSION_FILE")
fi

# Fetch latest version from toasttv.eu
LATEST=$(curl -sf --max-time 10 "$VERSION_URL" | tr -d '[:space:]') || {
    log "Failed to fetch latest version from $VERSION_URL"
    exit 0
}

if [ -z "$LATEST" ]; then
    log "Empty version response from $VERSION_URL"
    exit 0
fi

# Compare versions
if [ "$CURRENT" = "$LATEST" ]; then
    log "Already on latest version ($CURRENT). No update needed."
    exit 0
fi

log "Update available: $CURRENT → $LATEST. Starting update..."

# Run the install script with the target version
export VERSION="$LATEST"
curl -fsSL "https://raw.githubusercontent.com/yvg/toasttv/main/scripts/install.sh" | bash

log "Update to $LATEST complete."
