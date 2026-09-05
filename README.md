<p align="center">
  <img src="branding/dialden/dialden-icon.png" width="160" height="160" alt="Dialden television logo">
</p>

<h1 align="center">Dialden</h1>
<p align="center"><strong>Your library. Your channels.</strong></p>

Dialden turns a local TV and movie collection into continuously scheduled
home channels. It provides a browser administration UI, deterministic channel
guides, station bumpers and fillers, direct media delivery, continuous HLS, and
an LG webOS client.

This fork is designed primarily as a headless Docker service for Unraid and
other trusted home-LAN deployments. It keeps programme libraries read-only and
stores its database, metadata, artwork, schedules, and configuration in
persistent appdata.

> Dialden currently has no login or parent-account boundary. Do not expose the
> administration port to the public internet or an untrusted network.

## About the name

Dialden was previously called **ToastTV Other** and is built on
[yvg/toasttv](https://github.com/yvg/toasttv). The new identity appears in the
admin interface and LG app. Existing Docker image names, environment variables,
appdata paths, repository links, and the webOS application ID remain compatible;
you do not need to move your library or recreate your configuration.

## What it does

- Indexes separate TV and movie roots without changing source media.
- Enriches shows, episodes, and movies with TMDB metadata.
- Prefers English audio when available and otherwise preserves the source
  language.
- Applies a conservative, parent-controlled rating policy.
- Builds editable scheduled channels from local collections and curated network
  or general-mix suggestions.
- Publishes honest Now/Next guides and stable per-channel HLS streams.
- Schedules station-specific bumpers, idents, fillers, and standby loops.
- Supports CPU transcoding and optional Intel Quick Sync with CPU fallback.

## Unraid installation

The template pulls the public multi-architecture image:

```text
ghcr.io/itsrammen/toasttv-other:latest
```

Install the template from an Unraid terminal:

```bash
mkdir -p /boot/config/plugins/dockerMan/templates-user
wget -O /boot/config/plugins/dockerMan/templates-user/my-toasttv-other.xml \
  https://raw.githubusercontent.com/ItsRammen/ToatTV_Other/main/templates/toasttv.xml
```

Open **Docker → Add Container → ToastTV Other** (the existing template name) and configure these paths:

| Name | Example host path | Container path | Access |
| --- | --- | --- | --- |
| Appdata | `/mnt/user/appdata/toasttv` | `/app/data` | Read/write |
| TV Shows | `/mnt/user/Plex/TV Shows` | `/media/tv` | Read-only |
| Movies | `/mnt/user/Plex/Movies` | `/media/movies` | Read-only |
| Station Assets | `/mnt/user/appdata/toasttv/station-assets` | `/media/interludes` | Read/write |

The internal Station Assets path intentionally remains `/media/interludes` for
compatibility. After applying the template, open `http://TOWER:1993` and wait
for the initial library scan to finish.

Unraid can cache registry update checks. If `latest` was recently published but
Unraid reports **up to date**, enable **Advanced View** and choose **Force
Update**. A restart alone does not recreate a container from a newer image.

### Upgrading an existing Unraid installation

Older templates called the fourth mount **Interludes** and mounted it read-only.
To enable uploads and generated bumpers:

1. Edit the Dialden container.
2. Rename the entry to **Station Assets**.
3. Keep its container path as `/media/interludes`.
4. Use a dedicated host directory and change access to **Read/Write**.
5. Apply the template, then enable **Allow station asset changes** in
   **Settings → Library**, or use the enable button on **Station Assets**.
6. Run **Library → Station Assets → Scan bumper files**.

You do not have to rename an existing host directory. A path such as
`/mnt/user/appdata/toasttv/interludes` remains valid when mapped to
`/media/interludes`.

The default container identity is Unraid's `PUID=99` and `PGID=100`. If the
Station Assets directory is not writable, grant that identity access using the
same ownership and permission policy as the rest of your appdata.

## Station Assets library

**Station Assets** is the user-facing name for all short continuity media:
bumpers, idents, duration fillers, and standby loops. The database still uses
the media type `interlude`; that is an implementation detail retained for
backward compatibility.

The recommended host layout is:

```text
station-assets/
  nick/
    bumpers/
      more/
      up-next/
      now-next/
    idents/
    fillers/
    standby/
```

You normally do not need to create the child folders. Open **Library → Station
Assets** and either:

- upload a finished clip and describe what it means;
- design a simple H.264/AAC bumper in the browser; or
- scan existing clips, preview their canonical names, and configure them.

Dialden files new assets into the appropriate station/category directory,
avoids overwriting an existing variant, indexes the result, and applies the
chosen playback decision.

### Canonical filenames

Use lowercase slugs separated by double underscores. The first field is the
channel ID slug. Nickelodeon and Nick Jr. profiles intentionally share `nick`.
Keep a show's year when it is part of the collection identity.

| Purpose | Example |
| --- | --- |
| More of the same show | `nick__bumper-more__show-spongebob-squarepants-1999__target-08s__v01.mp4` |
| A show is up next | `nick__bumper-up-next__next-spongebob-squarepants-1999__target-08s__v01.mp4` |
| Now and next | `nick__bumper-now-next__now-spongebob-squarepants-1999__next-the-fairly-oddparents-2001__target-12s__v01.mp4` |
| Generic ident | `nick__ident-general__target-08s__v01.mp4` |
| Duration filler | `nick__filler-general__target-15s__v01.mp4` |
| Standby loop | `nick__standby-loop__target-60s__v01.mp4` |

`target` documents the intended duration; scheduling uses the duration measured
by FFprobe. Use `v01`, `v02`, and so on for alternatives. Variant choice is
deterministic, so rebuilding the same schedule does not randomly alter it.

Malformed structured names are withheld from automatic matching. Unstructured
legacy clips remain usable as generic assets but cannot participate in exact
station/show matching until configured in the manager.

### Scheduling and selection

Open **Settings → Playback and scheduling → Station assets** to enable scheduled
breaks and choose the number of programmes between them.

At a normal transition Dialden prefers:

1. An exact now/next bumper.
2. A same-show “more” bumper.
3. An up-next bumper.
4. A generic station ident.
5. An unstructured legacy interlude.

At the unused end of a bounded channel slot it prefers duration fillers, then a
standby loop. The final scheduled play can be clipped to end exactly at the
slot boundary, preventing the channel from appearing offline between blocks.
Assets with another station prefix are never borrowed.

For a first Nick test pack, collect two or three generic idents, common
show-specific transitions, fillers around 5/10/15/30/60 seconds, and one clean
60-second standby loop. H.264 video with stereo AAC audio is the safest source
format. Generated clips include a stereo audio stream for smooth transitions.

For the complete contract and pilot checklist, see
[`docs/STATION_ASSETS.md`](./docs/STATION_ASSETS.md).

## Docker Compose

Copy the example environment file and provide your library paths:

```bash
cp docker-compose.env.example .env
docker compose up -d --build
```

Important variables:

```env
TOASTTV_TV_PATH=/path/to/tv
TOASTTV_MOVIE_PATH=/path/to/movies
TOASTTV_STATION_ASSETS_PATH=/path/to/station-assets
TOASTTV_BIND_ADDRESS=127.0.0.1
TZ=UTC
```

`TOASTTV_INTERLUDE_PATH` remains a deprecated Compose fallback for older `.env`
files. New configurations should use `TOASTTV_STATION_ASSETS_PATH`.

The Compose file refuses to create missing source directories. Create the three
host library paths before starting it. Docker Desktop may not expose a mapped
Windows SMB drive to its Linux VM even when Windows can browse it; for media
stored on Unraid, running Dialden directly on Unraid is more reliable.

## First-run configuration

1. Open **Settings → Metadata** and save a TMDB API key, metadata language,
   rating region, and optional fallback regions.
2. Wait for **Library** discovery, probing, and metadata enrichment to finish.
3. Review unknown, unrated, or ambiguous collections under **Needs Review**.
4. Open **Channels** to create or edit a station and its weekly airtime.
5. Open **Library → Station Assets** to scan or add continuity media.
6. Enable and set Station Assets frequency under **Settings → Playback and
   scheduling**.

The default policy automatically allows `G`, `TV-Y`, `TV-Y7`, and `TV-G`;
routes `PG`, `TV-PG`, unknown, unrated, ambiguous, and provider failures to
review; and blocks `PG-13`, `TV-14`, `R`, `TV-MA`, and `NC-17`. Parent decisions
persist across rescans.

TMDB enrichment, artwork, the media index, parent overrides, and channel
definitions persist beneath appdata. The TMDB key stays server-side.

## Channels and playback

The Channels page supports manual schedules, automatic collection mixes,
network-inspired profiles, general public-kids mixes, editable airtime blocks,
and deterministic marathons. **Channel Improvements** provides a compact view
of playable titles and curated additions without opening the lineup builder.

The browser client is available at `/tv/`. Channel streams use a stable HLS URL
across programme and bumper boundaries, with direct-file playback as a fallback.
The dashboard distinguishes a logically on-air schedule from a running FFmpeg
worker.

Useful endpoints include:

```text
GET /api/v1/health
GET /api/v1/channels
GET /api/v1/channels/:id/now
GET /api/v1/channels/:id/guide?hours=8
GET|HEAD /api/v1/channels/:id/live/index.m3u8?clientId=:clientId
GET|HEAD /api/v1/media/:id/stream
```

Mutation routes use `/api/admin/v1`, but that prefix is organization rather
than authentication. Keep the service on a trusted LAN.

## Intel Quick Sync

CPU encoding is the safe default. On Linux or Unraid with a supported Intel
iGPU, map `/dev/dri`, then set:

```env
TOASTTV_TRANSCODING_MODE=auto
TOASTTV_QSV_DEVICE=/dev/dri/renderD128
```

`auto` runs a real startup encode probe and falls back to software if the
device, permission, driver, or encoder is unavailable. In Unraid, map the host
`/dev/dri` directory using **Intel GPU Device Mapping**; the FFmpeg setting must
still point to a concrete `renderD*` node. Changing these process settings
requires a container restart.

## Data safety and troubleshooting

- Back up `/mnt/user/appdata/toasttv` with the container stopped before copying
  raw SQLite files.
- Never use `docker compose down -v` unless you intend to delete the named data
  volume.
- Use **Rescan** after NAS changes because bind-mount file notifications can be
  unreliable.
- Check `docker compose logs -f toasttv` or the Unraid container log when a
  scan, FFmpeg worker, or hardware probe fails.
- If files are indexed but no collections exist, verify TV and movie mounts are
  exactly `/media/tv` and `/media/movies`, then rescan.

## LG webOS client

Preview the client at `http://SERVER:1993/tv/`. Packaging, sideloading, remote
navigation, and codec notes are in [`docs/WEBOS.md`](./docs/WEBOS.md).

## Development

The project requires Bun 1.3.6.

```bash
bun install --frozen-lockfile
bun tsc --noEmit
bun test
docker compose up -d --build
```

Pushes to `main` run CI and publish `linux/amd64` and `linux/arm64` images tagged
`latest` and `sha-<commit>` to GitHub Container Registry.

Architecture and design references:

- [`docs/DOCKER-WEBOS-MIGRATION.md`](./docs/DOCKER-WEBOS-MIGRATION.md)
- [`docs/continuous-channel-architecture.md`](./docs/continuous-channel-architecture.md)
- [`docs/era-stations.md`](./docs/era-stations.md)
- [`docs/SEAMLESS_TRANSPORT_SWITCH.md`](./docs/SEAMLESS_TRANSPORT_SWITCH.md)

## TMDB attribution

This product uses the TMDB API but is not endorsed or certified by TMDB.

## License

See [`LICENSE`](./LICENSE).
