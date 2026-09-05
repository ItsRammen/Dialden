# Feedback to the Nickstory bumper export

Two requests against the Nick Jr Play With Us export, in priority order. Both
were found by running the ToastTV parser over the delivered library
(`/media/interludes/nick-jr`, 198 files, all of which parse).

---

## 1. Every C part is missing

The export declares interactive sequences whose own scheduler semantics say

```json
"minimum_complete_pattern": ["A", "C"],
"notes": "... Never schedule C without an earlier A from the same sequence."
```

but **no C part was exported**. All 10 declared sequences list A and B only,
and both of those are the question:

- **A** — "One elephant looks different. Do you know which one? Let's figure it
  out together when we get back."
- **B** — "One elephant looks different. Do you know which one? We'll figure it
  out when we come back."

Neither reveals the answer, so the export asks for a pattern it does not
contain. ToastTV therefore schedules none of these 17 clips.

### Where to look

Each subject occupies three consecutive production codes. A and B are the first
two; the third is absent in every case, without exception. That regularity is
the search key.

| Sequence | Present | **Find C at** |
| --- | --- | --- |
| elephants | N3151-01, N3151-02 | **N3151-03** |
| horses | N3151-04, N3151-05 | **N3151-06** |
| puppies | N3151-07, N3151-08 | **N3151-09** |
| purple-dolls-mat | N3151-10, N3151-11 | **N3151-12** |
| robots | N3152-01, N3152-02 | **N3152-03** |
| rockets | N3152-04, N3152-05 | **N3152-06** |
| sailboats | N3152-07, N3152-08 | **N3152-09** |
| towtrucks | N3152-10, N3152-11 | **N3152-12** |
| trains | N3215-01, N3215-02 | **N3215-03** |
| yellow-turtles-mat | N3215-04, N3215-05 | **N3215-06** |

A C part is identifiable by content as well as by code: it is the post-break
reveal, naming which one was different, rather than promising to find out
later. If a clip at one of those codes turns out not to be a reveal, mark the
sequence as genuinely two-part rather than emitting a C that is not one.

### Marking contract

Emit C exactly as A and B are emitted — the five-part filename is unchanged and
the part letter lives in the final code field:

```text
nick-jr--filler--generic--2008--play-with-us-elephants-part-c-N3151-03.mp4
```

and add the part to the sequence in
`_audit/nickjr_interactive_sequences.json` with `"part": "C"` and
`"order": 3`.

Nothing else needs to change. ToastTV picks the group up automatically once
both A and C are present — no configuration, no re-import step.

Where a C genuinely does not exist, please say so explicitly in the audit
entry rather than leaving it implied by absence, so the difference between
"not ripped yet" and "never existed" is visible.

---

## 2. Subject slugs are not unique

Two distinct sequences collapse to the same filename subject:

| sequence_id | Filename subject |
| --- | --- |
| `nick-jr-playdate-one-brand-packaging-purple-dolls-mat` | `mat` |
| `nick-jr-playdate-one-brand-packaging-yellow-turtles-mat` | `mat` |

ToastTV groups sequence parts by that slug, so if both are ever exported
together their parts merge into one group — an A from the purple dolls game
could be paired with a C from the yellow turtles game. Only one of the two is
currently on disk, so nothing is broken today, but the collision is latent.

Please derive the filename subject from the full distinguishing part of the
`sequence_id` (`purple-dolls-mat`, `yellow-turtles-mat`) rather than the
trailing word.

---

## 3. Three declared files were not delivered

Listed in the audit but absent from disk:

```text
nick-jr--filler--generic--2008--play-with-us-sailboats-part-b-N3152-08.mp4
nick-jr--filler--generic--2008--play-with-us-mat-part-a-N3215-04.mp4
nick-jr--filler--generic--2008--play-with-us-mat-part-b-N3215-05.mp4
```

The two `N3215-*` entries are the `yellow-turtles-mat` sequence described
above, written with the colliding `mat` slug. Worth confirming whether they
failed to rip or were written over the `purple-dolls-mat` files of the same
name.

---

## What is working

No changes needed to the UGC navigation export. All 98 clips parse and
schedule as ordinary More / Up Next, with the styling read straight from the
code field:

- `ugc-navigation-right-now` and `ugc-navigation-web-cta-right-now` — 47 clips
  flagged `rightNow`
- `ugc-navigation-web-cta-*` — 41 clips flagged `legacyWebCta` for a future
  station setting to allow or suppress
- `ugc-navigation-when-we-come-back` / `-coming-up-next` — ordinary placement

The five-part contract with a richer final code field works well; keep it.
