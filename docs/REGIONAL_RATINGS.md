# Regional rating fallback

New metadata lookups try configured primary/fallback countries first, then US, CA, AU, GB, IE, JP, KR, HK, TW, DE and FR, without duplicates. The first country with a nonempty rating wins. Conflicting certifications within that country remain ambiguous; another country cannot hide the conflict. Unknown labels remain unrecognized and follow the existing review settings.

The unchanged default Kids 7 profile additionally understands these approved regional rules:

| Country | Allow | Parent review | Block |
| --- | --- | --- | --- |
| JP | G | PG12 | R15+, R18+ |
| KR | ALL | — | 12, 15, 18, 19 |
| HK | I | — | II, IIA, IIB, III |
| TW | 0+ | 6+ | 12+, 15+, 18+ |
| DE | 0, 6 | — | 12, 16, 18 |
| FR | U / Tous publics | — | 12, 16, 18 |

These are Dialden policy choices, not legal equivalences between countries. Only explicitly listed labels are interpreted; numerical strings are not guessed. Customized profiles keep their existing rules. Original certification and country remain in collection metadata and details. Manual approvals and blocks continue to take precedence.

## Existing libraries

Updating/restarting does not automatically reinterpret old cached certifications. Use the existing metadata re-evaluation action to request fresh lookups. This also retries title matching for automatic matches; manually locked identities stay locked. The existing review-only retry skips explicit overrides and already-blocked collections, so a full re-evaluation may be needed for items previously automatically blocked due to missing ratings. No live refresh is performed by this code change itself.

After a fresh lookup, a per-collection setting records its provider ID, country and original rating. Startup applies regional interpretation only when this marker matches the cached rating. Changed or older caches retain the previous interpretation until refreshed. Manual overrides are stored separately and never changed by this marker.

## Classification references

- Japan Eirin: https://www.eirin.jp/img/4ratings.pdf
- Korea Media Rating Board: https://www.kmrb.or.kr/main/cm/cntnts/cntntsView.do?cntntsId=1005&mi=1084
- Hong Kong OFNAA: https://www.ofnaa.gov.hk/en/services/film_division/film_classification/index.html
- Taiwan BAMID: https://cinema.bamid.gov.tw/
- Germany FSK: https://www.fsk.de/english/
- France CNC: https://www.cnc.fr/professionnels/visas-et-classification--activite-des-comites-et-de-la-commission-de-classification_586154

Provider metadata is not a guarantee that every release, edit or episode carries the same classification. Conflicts and unrecognized labels are not treated as automatic permission.
