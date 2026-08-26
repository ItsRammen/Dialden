# LG webOS client

ToastTV includes a packaged LG webOS client in `clients/webos`. It connects to
the ToastTV server over the trusted home LAN, displays the configured channels
and guide, and joins the program already in progress.

## Before packaging

1. Start ToastTV and wait for `Background scan complete` in the server logs.
2. Make the server reachable from the TV. Docker deployments normally need
   `TOASTTV_BIND_ADDRESS=0.0.0.0` in `.env`.
3. From another device on the same network, open
   `http://<toasttv-host>:1993/tv/`. This browser preview uses the page's current
   origin as its server URL and exercises the same client files as the TV app.

The installed TV app initially suggests `http://TOWER:1993`. Change it on the
setup screen if the server has another hostname, address, or port. The app saves
the chosen URL on the TV. If `TOWER` is not resolvable by the TV, use the
server's LAN IP address, for example `http://192.168.1.20:1993`.

ToastTV currently has no authentication, so keep port `1993` on a trusted home
LAN and do not expose it directly to the internet.

Media mounts are read-only inside the container. Do not replace or rewrite a
mounted video from the Unraid host while it is actively streaming; finish the
copy first, then let ToastTV discover the completed file.

## Using the TV remote

ToastTV resumes the last watched channel at launch. If tuning takes more than a
couple of seconds, **Browse channels** and **Server settings** appear without
cancelling the background preparation.

- **OK** shows or hides the single now-playing information bar.
- **Left / Right** and **Channel - / +** tune the previous or next on-air channel.
- **Up** opens the seven-day guide.
- **Down** or **Back** opens the channel browser.
- **Play** rejoins live playback; **Pause** pauses locally.

The channel browser uses a vertical channel rail and a detailed now/next panel.
Moving focus previews a channel without tuning it; press **OK** to watch. Channel
logos are application artwork shown in the browser and player information only.
They are never burned into the video stream.

The guide is a translucent overlay over the playing channel. **Left / Right**
move directly between station-calendar days, **Channel - / +** preview the
previous or next channel, and **OK** on either a channel or programme tunes that
channel live. **Back** closes the guide without touching the current decoder. A
different channel is prepared while the old picture keeps playing; its global
switching card reports progress until the short decoder handoff begins. Weekly
schedules come from the server independently of encoder readiness, so merely
browsing the guide never starts or tunes another channel.

## Local preview and LG Simulator

The `/tv/` browser preview is the quickest way to inspect the 1280×720 layout,
focus order, remote-key behavior, server requests, and recovery states locally.
LG's webOS TV Simulator can additionally exercise application launch and
webOS-style remote input after importing `clients/webos`, but its media support
does not exactly match a physical TV. Final HLS decoder, buffering, CORS, and
channel-change verification therefore still belongs on the target LG set.

LG documents the simulator in its
[Simulator introduction](https://webostv.developer.lge.com/develop/tools/simulator-introduction)
and [installation guide](https://webostv.developer.lge.com/develop/tools/simulator-installation).

## Build the IPK

Use the repository script, which downloads LG's official CLI at the pinned
version and packages the client:

```powershell
npm run webos:package
```

The package is written to:

```text
dist/webos/com.itsrammen.app.toasttv_0.3.7_all.ipk
```

LG documents the CLI installation and packaging commands in its
[CLI installation guide](https://webostv.developer.lge.com/develop/tools/cli-installation)
and [CLI developer guide](https://webostv.developer.lge.com/develop/tools/cli-dev-guide).

## Install on an LG TV

The TV and development computer must be on the same network.

Install LG's device commands once before the first sideload:

```powershell
npm install --global @webos-tools/cli@3.2.5
```

1. Create or sign in to an LG Developer account.
2. Install **Developer Mode** from LG Apps on the TV.
3. Open Developer Mode, sign in, enable **Dev Mode Status**, and allow the TV
   to restart.
4. Reopen Developer Mode and enable **Key Server**. Note the TV's IP address
   and the six-character passphrase shown by the app.
5. On the development computer, register the TV:

   ```powershell
   ares-setup-device
   ```

   Select `add`, then use a memorable device name such as `toasttv-lg`, the
   TV's IP address, port `9922`, and SSH user `prisoner`. A password is not
   required.

6. Retrieve the TV key, then verify the connection:

   ```powershell
   ares-novacom --device toasttv-lg --getkey
   ares-device --system-info --device toasttv-lg
   ```

   Enter the case-sensitive passphrase displayed on the TV when prompted.

7. Install and launch ToastTV:

   ```powershell
   ares-install --device toasttv-lg dist/webos/com.itsrammen.app.toasttv_0.3.7_all.ipk
   ares-launch --device toasttv-lg com.itsrammen.app.toasttv
   ```

Repackage and run `ares-install` again after client changes. Developer Mode is
time-limited; use **Extend Session Time** in the TV's Developer Mode app before
it expires. If Developer Mode expires, development-installed apps are removed.
LG's [Developer Mode app guide](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app)
contains the full device setup and renewal workflow.

## Playback compatibility

The client stays on one per-channel HLS URL while the server schedules episodes
and interludes. ToastTV normalizes the channel output to 1080p H.264 video and
stereo AAC audio, so mixed source containers and codecs do not force the TV to
reload at each boundary. One FFmpeg worker is shared by all viewers of a channel
and starts only when a viewer tunes in.

During a channel change ToastTV keeps the outgoing decoder playing while the
server warms the destination, resolves its now-playing source, and verifies a
complete HLS manifest with at least two segments. It then releases the outgoing
decoder, attaches the prepared stream, and reveals it only after playback time
advances with a usable buffer. This deliberately avoids overlapping two media
pipelines, which LG does not officially support on webOS TV. The tuning backdrop
covers only the short single-decoder handoff; a failed preflight never disturbs
the old channel, and **Back** cancels a pending switch.

If HLS cannot start, the client falls back to the current program's original
direct-file URL. Direct fallback compatibility still varies by LG generation;
H.264/AAC MP4 is the conservative format to test. LG publishes generation-specific
[audio/video format tables](https://webostv.developer.lge.com/develop/specifications/video-audio-50)
and its [streaming protocol matrix](https://webostv.developer.lge.com/develop/specifications/streaming-protocol-drm).

## Troubleshooting

- **Server unavailable:** confirm the saved URL, use a LAN IP instead of a
  hostname, and verify `/api/v1/health` from another device on the same network.
- **Empty channel:** wait for the background scan, then confirm eligible media
  appears under **Kids 7** in the administration UI.
- **Guide loads but video fails:** inspect the Dashboard's separate channel
  worker state and container logs for FFmpeg errors. A direct fallback failure
  can still indicate an unsupported source codec/container.
- **Install cannot connect:** reopen Developer Mode, enable Key Server again,
  retrieve the key, and check that the Developer Mode session has not expired.
