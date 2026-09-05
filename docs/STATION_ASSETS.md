# Station Assets library

**Station Assets** is the user-facing name for the dedicated library containing
bumpers, idents, fillers, and standby loops. The database continues to call
these files `interlude` media, and the container path remains
`/media/interludes` for compatibility with existing installations.

Programme libraries should remain read-only. Station Assets should be a
separate writable directory when uploads, generated bumpers, or renaming are
enabled.

## Deployment paths

| Deployment | Host path | Container path | Access |
| --- | --- | --- | --- |
| Unraid | `/mnt/user/appdata/toasttv/station-assets` | `/media/interludes` | Read/write |
| Docker Compose | `TOASTTV_STATION_ASSETS_PATH` | `/media/interludes` | Read/write |
| Legacy/local | `<media directory>/interludes` | Not applicable | Read/write |

Set `TOASTTV_STATION_ASSETS_WRITABLE=true` only when that dedicated mount is
writable. This permission does not make the TV or movie roots writable. Older
host directories named `interludes` can remain in place; point the Station
Assets mapping at them rather than moving files solely for the new label.

ToastTV can select bumpers by station and adjacent shows, then use filler
assets to cover the end of a bounded lineup slot instead of leaving the channel
with no scheduled media.

## Recommended layout

The manager creates these folders automatically:

```text
station-assets/
  nick/
    bumpers/
      more/
      up-next/
      now-next/
    idents/
    fillers/
    standby/
```

Folders are for organization; matching is driven by the canonical filename.
Use the channel ID as the station slug. Nickelodeon and Nick Jr. profiles share
the special `nick` slug.

## Filename contract

Use lowercase slugs separated by double underscores. Keep the year in show slugs when it is part of the library collection identity.

| Purpose | Filename |
| --- | --- |
| More of the same show | `nick__bumper-more__show-spongebob-squarepants-1999__target-08s__v01.mp4` |
| A show is up next | `nick__bumper-up-next__next-spongebob-squarepants-1999__target-08s__v01.mp4` |
| Now and next shows | `nick__bumper-now-next__now-spongebob-squarepants-1999__next-the-fairly-oddparents-2001__target-12s__v01.mp4` |
| Generic station ident | `nick__ident-general__target-08s__v01.mp4` |
| Short duration filler | `nick__filler-general__target-15s__v01.mp4` |
| Long standby loop | `nick__standby-loop__target-60s__v01.mp4` |

The `target` value describes the intended duration, but ToastTV uses the probed media duration for scheduling. Increment `v01`, `v02`, and so on for alternatives. Variants are selected deterministically, so rebuilding the same schedule does not randomly change it.

## Selection order

At a transition, ToastTV tries:

1. An exact `bumper-now-next` match.
2. A same-show `bumper-more` match.
3. A `bumper-up-next` match.
4. A generic station ident.
5. A legacy, unstructured interlude.

At the unused end of a bounded lineup slot, it prefers `filler-general`, then `standby-loop`, and clips the final scheduled play to the slot boundary. An ident is used as filler only when it is long enough to cover the remaining time.

Assets never cross station prefixes: a `nick` schedule will not borrow a `cbbc` filler.
Files that contain the structured `__` separators but fail the contract are withheld from automatic matching instead of silently becoming generic legacy bumpers.

## Nick pilot pack

Start with a small pack that can exercise every path:

- Two or more variants of the most common `bumper-more` combinations.
- `bumper-up-next` assets for SpongeBob and The Fairly OddParents.
- Exact `bumper-now-next` assets for the most common pairs in both directions.
- Three generic idents around 5–10 seconds.
- General fillers around 5, 10, 15, 30, and 60 seconds.
- One clean 60-second standby loop with audio that also loops cleanly.

After indexing the files, open **Library → Station Assets**. It scans likely
assets, reports naming and playback problems, and provides fields for station,
asset type, show relationships, target duration, and variant. Use **Preview
name** to inspect the canonical filename, then **Rename and configure** to
rename the real file, mark it as an internal interlude, and apply the selected
playback decision.

Collectionless station assets are fail-closed. The manager defaults to explicit
approval, but can instead leave an asset following policy or explicitly block
it. In a read-only deployment the complete scan and filename preview remain
available while mutation controls are disabled.

### Uploading finished clips

Use **Upload a finished clip** when the video is already authored. Choose the
file and configure its meaning; ToastTV stores it under the mounted Station
Assets library at `<station>/<category>/`, gives it the canonical filename,
marks it as an interlude internally, and applies the playback choice. MP4, MKV,
AVI, MOV, and WebM files up to 512 MB are accepted. Existing files are never
overwritten: an occupied variant advances to the next free number.

### Designing simple bumpers

Use **Design a simple bumper** for a clean 1080p title card. The live browser preview shows the wording and palette. ToastTV renders the final H.264/AAC MP4 with FFmpeg and includes a stereo audio stream so clients do not have to reconfigure between assets. Generated clips are limited to 60 seconds and use the same folders, names, approval rules, and collision protection as uploaded clips.

## Scheduling configuration

Open **Settings → Playback and scheduling → Station assets** to enable or
disable scheduled breaks and choose how many programmes play between them.
Channel transitions prefer exact now/next assets, then show-specific bumpers,
then a generic ident. Fillers and standby loops are reserved for unused time at
the end of bounded schedule slots.

## Pilot acceptance checks

- The Nick guide has no uncovered time inside a bounded slot when a playable Nick filler or standby asset is available.
- Show-specific bumpers mention the actual adjacent scheduled shows.
- The same schedule inputs produce the same bumper variant.
- No asset with another station prefix appears on Nick.
- The final filler ends exactly on the next slot boundary.
