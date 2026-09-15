# Automatic metadata matching

Dialden first compares titles and release years. Ambiguous or near-spelled titles can use additional evidence:

- TV: at least three local episode files and three distinct story titles must agree with provider season/episode positions. Paired-story files can agree with split provider episodes.
- Region suffixes, alternate subtitles and near spellings can reach that episode check even when their title score is lower. Spelling alone does not settle a match.
- A rival with supporting episode evidence, missing provider data, or too many plausible candidates leaves the title for review.
- Movies: a lone candidate can be confirmed using a provider alternative title (or a sufficiently specific prefix of its official title), the same release year and a measured runtime within three minutes.
- Existing runtime rules remain responsible for exact-title movie ties.

Provider work is bounded to five candidates and two TV seasons during episode comparison. Missing data is not evidence against a candidate. Matching does not override parent decisions.

After updating the server, use Settings → Metadata → Refresh library → Retry unresolved titles. No media-file rescan or TV-app update is necessary.

## Background maintenance

Completed scans trigger a bounded metadata retry: at most 25 unresolved titles per day, with a persisted seven-day per-title cooldown. Missing matches and ratings are eligible regardless of parental override; resolved parental choices and rating consensus decisions are skipped. A provider failure stops the batch. Progress appears in the metadata job status. Manual retry actions bypass the cooldown.

This maintenance runs after scans; it is not a separate timer when scanning is disabled.
