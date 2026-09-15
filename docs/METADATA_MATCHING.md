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
