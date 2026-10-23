# Dialden Native — playback preview

A separate Rust/SDL2 client for Dialden, with a television-scale interface inspired by the spacious typography, rounded surfaces and clear focus of modern TV interfaces. It uses Dialden's existing HTTP API. It has no Plex account dependency.

**This is a preview, not a production release.** `desktop-player` connects HLS through libmpv; the ARM `webos` build now uses LG native HLS playback, verified on a QNED91SPA running webOS 6.5.3. TV remote input and live preview video work; full-screen audio, channel-switching and long-running playback validation remain in progress. The default build remains a browsing/design preview. See [TV build and device validation](webos/BUILD.md).

## Run locally

Requires Rust and SDL2 development libraries (SDL2_ttf is not needed). Live playback also requires libmpv development/runtime libraries (`libmpv.so`).

```sh
cd clients/native
cargo run --locked --features desktop-player -- --server http://YOUR-SERVER:1993
# Sample content, no server connection:
cargo run --locked -- --demo
```

Use arrows to navigate, Enter to open a channel, Escape/Backspace to return. Up from the channel row reaches the programme action buttons; Up again reaches the tabs. Left/Right selects an action, and Enter opens details or the full guide. Back closes details and restores focus to the control that opened them. `--fullscreen` fills the display. Close the desktop window to exit.

```sh
cargo test --locked
# Reproducible native-renderer screenshot without a display:
SDL_VIDEODRIVER=dummy cargo run --locked -- --demo --screenshot /tmp/dialden-native.png
SDL_VIDEODRIVER=dummy cargo run --locked -- --demo --screen guide --screenshot /tmp/dialden-guide.png
```

`--screen actions`, `--screen details`, `--screen guide`, and `--screen settings`, and `--screen player` make the corresponding states available for visual checks. `--focus N` selects a zero-based channel index. `--screen timeline` opens the two-hour guide. Demo screens identify themselves as sample listings. The live server is supplied at runtime; there are no bundled credentials or server addresses.

## Data and responsiveness

The worker fetches `/api/v1/channels` and `/api/v1/channels/schedule`; the rendering thread does no HTTP work. It polls after each fetch cycle with a 30-second pause, retains the last snapshot during errors and preserves the selected channel across catalog changes. Artwork requests use `/api/v1/media/:mediaId/still`, falling back to `/thumbnails/:mediaId.jpg` on older servers or while a still is pending; missing artwork gets a branded fallback. Current-programme textures are cached in memory and evicted when they leave the snapshot. There is no disk/offline cache. Read-only API calls do not start channel streams.

The native renderer uses SDL2 and fontdue. Tests cover focus behavior, empty catalogs, channel identity after refresh, server-address validation and hiding interlude filenames. Desktop behavior is not proof of TV performance.

## Live playback and previews

With `--features desktop-player`, a focused home channel starts one muted preview after 250 ms. Focus changes cancel the old stream immediately; OK opens the same decoder full-screen and enables audio. The quick guide keeps the playing channel independent of its highlighted row. Returning to browsing mutes the preview; Settings, the full timeline, minimising the window, and exiting stop playback. No parallel preview decoders or speculative channel warming are used.

The client consumes each schedule's `liveStream` HLS URL. Playlist requests carry a per-launch client ID and maintain the existing server worker through normal playlist polling. It does not create an all-channel lineup session or a stable tuner session. Stopped streams cease requests; the server's existing idle timeout releases an unused encoder (normally 90 seconds), without stopping other viewers.

Stills remain visible while connecting and when live playback is unavailable. Buffering is reported from the decoder. An ended/error stream or 20 seconds without decoded video or playback-clock progress triggers up to three reconnects with 1/2/4-second delays. After exhaustion, reopen the channel to retry. Opening full-screen after an exhausted automatic preview also retries. Playback events are logged to stderr; they are not yet uploaded to server incident reporting.

`--no-playback` keeps a connected session read-only. Demo, screenshot and motion-preview exports never start streams. The decoder uses software decode and a 1920×1080 render surface, with aspect-fit letterboxing; this is a desktop reference implementation, separate from the TV hardware path. mpv handles audio/video synchronisation. Desktop playback glass samples a small blurred decoded frame, refreshed at most five times per second while controls are visible. Browsing glass continues to use artwork.

Integration checks require an HLS fixture and run separately from the unit suite:

```sh
SDL_VIDEODRIVER=dummy DIALDEN_TEST_STREAM=http://127.0.0.1:18793/index.m3u8 \
  cargo test --features desktop-player -- --ignored --test-threads=1
```

Set `DIALDEN_CAPTURE_DIR` to an existing directory to capture the actual native preview/player rendering from the integration test. Test audio uses mpv's null output; real speaker output requires an interactive check.

## Playback and webOS follow-up

Target a separate package ID, `com.itsrammen.dialden.native`, keeping the existing TV app available. Before packaging:

1. Implement and validate the LG native hardware-plane adapter, preserving the single-session preview/full-screen contract. The desktop libmpv software renderer is not the TV backend.
2. Validate HLS discontinuities, programme changes, bumper boundaries and long-running recovery on the TV. PlxNative's Plex-specific parser cannot be substituted directly for Dialden's playlists.
3. Connect real server setup and persistent configuration, integrate incident reporting, and verify remote controls.
4. Cross-compile/package using the webOS SDK/NDK with required runtime libraries. A separate ARM playback preview can now be built; it includes the LG HLS adapter validated on webOS 6.5.3. See [TV build instructions](webos/BUILD.md).

## License and attribution

This new client is GPL-3.0-or-later; see LICENSE. The existing server and web client licenses are unchanged. The renderer and navigation here are new Dialden code, not a copy of PlxNative's UI or player. Inter fonts are covered separately by the SIL Open Font License; see assets/OFL.txt and THIRD_PARTY_NOTICES.md. Any future inclusion of PlxNative code must retain its copyright and license notices and provide corresponding source with distributed builds.

## Glass rendering

The native UI uses cached, rounded glass textures over a procedural ambient wallpaper: a blurred backdrop sample, slight edge refraction, tint, antialiased rims and directional highlights. Focused controls use a brighter material for remote visibility. The effect is generated when a surface first appears, not recomputed every frame; its cache is bounded to 64 surfaces. It samples the selected programme’s server-generated still when available, otherwise the ambient wallpaper. Playback controls use a separate decoded-video glass layer on desktop; browsing surfaces do not sample overlapping UI. TV GPU performance remains unverified.

## Motion and playback backdrop

Launch has a 600 ms fade and gentle scale/settle, using a cached scene texture. Any navigation input skips it immediately. `--reduce-motion` disables it; `--intro-ms 150 --screenshot /tmp/intro.png` captures a deterministic intermediate frame. Channel cards lift on a critically damped spring. Home and guide details share a short fade/settle animation, transforming a cached sheet texture rather than rebuilding glass each frame. Page changes finish in 180 ms; launch remains 600 ms. Reduced motion snaps these transitions as well.

PlxNative's `docs/liquid-glass.md` explains that LG's Starfish/ACB video plane is outside the GL framebuffer, so its renderer cannot sample the playing video for blur. Plan for one active channel behind dimmed, readable player overlays; use artwork or a captured UI backdrop for glass elsewhere. Do not promise live-video blur without a verified video-texture path. The desktop decoder and LG HLS adapter are implemented; LG hardware video remains outside the UI framebuffer, so it uses translucent overlay tint rather than sampled video blur.

Generate a deterministic motion walkthrough (sample data only):

```sh
SDL_VIDEODRIVER=dummy cargo run --locked -- --demo --motion-preview /tmp/dialden-motion-frames
```

This simulates 125 frames at 30 fps and exports every third frame (10 fps): move channel focus, open the action row, open details, then close them. It tests rendering and navigation, not actual TV frame rate. This walkthrough uses sample content; real playback is available in the desktop-player build.

## Channel and guide flow

Enter on a channel card or now/next row opens the player immediately (live video in the desktop-player build, stills in demo/browsing builds). Its Open guide button returns to now/next with the current channel selected. Back restores the previous screen and selected channel. Up/Down (or Page Up/Down) changes channels directly, including with hidden controls. Left/Right selects the player buttons. Page changes use the short entrance transition, and reduced motion disables it.

For an animated walkthrough of channel → player → guide → another channel → Back:

```sh
SDL_VIDEODRIVER=dummy cargo run --locked -- --demo --channel-flow --motion-preview /tmp/dialden-channel-flow
```

The walkthrough simulates 180 frames at 30 fps, exporting every third frame (10 fps). Both walkthrough modes export 960×540 frames. This is navigation and layout only: no stream is started, and the quick guide remains a now/next view.

## Server-generated stills

The server provides one representative 1920×1080 JPEG per source revision at `/api/v1/media/:id/still`. The first request can return 202 while the server generates it; the client retries missing stills every five seconds without substituting low-resolution library thumbnails. Generation uses a single software decoder with a timeout and short-clip fallback, independent of channel playback workers. Successful stills are cached on disk (up to 500 entries), replaced by a new cache key when the source changes, and served with ETag/private cache headers. Access uses the same media eligibility and configured-root checks as direct playback.

The native network worker crops, darkens and blurs downloaded images. The selected still becomes the background beneath the UI and the source for glass surfaces. This is a representative programme image, not a live frame or proof of current playback. Neither the endpoint nor native rendering starts a stream. Server and native-client updates are both needed; older servers retain the thumbnail/ambient fallback.

## Opening a channel and now-playing controls

The player preview expands its programme still from the home preview rectangle toward fullscreen. The lower control panel rises into view with channel name, programme/episode, schedule progress and next programme, plus Guide and Browse channels actions. It hides after four seconds of inactivity; the first Left/Right/OK input reveals controls without activating a hidden button; Up/Down changes channel directly. Back returns to browsing. Reduced motion skips expansion and sliding.

```sh
SDL_VIDEODRIVER=dummy cargo run --locked -- --demo --player-flow --motion-preview /tmp/dialden-opening
```

This simulates opening a channel, controls hiding, OK revealing them, then opening the guide; export at 10 fps. It remains a still-image layout preview. The desktop-player build implements a 250 ms dwell before one muted preview, cancellation on focus change and decoder reuse on full-screen selection. TV validation is still outstanding.

## Guide over the player

Opening Guide from the now-playing controls shows a blurred, translucent sheet over the current channel’s video (or still in demo mode). The sheet slides up and down; Up/Down browses rows, OK selects a channel, and Back closes it without changing the original channel. Highlighted and currently playing channel indices are tracked separately and reconciled by channel ID when the catalogue refreshes. Home’s Guide tab opens the full timeline. The overlay is now/next; it keeps real playback running in the desktop-player build. Use Full guide for a multi-hour timeline.

```sh
SDL_VIDEODRIVER=dummy cargo run --locked -- --demo --guide-flow --motion-preview /tmp/dialden-guide-overlay
SDL_VIDEODRIVER=dummy cargo run --locked -- --demo --screen overlay --screenshot /tmp/dialden-guide-overlay.png
```

The walkthrough simulates 145 frames and exports every third frame at 10 fps: open player, open guide, browse two rows, and return to the original channel. Reduced motion skips the sheet animation.

## Full guide

The Guide tab and home action open a two-hour programme grid. The player’s quick guide has a Full guide button (Up above its first channel). Left/Right selects adjacent programmes and pages two hours at the window edges; Up/Down changes channel. OK opens the player preview for a currently airing programme, or a details panel for a future/past programme. Back closes details, then restores the originating screen and channel focus.

A separate worker loads `/api/v1/channels/:id/guide?hours=2&from=<epoch-ms>`, keeping network work off the render thread. The current window is prefetched while browsing or watching; windows are cached in memory and refreshed after two minutes while the app is visible. Up to two channel requests run concurrently; incomplete loads retry after 20 seconds and failed refreshes after 30 seconds. Failed refreshes retain cached listings and show a warning. Empty, loading and truncated responses have distinct messages. Programme times use the device timezone, with a date in the window heading; the server clock determines what is currently airing. Station asset filenames are omitted. No streams are started by loading the guide.

```sh
SDL_VIDEODRIVER=dummy cargo run --locked -- --demo --screen timeline --screenshot /tmp/dialden-full-guide.png
```

## Visual standard

[Liquid Glass standard](LIQUID_GLASS_STANDARD.md) defines the native client's layers, tokens, component recipes, focus, motion and visual review criteria. Shared implementation tokens live in `src/style.rs`. The document distinguishes implemented rules from remaining renderer/accessibility work; this is a TV adaptation, not Apple's material implementation.

### Animated timeline check

```sh
SDL_VIDEODRIVER=dummy cargo run --locked -- --demo --timeline-flow --motion-preview /tmp/dialden-now-flow
ffmpeg -framerate 10 -i /tmp/dialden-now-flow/%04d.png -filter_complex 'split[a][b];[a]palettegen[p];[b][p]paletteuse' /tmp/dialden-now-flow.gif
```

The nine-second walkthrough browses channels/programmes, opens future details and returns while a clearly labelled 300× demo clock advances about 45 minutes. The live guide uses server-adjusted real time. The preview flag requires demo/export mode and cannot affect live schedules. Add `--reduce-motion` to exercise that setting.

## UI review fixtures

Use `--demo --fixture empty|loading|offline|long|bright|busy` with `--screen` and `--screenshot` to reproduce layout edge cases. Bright/busy fixtures exercise synthetic artwork through the normal backdrop preparation path. These do not contact a server. The native UI review and remaining limits are recorded in [UI_REVIEW.md](UI_REVIEW.md).

### Programme information and shared guide rows

Schedule and guide responses now carry an optional `metadata` object with `overview`, `overviewScope` (`episode`, `show`, `movie`), `airDate`, `rating`, and `ratingRegion`. The server projects these from stored media/collection metadata; no provider calls occur while browsing. Existing metadata enrichment during scans/refreshes supplies episode information. Missing cached fields remain missing until enrichment succeeds; this change does not approve media or initiate a library rescan.

Home and timeline details use the same sheet. Both Now/Up Next lists call `components::channel_guide_row`, with show headings and episode subtitles. The timeline keeps its time-scaled cells. See the reuse contract in `LIQUID_GLASS_STANDARD.md` before adding another programme list.

Deploy the updated server to expose metadata to a connected client. Old server responses remain usable with plain labels and a missing-description fallback. The demo uses explicitly labelled sample descriptions, not retrieved listings. The native TV package is installed separately from server updates.

### Loading and navigation preview

The first connection shows a branded loading surface with a gentle tuning animation. It yields on the first catalogue result or error, independently of artwork. Back opens connection details; later refreshes preserve the current view. `--reduce-motion` uses a static mark and immediate handoff.

```sh
SDL_VIDEODRIVER=dummy cargo run -- --demo --loading-flow --motion-preview /tmp/dialden-launch
```

This deterministic preview covers startup, entering a channel preview, opening/closing the quick guide and returning home. `--demo --fixture loading --screenshot /tmp/loading.png` captures the static loading composition. Page entrances render live content throughout rather than freezing guide updates for the duration of an animation.

Use `--demo --ambient-flow --motion-preview /tmp/dialden-ambient` for a 12-second preview of the calmer launch background. The subtle light field drifts behind stationary text; reduced-motion mode freezes both the background and tuning mark.

Home, guide and settings now share the calm ambient treatment. Programme backdrops drift gently while cards remain fixed; reduced motion disables drift. On startup, Down focuses the glass Connection control and OK opens connection settings; Back is the shortcut. Routine loading text is hidden, with a small explanation only after eight seconds.

The shared ambient backdrop uses the curved luminous ribbon from the earlier design. The logo uses static antialiased bars; a separate subtle activity indicator appears only after three seconds of connecting. `--ambient-flow` previews both together.

Add `--smooth-preview` to export every simulated frame at 30 fps rather than the compact 10 fps preview. With `--ambient-flow` this exports six seconds (180 frames), suitable for checking the ribbon and delayed activity indicator. Encode those frames at 30 fps.

The ambient ribbon now genuinely waves: two translucent meshes bend and widen along their length, with a restrained luminous fold. `--demo --ambient-flow --smooth-preview --motion-preview DIR` exports a six-second 30 fps sample. Reduced motion freezes the shape; the logo remains static.

The launch composition now uses only the Dialden name and tagline, with no icon above them. The flowing ribbon, delayed loading dots and glass Connection control remain.

### Interactive first-launch setup demo

Run `cargo run -- --demo --screen setup` to explore local discovery, manual local/remote entry, the on-screen keyboard, connection testing and recovery. Results are simulated and labelled; no network discovery or address persistence occurs. `--screen setup-saved` demonstrates recovery when a saved server is unavailable. Use `--setup-result empty` or `--setup-result error` to explore alternative outcomes.

Record the launch-to-Home walkthrough with `--demo --setup-flow --motion-preview DIR`. See [SETUP_FLOW.md](SETUP_FLOW.md) for all states, interaction rules and the remaining production integration.


Preview top-level navigation and Settings with:

```sh
SDL_VIDEODRIVER=dummy cargo run -- --demo --tabs-flow --smooth-preview --motion-preview /tmp/dialden-tabs
```

The walkthrough switches Watch now → Guide → Settings, toggles session-only Reduce motion, then returns. Settings connection information is read-only; desktop playback is available through the optional feature; TV playback remains under development.

## TV build preparation

The `webos` feature adds full-screen TV launch, packaged server configuration, and older-SDL ribbon rendering. `tools/build-webos.sh` creates a separate ARM IPK with native LG HLS playback, excluding the desktop mpv decoder. See [build and validation status](webos/BUILD.md); successful packaging does not establish TV runtime compatibility.

### Playback polish

The player uses a compact 1560×194 control surface. Its desktop glass samples decoded video at 240×135 with blur and tint, at most five refreshes per second; this does not establish support for sampling LG’s separate video plane. The top navigation is 636×62. A small animated three-dot indicator appears only after 600 ms of connecting/buffering, with no text banner for normal waits. Terminal errors remain visible and explain how to retry. Home tabs and programme details retain the current muted preview so returning does not reload it. Channel-change latency is logged to first frame; a cold server encoder can still delay tuning. No extra server channels are warmed by this change.

### 0.1.1 startup and image quality

Connected UI uses the Dialden name without prototype branding. The homebrew package disables the system splash and launch spinner (`noSplashOnLaunch`, `spinnerOnLaunch`; https://www.webosbrew.org/pages/appinfojson). Install the full IPK to refresh launcher metadata; replacing the executable alone is insufficient. These flags still need verification on the TV.

Both desktop rendering and server representative stills use 1080p; native LG playback retains the stream’s decoded resolution. Stills preserve aspect ratio and use a new cache revision, requiring the updated server. They represent the current programme, not its exact live timestamp; the selected channel’s moving preview uses the live stream. Source quality still limits detail. Channel switches retain one serial media worker and exported window rather than overlapping teardown with a new decoder worker.

Measured on 2026-10-22: one cold nature-discovery playlist request took 4.197 seconds, a warm repeat 0.004 seconds. These are server HTTP timings, not TV first-frame measurements. Cold encoder startup and LG HLS buffering remain; PlxNative’s BUFFERSTREAM path is a separate architecture. First-frame timing is now also written to the TV diagnostic log.

### 0.1.2 bounded lineup preparation

Real playback sessions open `/api/client/v1/session` on a separate HTTP worker once the catalog arrives, prefer the selected channel, and renew every 30 seconds. The existing server staggers the other channels and applies its hardware-dependent concurrency limit. No TV tuner is created or substituted for direct HLS playback. Rapid focus updates coalesce while HTTP is busy. Hiding the app releases its unique per-launch session; on process termination a best-effort worker close is backed by the server's 180-second lease expiry. Older servers can reject preparation without preventing direct playback. Demo, screenshot and `--no-playback` runs never prepare a lineup.

Live server verification on 2026-10-22: a cold lineup session took 5.995 seconds, reported 1 of 7 channels ready, and a Nickelodeon playlist request after eight seconds of background preparation took 0.006 seconds. The temporary session was closed afterward. This removes repeated cold starts after browsing; it does not eliminate the first cold encoder startup or LG buffering. Native TV end-to-end timing remains unverified until installation. Native lifecycle tests cover request shape, coalescing, failed-open cleanup and hiding before startup; existing server tests cover worker caps, expiry, staggering and close races.

### 0.1.3 player lifecycle and controls

Rapid channel requests coalesce on the LG media worker; an accepted asynchronous load settles before teardown. See `webos/BUILD.md` for the observed crash and bounded lifecycle-timeout behavior. Up/Down navigates the visible vertical player menu and changes channels when it is hidden; Back dismisses controls before leaving playback. Routine buffering has only three subtle dots, with no panel or waiting headline.

### Native 0.1.5 interface preview
Adds an original soft launch wave on the first ready home entrance and a compact translucent player dock. Left/Right changes channel even with controls open; Up/Down moves between visible controls (or changes channels with controls hidden). Menu & launch sounds share a session toggle in Settings. Build and automated tests do not replace TV listening, mixing, and bright-scene readability checks.

### Native 0.1.6 home screen
Removes repeated station branding from preview loading; loads same-origin `iconUrl` PNGs from the channel catalog on a separate cached worker. Requires the matching server update for icons. Uploaded logos take priority; recognized networks use the server's bounded PNG cache sourced from https://github.com/tv-logo/tv-logos. This is display artwork only and does not enable on-air watermarks. Supported automatic identities initially include Nickelodeon, Nick Jr., Cartoon Network, Disney Channel, Disney Junior, and Toonami; others retain name labels. Assets use current source-catalog branding, not guaranteed era-specific logos.

### Native 0.1.9 guide responsiveness
Guide data is requested before entering the page, retained across tab changes and keyed by time window. Tab transitions rasterize the incoming page once and animate the texture for 180ms; input still bypasses decoration. Rounded panels fill their rectangular middle in one operation, preserving the antialiased corner strips. TV diagnostics include per-channel guide fetch duration and success. These changes pass local cache/retry tests and rendering checks; TV latency and frame-rate improvements still require an installed-build measurement.
