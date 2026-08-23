# <img src="data/logo.png" alt="ToastTV logo" width="80" height="80" valign="middle"> ToastTV

**The warm, crispy, 90s TV experience for your Raspberry Pi.**

No more "what should we watch?" — **Turn it on, and the station is already running.**

The anti-algorithm for tired parents and kids who just want to watch cartoons.

> **ToastTV Other fork:** This repository adds a Docker/Unraid headless server,
> managed TV and movie roots, a conservative Kids 7 policy, parent overrides,
> and deterministic channel schedule APIs. Direct media streaming and the LG
> webOS playback package are still under development.

<img src="docs/toasttv_hero.png" alt="A picture of 3 kids watching cartoons on a TV in a cozy 90s living room" />

### Deploy this fork

For Unraid, follow the [Unraid template instructions](#unraid-template). The
template pulls `ghcr.io/itsrammen/toasttv-other:latest` and mounts the TV and
movie shares read-only.

For Docker Desktop on this Windows library:

```powershell
Copy-Item docker-compose.env.example .env
docker compose up -d --build
```

Open the administration UI at `http://127.0.0.1:1993`. The inherited Raspberry
Pi installer at `toasttv.eu` installs the original upstream bare-metal release,
not this Docker/Unraid fork.

## Getting Started

The Raspberry Pi playback features below describe the inherited upstream
project. This fork's current Docker milestone provides library administration
and schedules; media streaming and the LG webOS player are still in development.

## Broadcast Control Center

The mobile-first dashboard puts you in the director's chair from any device:

### Library Management
Upload videos, categorize content, and toggle interludes. Videos are automatically checked against your Pi's hardware capabilities. Incompatible files are flagged before they hit the playlist.

<img src="docs/library.png" alt="Library Management" width="100%">

### Bedtime Enforcement
One tap to "Sign Off" manually, or set automatic daily limits.

<img src="docs/off_air.png" alt="Bedtime Enforcement" width="100%">

## Why It's Better Than a Playlist

- **Smart Channel Engine**: ToastTV builds a dynamic "Channel" schedule: `[Intro] → [Video] → [Video] → [Interlude] → [Video]`.
- **Screen Time Limits**: Set a daily quota (e.g. 45 mins). When time is up, the station plays the sign-off sequence and stops. No arguments.
- **Seasonal Awareness**: Christmas interludes in December, Spooky bumpers in October. The engine tracks dates automatically—zero config required.
- **Native MPV Power**: Plays MKV, AVI, MP4 directly with hardware acceleration (DRM/KMS). No transcoding, no buffering, rock-solid sync.
- **Living Room Ready**: No keyboard needed. Control playback with your **TV remote** via HDMI-CEC.

### TV Remote Control (HDMI-CEC)

ToastTV listens for HDMI-CEC commands from your TV remote:

| Button | Action |
|--------|--------|
| **SELECT / OK** | Start playback or toggle pause |
| **RIGHT →** | Skip to next video |
| **UP ↑** | Toggle TV guide |
| **PLAY ▶** | Start playback |
| **PAUSE ⏸** | Pause video |

> **Note**: CEC support varies by TV. Arrow keys and SELECT typically work best.

### TV Guide Overlay

Press **UP** on your remote for a retro Now/Next display, see what's playing, what's coming up, and how much screen time is left.

<img src="docs/tvguide.png" alt="TV Guide Overlay" width="100%">

### Starter Content

ToastTV works out of the box. It includes a full "broadcast day" so you can test the flow immediately:

Three episodes of **[Caminandes](https://studio.blender.org/films/caminandes-1/)** (by Blender Studio, CC-BY) are included.

The mascots **Penny & Chip** are ready to run your station.
- **Good morning!** — They sign on together.
- **Bumpers** — They keep the flow moving.
- **Bedtime** — They sign off for the night.
- **Seasonal** — They celebrate holidays together.

<img src="docs/penny_and_chip.png" alt="Penny & Chip" width="400">

## Development

### Docker headless server

The Docker server runs the management application without MPV, HDMI-CEC, or
Raspberry Pi hardware detection. It supports independent read-only TV and
movie roots, a default-deny Kids 7 library, and deterministic read-only channel
schedules. Seerr/Overseerr is intentionally not part of this stage.

#### Unraid template

Pushes to `main` publish `linux/amd64` and `linux/arm64` images as
`ghcr.io/itsrammen/toasttv-other:latest`. GitHub Container Registry creates the
first package as private; its owner must change the package visibility to
**Public** once before Unraid can pull it anonymously.

To install the repository template manually from an Unraid terminal:

```bash
mkdir -p /boot/config/plugins/dockerMan/templates-user
wget -O /boot/config/plugins/dockerMan/templates-user/my-toasttv-other.xml \
  https://raw.githubusercontent.com/ItsRammen/ToatTV_Other/main/templates/toasttv.xml
```

Then open **Docker → Add Container**, select **ToastTV Other**, and confirm the
defaults:

```text
Appdata: /mnt/user/appdata/toasttv
TV Shows: /mnt/user/Plex/TV Shows (read-only)
Movies:   /mnt/user/Plex/Movies (read-only)
Web UI:   http://TOWER:1993
```

The template uses the bundled Kids 7 policy. Parent allow/block overrides and
the media index persist beneath appdata. The image is an administration and
schedule server only; it does not yet include the LG viewing application.

For this library on Windows:

```powershell
Copy-Item docker-compose.env.example .env
docker compose up -d --build
```

The example maps `Z:/TV Shows` and `Z:/Movies`. Docker Desktop's WSL backend may
not make mapped SMB drives available to Linux containers even when Windows can
read them. For a library hosted on Unraid, deploying the template directly on
the Unraid server with `/mnt/user/...` paths is the reliable option. The
Compose file requires both host paths and refuses to create a missing source
directory, preventing a typo from appearing as an intentionally empty library.

For another host, set both paths explicitly:

```bash
TOASTTV_TV_PATH=/path/to/tv \
TOASTTV_MOVIE_PATH=/path/to/movies \
TZ=Asia/Taipei \
docker compose up -d --build
```

The admin UI defaults to `http://127.0.0.1:1993`; health status is at
`/api/v1/health`. There is currently no authentication or parent account, so do
not expose this port to the internet or an untrusted network. To reach it from
a trusted home LAN, explicitly set `TOASTTV_BIND_ADDRESS=0.0.0.0` in `.env`.

SQLite, thumbnails, and parent overrides use the `toasttv-data` Docker volume.
TV, movies, interludes, and policy are separate read-only bind mounts. Back up
the data volume with the container stopped before copying raw SQLite files;
`docker compose down -v` deletes it.

[`config/kids-7.library.json`](./config/kids-7.library.json) contains the exact
top-level filesystem folder names approved for playback (currently 47 TV and
69 movie folders from this library). Matching is exact and case-insensitive and
recursively includes supported video files beneath a matched folder, including
any Extras subfolder. Supported extensions are `.mp4`, `.mkv`, `.avi`, `.mov`,
and `.webm`. Unmatched media remains visible to administrators but is not
probed, thumbnailed, or scheduled. The Library page opens on **Kids 7**. A
parent can allow, block, or return an item to policy control without modifying
the media files.

The policy is intentionally conservative and is loaded once at process start.
Restart the container after editing it. If `TOASTTV_LIBRARY_POLICY` is unset,
managed roots boot default-deny; if a configured policy is missing, unreadable,
or invalid, startup fails rather than falling back to the full library.

The scanner preserves catalog rows and parent overrides when a mount cannot be
completely traversed, but quarantines that root from playback until a complete
readable scan succeeds. An individual ffprobe failure gates only that item. A
successfully scanned empty root is treated as intentionally empty and its old
rows are removed. Network-drive change notifications can be unreliable on
Docker Desktop/NAS shares, so use **Rescan** after host changes.

The current schedule endpoints are:

```text
GET /api/v1/channels
GET /api/v1/channels/:id/now
GET /api/v1/channels/:id/guide?hours=8
```

The policy seeds Kids Club, Nature & Discovery, and Family Movie Night in the
`Asia/Taipei` timezone. Timelines are deterministic across restarts and return
the current media ID, start/end timestamps, and live offset. These endpoints
do not stream media yet; direct-play delivery and the webOS player are the next
client milestone.

`/api/v1/health` currently checks SQLite and FFmpeg only. It does not prove the
mounts are readable or that the first scan finished. Wait for
`Background scan complete` in `docker compose logs -f toasttv`, then verify the
Kids 7 library before relying on a schedule.

Docker Compose defaults to UID/GID `1000`; the image also accepts numeric
`PUID`/`PGID` overrides. A host or NAS media bind mount must grant the selected
identity (or a supplemental group) read access to files and traverse access to
directories. `group_add` applies to Linux/Unraid; Docker Desktop uses Windows
share permissions and Docker file sharing.

```yaml
services:
  toasttv:
    group_add: ["1234"] # numeric GID allowed to read/traverse the media share
```

The provided Unraid template maps appdata to `/app/data`, maps both media roots
read-only, and runs the server as Unraid's normal `PUID=99` / `PGID=100`.
Override those advanced fields if your share permissions use another identity.
Stop the container while an appdata backup copies the SQLite database.

Docker deliberately disables legacy local playback controls. Direct-play/HLS
delivery, a browser reference player, and the webOS client remain staged in
[`docs/DOCKER-WEBOS-MIGRATION.md`](./docs/DOCKER-WEBOS-MIGRATION.md).

```bash
make install   # Install Bun, MPV, FFmpeg
make start     # Start MPV + server
make dev       # Start with watch mode
make test      # Run tests
```

### Testing Different Hardware Profiles

Force a specific Pi profile to test media compatibility:

```bash
make start PROFILE=pi-zero-2w   # Test as Pi Zero 2 W (limited)
make start PROFILE=pi-4         # Test as Pi 4 (full capability)
make dev PROFILE=pi-zero-2w     # Dev mode with profile
```

Available profiles: `pi-zero-2w`, `pi-3`, `pi-4`, `pi-5`, `unknown`

### RPi Simulator Testing

Test the install flow locally using a Raspberry Pi VM (or any ARM64 VM):

```bash
# On your computer: start the dev server
make serve-local

# In the VM: curl install from your computer
curl -fsSL http://<computer-ip>:3000/install.sh | sudo LOCAL_SERVER=http://<computer-ip>:3000 bash
```

This builds a fresh tarball and serves it via a local HTTP server that mocks GitHub release endpoints.

### TV Simulation (Black-Box Testing)

For testing detection in a VM without real hardware:

```bash
# Deploy mock scripts to VM (one-time)
TVSIM_HOST=dietpi@192.168.x.x make tvsim

# On VM: simulate TV events
./tv-sim.sh on          # TV power on
./tv-sim.sh off         # TV standby
./tv-sim.sh guide       # Toggle TV guide
./tv-sim.sh hdmi-plug   # HDMI cable connected
./tv-sim.sh hdmi-unplug # HDMI disconnected
./tv-sim.sh status      # Show current state
```

### Tech Stack

See [ARCHITECTURE.md](./ARCHITECTURE.md) for tech stack, and design decisions.

## License

MIT
