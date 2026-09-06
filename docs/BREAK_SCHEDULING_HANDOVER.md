# Handover: station-asset selection and generated schedule cards

Written 2026-09-06, at the end of a long session on break scheduling. Everything
described as done is committed and pushed to `main` (`9cb99b8`..`0b53dcd`).

The work below is in priority order. The first two items are **live bugs with
measured impact**; the third is a prerequisite for the fourth, which is the
feature the user actually asked for.

---

## Context: what changed this session

The user reported Nickelodeon playing one 28-second interlude thirty times in a
row across a fourteen-minute gap. That led to a chain of fixes:

| commit | what |
|---|---|
| `9cb99b8` | Filler selection picked from a length *band* rather than only the longest, plus a recently-played memory |
| `773dce2` | Slot remainders are spread across breaks as elastic pods instead of banked as a tail |
| `eef7f4b` | Break position (`break-out` / `break-in` / `standalone`) parsed and honoured; `event-packaging` rejected |
| `ef7d4a2` | A break is bracketed: "we'll be right back" opens, "up next" closes. Nick Jr separated from Nickelodeon's asset pool |
| `bf7a7d6` | Break position read when a season follows it (`generic-break-out-summer`) |
| `1d3a8c8` | In-season pieces preferred while their window holds, with spacing |
| `0b53dcd` | `logoPath` actually drawn (it had been a dead option since the module was written) |

Two of these are worth knowing about because they were *latent* bugs that only
surfaced when something else changed:

- Nick Jr and Nickelodeon both resolved to station key `nick`, so all 248
  `nick-jr--` assets were unreachable and the preschool block wore its sibling's
  bumpers. Surfaced only when the user renamed the asset folders.
- `rightNow` ("starts right now") was parsed but consulted by no selector. Inert
  while breaks were single stings; actively wrong once breaks became pods.

---

## 1. The length band collapses when long pools are mixed — LIVE BUG

**Impact, measured against the real library over a day:**

| channel | interlude plays/day | distinct used | pool size | most-repeated |
|---|---|---|---|---|
| Nickelodeon | 235 | 81 | 428 | **87x** |
| Nick Jr. | 200 | 34 | 248 | 29x |
| Disney Channel | 92 | 21 | 27 | 59x |

The worst offenders are all long-form:

```
87x  nickelodeon--filler--generic-long-form-nick-extra-standalone--2007--N3408-01.mp4
23x  nick-jr--filler--generic-long-form-show-interstitial-standalone--2011--...-N13918-02.mp4
```

**Cause.** `FILLER_LENGTH_BAND` (`src/services/StationAssetService.ts:394`) keeps
only candidates within 30% of the *longest asset that fits*:

```ts
const longest = Math.max(...fitting.map((entry) => entry.item.durationSeconds))
const longEnough = fitting.filter(
  (entry) => entry.item.durationSeconds >= longest * FILLER_LENGTH_BAND
)
```

That was tuned when every asset was 5-28s. The user has since imported a
long-form pool (67 assets, up to 70s on Nickelodeon and 120s on Nick Jr), so the
threshold jumped to roughly 21s and the candidate set collapsed from ~500 short
assets to the few dozen long ones.

This is structurally the same failure as the original thirty-in-a-row bug: a
pool narrowed before the seed is applied. It was reintroduced by new *content*
rather than new code, which is why no test caught it.

**Do not simply lower the band.** It exists for a real reason — without it a
130-second pod fills with twenty-two 5-second idents. The fix needs to keep
"prefer something substantial" while not collapsing the pool. Options worth
weighing:

- Bound the reference length (band relative to `min(longest, cap)`) so one 120s
  asset cannot redefine the tier.
- Bucket by length and pick a bucket first, then an asset within it, so short
  and long assets both stay reachable.
- Target the *remaining budget* rather than the longest asset, per the
  exporter's own guidance in `docs/` ("prefer the asset that leaves the smallest
  non-negative remainder") — but note that strict best-fit is what produced the
  original repeat bug, because a deterministic tie always resolves the same way.

**Regression test to add:** a pool mixing 5-28s and 60-120s assets must use both
populations across a long gap. `tests/StationAssetService.test.ts` has a
`describe('filling a long gap')` block modelled on the real library; extend it.

---

## 2. The transition picker has no repeat memory — LIVE BUG

`selectStationTransitionAsset` (`src/services/StationAssetService.ts:323`) takes
no `recentlyPlayed` parameter at all. Every other selector grew one this session;
this one was missed. It is why identical station IDs cluster.

Callers are both in `ChannelService.emitBreakPod`
(`src/services/ChannelService.ts:2077`), which already maintains a
`recentBreakAssets` history capped at `FILLER_MEMORY`
(`src/services/ChannelService.ts:210`, which is `STATION_ASSET_HISTORY`) and passes it to
the filler selector. Threading the same list through is straightforward. Mind
the priority tiers: exclusion should apply *within* a tier, and must fall back
rather than return nothing when a tier is exhausted — an "up next" bumper for
the right show beats variety.

---

## 3. drawtext escaping is one layer short — BLOCKS ITEM 4

`escapeDrawText` (`src/services/bumpers/renderSpec.ts:44`) escapes for drawtext
but not for the filtergraph parser, which consumes one level of backslash before
drawtext sees the value. **Any text containing a colon fails to render:**

```
text=at 8\:30   -> exit 234, "No option name near '30:fontcolor=..."
text=at 8\\:30  -> exit 0
```

This is pre-existing, not from this session's changes (confirmed by rendering
through the untouched `-vf` path). The module docstring specifically claims to
handle `"Bob's Burgers: 6.30"`, and `tests/Bumpers.test.ts` asserts the escaped
string — but the test only checks the argument vector, never that ffmpeg accepts
it. That is why it went unnoticed.

Five escaping strategies were tried against `Bob's Burgers: 100% off \ now`.
Doubling the escapes fixes colons but apostrophes still break the graph parser;
single-quoting fixes apostrophes but then colons split the option list. No
single-pass escaping was found that survives both layers for all four special
characters (`: ' % \`).

**Recommended fix: use `textfile=` instead of `text=`.** It sidesteps escaping
entirely, which matters because programme titles are arbitrary user data. The
cost is that `renderSpec.ts` is deliberately pure — it builds an argument vector
and touches no files, so that the command can be asserted character by character
in a test. Writing a text file has to move to the caller
(`BumperAdministrationService.generate`), and `buildBumperArgs` should take the
already-written path.

**Whatever the fix, add a test that actually runs ffmpeg** on a torture string.
Guard it with `test.skipIf(noFfmpeg)` — CI images vary, and there is precedent
for this in the repo.

---

## 4. Generated "up next" schedule cards — THE FEATURE

The user wants cards that show the upcoming programme plus what follows over the
next 30-60 minutes, over a music bed, with the station logo in the corner.

### Why it is worth building

Four channels have no station assets at all and run genuinely dead:

| channel | days with gaps | worst gap | dead air/week |
|---|---|---|---|
| PBS Kids | 7/7 | 23m34 | **7h 12m** |
| Disney Junior | 7/7 | 24m22 | **6h 24m** |
| Cartoon Network | 7/7 | 17m21 | **5h 22m** |
| Disney Channel | 7/7 | 7m09 | **1h 57m** |
| Nickelodeon, Nick Jr., Nature & Discovery | 0/7 | none | none |

That is ~21 hours a week of off-air. No amount of selection tuning fixes it —
those channels have nothing to select from. Cards give them a pool.

On Nickelodeon and Nick Jr the case is different: no gaps, but breaks run to a
**7-second median**, too thin to read as a break. Cards give them substance and
carry information a fifth station ident does not.

### What already exists

`src/services/bumpers/` is a working generator, largely unwired:

- `renderSpec.ts` builds the ffmpeg argument vector (`lavfi` colour source +
  `drawtext`), and **deliberately always writes a silent audio track** — a
  segment with no audio stream makes players reconfigure mid-channel. Any music
  bed must keep the same codec, rate and layout (aac / 48000 / stereo) or it
  reintroduces exactly the stall that track prevents.
- `logoPath` now renders, inside the title-safe area (5% inset) so overscan does
  not crop it.
- `BumperAdministrationService.generate()` renders, then indexes the file as a
  playable station asset with a proper `buildStationAssetFilename` name — so a
  generated card automatically inherits break positions, pod ordering, seasonal
  spacing and repeat avoidance. **This is the key integration point.**
- `resolveBumper.ts` is fully designed and referenced only by tests. Its
  `BumperPlan.cacheKey` is documented as "stable for identical text", which is
  the mechanism a schedule-aware card needs.

### The hard part

A static bumper is cached by its text and reused forever. **A schedule card
cannot be** — its text changes every airing, so it must be rendered per break and
cached by content.

Renders must therefore happen *ahead* of air. Schedules are deterministic
(`buildDay` gives the same result for a given date), so a pre-render pass at
schedule-build time works. Roughly 500 cards/day across all channels with no
cache hits, a second or two each — cheap, especially on the QSV pipeline.

The open design question is *placement*: the scheduler currently picks assets
from a pool by station and kind. Placing a *specific* card at a *specific* break
needs either a card-aware step in `ChannelService`, or substitution at resolve
time (`ChannelTimelineResolverService` looks like the right seam). This has not
been designed yet and is the main thing to think through.

**Do not render one long card for a 24-minute hole.** Render a ~30-60s card per
upcoming programme and let the existing pod and tail machinery rotate them.
A single card looped for 24 minutes is item 1's bug in nicer clothes.

### Smaller things

- `generate()` caps duration at 60 seconds
  (`src/services/BumperAdministrationService.ts:238`). Raise it, or use the
  loop-and-rotate approach above.
- Generated cards must be filtered out of the Guide and Now/Next the same way
  bumpers already are (`isViewerGuideProgram` in `clients/webos/app.js`), or the
  line-up fills with "Up Next" entries announcing themselves.
- Music is the only part needing *sourcing* rather than code.

---

## Reproducing the measurements

Every figure above came from driving the real library and config through
`ChannelService`, in a throwaway file under `tests/`. Load:

- media from `/mnt/tower/appdata/toasttv/media.db`
- policy from `/mnt/tower/appdata/toasttv/kids-7.library.json`
- channels via `ChannelConfigurationStore` on
  `/mnt/tower/appdata/toasttv/channels.json`

Two traps cost real time:

1. `collectionIdentityKey` is **not a stored column**. It is a subquery against
   `media_collections` (`src/repositories/MediaRepository.ts:135`). Select it
   the same way, or group resolution silently fails and every channel returns an
   empty guide.
2. `playbackEnabled` must be derived as the repository does
   (`root_available && duration > 0 && (playback_override ?? policy_enabled)`),
   not set to `true`. Only 4,896 of 22,169 videos are policy-enabled.

Give the test an explicit long timeout; a week across seven channels exceeds the
5s default.

---

## Unrelated, still outstanding

- **25 files carry CRLF line endings** (LICENSE, package.json, tsconfig.json,
  the workflows, the CSS). Not introduced this session; they will show as
  whole-file rewrites on the next commit that touches any of them. A
  `.gitattributes` with `* text=auto eol=lf` plus a one-off normalisation commit
  would settle it.
- `N10457-04` is still in the active tree as
  `nickelodeon--filler--generic-break-out--2009--N10457-04.mp4`. It is Double
  Trouble Night event packaging — the exporter's own example of a false generic —
  downloaded before v13 reclassified it. The parser now rejects
  `--event-packaging--` outright, but cannot catch this one under its old name.
  Needs a re-import or a manual delete.
- Seasonal coverage is thin and lopsided: summer 16, fall 13, spring 2,
  **winter 0**. Winter/Christmas is the gap a viewer would most expect to see.
  Exporter-side.
- The seasonal windows are calendar quarters (`06-01`..`08-31`). Broadcast
  seasons are not: Nick's "fall" tracked the September back-to-school push and
  summer began with the school year ending in late May. Importer-side, easy to
  shift.
