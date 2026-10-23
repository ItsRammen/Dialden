# Native UI consistency review

21 October 2026. Scope: the separate Rust/SDL native client, including Watch now, full timeline, legacy now/next, quick guide, player preview, settings, details, navigation and data states. This does not certify the existing webOS JavaScript client or server admin UI.

## Findings addressed

| Area | Inconsistency | Change |
|---|---|---|
| Materials | Color brightness implicitly selected glass behavior | Explicit Control, FocusedControl and Sheet material roles |
| Navigation | Active tab created a second glass island and shadow | Shared navigation component; one enclosure and quiet inset selection |
| Home artwork/cards | Content looked like glass controls | Matte image frame and cards; 24 px card corners, shared focus colors |
| Dense rows | Full guide, legacy guide and quick guide had different shapes | 12 px dense content corners and consistent pale focus treatment |
| Details | Home and future-guide sheets used different content, sizing, buttons and animations | Shared Details model/renderer, metadata layout, compact return action, scrim and cached fade/settle |
| Home details | Programme details displayed generic prototype messaging | Actual current programme title, duration, episode and status; player remains explicitly labelled as a preview |
| Playback | Quick-guide button used wallpaper glass above an unrelated video backdrop | Shared opaque playback button treatment for player and quick guide |
| Playing versus focused | Browsing the guide obscured which channel remained playing | Persistent “Playing” label independent of row focus |
| Settings | Subtitle and rows drifted from other pages; content used glass | Aligned heading/subtitle, matte settings section, consistent row typography |
| Long names | Two-line headings silently discarded remaining words | Final line now receives overflow and ellipsis |
| Badges | Channel numbers used hardcoded left offsets | Shared measured centering |
| Focus edges | Button outline and surface used incompatible radii | Removed mismatched outer outline; focus uses the material/fill |
| Bright artwork | Secondary text weakened over pale stills | Lowered the prepared-backdrop brightness range; checked bright and busy fixtures |
| Panel edges | Integer-only scanline corners were visibly coarse | Fractional alpha coverage on rounded edges |
| Empty/loading | Generic marketing copy and repeated status text | Specific state titles, useful supporting text, no duplicate footer or inactive Select hint |
| Empty timeline | Empty grid without explanation | Empty-state message and return instruction |
| Quick-guide handle | Touch-style drag affordance in remote-only UI | Removed handle |
| Page motion | Every page reused the 600 ms launch effect | 240 ms page transition; launch remains 600 ms |
| Dialog motion | Guide details snapped open while home details expanded from another control | Same reversible spring, small fade/settle and cached texture on both routes |
| Player progress | Bar only changed on schedule refresh | Progress extrapolates between refreshes |
| Legacy guide navigation | Left/right in the legacy tab could panic | Safe mapping back to main tabs, with regression test |

## Verification

- 23 Rust tests pass, including guide timing/selection, navigation, reduced motion spring behavior, header clearance, short-page timing and the legacy navigation regression.
- Native build succeeds.
- Inspected 1080p render captures for home, home details, timeline, quick guide, player, settings, empty/loading, offline cached data, long home titles and long details titles.
- Added reproducible `--demo --fixture empty|loading|offline|long|bright|busy` states. Synthetic artwork goes through the normal backdrop darkening/blur path.
- Rendered navigation walkthroughs for home details, timeline details with accelerated time, player/quick guide, and timeline with reduced motion. Captures simulate 30 fps and export 10 fps; they are not real-TV benchmarks.

## Remaining limits

- Native video playback and TV packaging remain unimplemented. No TV installation was performed.
- Contrast is visually reviewed on fixture backgrounds, not formally certified across every programme image. Adaptive contrast, increased contrast and reduced-transparency controls remain outstanding.
- Materials sample a prepared backdrop, not the full composited scene or LG hardware video plane. Moving glass retains its cached resting sample.
- Settings currently shows connection information; interactive server setup and persistent preferences are not implemented.
- Bright/busy fixtures are synthetic. Test real artwork, physical viewing distance, remote repeat behavior and frame pacing on the TV before release.
- Guide detail titles are limited to two lines with an ellipsis; a full synopsis/scrollable detail view is outside this pass.

The design standard and shared components are the source of truth for subsequent UI changes. A new popup should reuse Details or explicitly justify a new sheet type, not hand-build another panel.
