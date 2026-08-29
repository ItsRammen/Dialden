# ToastTV Lab

A throwaway webOS app that probes whether MSE playback beats the native HLS
player for channel switching. It is **not** production code and is not wired
into the ToastTV client.

It exists because native HLS owns its buffer and will not release it, so a
server-side channel switch cannot reach the screen until whatever the TV has
already downloaded has played out. Measured on an LG 65QNED91SPA that costs
about 3.1 s per switch. hls.js hands the buffer back.

## What it does

Opens its own tuner session under a distinct client id, plays the existing
MPEG-TS tuner stream through hls.js (which transmuxes to fMP4 in JS, so the
server needs no change), and on a channel change flushes everything ahead of
the playhead before letting hls.js refill.

## Measured on LG 65QNED91SPA, webOS 6.5.3

| | native HLS (client 0.3.16) | hls.js + forward flush |
| --- | --- | --- |
| median | 3110 ms | 981 ms |
| range | 2951-5023 ms | 282-1813 ms |

Fragment sequence numbers confirm the switch reaches new media rather than
replaying the advertised window: one switch moved sn 35 -> 40 with the playhead
jumping 34.00 -> 39.02 s.

## Running it

    npx @webos-tools/cli ares-package --no-minify -o dist/webos clients/webos-lab
    npx @webos-tools/cli ares-install --device tv dist/webos/com.itsrammen.app.toasttvlab_0.0.1_all.ipk
    npx @webos-tools/cli ares-launch --device tv com.itsrammen.app.toasttvlab

Channel-up on the remote switches. `window.lab.stats()` and `window.lab.next()`
are exposed for driving it over the DevTools protocol.

## Known rough edges

`networkError/aborted` fires when the flush cancels an in-flight fragment load,
and hls.js spends time recovering — that is most of the gap between the 282 ms
best case and the 1813 ms worst. A production implementation should stop the
loader, flush, then restart it at the target position rather than flushing
underneath a live request.
