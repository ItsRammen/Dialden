# Automatic metadata matching

Dialden first compares titles and release years. Ambiguous or near-spelled titles can use additional evidence:

- TV: at least three local episode files and three distinct story titles must agree with provider season/episode positions. Paired-story files can agree with split provider episodes.
- Region suffixes, alternate subtitles and near spellings can reach that episode check even when their title score is lower. Spelling alone does not settle a match.
- A rival with supporting episode evidence, missing provider data, or too many plausible candidates leaves the title for review.
- Movies: a lone candidate can be confirmed using a provider alternative title (or a sufficiently specific prefix of its official title), the same release year and a measured runtime within three minutes.
- Existing runtime rules remain responsible for exact-title movie ties.

Provider work is bounded to five candidates and two TV seasons during episode comparison. Missing data is not evidence against a candidate. Matching does not override parent decisions.

After updating the server, use Settings → Metadata → Refresh library → Retry unresolved titles. No media-file rescan or TV-app update is necessary.
