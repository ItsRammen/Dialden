# Nick Jr interactive sequences — status and outstanding work

Play With Us bumpers come in ordered parts. **A** asks the question, **B**
repeats it, **C** reveals the answer. Scheduling them as independent random
fillers is what produced questions with no answer, and answers to questions
nobody was asked.

The grouping and selection logic is built and tested. It cannot schedule
anything yet, because **no C part exists in the library**.

## What is done

- The five-part filename contract is unchanged. The exporter writes a richer
  final code field and `parseStationAssetFilename()` reads it, so an older
  export parses exactly as before and an unrecognised code is ordinary
  metadata.
- `StationAssetDescriptor` carries `sequence` (`family`, `id`, `part`),
  `sourceStyle`, `legacyWebCta` and `rightNow`.
- A sequence part never enters independent filler rotation.
- `selectStationInteractiveSequence()` picks one group as a single scheduling
  decision and returns its parts in order. A group is usable only with both A
  and C. B is optional; `compact: true` drops it.
- `describeStationInteractiveSequences()` reports which groups exist and
  whether each is usable, so a missing part is visible rather than silent.
- UGC navigation stays ordinary More / Up Next. It is not a new asset kind.

Covered by `tests/StationAssetSequences.test.ts`.

## Current library

All 198 Nick Jr assets parse; none fail.

| | Count |
| --- | --- |
| UGC navigation | 98 |
| `rightNow` | 47 |
| `legacyWebCta` | 41 |
| Sequence parts | 17 |
| Sequence groups | 9 |
| **Usable groups** | **0** |

Every group has A and B only. The consequence today is that those 17 clips no
longer play at all: they are excluded from filler rotation, and no sequence can
be assembled without a C. That removes the unanswered questions, which was the
goal, but it removes the clips with them.

## Outstanding

- [ ] **Obtain the C parts.** See
      [nickstory-exporter-feedback.md](nickstory-exporter-feedback.md) for the
      exact production codes to look for. Nothing below matters until this
      lands; everything below is unblocked the moment it does.
- [ ] **Wire `selectStationInteractiveSequence()` into the timeline builder.**
      Deliberately not done: with zero usable groups it can only return an
      empty array, so wiring it now would add an unverifiable change to the
      playback scheduling path for no behavioural gain. The selector and its
      rules are tested and ready.
- [ ] **Decide the incomplete-group policy.** Today an A without a C is
      dropped, per the specification. If those clips should keep playing until
      the C parts arrive, that is a one-line change to the usable rule in
      `selectStationInteractiveSequence()`. A works reasonably as a plain
      pre-break bumper on its own — it says "we'll figure it out when we get
      back" — so this is a real choice, not an oversight.
- [ ] **Apply no-immediate-repeat history at the sequence level**, not the part
      level, once sequences actually schedule.
- [ ] **Spread A / B / C across real break blocks.** The preferred layout puts
      a promo or filler between the parts. ToastTV's one-asset transitions
      cannot express that yet, which is why `compact` mode exists. Deferred by
      the original specification too.
- [ ] **Honour `rightNow` placement.** A clip saying the show starts this
      instant must be the last thing before that show. The current transition
      selector places exactly one asset at a boundary, so this holds today by
      construction — but it stops holding the moment a break can contain more
      than one item.
- [ ] **Add a station setting for `legacyWebCta`.** 41 clips name a NickJr.com
      address that no longer resolves. The flag is parsed and exposed; nothing
      reads it yet.

## Grouping caveat

The sequence `id` is derived from the subject slug in the filename, so two
sequences whose slugs collide would merge into one group — and an A from one
game could then be paired with a C from another. The export already contains
two distinct subjects that collide this way, `purple-dolls-mat` and
`yellow-turtles-mat`, both written as `mat`. Only one of them is on disk, so
nothing is wrong today. The exporter feedback asks for distinct slugs.
