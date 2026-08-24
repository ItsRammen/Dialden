# Era-inspired stations

ToastTV era stations reproduce the *shape* of a familiar television day, not
an exact network feed or a particular historical date. The default is a family
mix: historically associated programmes anchor each layout, while approved
newer favourites such as Bluey can appear as clearly identified guest
programming in a suitable daypart.

Templates contain scheduling rules and title suggestions only. They do not
bundle copyrighted media, locate downloads, or imply affiliation with a
broadcaster.

## Research basis

The built-in layouts are deliberately broad because real schedules changed by
season, year, and market. The following patterns are well supported:

- Cartoon Network moved weekday Toonami to Saturday evenings in 2004 and
  replaced the weekday block with the younger-skewing Miguzi. Its 2006 Fridays
  block ran from 7 p.m. to 11 p.m. and emphasized originals and premieres.
  Sources: [Animation World Network on the 2004 change](https://www.awn.com/news/cartoon-network-shifts-toonami-saturday-creates-miguzi),
  [Animation World Network on Fridays in 2006](https://www.awn.com/news/musical-guests-grace-cartoon-network-fridays-set-summer-06).
- Representative late-1990s Nickelodeon schedules separated weekday Nick Jr.,
  after-school Nicktoons/live action, Saturday-night SNICK, and a movie or
  special window. The exact hours are inspiration, not a permanent rule.
  Sources: [archived 1999 schedule](https://nickelodeon.fandom.com/wiki/Schedule_1999),
  [trade coverage of the Saturday SNICK block](https://www.nexttv.com/news/nick-adds-shows-saturday-snick-block-137677).
- Disney describes its late-1990s strategy as a mix of films, family
  programming, and an increasing focus on ages 9–14. Disney's 2004 material
  describes Playhouse Disney as a daily learning-oriented preschool block.
  Sources: [D23 Disney Channel history](https://d23.com/a-to-z/disney-channel-the/),
  [The Walt Disney Company on its 2004 programming](https://thewaltdisneycompany.com/press-releases/rich-ross-promoted-to-president-disney-channel-worldwide/).
- Toon Disney began as a family animation service. By the Jetix period, action
  programming occupied a large part of the day and movies remained a visible
  event type. Sources: [Disney 2000 annual report](https://thewaltdisneycompany.com/app/uploads/2015/10/2000-Annual-Report.pdf),
  [representative 2005 Toon Disney schedule](https://kidsblockblog.wordpress.com/2020/05/24/toon-disney-schedule-for-friday-september-30-2005/).
- Disney Channel Original Movies were a recurring part of the network identity;
  D23 maintains an official chronology. Source:
  [D23 Disney Channel Original Movies](https://d23.com/a-to-z/disney-channel-original-movies/).

Daypart boundaries in ToastTV are implementation recommendations inferred from
those patterns. They are not claims that a network used the same grid every day
throughout an entire era.

## Included layouts

- Cartoon Network inspired: 1997–2004 and 2005–2012
- Nickelodeon inspired: 1994–2004 and 2005–2012
- Nick Jr. inspired: 1999–2012
- Disney Channel inspired: 1998–2007 and 2008–2012
- Playhouse Disney inspired: 1999–2011
- Toon Disney inspired: 1998–2008
- Jetix inspired: 2004–2009
- Toonami/action inspired: 1997–2008
- Classic cartoons inspired: 1955–1999

The catalog keeps Nickelodeon and Nick Jr. separate. It also treats animated
animal stories as animation/family programming, not nature documentaries.

## What is implemented now

- The Auto builder compares every template with the approved, technically
  playable library.
- Curated title aliases, stored network/studio metadata, and a soft era score
  identify owned matches.
- Modern family favourites have a separate `family-guest` relationship. They
  use the historical layout without being presented as network originals.
- Missing shows and movies are displayed as a wishlist. ToastTV provides no
  acquisition or download integration.
- All-day era stations materialize distinct editable daypart groups. A safe
  fallback fills a block when the chosen library has no ideal match, preventing
  an avoidable off-air gap.
- Template provenance is stored with an Auto-built channel so reopening Auto
  setup restores the selected recipe.
- Existing periodic episode marathons remain available. Templates describe a
  historically plausible movie/marathon cadence, but that guidance is not yet
  a calendar event guarantee.
- Interstitials remain optional and disabled by default. The existing playback,
  FFmpeg, software encode, and Intel QSV boundaries are unchanged.

## Programming-engine follow-up

The next scheduler phase should persist station-specific programming state
rather than adding more ad-hoc form fields:

1. Weekly pools with permanent anchors, rotating support titles, and a stored
   deterministic seed.
2. Per-station episode progress and playback order (`random`, `sequential`,
   `season-sequential`, or `story-order`).
3. Episode/show cooldowns with graceful relaxation for small libraries.
4. A generated and persisted 72-hour authoritative timeline.
5. Calendar event overrides for movie nights, spotlight stacks, marathons, and
   seasonal boosts.
6. A station-health view for repeat pressure, missing dayparts, insufficient
   serialized content, and schedule gaps.
7. Per-station optional interstitial planning after the core timeline is
   stable.

Those records should be keyed by station and durable collection identity so
one media library can serve multiple stations without sharing progress or
duplicating files.
