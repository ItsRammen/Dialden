# Playback incident reports

Requires server support and webOS app 0.7.3 or later. Open Overview → TV connections → Playback incidents, or `/diagnostics/playback`. JSON export is available at `/api/admin/v1/playback-incidents`.

The app reports watchdog stalls, media-element errors, recovery attempts, recovery verified by advancing playback, and terminal playback failures. Reports include the app version, channel/program identifiers, tuner session, timeline revision, media clock, buffer ahead, ready/network states, available frame/drop counters, and recovery elapsed time. The server adds receipt time and worker state/program/revision at receipt. TV-estimated server time helps correlate delayed reports; it is not an authoritative timestamp. Worker state describes receipt time, not necessarily the moment an offline TV froze.

The TV retains up to 30 pending reports in memory while running, retries on subsequent heartbeats, and removes only acknowledged reports. Same-kind events are throttled to one per two seconds. Reports cannot survive closing the app or report a powered-off/disconnected TV until connectivity returns. The server deduplicates retries and keeps the latest 500 reports in `diagnostics/playback-incidents.json` under appdata. Reports older than seven days are excluded from the view and pruned on subsequent writes. No raw media URLs, paths, or arbitrary error messages are retained.

This captures evidence, not automatic root-cause classification. Empty buffers suggest delivery starvation; advancing media clocks with stalled frame counters suggest a decoder issue. Correlate the recorded programme/timeline and worker state with server logs before drawing a conclusion.
