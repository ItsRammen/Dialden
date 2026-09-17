# Playback incident reports

Requires server support and webOS app 0.7.3 or later. Open Overview → TV connections → Playback incidents, or `/diagnostics/playback`. JSON export is available at `/api/admin/v1/playback-incidents`.

The app reports tuning/reconnects stuck for 45 seconds, watchdog stalls, media-element errors, recovery attempts, recovery verified by advancing playback, and terminal playback failures. Reports include the app version, channel/program identifiers, tuner session, timeline revision, media clock, buffer ahead, ready/network states, available frame/drop counters, and recovery elapsed time. The server adds receipt time and worker state/program/revision at receipt. TV-estimated server time helps correlate delayed reports; it is not an authoritative timestamp. Worker state describes receipt time, not necessarily the moment an offline TV froze.

The TV retains up to 30 pending reports in local storage (when available), scoped to the configured server, retries on subsequent heartbeats, and removes only acknowledged reports. Same-kind events are throttled to one per two seconds. App 0.7.5 restores pending reports after restarting and requires explicit saved-event acknowledgements from the updated server. Older servers leave reports pending. Reports cannot be transmitted while the TV is powered off or disconnected. Pending reports expire after seven days when restored. The server deduplicates retries and keeps the latest 500 reports in `diagnostics/playback-incidents.json` under appdata. Reports older than seven days are excluded from the view and pruned on subsequent writes. No raw media URLs, paths, or arbitrary error messages are retained.

This captures evidence, not automatic root-cause classification. Empty buffers suggest delivery starvation; advancing media clocks with stalled frame counters suggest a decoder issue. Correlate the recorded programme/timeline and worker state with server logs before drawing a conclusion.

Normal heartbeats from app 0.7.5 include `appVersion`, visible in `/api/admin/v1/clients`, so an outdated installation can be distinguished from missing reports. A TV that stops executing JavaScript cannot record its own freeze; absence of a heartbeat is evidence of lost contact, not proof of a decoder or server failure.

App 0.7.7 records active-playback `waiting`/`stalled` events immediately (excluding tuning, deliberate pauses, seeking, and background playback). These use the backward-compatible `stall` event with a `trigger` field; they indicate observed buffering, not a confirmed prolonged freeze. Silent lack of progress is reported after five seconds; the recovery watchdog retains its twenty-second threshold.

## Scan responsiveness and server health context

The September 16, 2026 Nick reports showed two approximately 13-second stalls overlapping the 15-minute library safety scans. Scan logs covered 23,385 files; no encoder exit appeared in the supplied window. This is strong correlation, not proof that every playback interruption has the same cause.

Library scans now use asynchronous directory traversal, readiness and timestamp checks, with at most 32 concurrent timestamp reads. Index writes commit at most 250 files per batch and yield to the event loop between batches. Batch locator reads also yield. Existing verified files retain root availability during the scan; new files remain unavailable until root validation completes. Traversal failures preserve the old index and mark the affected root unavailable.

Playback incidents now include scan status/start/completion times, the maximum observed server event-loop delay in the preceding minute, and HLS request counts, errors (including 404/503), maximum response setup time and age of the last successful segment response. Requests are scoped to the reported tuner session, or channel for legacy clients. History is bounded to 2,000 requests and 120 loop samples, with a 60-second cutoff. No URLs, query parameters or raw errors are persisted. A segment response age of -1 means no successful segment response was observed in that history.

These are receipt-time observations. reportDeliveryDelayMs estimates how late the TV report arrived using its estimated server clock; delayed reports may describe an earlier event outside the history window. HLS response setup timing ends when the handler returns the response: it does not measure completion of network transfer or playback on the TV. Worker live status is not proof of timely segment production.

High event-loop delay alongside a scan supports server scheduling contention. Slow response setup or HLS errors indicates server delivery trouble. Normal server observations do not rule out network/TV buffering, encoder delays or an incident that was reported late. Existing app 0.7.7 reports automatically receive this server context after a server update; no TV reinstall is required for these fields.
