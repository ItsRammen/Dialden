# Third-party notices

## Inter fonts

`assets/Inter-Regular.ttf` and `assets/Inter-Bold.ttf` are distributed under the SIL Open Font License 1.1 in `assets/OFL.txt`.

Source: https://github.com/GLinnik21/plx-native/tree/f353f6d93c8fae14c6b51f1155d0f0a16db06186/pkg
Files: `appfont.ttf`, `appfont-bold.ttf`. These are the upstream static Inter font files, including its internal family-name modifications; the binary contents have not been changed here.

Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter).

## Rust dependencies

Dependency versions are pinned in Cargo.lock. Their individual licenses apply; this client's license does not replace them. SDL2 is supplied by the build/runtime environment and is licensed under the zlib license.

PlxNative provided architectural reference and design inspiration. Its branding, application screens and Plex playback implementation are not included in this prototype.

## Optional desktop playback

The `desktop-player` feature links the system-provided libmpv (https://mpv.io/). No mpv or PlxNative player source/binary is vendored here. mpv's applicable license depends on its build configuration and linked dependencies; preserve its notices and source obligations if distributing a bundled library. The client remains GPL-3.0-or-later.
