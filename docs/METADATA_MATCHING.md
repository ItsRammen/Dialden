# Automatic metadata matching

Dialden first compares titles and release years. Ambiguous or near-spelled titles can use additional evidence:

- TV: at least three local episode files and three distinct story titles must agree with provider season/episode positions. Paired-story files can agree with split provider episodes.
- Region suffixes, alternate subtitles and near spellings can reach that episode check even when their title score is lower. Spelling alone does not settle a match.
- A rival with supporting episode evidence, missing provider data, or too many plausible candidates leaves the title for review.
- Movies: a lone candidate can be confirmed using a provider alternative title (or a sufficiently specific prefix of its official title), the same release year and a measured runtime within three minutes.
- Movies with an unresolved folder name can use the actual filename when the collection contains exactly one file with an explicit year. The provider title and year must agree with the filename, and its runtime must be within three minutes of the measured file. Same-title rivals use the existing runtime tie rules; more than five exact-title candidates prevent this fallback. Multipart collections and filenames/folders marked as fan or book edits are excluded.
- Explicit Roman part numbers normalize to digits (`Part I` = `Part 1`), preserving distinct parts and standalone words such as `I, Robot`.
- Lone near-title movie candidates now receive runtime lookups too; punctuation variants can use the existing same-year, strong-title and runtime checks.
- A lone movie candidate may use documented festival or theatrical release years when its primary year differs. The title/official alias and measured runtime must still agree. Digital/DVD/broadcast dates do not establish this evidence.
- For a single-file movie of at least 60 minutes, a unique exact-title/year feature can be distinguished from rivals that are all known shorts of at most 40 minutes. The feature's runtime difference must stay within both 15 minutes and 10%. Unknown runtimes, a second feature, more than five exact candidates, or a medium-length rival prevent this fallback. This covers reasonable cut/intermission differences without relaxing ordinary feature-versus-feature comparisons.
- Collections of multiple `SxxExx` files in Movies receive an actionable TV-library warning. Names marked as fan/book edits receive a custom-edit explanation instead of automatic catalogue matching. Existing saved matches and explicit provider IDs take precedence.
- Existing runtime rules remain responsible for other exact-title movie ties. A candidate is not preferred merely because it is more popular.

Provider work is bounded to five candidates and two TV seasons during episode comparison. Missing data is not evidence against a candidate. Matching does not override parent decisions.

After updating the server, use Settings → Metadata → Refresh library → Retry unresolved titles. No media-file rescan or TV-app update is necessary.

## Background maintenance

Completed scans trigger a bounded metadata retry: at most 25 unresolved titles per day, with a persisted seven-day per-title cooldown. Missing matches and ratings are eligible regardless of parental override; resolved parental choices and rating consensus decisions are skipped. A provider failure stops the batch. Progress appears in the metadata job status. Manual retry actions bypass the cooldown.

This maintenance runs after scans; it is not a separate timer when scanning is disabled.

## Explicit provider identity hints

Folders such as `Show (2024) {tmdb-12345}` can identify a title directly without a search. TV and movie IDs are interpreted in their respective library kinds. Existing saved identities take precedence; conflicting or invalid tags require review. An identity hint does not bypass rating policy or parent overrides.

This supports TMDB hints; IMDb and TVDB tags are not resolved by this implementation.


## Review queue

Library → Review queue separates media type (Movies & TV, Movies, TV shows) from the next action required:

- **Missing match:** pending, ambiguous, unmatched, failed or unconfigured lookups.
- **Needs rating:** a matched/manual identity with a missing or conflicting certification, including titles that already have a saved parent decision.
- **Needs approval:** a matched/manual identity and resolved rating whose effective policy decision still requires review. Ordinary PG/TV-PG channel opt-ins remain in the separate PG browsing flow.
- **All issues:** the union of these three groups, counting each collection once.

Search applies to titles and episode/file names. Category counts follow the media-type and search filters. Category/type changes reset pagination; pagination and bulk-action return links retain the filters. The library summary's Needs review count reflects all outstanding issues, not just unanswered parental decisions. Browsing or filtering does not change a rating or override.

The previous `/library/review/metadata` link remains supported as a combined match-and-rating view.


## TV episode evidence

Ambiguous TV titles can resolve automatically when at least three distinct episode files agree with one candidate's story titles and season/episode positions. Any supporting episode evidence for a rival keeps the collection in review. Release suffixes such as `Bluray-1080p v2` are removed before comparison; story part numbers and paired-story titles are preserved.

A season-specific TMDB 404 counts as absent episode evidence only after the series itself can still be fetched. Network failures, rate limits, invalid responses and unavailable series stop automatic disambiguation. This lets a multi-season show match even when a similarly named series has fewer seasons, without treating provider outages as evidence. Existing saved identities and parent decisions remain unchanged.


Additional TV fallbacks handle audio/bracketed release tags, explicit adjacent ranges such as `S01E01-E02` with `Story A + Story B`, and dated daily-show filenames. Dated matches require both the air date and guest/story title, with three distinct dates and titles; a provider's written date prefix is removed only if it agrees with its air-date field. Conflicting rival evidence still prevents selection.

TV episode comparison examines every plausible candidate, up to twenty candidates and two local seasons each. More than twenty plausible candidates remain for review; the stored candidate list is not truncated before this check. A filename fallback requires at least three distinct episode positions, consistent title and year across all episodic filenames, and a unique provider match with that exact title and year. Missing years or conflicting filenames keep the collection unresolved. These rules do not change saved identities or parental overrides.
