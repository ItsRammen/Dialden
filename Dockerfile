# syntax=docker/dockerfile:1

ARG BUN_VERSION=1.3.6

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

# The ffmpeg package also provides ffprobe. Both are available on Debian's
# amd64 and arm64 architectures. tzdata makes the configurable server timezone
# deterministic on slim container hosts.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ffmpeg \
        gosu \
        tzdata \
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
    TOASTTV_LIBRARY_POLICY=/app/data/kids-7.library.json \
    TOASTTV_MEDIA_READ_ONLY=true \
    TOASTTV_UPDATES_ENABLED=false

COPY --from=build --chown=bun:bun /app/bin/server.js ./bin/server.js
COPY --chown=bun:bun public ./public
COPY --chown=bun:bun clients/webos ./clients/webos
COPY --chown=bun:bun data ./data
COPY --chown=bun:bun data ./defaults
COPY --chown=bun:bun config ./config
COPY --chown=bun:bun config/kids-7.library.json ./defaults/kids-7.library.json
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /media /app/data/thumbnails /app/data/artwork /app/data/transcode \
    && chown -R bun:bun /app /media

EXPOSE 1993
VOLUME ["/app/data"]
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "const value = Number.parseInt(process.env.PORT || '', 10); const port = Number.isInteger(value) && value > 0 && value <= 65535 ? value : 1993; const response = await fetch('http://127.0.0.1:' + port + '/api/v1/health'); if (!response.ok) process.exit(1)"]

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "run", "bin/server.js"]
