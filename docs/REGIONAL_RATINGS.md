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

## Conflicting labels that agree under the profile

Fresh lookups preserve every provider rating. When labels conflict in the first relevant region, Dialden evaluates each label under the active parental profile. If every label produces Allow or every label produces Block, that shared decision can be applied automatically. Mixed decisions, unknown labels, and review results remain unresolved.

The certification remains ambiguous: this does not invent one official rating. Collection details list the source ratings and explain the shared policy result. Metadata review may still show the conflict even when parental review is resolved.

Saved evidence is tied to the provider identity and rating-region settings. Rechecking saved policies recomputes the decision under the current profile. Explicit parent overrides still take precedence. Older cached conflicts need a fresh metadata lookup before they can use this evidence.

A local audit of 29 conflicts found 16 unanimous Kids 7 decisions (2 Allow, 14 Block). This is not a count of newly approved library items; some already have parent overrides.

## Provider label variants

French TP is the Tous publics category; TP+A is not silently treated as TP. Canadian C is children-oriented; C8/C8+ targets ages eight and over and is excluded by the default Kids 7 policy. These mappings are region-scoped and custom profiles retain their explicit rules.

Sources:
- CNC classification report, including TP and TP+A: https://www.vie-publique.fr/files/rapport/pdf/084000150.pdf
- Canadian Broadcast Standards Council classifications: https://www.cbsc.ca/tools/for-english-ca-and-third-language-broadcasters/

## Additional supported fallbacks

Brazil and Singapore are appended after the existing automatic regions. The default Kids 7 profile allows Brazil L/Livre, blocks numeric age bands 10–18, allows Singapore G, retains PG for review, and blocks PG13/NC16/M18/R21. Existing preferred-region conflicts still stop fallback selection. Custom profiles are not expanded automatically.

Sources:
- Brazil Ministry of Justice classification guide: https://www.gov.br/mj/pt-br/assuntos/seus-direitos/classificacao-1/classind-audio-visual-4-edicao-2021.pdf
- Singapore IMDA film classifications: https://www.imda.gov.sg/regulations-and-licensing-listing/content-standards-and-classification/standards-and-classification/films
