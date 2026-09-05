# ToastTV Docker and webOS Migration Audit

Status: repository audit complete; the headless server, deterministic Kids 7
channels, safe direct-play endpoint, browser reference client, and packaged
webOS MVP are implemented. HLS fallback, authentication/pairing, and physical-TV
compatibility validation remain future stages. Sections 1-9 describe the
upstream ToastTV `0.6.4` baseline at commit `f63005e`, while explicit **current
fork** notes describe changes in this working tree. Sections 10 onward describe
the target architecture unless marked as implemented.

The governing rule is:

> ToastTV decides what is airing and when it is airing. A playback client decides how to render it.

## 1. Current architecture

ToastTV is a Bun application with a Hono management server, SQLite persistence, a media indexer, an in-memory playlist/session engine, and one local MPV player. `ToastTVDaemon` is both the composition root and the coordinator for device services.

```text
main.ts
  |
  +-- ToastTVDaemon.init()
  |     +-- ConfigRepository
  |     +-- MediaRepository (SQLite)
  |     +-- HardwareDetectionService
  |     +-- MediaIndexer / FFProbeClient / ThumbnailClient
  |     +-- PlaylistEngine / SessionManager
  |
  +-- ToastTVDaemon.start()
  |     +-- MpvClient.connect()            <-- fatal startup gate upstream
  |     +-- background media scan/watch
  |     +-- PlaybackService
  |     +-- CECClient / TVDetectionService
  |
  +-- createServer()
  |     +-- dashboard, library, settings, playback controllers
  |     +-- dashboard SSE
  |
  +-- Bun.serve(:1993)
  +-- PlaybackService MPV synchronization loop
```

The layer shape documented by the project is sound:

```text
Controllers -> Services -> Repositories -> Clients
```

The problem is not the existence of those layers. The problem is that the composition root and the only playback state are centered on one local HDMI device.

### Application entry points and framework

- `package.json` selects `src/main.ts`, Bun `1.3.6`, and Hono `4.11.7`.
- `src/main.ts` initializes and starts the daemon, creates the Hono app, starts `Bun.serve`, then starts the MPV synchronization loop.
- `src/server.ts` builds the Hono application, mounts static assets and controllers, and returns the global `PlaybackService` to `main.ts`.
- The management UI is server-rendered HTML enhanced with HTMX. The shared layout currently loads HTMX from `unpkg.com`, which is an offline-LAN reliability risk.
- The configured `server.port` stored in SQLite is not used by `main.ts`; the process-level `PORT` value wins.

### Current HTTP surface

The upstream baseline exposes:

- dashboard, library, and settings pages;
- library scan/upload and media metadata mutations;
- global session start/stop/pause/skip/shuffle controls;
- a global dashboard SSE feed at `/events/dashboard`;
- static assets and thumbnails.

The current fork additionally exposes `GET /api/v1/health`, deterministic
channel list/now/guide responses, same-origin channel administration at
`/channels` and `/api/admin/v1/channels`, and `GET`/`HEAD` direct media delivery
with single-range support. Channel definitions and manual off-air switches are
applied live and stored atomically in `/app/data/channels.json`. It serves the
browser reference client at `/tv/`, and the
same files form the packaged webOS client. In Docker headless mode it keeps
management routes available but returns `503` from legacy local-playback
mutations, disables media upload and catalog deletion for the read-only library,
and disables bare-metal self-update. It does not yet expose HLS, client
registration, pairing, signed media URLs, or channel-scoped events.

## 2. Relevant source files and ownership

Classification:

- **A**: platform-independent or reusable with limited hardening;
- **B**: Raspberry Pi or bare-metal deployment specific;
- **C**: playback-device or single-viewer specific.

| Area | Source | Class | Current responsibility | Migration treatment |
|---|---|---:|---|---|
| Entry point | `src/main.ts` | C | Boots daemon, HTTP server, and local playback loop | Keep HTTP boot; make local playback optional |
| Composition root | `src/daemon.ts` | B/C | Constructs database, indexing, MPV, Pi profile, CEC, global session | Split core server composition from legacy local-device adapter |
| Hono app | `src/server.ts` | A | Static UI, controllers, SSE | Preserve and add versioned playback APIs |
| Runtime config | `src/repositories/ConfigRepository.ts` | A | JSON bootstrap paths plus SQLite settings | Preserve; make container paths explicit and add migration-safe settings |
| Media database | `src/repositories/MediaRepository.ts` | A | File catalog, collections, cached metadata, ratings, policy, and overrides | Preserve stable file IDs and explicit overrides; evolve through the schema ledger |
| Repository contract | `src/repositories/IMediaRepository.ts` | A | File, collection, metadata-queue, policy, and summary persistence | Preserve; split contracts only when scheduling/client persistence requires it |
| File scan | `src/services/MediaIndexer.ts` | A/B | Root discovery, collection detection, changed-file probing, and scan state | Keep independent from online enrichment and retain fail-closed root/probe gates |
| Metadata enrichment | `src/services/metadata/*`, `src/clients/TmdbClient.ts` | A | Cached, sequential TMDB matching, rating resolution, and policy evaluation | Keep behind `MetadataProvider`; never call providers per episode or page view |
| Collection library | `src/services/CollectionLibraryService.ts`, collection controllers/templates | A | Collection summary/search/review, season detail, and parent actions | Primary library workflow; retain the flat file view as an advanced fallback |
| Channel administration | `src/services/ChannelService.ts`, `src/services/ChannelConfigurationStore.ts`, `src/controllers/ChannelController.ts`, `src/templates/channelAdministration.ts` | A | Computed channel timelines plus live CRUD, enable/off-air controls, and atomic JSON persistence | Preserve the API/editor; normalize only if revision history or transactional schedule generation requires it |
| Filesystem/probe | `src/clients/FilesystemClient.ts` | A | Recursive file listing/watch and ffprobe | Retain after root validation and richer probe data |
| Thumbnail generation | `src/clients/ThumbnailClient.ts` | A | FFmpeg thumbnails under data directory | Retain with configurable persistent root |
| Media business logic | `src/services/MediaService.ts` | A | List, type/date updates, logo and media deletion | Retain after read-only mount and path-safety work |
| Playlist engine | `src/services/PlaylistEngine.ts` | A/C | Random per-session queue, intro/outro, interludes, safe mode | Extract reusable sequence rules; do not use mutable viewer state as a channel |
| Session manager | `src/services/SessionManager.ts` | A/C | In-memory session timer and daily quota counters | Reuse policy ideas only after scope/persistence is defined |
| Playback orchestration | `src/services/PlaybackService.ts` | C | Controls one player and follows MPV file transitions | Keep only as a legacy Pi adapter; replace centrally with channel services |
| MPV adapter | `src/clients/MpvClient.ts` | C | JSON IPC, enqueue, status, MPV overlays | Legacy local-player adapter only |
| CEC adapter | `src/clients/CECClient.ts` | B/C | CEC process, TV power, remote keys | Remove from server path; keep only for legacy Pi target |
| TV detection | `src/services/TVDetectionService.ts` | C | Turns one TV's power/input state into global session state | Not part of server architecture |
| Pi detection | `src/services/HardwareDetectionService.ts` | B | Chooses Raspberry Pi decoder profile | Replace server use with client capability negotiation |
| Hardware profiles | `src/config/hardwareProfiles.ts` | B/C | Pi codec/resolution limits | Legacy Pi only; do not apply to indexed server media |
| Dashboard SSE | `src/services/DashboardEventService.ts` | A/C | MPV events plus scan and metadata progress fanout | Reuse transport; add channel-scoped events when durable schedules land |
| Client presence | `src/services/ClientPresenceService.ts`, `src/controllers/ClientPresenceController.ts` | A | Ephemeral heartbeat-derived online/viewer telemetry | Operational signal only; replace with authenticated persisted clients during pairing work |
| Admin UI | `src/controllers/*`, `src/templates/*`, `public/*` | A/C | Collection library, review, metadata settings, channels, and legacy local controls | Headless dashboard is broadcast-oriented; legacy controls remain isolated to local mode |
| MPV assets | `data/mpv.conf`, `scripts/logo.lua`, `scripts/tvguide.lua` | C | Local HDMI presentation | Legacy Pi packaging only |
| Installer/update | `scripts/install.sh`, `scripts/update.sh`, `Makefile` | B | Bare-metal Pi packages and services | Keep as legacy distribution; Docker uses separate artifacts |

## 3. Current playback flow

Upstream playback is viewer-started and imperative:

```text
CEC or POST /api/session/start
        |
        v
PlaybackService.startSession()
        |
        v
PlaylistEngine.startSession()
  - refresh catalog and config
  - create random ShuffleDeck
  - build a queue from the full session limit
  - inject intro/interludes/outro
  - select item zero
        |
        v
MpvClient.play(local filesystem path)
MpvClient.enqueue(next local filesystem path)
        |
        v
PlaybackService polls MPV status
        |
        v
MPV path changes -> PlaylistEngine.getNextVideo()
```

Consequences:

- no viewer means no running channel;
- opening at 16:13 creates a fresh random session at offset zero;
- current position is MPV's `time-pos`, not a server timeline calculation;
- application restart loses queue, current item, and quota state;
- there is one engine, session, player, and dashboard state for the whole process;
- a second client cannot independently tune a channel;
- `IMediaPlayer` has no seek operation, because live joining was not part of the current design.

This flow must remain available only as a compatibility path for existing Pi installations. The LG application must not be implemented as another `IMediaPlayer` controlled imperatively by the server.

## 4. MPV dependencies

The fatal upstream Docker blocker is `ToastTVDaemon.start()` awaiting `MpvClient.connect()` before the Hono server is created. `MpvClient` makes ten attempts with a two-second retry delay and then throws. Without the pre-started Unix socket at `/tmp/toasttv-mpv.sock`, port `1993` is never bound.

MPV-specific behavior also appears in:

- path-based play and enqueue operations;
- file-transition detection by comparing MPV's path with `PlaylistEngine.currentVideo`;
- local pause, skip, stop, and loop operations;
- local logo preprocessing and Lua messages;
- TV guide Lua overlay messages;
- the bare-metal Makefile and installer, which start MPV before ToastTV.

The initial migration adds a disabled media-player adapter only to keep legacy management-service dependencies bootable. Headless mode does not connect to MPV, start the playback loop, or allow legacy playback mutations. This adapter is transitional, not the future remote-client interface.

## 5. CEC dependencies

CEC is not normally fatal because failures are caught, but it is deeply tied to one local TV:

- `CECClient` spawns `cec-client`, parses power/input/key events, and uses a Unix shell for power queries.
- `TVDetectionService` converts one TV's power state into global session start/stop.
- CEC keys directly call global `PlaybackService` methods and the MPV guide overlay.
- CEC defaults to enabled and its runtime settings are not fully persisted by `ConfigRepository.update()`.
- A heartbeat timer is created even when no CEC client is useful.

The Docker server must not initialize CEC. Remote keys belong inside each TV client and should affect only that client's overlays/local pause behavior, not a global channel clock.

## 6. Raspberry Pi-specific dependencies

`HardwareDetectionService` reads `/proc/device-tree/model`, runs `free -m`, and maps the result to Pi-specific profiles. Missing Pi information falls back without aborting, but the `unknown` profile is a conservative playback-device profile rather than a meaningful server capability.

Using server hardware to label media compatible or incompatible is incorrect once clients render media. The current headless seam passes no hardware detector to `MediaIndexer`, suppresses the Pi-specific HEVC warning, and avoids Pi profile classification. It still records the transitional default `compatibility = 'compatible'` and stores only the repository's limited codec/width/height fields; this is not yet a complete neutral capability record. A later `PlaybackDecisionService` must combine expanded neutral probe facts with the authenticated requesting client's capability profile.

Other Pi/bare-metal assumptions include system package installation, systemd layout, `/opt/toasttv`, MPV/DRM/KMS configuration, HDMI, CEC utilities, and the self-update script.

## 7. Existing reusable services

The following behavior should be preserved rather than rewritten:

- SQLite media/settings persistence and stable media IDs, subject to migration fixes;
- recursive media discovery, extension filtering, mtime-based probing, filename cleanup, and thumbnail generation;
- intro/outro/off-air media conventions;
- seasonal interlude date rules after timezone/date-format corrections;
- interlude frequency and no-repeat shuffle concepts;
- configuration, library, and settings management UI;
- Hono routing and SSE fanout patterns;
- injected date/time and external-client interfaces used by tests.

The playlist logic should be decomposed into a pure or deterministic sequence builder. It may decide ordering and interlude placement, but it must not own the authoritative wall clock or a viewer-started timer.

## 8. Current database models relevant to playback

SQLite now separates file facts from collection-level metadata and decisions.

### `media`

Alongside the legacy playback/probe fields, each managed file has a stable
`(root_id, relative_path)` locator, `library_kind`, `collection_id`, parsed
season/episode fields, root availability, and a compatibility projection of the
effective collection decision. The original absolute path remains for the
legacy local Pi player; remote delivery resolves the stable locator through the
canonical media boundary.

### `media_collections`

One TV series or movie owns cached provider metadata, match state/candidates,
raw certification and region, policy decision/reason/version, and the explicit
parent override. The effective decision is:

```text
parent_override ?? policy_decision
```

Missing, ambiguous, unrated, provider-error, and unconfigured states are never
projected as playable. A manual TMDB confirmation locks the external match, and
file rescans update presence without deleting metadata or parent decisions.

### `settings` and `schema_migrations`

`settings` retains the legacy key/value configuration. `schema_migrations`
records the collection migration; older per-file explicit overrides are
preserved, while old automatically generated policy booleans are not promoted
to trusted collection approval.

Channel definitions and manual off-air switches are durable in
`/app/data/channels.json`, but there are still no channel, program, timeline,
authenticated client, credential, capability, pairing, probe-cache, or
transcode-job tables. Computed program rows and timeline revisions remain
unmaterialized.

### Database implications for the target schedule design

Keep the implemented file/collection tables, then introduce these durable
scheduling and client concepts through additional versioned migrations:

```text
channels
  id, name, enabled, timezone, active_schedule_revision

schedules
  id, name, timezone, enabled, revision

programming_rules
  id, schedule_id, position, rule_type, rule_json

channel_programs (or generated schedule window)
  id, channel_id, media_id, kind, sequence,
  scheduled_start_ms, scheduled_end_ms, revision

clients
  id, name, platform, platform_version,
  capabilities_json, token_digest, selected_channel_id, last_seen_ms

media_probe (or expanded media columns)
  container, video_codec/profile/level, audio_codec/channels,
  width, height, fps, bitrate, duration_ms, probe_version, probe_error

transcode_cache (optional after the single-process MVP works)
  cache_key, media_id, capability_profile, state, path, last_access_ms
```

`schedules` and `programming_rules` are the durable source used to generate a rolling window of `channel_programs`; materialized rows are not themselves sufficient to explain or extend a channel. For the first single-channel migration, a schedule may adapt the existing playlist/interlude settings, but that mapping must be explicit, versioned, and deterministic. Generate a replacement window under a new revision and activate it atomically so API readers never observe a partially rebuilt guide.

Use millisecond precision or exact media time-base information. Whole-second duration flooring can accumulate timeline error across long schedules.

Store a stable logical locator relative to a configured media root rather than treating a container-specific absolute path as identity. All resolution must canonicalize the final path and verify it remains inside an allowed root.

### Persistence findings and current milestone status

The current fork fixes immediate data-loss/correctness defects from the audited baseline:

- `MediaRepository.upsertMedia()` and `upsertBatch()` now persist extended probe fields and the compatibility value computed by the indexer;
- TV, movie, and interlude rows have stable `(root_id, relative_path)` locators in addition to their current absolute playback path;
- scans reconcile each successfully traversed root independently. Missing or incompletely traversable roots preserve their catalog rows and parent overrides but are quarantined from playback; a successfully traversed empty root is reconciled as intentionally empty. An individual ffprobe failure gates only that zero-duration item while the otherwise complete root can become available;
- each show/movie is grouped into a persistent collection before files are upserted. Existing explicit parent overrides survive migration and rescans, while legacy automatic allowlist results are recalculated;
- filesystem probing is independent of approval, and online metadata matching is a separate cached sequential job. Missing TMDB configuration or any uncertain/error state resolves to review;
- the configurable Kids 7 rating policy stores `allow`, `review`, or `block` plus its reason. Only a current root, positive duration, and effective `allow` decision can enter playback or scheduling;
- the Kids 7 policy seeds deterministic clock-driven channels and collection-to-group membership. `ChannelConfigurationStore` applies an editable appdata override, including persistent manual off-air switches, while `channels`, `now`, and bounded `guide` remain read-only playback endpoints. Generated timelines are currently computed rather than durably materialized.

The following persistence work remains before normalized/materialized channel scheduling:

- fps/bitrate are probed but not stored, and container/audio facts are not collected;
- headless indexing still uses the transitional default compatibility label rather than a versioned neutral probe record;
- absolute playback paths remain transitional, but path-prefix changes retain row IDs through stable root-relative locators;
- daily quota, queue, and session state are in memory only;
- several configuration fields are read but not seeded or persisted on update;
- the collection migration has a schema ledger, but durable schedule revisions and their transactional migrations do not exist yet.

## 9. Existing scheduling and timeline behavior

The repository now has a deterministic `ChannelService` driven by day/time/group
slots, an injected clock, exact timezone-to-UTC conversion, and stable seeded
ordering. The policy supplies defaults; the browser/admin CRUD surface applies
changes live and atomically stores channel definitions plus manual off-air state
in `/app/data/channels.json`. `/api/v1/channels`,
`/api/v1/channels/:id/now`, and `/api/v1/channels/:id/guide` expose the computed
timeline. This is deliberately smaller than the target model: collection group
membership still comes only from exact startup-policy root/collection entries,
there is no group-assignment editor, there are no schedule/program tables or
atomic materialized revisions, and the legacy local-player queue remains
session-random rather than channel-time based.

Interludes are chosen randomly when a per-session count reaches a configured frequency. Seasonal eligibility comes from filename-derived `MM-DD` ranges and SQLite filtering. `SystemDateTimeProvider.today()` uses a UTC ISO date, while `SessionManager` uses host-local date/hour. Docker `TZ`, seasonal selection, and quota reset can therefore disagree.

`SessionManager` is useful policy scaffolding but does not currently enforce a persistent daily quota:

- watched minutes are accumulated only when a session ends;
- paused wall time counts;
- active elapsed time is not subtracted from the reported daily remainder;
- `quotaExhausted` is not used to stop queue generation;
- restarting resets the counters.

### Required channel timeline semantics

The implemented service follows these boundary semantics with whole-second
media durations; the target durable contract must retain them while adding
sub-second probe precision:

```text
program is current when start <= serverNow < end
offsetMs = serverNowMs - scheduledStartMs
offsetMs is clamped to [0, durationMs)
offsetSeconds = offsetMs / 1000 only when a client needs seconds
exact end belongs to the next program
```

`offsetMs` is authoritative and must retain sub-second precision; do not floor each item to whole seconds. The API should include `serverTime`, preferably also `serverTimeMs`, and a timeline/schedule revision. Prefer storing instants as UTC epoch milliseconds and serializing ISO 8601 with an explicit offset or `Z`. A channel keeps advancing whether zero, one, or many clients are tuned to it.

## 10. Proposed refactor boundaries

```text
MediaIndexer / MediaRepository
  stores neutral catalog and probe facts
             |
             v
ProgrammingSequenceBuilder
  extracts reusable PlaylistEngine ordering/interlude rules
             |
             v
ScheduleService
  materializes or deterministically anchors timed programs
             |
             v
ChannelService
  resolves now/next/guide from server time
             |
       +-----+------------------+
       |                        |
       v                        v
MediaService              ClientService
validated ID->path        identity/capabilities/channel/heartbeat
       |                        |
       +-----------+------------+
                   v
          PlaybackDecisionService
           DIRECT_PLAY or HLS
                   |
          +--------+---------+
          |                  |
          v                  v
    StreamingService   TranscodeService
    HTTP Range/MIME    FFmpeg/HLS cache
```

Recommended boundaries:

- **ProgrammingSequenceBuilder**: ordered items only; deterministic seed or persisted output; no viewer state.
- **ScheduleService**: program start/end instants, revisions, rolling schedule window, timezone conversion.
- **ChannelService**: current program, offset, next, guide, server time.
- **MediaResolver**: media ID to canonical allowed path; no raw client paths.
- **PlaybackDecisionService**: neutral media probe plus client capability profile.
- **StreamingService**: conditional requests, MIME, `HEAD`, single-range `206`, `Content-Range`, and safe seeking.
- **TranscodeService**: one-server FFmpeg jobs and cache keyed by media plus an allow-listed output profile/settings; owns source-time-to-playlist-time mapping and job cleanup.
- **ClientService**: registration, token, capability, selected channel, last-seen; no ownership of channel time.
- **LegacyLocalPlayback module**: current MPV/CEC/Pi services isolated from the default server deployment.

## 11. Proposed API schema

Playback APIs should be versioned and distinct from management APIs.

### Channels

```http
GET /api/v1/channels
```

```json
{
  "serverTime": "2026-08-23T16:13:10.000+08:00",
  "serverTimeMs": 1787472790000,
  "channels": [
    { "id": "kids", "name": "Kids", "enabled": true }
  ]
}
```

```http
GET /api/v1/channels/:channelId/now
```

```json
{
  "channelId": "kids",
  "serverTime": "2026-08-23T16:13:10.000+08:00",
  "serverTimeMs": 1787472790000,
  "timelineRevision": "2026-08-23-kids-r4",
  "program": {
    "id": "program-abc123",
    "mediaId": "382",
    "title": "Bluey - S01E02",
    "scheduledStart": "2026-08-23T16:09:00.000+08:00",
    "scheduledEnd": "2026-08-23T16:16:00.000+08:00",
    "offsetMs": 250000,
    "offsetSeconds": 250.0,
    "durationMs": 420000,
    "durationSeconds": 420,
    "playback": {
      "mode": "direct",
      "url": "/api/v1/media/382/stream"
    }
  },
  "next": {
    "id": "program-def456",
    "title": "ToastTV Interlude",
    "startsAt": "2026-08-23T16:16:00.000+08:00"
  }
}
```

```http
GET /api/v1/channels/:channelId/next
GET /api/v1/channels/:channelId/guide?from=<ISO>&to=<ISO>
```

Guide items must include stable program IDs, start/end instants, media availability, and enough information for Now/Next. Apply a bounded maximum guide window.

### Media

```http
HEAD /api/v1/media/:mediaId/stream
GET  /api/v1/media/:mediaId/stream
GET  /api/v1/media/:mediaId/hls/:playbackId/master.m3u8  (future)
```

The stream route accepts no filesystem path. Direct playback supports HTTP
Range requests and returns correct `Accept-Ranges`, `Content-Range`,
`Content-Length`, MIME, `206`, and `416` behavior. A full `200` response does
not need `Content-Range`; a `416` response uses
`Content-Range: bytes */<full-length>`.

`playbackId` is an opaque, server-issued reference to an allow-listed output decision, not a client-supplied FFmpeg profile or argument. The client must use the `playback.url` returned by the authoritative `now` response rather than constructing a transcode URL. A relative URL is resolved against the saved ToastTV server base, not the packaged app's origin; returning an absolute URL is also acceptable.

### Clients

```http
POST /api/v1/clients/register
POST /api/v1/clients/:clientId/heartbeat
PUT  /api/v1/clients/:clientId/channel
GET  /api/v1/client/config
```

Registration records platform and capability information and returns a scoped credential. Tokens should be stored as digests. Pairing can later authorize registration without changing channel APIs. A client ID present in a path must match the authenticated credential's subject or an authorized administrator.

Do not trust a `clientId` or capability/transcode profile supplied in a query string. Once registration exists, authenticate the request and derive client identity and capabilities from the scoped credential. An anonymous LAN MVP should use a conservative server-side profile.

Bearer delivery needs a separate design for media elements: a normal HTML `<video src>` request, an HLS manifest, and its segment requests cannot reliably attach the API's custom `Authorization` header. Viable approaches are short-lived signed URLs for the manifest/file and every segment, a carefully scoped cookie supported on target TVs, or a same-origin hosted UI. Signed URLs must remain usable for expected Range/segment requests and have a refresh path before expiry. Do not put a long-lived client token in playback URLs or logs.

### Events and health

```http
GET /api/v1/events
GET /api/v1/health
GET /api/v1/server/info
```

Example event:

```json
{
  "type": "channel.program.changed",
  "channelId": "kids",
  "programId": "program-def456",
  "timelineRevision": "2026-08-23-kids-r4",
  "serverTime": "2026-08-23T16:16:00.020+08:00",
  "serverTimeMs": 1787472960020
}
```

SSE or WebSocket is a latency optimization. Clients must retain timed polling/reconciliation as a fallback and refetch authoritative `now` state after reconnect.

### Clock synchronization and drift

For each clock sample the client records local send time `t0` and receive time `t1`, then estimates server clock offset using the response's `serverTimeMs` against the local midpoint `(t0 + t1) / 2`. Prefer the lowest-round-trip samples, discard obvious latency outliers, and refresh the estimate periodically and after reconnect. Expected playback position is the authoritative `offsetMs` advanced by estimated server elapsed time, not by the TV's wall clock alone.

Reconcile near the scheduled end and approximately every 30-60 seconds. As initial policy, ignore drift below one second; on LG use a direct seek for drift above roughly three seconds and tune the one-to-three-second behavior through device testing. Do not require playback-rate correction on webOS because LG documents only rate `1.0`.

### HLS live-join lifecycle

Starting a new FFmpeg process at source time zero when a viewer joins several minutes into a program is not acceptable: it delays the core live-join behavior until the transcode catches up. The first HLS design must choose and test one of these explicit mappings:

1. a complete or sufficiently pre-generated VOD rendition cached by media ID and allow-listed profile, with the segment covering the requested offset available before the URL is issued, in which HLS time remains source-media time and the client seeks to `offsetMs`; or
2. an offset-anchored playback job whose manifest time zero maps to a recorded source offset, with the API returning that mapping so client seeks and later reconciliation remain correct.

Jobs shared by multiple clients must share only when media identity, probe version, output profile/settings, and timeline mapping are compatible. Publish manifests/segments atomically, define when `EXT-X-ENDLIST` appears, retain segments needed by late joiners, and bound disk use with reference/access tracking, failure cleanup, and shutdown cleanup. Direct play or a conservative transcode failure screen must remain available when an HLS job cannot start.

## 12. Docker migration requirements

### Initial implementation

The initial headless milestone now provides:

- `TOASTTV_HEADLESS=true`, which skips MPV, the MPV loop, CEC, TV detection, and Pi hardware classification;
- a transitional disabled player satisfying legacy dependency injection without creating fake sessions;
- legacy playback mutation routes return `503` in headless mode;
- `TOASTTV_DATA`, `TOASTTV_DATABASE`, `TOASTTV_MEDIA`, `TOASTTV_TV_MEDIA`, `TOASTTV_MOVIE_MEDIA`, `TOASTTV_LIBRARY_POLICY`, `TOASTTV_CONFIG`, `TOASTTV_HOST`, `TOASTTV_MEDIA_READ_ONLY`, `TOASTTV_UPDATES_ENABLED`, and `PORT` process settings;
- a shared `TOASTTV_DATA` path helper for thumbnails, logo uploads, update logs, and static thumbnail serving, while the database defaults beneath the same directory and the bootstrap config path remains explicitly configurable;
- a multi-stage Bun `1.3.6` Dockerfile with FFmpeg/ffprobe, a non-root runtime, and dependency installation locked by committed `bun.lock` plus `bun install --frozen-lockfile --production`;
- Compose persistence at `/app/data`, separate read-only `/media/tv` and `/media/movies` mounts, a narrowly writable Station Assets mount at the compatibility path `/media/interludes`, plus a read-only policy mount. Required bind sources use `create_host_path: false`;
- `TOASTTV_MEDIA_READ_ONLY=true`, which replaces the upload UI with host-mount guidance, hides delete controls, and rejects both `POST /api/upload` and `DELETE /api/media/:id` with `403`; writable-mode filenames are reduced to a single basename, checked for canonical root containment, and rejected when the destination is a symlink;
- `TOASTTV_UPDATES_ENABLED=false`, which skips update checks and rejects the bare-metal apply flow inside the container; Docker deployments update by rebuilding/redeploying the image;
- unavailable roots preserve their index while successful empty roots reconcile; stable locators survive mount-prefix changes, and batch indexing persists computed compatibility values;
- collection-first TV/movie indexing, cached sequential TMDB enrichment, configurable rating policy, persistent parent overrides, and metadata/approval review queues;
- fail-closed collection eligibility, independent probing, root-availability gating, and deterministic Kids 7 channel/now/guide APIs;
- collection/season library pages, separate scan and metadata progress over SSE, cached size-restricted artwork, and a headless dashboard backed by real channel/library/client state;
- ephemeral webOS client heartbeats plus editable channel CRUD, previewed catalog-driven station automation, persistent collection-group assignments, and per-channel on-air/off-air controls using broadcast terminology rather than physical-TV power state;
- `/api/v1/health` checking SQLite access and the FFmpeg toolchain;
- shutdown stops the playback loop and watcher, retains and awaits the background scan task, and prevents that task from starting a watcher after shutdown begins.

The legacy Pi path remains the default outside the container. Shutdown is not yet fully graceful at the HTTP layer: `main.ts` does not retain the `Bun.serve` handle, stop accepting requests, or drain active SSE/HTTP connections before exit.

### Current implemented persistent layout

```text
/app/data/
  config.json       bootstrap seed/input when present
  media.db          SQLite catalog and settings
  channels.json     editable channel definitions, generated collection groups, and manual off-air switches
  logo.png          mutable management UI logo
  thumbnails/       generated thumbnails
  artwork/          cached provider-sized TMDB collection artwork
  transcode/        reserved directory; HLS service not implemented yet
  update.log        legacy-only log path; updates are disabled in Docker
  mpv.conf          copied compatibility asset; unused in headless mode
  user.conf         copied compatibility asset; unused in headless mode

/media/tv          read-only TV library
/media/movies      read-only movie library
/media/interludes  writable Station Assets library (compatibility path)
/app/data/kids-7.library.json  seeded persistent policy; active for Unraid and image-default deployments
/app/config/kids-7.library.json  active read-only repository policy in the supplied Compose deployment
```

The named `toasttv-data` volume preserves the implemented `/app/data` contents across container recreation. `TOASTTV_DATA` is the root for mutable generated paths, `TOASTTV_DATABASE` can override its database, and `TOASTTV_CONFIG` selects the bootstrap JSON. TV and movie roots remain read-only; the separate Station Assets root is writable only when `TOASTTV_STATION_ASSETS_WRITABLE=true`. The image creates `/media` before dropping privileges but does not change ownership of a user-supplied runtime bind mount. The runtime user must have read/traverse access to programme libraries and write access to Station Assets.

The image seeds `kids-7.library.json` into appdata only when it is missing, so
Unraid policy edits survive image replacement. Container `TZ` controls logs and
legacy date handling. The policy seeds channel definitions; after an edit,
effective channel timezones and slots, generated collection-group membership,
and manual on-air/off-air state are atomically stored in `channels.json` and
restored at startup. Station previews can filter parent-allowed, technically playable
collections by title, TMDB genre, original network, and production studio.
Brand-style mixes are personal catalog filters, never official schedules. The supplied
Compose file explicitly selects its separate read-only `/app/config` policy;
its seeded appdata copy is not active unless `TOASTTV_LIBRARY_POLICY` is changed.

### Target normalized persistent layout

```text
/app/data/
  media.db
  config/
  thumbnails/
  cache/
  transcode/
```

Schema migrations, generated channel schedules, pairing credentials, probe versions, and transcode cache metadata must all live under this persistent root or in SQLite. Backup documentation must identify which cached directories can be omitted and how to take a consistent SQLite/schedule snapshot.

### Remaining Docker hardening

- Persist per-root scan/readiness records (status, last success/error, and item count) and expose them through health. Row-level availability already gates playback and the scanner distinguishes a complete empty traversal from an unavailable/incomplete root, but an empty root has no row on which to retain that state.
- Decide whether a future optional writable ingest root or persistent hide/tombstone feature is needed. The current Docker MVP intentionally supports host-side media changes plus rescan and rejects both application uploads and catalog-row deletion.
- Replace ad-hoc column migrations with a versioned schema ledger. Remote media
  now resolves canonical root-relative locators and never serves the catalog's
  stored absolute path; the legacy local-player path remains separate.
- Retain the `Bun.serve` handle and drain/stop HTTP and SSE connections during shutdown.
- Vendor HTMX and any other UI runtime assets for offline LAN use.
- Add an image build/boot smoke test in CI for `amd64` and `arm64`.
- Add container-aware backup/migration documentation for SQLite and generated schedule state.
- Avoid requiring write access to `/media` and never chown a user-supplied media bind mount.

## 13. webOS implementation considerations

### Packaged shell versus hosted UI

LG requires `appinfo.json` to point `main` at an HTML path relative to the package; it cannot name a remote URL directly. LG nevertheless officially supports a hosted-web-app pattern in which the packaged local `index.html` redirects to remote content. See LG's [`appinfo.json` reference](https://webostv.developer.lge.com/develop/references/appinfo-json) and [web app types](https://webostv.developer.lge.com/develop/getting-started/web-app-types).

For ToastTV, a packaged or hybrid shell remains the reliability recommendation, not a platform mandate: package startup, playback, reconnection, focus navigation, and fallback UI; fetch APIs, guide data, and optional noncritical assets from ToastTV. A hosted redirect can simplify updates and should be tested, but normal playback must still fail intelligibly when the server is unavailable and must not depend on downloading the entire application before showing recovery UI.

Because a packaged app calling a LAN server is cross-origin, ToastTV must provide narrowly scoped CORS handling for playback APIs. LG states that webOS TV follows standard CORS behavior and that access must be enabled server-side. See LG's [CORS guidance](https://webostv.developer.lge.com/faq/how-to-solve-the-problem-if-cors-occurs). Confirm the actual packaged-app origin on each supported platform; CORS is not authentication, and an origin that cannot uniquely identify the app must not be trusted as a client credential.

### Playback behavior

LG documents HTTP/HTTPS and HLS support, seeking, and live seeking on supported platform generations. It also documents that playback speed other than `1.0` is not supported. Therefore the webOS client should use tolerant drift thresholds and direct seeks for large drift; playback-rate correction can remain a browser-client optimization but must not be required on LG. HLS output must keep audio/video segment durations aligned and avoid unsupported discontinuities. See LG's [streaming protocol and DRM matrix](https://webostv.developer.lge.com/develop/specifications/streaming-protocol-drm).

Codec/container support varies materially by TV generation and model. Do not infer support from the server or a single global LG profile. Begin with conservative declared profiles, capture the webOS/platform version at registration, and allow actual playback failure to fall back to HLS. LG publishes generation-specific [audio/video format tables](https://webostv.developer.lge.com/develop/specifications/video-audio-50).

Playback setup must wait for the relevant media readiness event before seeking and must handle a rejected `video.play()` promise. A direct-play decode failure should report the observed failure, request a server-approved HLS fallback once, and then show a recoverable error rather than looping indefinitely.

### Remote and focus

All screens must support five-way focus independently of pointer input. Current documented key codes include arrows `37-40`, OK `13`, Back `461`, and conventional-remote media keys. Back behavior changes with app metadata/platform generation, so overlays should be represented in history or handled using the documented `disableBackHistoryAPI` behavior. See LG's [Magic Remote guide](https://webostv.developer.lge.com/develop/guides/magic-remote).

### Discovery and pairing

Do not make mDNS the only startup path. No documented webOS TV web-app API was found that exposes general UDP multicast/mDNS discovery to packaged JavaScript. Treat discovery as an on-device experiment, not an architectural dependency.

The reliable MVP order is:

1. saved server URL;
2. manual URL entry with remote-friendly segmented fields;
3. QR code and/or short pairing code shown on the TV;
4. optional discovery if confirmed on supported physical TVs.

Pairing should return a client ID, scoped token, assigned/default channel, server time, and capability profile. The client must retain polling if SSE/WebSocket disconnects.

### Minimum app state machine

```text
BOOT
  -> LOAD_SAVED_SERVER
  -> CONNECTING
  -> SERVER_SETUP or CHANNEL_SELECT
  -> SYNC_NOW
  -> LOADING_MEDIA
  -> SEEK_TO_LIVE_OFFSET
  -> PLAYING

PLAYING
  -> local overlay/guide
  -> reconcile near scheduled end and every 30-60s
  -> direct transition or refetch on event
  -> RECONNECTING on network/server failure

RECONNECTING
  -> bounded backoff with visible status
  -> refetch clock and authoritative now state on success
  -> SERVER_UNAVAILABLE while retries continue

LOADING_MEDIA
  -> HLS_FALLBACK after eligible direct-play failure
  -> MEDIA_UNAVAILABLE or PLAYBACK_ERROR after bounded failure
```

Local pause never changes channel time. On resume, the first implementation should refetch `now` and return live.

## 14. Identified technical risks

| Priority | Risk | Impact | Mitigation |
|---|---|---|---|
| P0 | Computed channel timelines are not durably materialized | Editable channel definitions are durable JSON, but generated program windows, atomic revisions, and audit/history are missing | Add program revisions and auditability without breaking the current editor or channel contract |
| P1 | Legacy absolute paths remain stored for local playback | Remote delivery now uses canonical root-relative resolution, but the legacy Pi player still consumes the catalog path | Keep the remote resolver as the only client delivery boundary and migrate legacy local playback separately |
| P0 | Management mutation routes remain unauthenticated | A LAN peer can alter catalog/configuration | Separate admin/playback APIs and introduce admin authorization; in-container self-update is already disabled |
| P0 | Incorrect automatic metadata match could apply the wrong rating | Unsafe content could be allowed from unrelated metadata | Auto-confirm only a unique exact normalized title/year/type match; send fuzzy, conflicting, missing, and unrated results to review and retain manual lock |
| P0 | Media-element authentication is undefined | `<video>`/HLS requests cannot reliably send the API bearer header, encouraging long-lived query tokens | Use short-lived signed file/manifest/segment URLs, a tested scoped cookie, or same-origin hosting; never trust query `clientId`/profile |
| P0 | On-demand HLS begins at source time zero | A mid-program viewer waits for FFmpeg to catch up and cannot join live | Pre-generate/cache seekable VOD HLS or use an offset-anchored job with an explicit source-time mapping |
| P1 | Root state is enforced on rows but not persisted independently | Empty roots have no row carrying last scan/error state and health can remain green for a missing mount | Persist per-root scan state and include it in readiness; retain current traversal-completeness gating |
| P1 | Headless compatibility is still a transitional default | Catalog facts are insufficient for reliable direct-play decisions | Store versioned neutral probe facts; batch compatibility persistence is already fixed |
| P1 | Whole-second durations and random queue state | Drift and restart nondeterminism | Millisecond precision plus persisted schedule rows/revision/seed |
| P1 | UTC/local timezone inconsistency | Wrong seasonal item/quota/day boundary | Explicit channel timezone and UTC instant calculations |
| P1 | Read-only libraries have no persistent hide/ingest workflow | Operators cannot suppress one mounted item or upload through the app | Keep upload/delete mutations disabled in Docker; add an explicit tombstone or separate writable ingest root only if required |
| P1 | Single global session/quota semantics | Multi-client behavior is undefined | Decide household/channel/client quota scope before schema migration |
| P1 | Probe data lacks container/audio/fps/bitrate | Direct-play decisions are unreliable | Expand ffprobe schema and version cached probe output |
| P1 | webOS model fragmentation | Direct play works on some TVs but fails on others | Capability profiles, observed failure fallback, representative hardware testing |
| P1 | CORS/TLS/LAN URL behavior | Packaged app cannot reach API reliably | Explicit CORS allowlist; test HTTP LAN and trusted HTTPS options on TVs |
| P1 | HTTP server is not drained on shutdown | SSE/HTTP requests can be cut off despite scan/watcher cleanup | Retain the `Bun.serve` handle, stop accepting work, drain with a deadline, then close resources |
| P2 | HLS process/cache cleanup | Disk exhaustion or orphaned FFmpeg jobs | Bounded cache, job lifecycle, access timestamps, shutdown cleanup |
| P2 | CDN-hosted HTMX | Admin UI degrades offline | Serve pinned local asset |
| P2 | File watching differences in containers | New media may not appear promptly | Verify Linux bind mounts and retain manual/periodic reconciliation |
| P2 | Insufficient structured playback diagnostics | Device-specific direct/HLS failures and drift are hard to reproduce | Log state changes, decision reasons, job IDs, errors, and sampled corrections without logging credentials or every heartbeat |

## 15. Staged implementation plan

Each stage must keep the application bootable, run existing tests, add focused tests, type-check, and validate Docker configuration/build where the environment permits. Every externally visible state transition should have a bounded failure path and structured log. Log client connect/disconnect, program change, playback-decision reason, transcode lifecycle/failure, media unavailability, reconnection, and sampled drift correction; do not log credentials/signed URLs or flood logs with heartbeats.

### Stage 1: audit and headless server boot — current milestone

- Document architecture and migration boundaries.
- Add explicit headless mode with legacy Pi behavior preserved by default.
- Skip MPV, CEC, Pi hardware classification, and playback loop in headless mode.
- Make container data/media paths explicit.
- Add Dockerfile, Compose, FFmpeg/ffprobe, persistence, and health endpoint.
- Reject legacy local playback mutations in headless mode.
- Lock container dependency installation to `bun.lock`.
- Route mutable generated assets through `TOASTTV_DATA`, disable application upload/delete operations for the read-only Docker media mount, and disable the bare-metal updater in containers.
- Preserve unavailable-root catalogs while reconciling successful empty roots, persist batch compatibility values, and retain/await the scan task during shutdown.

Exit condition: management HTTP boots without MPV/CEC/Pi hardware; SQLite and generated data paths are persistent; media is mounted read-only; tests and type checking pass. Image build/boot and complete HTTP draining remain separately tracked validation items.

### Stage 2: persistence and media safety prerequisites

- Continue the implemented schema ledger for every future persistent change.
- Retain collection-level metadata/policy/override state and the rule that only explicit effective `allow` is schedulable.
- Persist explicit per-root availability/last-scan state and expose media readiness; row-level playback quarantine and complete-traversal reconciliation are implemented.
- Retain the implemented canonical media resolver as the only remote-delivery
  boundary and add persisted per-root readiness around it.
- Fix legacy extended-probe persistence and collect versioned container/audio/time-base data.
- Decide whether a persistent hide/tombstone feature or separate writable ingest root is needed.
- Add admin authorization and container-aware backup/restore guidance.

### Collection library and metadata milestone — implemented

- Group Plex-style TV folders and movies into persistent collections; parse TV
  seasons/episodes while keeping detailed file facts behind the advanced view.
- Cache show/movie-level TMDB metadata, candidate matches, artwork paths,
  certifications, region, confidence, and errors in SQLite.
- Run metadata enrichment as a sequential job separate from filesystem scans;
  absent credentials, ambiguous matches, missing ratings, and provider failures
  remain in review. Policy edits are reapplied at startup, while rating-region
  changes invalidate cached certifications until their retained matches refresh.
- Evaluate configurable Kids 7 rating buckets and preserve explicit parent
  allow/block/reset actions across rescans and newly added episodes.
- Expose collection summary/list/detail/review APIs and UI, guarded admin
  mutations, scan/metadata SSE progress, safe bulk overrides, and manual match.
- Render the headless home page from real channels, catalog decisions, metadata
  state, scan state, and ephemeral client heartbeats.

### Stage 3: channel timeline core

- Preserve the implemented editor/API and optionally normalize its durable JSON channel definitions when database transactions or history are required.
- Add normalized/versioned schedule and programming-rule records, materialized program windows, atomic revision activation, and audit/history.
- Add a collection-to-programming-group editor/API and persistence model; today exact policy entries are loaded only at startup.
- Split the implemented injected-clock `ChannelService` into durable schedule generation and timeline lookup layers.
- Define screen-time policy scope and persistence.
- Add tests for exact start/end, sub-second mid-program `offsetMs`, interludes, empty/missing media, rolling-window regeneration, atomic revision activation, day/timezone/DST, restart determinism, and multi-channel independence.

### Stage 4: versioned channel API and events

- Extend the implemented channels/now/guide responses with a dedicated next route, millisecond media timing, and durable atomic revision semantics.
- Publish channel-scoped SSE events.
- Add server info and client config.
- Add clock-sampling guidance and API contract/integration tests for bounded guide windows, fallback polling, failure responses, rejection of query-supplied client/profile identity, and the conservative anonymous profile used before registration lands.

### Stage 5: safe direct play and browser reference client — MVP implemented

- Media-ID resolution plus HTTP Range/HEAD handling is implemented.
- The current trusted-LAN MVP uses an anonymous server-approved media URL;
  opaque/short-lived URLs remain required before an authenticated deployment.
- Root containment, symlink escape, MIME, Range boundary/`416`, and
  missing-media tests cover the implemented resolver and endpoint; signature
  expiry tests wait for signed URLs.
- `/tv/` provides the reference player with midpoint clock estimation, live
  seek, transitions, bounded reconnection, drift reconciliation, failure states,
  and guide data.

### Stage 6: capability decisions and HLS

- Add richer probe cache and client capability profiles.
- Implement direct-versus-HLS decisions outside scheduling code.
- Add a single-server FFmpeg HLS job/cache lifecycle with an explicit source-time-to-playlist-time mapping, atomic manifests, bounded cleanup, and graceful fallback.
- Test mid-program cold join, warm cached join, multiple compatible clients sharing a job, late joiners, source/program end, restart cleanup, transcode failure, and representative MP4/MKV/AVI/video/audio combinations.

### Stage 7: packaged webOS client — MVP implemented

- `clients/webos` contains the packaged shell and `appinfo.json`; packaging and
  Developer Mode sideloading are documented in [`WEBOS.md`](./WEBOS.md).
- The MVP implements saved/manual server setup, channel selection, HTML5 direct
  playback, live joining, remote focus, Back behavior, guide display, and
  reconnection.
- Hosted-shell comparison, authenticated media access, and direct-to-HLS
  fallback remain future work.
- Physical webOS generation testing remains required; browser or emulator
  results cannot establish codec/HLS compatibility on a TV.

### Stage 8: registration, pairing, and multi-client polish

- Persist clients, credentials, capabilities, channel assignment, and last seen.
- Add short-code/QR pairing; experiment with discovery only as an enhancement.
- Replace the implemented ephemeral heartbeat presence with authenticated,
  persisted client management; add transcode status when HLS lands.
- Confirm credential rotation/revocation, signed-URL expiry, redacted logging, and that query-supplied client/profile identity is ignored.
- Confirm that multiple clients on one channel resolve the same program and approximately the same offset without sharing viewer playback state.

## Initial milestone validation checklist

- [x] Required architecture audit produced.
- [x] Headless server path does not connect to MPV.
- [x] Headless server path does not initialize CEC or Pi hardware detection.
- [x] Legacy Pi playback remains the default outside Docker.
- [x] Container data/media environment paths are recognized.
- [x] Dockerfile contains Bun and FFmpeg/ffprobe and runs as non-root.
- [x] Container dependency install is frozen to committed `bun.lock`.
- [x] Compose persists `/app/data`, mounts TV/movies and policy read-only, and narrowly enables writes only for the separate Station Assets mount without auto-creating missing source paths.
- [x] Mutable generated paths use `TOASTTV_DATA`.
- [x] Docker read-only upload/delete UI and endpoint behavior is explicit; writable-mode filenames are root-confined and existing symlink destinations are rejected.
- [x] In-container bare-metal update checks/apply are disabled.
- [x] Health endpoint reports SQLite and FFmpeg status.
- [x] Headless playback controls cannot create a fake local session.
- [x] Missing/incomplete roots preserve indexed rows but are playback-quarantined; successfully traversed empty roots reconcile only their own rows.
- [x] Stable root-relative locators preserve IDs and overrides across container path-prefix changes.
- [x] Managed roots use collection-level rating policy and parent overrides; unknown, unrated, ambiguous, failed, and unconfigured metadata never auto-allows.
- [x] TV episodes are grouped by show/season, and new episodes inherit the collection's effective decision without per-episode provider calls.
- [x] Explicit parent decisions survive collection rescans and disappearance/reappearance; old automatic approval booleans are not trusted during migration.
- [x] Scan/probe progress and separate metadata progress are exposed through API, UI, and dashboard SSE events.
- [x] The About UI contains the TMDB-approved logo and required attribution notice.
- [x] Deterministic Kids 7 channel list/now/guide endpoints are implemented and clock-tested.
- [x] Browser/admin channel CRUD is applied live and atomically persisted to `/app/data/channels.json`.
- [x] Manual off-air state is restored across process and container restarts.
- [x] Batch upserts persist computed compatibility.
- [x] Background scan is retained/awaited and cannot start a watcher after shutdown begins.
- [x] Docker image builds and a headless container boot smoke test serves `/tv/`,
  three configured channels, and the packaged-app CORS preflight.
- [x] Official LG CLI produces the installable webOS IPK; manifest/assets and
  the 1920×1080 channel, playback, guide, focus, and Back flows are smoke-tested.
- [ ] Health/readiness exposes persisted per-root status; runtime scanning already distinguishes incomplete/unavailable traversal from successful empty traversal.
- [ ] `Bun.serve` handle is retained and HTTP/SSE connections are drained on shutdown.
