# Metadata and parental automation acceptance audit

Scope: automatic identification, regional certification lookup, parental decisions, channel eligibility, recovery and operator review. The comparison with Plex concerns workflow automation, not identical proprietary catalog coverage or classification decisions.

## Evidence and results

- The local before/after matcher test started with 67 unresolved collections. Earlier matching left 66; episode/alternative-title evidence left 53; near-title corroboration left 42. Raw result artifacts were saved locally in /tmp/dialden-match-results.json and /tmp/dialden-further-results.json.
- A later read-only live snapshot contained 1,488 present collections, 1,446 matched/manual and 42 ambiguous/unmatched (97.2% identified). This includes prior manual identities; it is not an automatic-match accuracy claim.
- A fresh provider audit of 131 rating problems returned 29 resolved, 29 conflicting and 73 missing. Six unrecognized labels are covered by the French/Canadian additions. Sixteen of 29 conflicts yield a unanimous Kids 7 decision, without inventing a single certification.
- The regression suite covers title/year matching, episode evidence, alternate movie titles and runtime, provider ID hints, regional fallbacks, profile changes, explicit overrides, failed refresh recovery, bounded retries, review dry runs/audit records and channel-specific PG decisions.
- Production Bun bundling, TypeScript checking and the full test suite pass. Desktop/mobile review rendering was inspected with an isolated local database, including source ratings and consensus explanations; mobile had no horizontal overflow.

## Requirement coverage

| Requirement | Implementation and verification |
|---|---|
| Automatic identification after import | MediaIndexer collection discovery → daemon scan completion → MetadataEnrichmentService.runPending; MetadataEnrichment integration tests |
| Resolve common ambiguous titles | TitleMatcher, runtimeMatch and supporting episode/movie evidence; positive and negative integration tests |
| Respect explicit identity | Locked provider matches precede folder hints; TMDB hints tested independently from rating decisions |
| Regional parental policy | RatingResolver, RegionalRatings, PolicyEngine; country, unknown-label and custom-profile tests |
| Rating conflicts | Persisted raw evidence; consensus only when all labels agree; profile-change and override tests |
| Parent decisions remain authoritative | Repository effective decision and eligibility transactions; metadata retry and policy refresh integration tests |
| PG stays deliberate per automatic channel | ChannelParentalGuidance and channel PG exceptions; cross-channel, removal and rescan tests |
| Retry without manual intervention | Post-scan daily batch of 25; seven-day persisted per-title cooldown; tests for limits and continuation |
| Survive provider errors | Preserve identity/artwork/facets across repeated failures and recovery; tests |
| Newly eligible titles reach automatic channels | Metadata terminal events await the same generated-lineup reconciliation used after scans; changed workers follow the existing reconciliation path |
| Clear manual fallback | Separate missing ratings, rating conflicts, metadata ties, parental choices and file failures; source-rating display verified locally |

## Deliberate manual cases

Missing provider data cannot establish a rating. Remakes with insufficient episode evidence, conflicting identities, incompatible year/edition information and mixed policy decisions remain reviewable. PG inclusion is intentionally a channel choice. Physical file corruption still needs source replacement.

The optional review assistant remains an explicit preview/apply workflow. Applying its deterministic approval/block recommendations writes deliberate overrides and an undoable audit record. Background matching and rating consensus do not create those overrides.

## Plex comparison and deployment

Plex documents automatic matching after scans, manual Fix Match for exceptions, and provider-ID naming hints. Its parental controls also use rating restrictions. Dialden now follows that broad workflow while retaining its stricter channel-specific PG choices and evidence requirements. IMDb/TVDB folder-ID resolution, Plex database synchronization and identical matching accuracy are not claimed.

- https://support.plex.tv/articles/200889878-matching-process/
- https://support.plex.tv/articles/201018497-fix-match-match/
- https://support.plex.tv/articles/naming-and-organizing-your-movie-media-files/
- https://support.plex.tv/articles/parental-controls/

Update the server container to deploy these changes. Retry unresolved metadata once to use new matching/evidence rules immediately; later scans perform bounded maintenance. Recheck saved ratings applies updated mappings to eligible cached evidence. No TV app update is required. This work did not deploy/restart the live container or change live parent overrides.
