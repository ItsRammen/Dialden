# syntax=docker/dockerfile:1

ARG BUN_VERSION=1.3.6
ARG JELLYFIN_FFMPEG_PACKAGE=jellyfin-ffmpeg8

FROM oven/bun:${BUN_VERSION} AS build

WORKDIR /app

# Install only the packages needed to produce the self-contained Bun bundle.
COPY package.json bun.lock .npmrc ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

RUN mkdir -p /app/bin \
    && bun build \
    --target=bun \
    --minify \
    --outfile=/app/bin/server.js \
    ./src/main.ts


FROM oven/bun:${BUN_VERSION} AS runtime

USER root

ARG JELLYFIN_FFMPEG_PACKAGE

# fontconfig and one real font are here for ffmpeg's drawtext filter, which
# renders the station bumpers. drawtext initialises fontconfig even when it is
# handed an explicit fontfile, so both the library and a face must exist or the
# filter fails before drawing anything. DejaVu is the fallback; a station that
# ships its own TTF is used in preference to it.
#
# Jellyfin's pinned FFmpeg build includes its Intel media-driver and oneVPL /
# MediaSDK runtime stack on amd64, while retaining arm64 support for the normal
# software path. ToastTV invokes the binaries directly; it does not embed or
# require a Jellyfin server. tzdata keeps channel timezones deterministic.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        fontconfig \
        fonts-dejavu-core \
        gnupg \
        tzdata \
        util-linux \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/jellyfin.gpg \
    && printf '%s\n' \
        'Types: deb' \
        'URIs: https://repo.jellyfin.org/debian' \
        'Suites: trixie' \
        'Components: main' \
        'Signed-By: /etc/apt/keyrings/jellyfin.gpg' \
        > /etc/apt/sources.list.d/jellyfin.sources \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        "${JELLYFIN_FFMPEG_PACKAGE}" \
    && ln -sf /usr/lib/jellyfin-ffmpeg/ffmpeg /usr/local/bin/ffmpeg \
    && ln -sf /usr/lib/jellyfin-ffmpeg/ffprobe /usr/local/bin/ffprobe \
    && apt-get purge -y --auto-remove curl gnupg \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    PORT=1993 \
    TOASTTV_HEADLESS=true \
    TOASTTV_HOST=0.0.0.0 \
    TOASTTV_CONFIG=/app/data/config.json \
    TOASTTV_DATA=/app/data \
    TOASTTV_DATABASE=/app/data/media.db \
    TOASTTV_MEDIA=/media \
    TOASTTV_TV_MEDIA=/media/tv \
    TOASTTV_MOVIE_MEDIA=/media/movies \
    TOASTTV_LIBRARY_POLICY=/app/data/kids-7.library.json \
    TOASTTV_MEDIA_READ_ONLY=true \
    TOASTTV_TRANSCODING_MODE=software \
    TOASTTV_QSV_DEVICE=/dev/dri/renderD128 \
    TOASTTV_STATION_ASSETS_WRITABLE=false \
    TOASTTV_UPDATES_ENABLED=false

COPY --from=build --chown=bun:bun /app/bin/server.js ./bin/server.js
COPY --chown=bun:bun public ./public
COPY --chown=bun:bun clients/webos ./clients/webos
COPY --chown=bun:bun data ./data
COPY --chown=bun:bun data ./defaults
COPY --chown=bun:bun config ./config
COPY --chown=bun:bun config/kids-7.library.json ./defaults/kids-7.library.json
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /media /app/data/thumbnails /app/data/artwork /app/data/transcode /app/data/streams \
    && chown -R bun:bun /app /media

EXPOSE 1993
VOLUME ["/app/data"]
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "const value = Number.parseInt(process.env.PORT || '', 10); const port = Number.isInteger(value) && value > 0 && value <= 65535 ? value : 1993; const response = await fetch('http://127.0.0.1:' + port + '/api/v1/health'); if (!response.ok) process.exit(1)"]

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "run", "bin/server.js"]
