# Native TV playback preview

This package includes native HLS playback through LG’s Starfish media API on the tested QNED91SPA/webOS 6.5.3. It uses an exported video window beneath SDL, with one muted home preview promoted to full-screen with audio. This remains a preview: keep the existing Dialden app available while validating channel transitions and long-running playback. Desktop libmpv is excluded.

The package ID is `com.itsrammen.dialden.native`, version `0.1.3`, title **Dialden**. It does not replace the existing app. `server.txt`, adjacent to the executable, supplies the endpoint for this private test build; credentials are not supported. The endpoint is validated with the same rules as `--server`.

## Rebuild

Install Rust's `armv7-unknown-linux-gnueabi` target and the webOS CLI (`ares-package`). Download and relocate the official x86-64 Linux SDK:

- Source: https://github.com/openlgtv/buildroot-nc4/releases/tag/2026.08-webos
- File: `arm-webos-linux-gnueabi_sdk-buildroot-x86_64.tar.gz`
- SHA256: `2230a6351e5cce6fcb9d4fdcb4697335f223995401ef969c81744aaeb14c5344`
- Run the extracted SDK's `relocate-sdk.sh` before building.

```sh
rustup target add armv7-unknown-linux-gnueabi
WEBOS_SDK=/path/to/arm-webos-linux-gnueabi_sdk-buildroot \
DIALDEN_SERVER=http://your-server:1993 \
DIALDEN_PACKAGE_OUTPUT=/tmp/dialden-native-tv-package \
  tools/build-webos.sh
```

The script builds ARMv7 soft-float, strips the executable, packages existing Dialden icons, and records dynamic dependencies and symbol versions alongside the IPK. No SDK libraries are bundled and nothing is installed automatically. The SDK itself is not redistributed.

## Compatibility work

- TV launches request the Back key and full-screen presentation before SDL starts.
- Modern Rust/ring expect `getauxval`; the SDK's glibc 2.12 does not export it. A small ARM/webOS-only implementation reads the kernel auxiliary vector without allocating, including during startup. It preserves an existing zero value and sets ENOENT for absent keys.
- The TV ribbon uses narrow texture strips with the same shape function, avoiding hard dependencies on `SDL_RenderGeometryRaw` and `SDL_SetTextureScaleMode`. The desktop keeps its mesh renderer.
- The executable's required GLIBC versions are at most 2.12. Other imported SDL functions still need checking against the actual TV libraries. Never replace the TV's system libraries to satisfy this app.

## Validation status

Cross-compilation and IPK packaging succeed. The native unit suite passes with the `webos` feature. The desktop playback build has been tested independently with actual Dialden HLS.

On 2026-10-22 the package was installed on the LG QNED91SPA running webOS 6.5.3. The executable passed `--help`, and the installed app was verified in the foreground with a TV screenshot showing seven real server channels. Remote navigation, sustained performance and playback are not validated by this startup check. Root SSH uses port 22. Luna commands on this TV required `ssh -tt` to produce responses; a first foreground check returned Home before the app was subsequently observed running. Direct shell launch without the application-manager environment fails with no video device; use the application manager.

Earlier emulator limitation: QEMU against the downloaded SDK runtime fails before app entry, inside the loader while invoking a null initializer in the SDK's `libc.so.6`. This is not proof of a crash with the TV's runtime, and it is not a passing smoke test. The TV's actual library inventory and a startup check are required before calling this package runnable.

The identified TV advertises itself as LG QNED91SPA at `LGwebOSTV.local`. Root SSH must be enabled and reachable to inspect its firmware libraries and logs. Keep the default developer-mode connection separate from root SSH; they use different users/ports.

Once connected: inspect architecture, webOS version, imported SDL symbols and dynamic dependencies; stage the binary in a temporary directory for `--help`; then install the separate IPK, launch it, and test arrows/OK/Back, server data, artwork, page transitions and returning Home. Record launch failures rather than repeatedly relaunching an unverified binary.

## Native HLS adapter

`playback_webos.rs` resolves the firmware's C++ API symbols at runtime and reserves opaque object storage following the public webos-userland ABI header; no firmware binaries are shipped. Constructor uid is null (the pre-authorized uMS namespace). Load arguments are `[url, options]`, with HLS transport and `option.appId`/`option.windowId`. The player owns its audio volume; system TV volume is not changed.

All media operations run on one worker thread. UI commands and generation-tagged results prevent late results from changing a newer channel. A session owns its callback context through unload/destruction. Exiting never waits on a blocked media call on the UI thread. Exported-window changes remain on the SDL thread; the renderer clears only the video rectangle to transparent and preserves aspect ratio. LG video is not available as a texture for glass blur.

Playback event 0 supplies the HLS clock on this firmware; the synchronous clock getter can stay at zero. Prefer callback progress so the watchdog does not reconnect healthy streams. Decode readiness, buffering, errors and ended streams feed the existing retry policy. Firmware buffering strings include `start buffering`/`stop buffering`. The system owns Home/Exit.

Verified on the TV: 1920×1080 HLS loaded, playing callbacks, actual decoded live video in a screenshot, sustained playback beyond the 20-second watchdog, and a buffering start/end recovery. Full-screen audio, rapid channel switching, bumper/discontinuity boundaries and extended soak testing still require validation. Do not equate successful desktop tests or cross-compilation with that device validation.

## TV input and startup fix (2026-10-22)

The initial firmware test exposed LG's extra `inputSource` word in keyboard/text events. Upstream rust-sdl2 bindings read the wrong offsets, so arrows were decoded as other keys. `platform::events` removes that word before decoding, reads custom key values as integers, and translates Back/channel keys. Mouse events keep their standard layout. The UI now handles pointer hover/click and wheel input for the connected browsing screens, guide, player controls and details. Setup-demo pointer support is separate and not implemented.

The generic ARM target enabled software floating point. The build now enables VFPv3/NEON while preserving the soft EABI calling convention. This requires a CPU supporting those instructions (verified on this QNED91SPA); do not distribute to unchecked hardware. With the installed firmware, graphics/font preparation fell from 26.4 seconds to 2.2 seconds and first present was measured at 2.3 seconds. The renderer is accelerated OpenGL ES 2. Frame pacing no longer adds a full 16 ms after vsync. Local regression suites pass (53 tests in both webOS and desktop configurations); physical remote logs confirm arrows/OK/Back and navigation to Settings/Guide. Pointer hit-testing has automated coverage; physical pointer interaction still needs user confirmation.

Bounded diagnostics are written to `/tmp/dialden-native-diagnostics.log` (startup timing, renderer, frame totals and key/click events, no entered text). The temp log is capped at 128 KiB. Home/Exit remain owned by the system. See the official SDK `SDL_events.h` and `SDL_webOS.h` for LG's event layout and scancodes.

## Startup background

The static ambient field and its blurred sample are bundled as small PNG assets instead of calculating hundreds of thousands of floating-point operations and a blur before drawing. SDL presents an app-owned dark frame immediately after renderer creation; the complete UI first present measured 0.56–0.63 seconds on this TV. This is UI startup timing, not channel tuning latency. A gray system launch indicator should therefore be much shorter; physical confirmation is still needed.

## 0.1.3 rapid-switch crash mitigation

The TV crash report at 2026-10-22 10:56:23 UTC records SIGSEGV in StarfishMediaAPIs::allocateResource from the asynchronous AdaptivePipeline resource callback. App logs show rapid card navigation unloading accepted HLS loads before load-complete. Version 0.1.3 waits for load completion/error on the media worker before unloading, waits for unload acknowledgement, and coalesces queued channel choices before loading the latest. Load payload storage stays alive with the native object. A lifecycle timeout quarantines one object and stops the worker rather than freeing callback storage still potentially in use; the app must then be restarted. The exported window remains valid until process exit. This is mitigation for the observed sequence, not proof against every firmware callback race.

Installed through the TV package manager and launched successfully. Tested 32 remote navigation events: 16 delivered in a fast burst and 16 with 350 ms delay between SSH calls. Playback resumed and the only crash report remained the earlier 0.1.2 report. 60 unit tests pass in both desktop and webOS feature configurations; ARM build succeeds. Longer physical remote/pointer testing is still needed.
