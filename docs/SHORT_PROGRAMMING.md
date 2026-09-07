# Short programming

Shorts are complete programmes from the existing TV library. They are not station assets or generated filler, and appear by name in both User and Admin guides.

## Import and enable

1. Place each complete short in a stable folder under a configured TV library root (for example `Random! Cartoons (2008)`). Retain torrent originals if they are still being seeded. Docker must have a readable mapping to the library folder.
2. Scan the TV library and approve the collection for playback. Verify the detected file durations and titles in the library before enabling it.
3. Open Channels → configure the station → Programming pattern → Short programming.
4. Expand Short programming, enable filling remaining block time with shorts, search for and select the imported collections, and save. Defaults allow two shorts per block, each at most 600 seconds. A programming-group selector is also available for existing group-based setups.

The inspected Random.Cartoons.S01.TVRip.XviD-Ant download contains 39 separate AVI cartoons lasting approximately 412–458 seconds, so it does not need splitting. No source files are moved, renamed, or edited by the station setting. Bundled anthology episodes must be separated at reviewed story boundaries before importing as shorts; Dialden never splits them automatically.

## Scheduling

For bounded blocks with eligible main programmes, Dialden plans the main episodes first, chooses a fitting combination of whole shorts, then distributes the remaining allowance across breaks. Shorts are appended to the block's main programme list; matching bumpers can play between them. The selection reserves time for additional handovers and uses measured media durations, not nominal episode lengths. It selects only approved, available videos and honours the maximum duration and count.

Selected shorts collections are excluded from the regular programme mix in bounded blocks on that station. The last 20 selected short IDs are remembered across blocks in the deterministic day plan; a short cannot repeat within a block. History resets with the scheduled day. If no fresh short fits, normal break filling continues. This does not force every block to end with shorts or guarantee a fixed break duration.

Continuous all-day schedules have no fixed block end and retain their existing behaviour. Empty/off-air blocks are not populated by the shorts pool. Collection selections use root, library kind, and collection identity rather than transient numeric database IDs, and unavailable selections remain saved through rescans.

For replicated network stations, shorts suggestions use the same curated network affiliations and saved era as Auto lineup. Unknown or unmatched titles are not suggested. Previously selected collections remain visible and labelled even if they fall outside current suggestions. Searching hides rows without changing their selections. Ordinary station and branding edits preserve the saved Auto lineup recipe; Auto setup is the workflow for replacing it.
