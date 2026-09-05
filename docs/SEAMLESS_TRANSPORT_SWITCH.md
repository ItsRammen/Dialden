# Seamless transport switching

## Goal

ToastTV should present one continuous HLS transport to an LG webOS client while
the server selects among already-running channel workers. The client keeps one
video element and one manifest URL; channel identity, logos, schedules, and the
Now/Next display remain client-side metadata.

## Existing boundary

Every channel worker already produces normalized H.264/AAC MPEG-TS with a fixed
GOP and one-second HLS segments. A per-viewer virtual tuner preserves segments
from the selected worker behind one stable manifest URL. Previously, a channel
change copied the target bytes unchanged and inserted `#EXT-X-DISCONTINUITY`.
Independent FFmpeg processes use independent PCR/PTS/DTS clocks and transport
continuity counters, so LG correctly treats that boundary as a decoder reset.

## Seamless path

For compatible MPEG-TS segments, the virtual tuner now:

1. Validates the PAT/PMT program map and requires the same stream types and PIDs
   throughout the tuner session.
2. Rewrites PCR, PTS, and DTS onto the tuner's continuous 90 kHz clock.
3. Rewrites per-PID MPEG-TS continuity counters across segment and channel
   boundaries.
4. Publishes the target edge without an HLS discontinuity, and keeps the
   outgoing entries advertised so the live window slides by one segment as
   usual. The target shares the outgoing decoder timeline, so cutting the
   window would show a native reader an unexplained media-sequence jump with
   nothing marking it — the resync this mode exists to avoid. Only a
   discontinuity commit still cuts the window.
5. Reports the transport mode and switch boundary to the client, which updates
   metadata only after playback crosses that boundary.

The source channel encoders remain shared. Rewriting is a bounded packet-copy
operation per viewer, not a decode or transcode.

## Fallback

Malformed transport packets, missing PAT/PMT data, a changed program map, or a
filesystem failure never produce a guessed seamless stream. The tuner falls
back to preserved source bytes plus `#EXT-X-DISCONTINUITY`, and the webOS client
uses its guarded freeze/re-attach transition.

The marker is not optional on that path. Once a session has published anything
on the rewritten clock, raw source bytes are a real timestamp reset even when
the channel never changed, so a mid-channel fallback is marked exactly like a
channel switch. Seamless output likewise only omits the marker while it
continues an established clock: a session re-arming after an incompatibility
starts a new one and marks that first boundary.

An incompatibility latches the session into discontinuity mode so steady-state
polling does not rewrite and discard every segment. The latch is retried at the
next channel switch, which already publishes a guarded discontinuity and is
therefore the one safe place to find out whether the transport recovered.

## Black bridge

A short black/silent bridge can be added later as another compatible source in
the same transport clock. It is deliberately not generated per tune and never
contains branding. A direct keyframe cut is the preferred first implementation:
it is faster and keeps all informational overlays in the webOS application.

## Expected latency

The switch becomes visible at the next target segment boundary. With one-second
segments and a client held near the live edge, the expected transport delay is
roughly zero to one segment plus network jitter. Data already buffered by the TV
cannot be recalled by the server, so this is near-instant rather than a literal
zero-millisecond cut.

That buffer sets the client's budget. A seamless cut is only confirmed once
playback drains past the media buffered when the tune was requested, so the
probe deadline is derived from that drain plus one progress window — a fixed
budget could only ever expire. Beyond `IN_PLACE_TUNER_SEAMLESS_MAX_DRAIN_MS`
the client does not start a seamless probe at all: the guarded freeze/re-attach
reaches the new channel sooner than waiting for the drain would.

Note that the drain reference must be the buffer measured when the tune was
*requested*, not when the response arrived. Because a seamless splice extends
the same buffered range, the later snapshot can already contain target content
the player fetched while the tune was in flight.
