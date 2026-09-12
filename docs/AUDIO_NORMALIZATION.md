# Consistent volume and Night mode

Settings → Media engine → Channel audio controls server-generated HLS channel audio. Consistent volume defaults on; Night mode defaults off. No TV app update is required. Direct file playback and local MPV playback do not use these filters.

A single background FFmpeg worker measures the audio tracks selected for current and upcoming channel items, after stereo downmixing. Playback never waits for analysis. Until a measurement is available, only peak limiting is applied. Measurements take effect when the source is next prepared in a channel pipeline; an already-running pipeline is not interrupted to change its gain. Setting changes likewise apply to newly prepared pipelines.

Measurements are stored in `audio-normalization/measurements.json` under appdata. Source path and selected audio track determine the cache key; file size and modification time validate reuse. Validation runs in the background, with a one-minute retry interval. The cache holds at most 5,000 tracks and the pending queue at most 100. Analysis uses one decoder/filter thread, reads at up to eight times playback speed, and stops an individual job after 30 minutes. Turning Consistent volume off cancels pending/current analysis; application shutdown also cancels it.

Measured gain aims for -18 LUFS, capped by the measured -2 dBTP peak ceiling and a maximum +12 dB boost. A final limiter protects the output without automatic makeup gain. Very dynamic or exceptionally quiet files may remain below target rather than receive excessive gain. Measurements cover whole source files, not individual scenes or excerpts. Silent or below-gate audio is cached without added gain. Unreadable files remain unmeasured and do not interrupt streaming.

Night mode adds gentle compression to soften loud passages. It is independent of Consistent volume and does not require cached measurements. Both the software and hardware-video channel pipelines run the same audio filters on the CPU, before concatenation and AAC encoding. Original media are never rewritten.

The settings card shows measured, queued, active, and failed analysis counts. Failed analysis counts are diagnostic attempts, not a declaration that a library file is corrupt.
