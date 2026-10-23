use crate::{model::*, rounded_panel, style, Paint, INK, MUTED, WHITE};
use sdl2::{pixels::Color, rect::Rect, render::Canvas, video::Window};
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::mpsc::{Receiver, Sender},
    time::{Duration, Instant},
};
pub const WINDOW: i64 = 2 * 60 * 60 * 1000;
const HALF_HOUR: i64 = 30 * 60 * 1000;
#[derive(Clone, Debug)]
pub struct Entry {
    pub title: String,
    pub episode: String,
    pub metadata: ProgramMetadata,
    pub start: i64,
    pub end: i64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireEntry {
    #[serde(default)]
    metadata: ProgramMetadata,
    title: String,
    #[serde(default)]
    collection_title: String,
    #[serde(default)]
    episode_label: String,
    scheduled_start: String,
    scheduled_end: String,
    #[serde(rename = "type")]
    kind: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireGuide {
    server_time_ms: i64,
    programs: Vec<WireEntry>,
    #[serde(default)]
    truncated: bool,
}
fn parse(wire: WireGuide) -> (i64, Vec<Entry>, bool) {
    let mut entries: Vec<_> = wire
        .programs
        .into_iter()
        .filter(|p| matches!(p.kind.as_str(), "program" | "movie" | "short"))
        .filter_map(|p| {
            let start = chrono::DateTime::parse_from_rfc3339(&p.scheduled_start)
                .ok()?
                .timestamp_millis();
            let end = chrono::DateTime::parse_from_rfc3339(&p.scheduled_end)
                .ok()?
                .timestamp_millis();
            let episode = [
                p.episode_label.as_str(),
                if !p.collection_title.is_empty() && p.title != p.collection_title {
                    &p.title
                } else {
                    ""
                },
            ]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" · ");
            (end > start).then(|| Entry {
                metadata: p.metadata,
                title: if p.collection_title.is_empty() {
                    p.title
                } else {
                    p.collection_title
                },
                episode,
                start,
                end,
            })
        })
        .collect();
    entries.sort_by_key(|e| e.start);
    (wire.server_time_ms, entries, wire.truncated)
}
#[derive(Clone)]
pub struct Request {
    pub from: i64,
    pub channels: Vec<String>,
}
pub struct Reply {
    pub from: i64,
    pub channel: String,
    result: Result<(i64, Vec<Entry>, bool), String>,
}
pub fn run(server: url::Url, rx: Receiver<Request>, tx: Sender<Reply>) {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(8))
        .build();
    let mut pending = None;
    'worker: loop {
        let mut request = match pending.take().or_else(|| rx.recv().ok()) {
            Some(r) => r,
            None => return,
        };
        while let Ok(latest) = rx.try_recv() {
            request = latest;
        }
        for batch in request.channels.chunks(2) {
            if let Ok(latest) = rx.try_recv() {
                pending = Some(latest);
                continue 'worker;
            }
            // Bound concurrency so one slow channel cannot block every visible row.
            let disconnected = std::thread::scope(|scope| {
                let handles: Vec<_> = batch.iter().map(|channel| {
                    let agent = &agent;
                    let server = &server;
                    let tx = &tx;
                    let from = request.from;
                    scope.spawn(move || {
                        let mut url = server.clone();
                        url.path_segments_mut().unwrap().clear().extend(["api", "v1", "channels", channel, "guide"]);
                        url.query_pairs_mut().append_pair("hours", "2").append_pair("from", &from.to_string());
                        let started = Instant::now();
                        let result = crate::network::json::<WireGuide>(agent, url.as_str()).map(parse);
                        crate::platform::diagnostic(&format!("guide_fetch channel={channel} ms={} ok={}", started.elapsed().as_millis(), result.is_ok()));
                        tx.send(Reply { from, channel: channel.clone(), result }).is_err()
                    })
                }).collect();
                handles.into_iter().any(|h| h.join().unwrap_or(true))
            });
            if disconnected { return; }
        }
    }
}
#[derive(Clone, Default)]
struct Row {
    entries: Vec<Entry>,
    error: bool,
    truncated: bool,
}
pub struct State {
    pub from: i64,
    pub cursor: i64,
    pub detail: Option<Entry>,
    rows: HashMap<(String, i64), Row>,
    return_to: Option<Navigation>,
    last_request: HashMap<i64, (Vec<String>, Instant)>,
    clock_offset: i64,
    demo: bool,
    pub preview_now: Option<i64>,
}
impl Default for State {
    fn default() -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        Self {
            from: now.div_euclid(HALF_HOUR) * HALF_HOUR,
            cursor: now,
            detail: None,
            rows: HashMap::new(),
            return_to: None,
            last_request: HashMap::new(),
            clock_offset: 0,
            demo: false,
            preview_now: None,
        }
    }
}
impl State {
    pub fn now(&self) -> i64 {
        self.preview_now
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis() + self.clock_offset)
    }
    pub fn enter(&mut self, previous: Navigation) {
        self.return_to = Some(previous);
        self.detail = None;
        if self.from + WINDOW <= self.now() {
            self.from = self.now().div_euclid(HALF_HOUR) * HALF_HOUR;
            self.cursor = self.now();
        }
    }
    pub fn reconcile(&mut self, old: &Snapshot, new: &Snapshot) {
        self.rows.retain(|(id, _), _| new.channels.iter().any(|c| &c.id == id));
        if let Some(previous) = &mut self.return_to {
            previous.reconcile(old, new);
        }
    }
    pub fn accept(&mut self, reply: Reply) {
        if self.rows.len() > 128 {
            self.rows.retain(|(_, from), _| *from == self.from);
            self.last_request.retain(|from, _| *from == self.from);
        }
        let row = self.rows.entry((reply.channel, reply.from)).or_default();
        match reply.result {
            Ok((now, entries, truncated)) => {
                self.clock_offset = now - chrono::Utc::now().timestamp_millis();
                *row = Row {
                    entries,
                    error: false,
                    truncated,
                };
            }
            Err(_) => row.error = true,
        }
    }
    pub fn prefetch(&mut self, tx: &Sender<Request>, data: &Snapshot) {
        let from = self.now().div_euclid(HALF_HOUR) * HALF_HOUR;
        self.request_window(tx, data, from);
    }
    pub fn request(&mut self, tx: &Sender<Request>, data: &Snapshot) {
        self.request_window(tx, data, self.from);
    }
    fn request_window(&mut self, tx: &Sender<Request>, data: &Snapshot, from: i64) {
        let ids: Vec<_> = data.channels.iter().map(|c| c.id.clone()).collect();
        if ids.is_empty() {
            return;
        }
        let incomplete = ids.iter().any(|id| !self.rows.contains_key(&(id.clone(), from)));
        let failed = ids.iter().any(|id| self.rows.get(&(id.clone(), from)).is_some_and(|row| row.error));
        let retry_seconds = if incomplete { 20 } else if failed { 30 } else { 120 };
        if self
            .last_request
            .get(&from)
            .is_some_and(|(channels, time)| {
                *channels == ids && time.elapsed() < Duration::from_secs(retry_seconds)
            })
        {
            return;
        }
        if tx
            .send(Request {
                from,
                channels: ids.clone(),
            })
            .is_ok()
        {
            self.last_request.retain(|_, (_, at)| at.elapsed() < Duration::from_secs(120));
            self.last_request.insert(from, (ids, Instant::now()));
        }
    }
    fn entries(&self, data: &Snapshot, index: usize) -> &[Entry] {
        data.channels
            .get(index)
            .and_then(|c| self.rows.get(&(c.id.clone(), self.from)))
            .map(|r| r.entries.as_slice())
            .unwrap_or(&[])
    }
    fn selected(&self, data: &Snapshot, index: usize) -> Option<&Entry> {
        let entries = self.entries(data, index);
        entries
            .iter()
            .find(|e| e.start <= self.cursor && e.end > self.cursor)
            .or_else(|| entries.iter().find(|e| e.start >= self.cursor))
    }
    pub fn key(&mut self, key: Key, nav: &mut Navigation, data: &Snapshot) {
        if self.detail.is_some() {
            if matches!(key, Key::Back | Key::Ok) {
                self.detail = None;
            }
            return;
        }
        if matches!(key, Key::Back) {
            if let Some(previous) = self.return_to.clone() {
                *nav = previous;
            } else {
                nav.page = Page::Watch;
                nav.nav = true;
            }
            return;
        }
        if nav.nav {
            nav.key(key, data.channels.len());
            return;
        }
        match key {
            Key::Up if nav.index > 0 => nav.index -= 1,
            Key::Up => nav.nav = true,
            Key::Down => nav.index = (nav.index + 1).min(data.channels.len().saturating_sub(1)),
            Key::Left | Key::Right => {
                let entries = self.entries(data, nav.index);
                let current = self.selected(data, nav.index).map(|e| e.start);
                let next = if matches!(key, Key::Right) {
                    entries
                        .iter()
                        .find(|e| e.start > current.unwrap_or(self.cursor))
                } else {
                    entries
                        .iter()
                        .rev()
                        .find(|e| e.start < current.unwrap_or(self.cursor))
                };
                if let Some(e) = next {
                    self.cursor = e.start.max(self.from);
                } else {
                    self.from += if matches!(key, Key::Right) {
                        WINDOW
                    } else {
                        -WINDOW
                    };
                    self.cursor = self.from;
                }
            }
            Key::Ok => {
                if let Some(entry) = self.selected(data, nav.index).cloned() {
                    let now = self.now();
                    if entry.start <= now && now < entry.end {
                        nav.open_channel();
                    } else {
                        self.detail = Some(entry);
                    }
                }
            }
            _ => {}
        }
    }
    pub fn demo(&mut self, data: &Snapshot) {
        self.demo = true;
        for (i, ch) in data.channels.iter().enumerate() {
            let title = data
                .schedule(&ch.id)
                .and_then(|s| s.program.as_ref())
                .map(|p| p.heading())
                .unwrap_or("Programme");
            self.rows
                .entry((ch.id.clone(), self.from))
                .or_insert_with(|| Row {
                    entries: (0..5)
                        .map(|n| {
                            let start = self.from + n * HALF_HOUR - 10 * 60 * 1000;
                            Entry {
                                title: if n % 2 == 0 {
                                    title.into()
                                } else {
                                    data.schedule(&ch.id)
                                        .and_then(|s| s.next.as_ref())
                                        .map(|p| p.heading())
                                        .unwrap_or("Next programme")
                                        .into()
                                },
                                metadata: data
                                    .schedule(&ch.id)
                                    .and_then(|s| {
                                        if n % 2 == 0 {
                                            s.program.as_ref()
                                        } else {
                                            s.next.as_ref()
                                        }
                                    })
                                    .map(|p| p.metadata.clone())
                                    .unwrap_or_default(),
                                episode: format!("S01E{:02}", n + 1 + i as i64),
                                start,
                                end: start + HALF_HOUR,
                            }
                        })
                        .collect(),
                    ..Default::default()
                });
        }
    }
}
fn time(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.with_timezone(&chrono::Local).format("%H:%M").to_string())
        .unwrap_or_default()
}
// Half-open window: an exact end belongs to the next page.
fn marker(from: i64, now: i64) -> Option<(i32, i32)> {
    if now < from || now >= from + WINDOW {
        return None;
    }
    let x = 450 + ((now - from) as f64 / WINDOW as f64 * 1370.).round() as i32;
    Some((x, (x - 82).clamp(450, 1656)))
}
pub fn draw(c: &mut Canvas<Window>, p: &mut Paint, nav: &Navigation, data: &Snapshot) {
    p.label(c, "Guide", 100, 174, 52, true, WHITE, 900);
    p.label(
        c,
        &format!(
            "{} – {}  ·  TV local time{}",
            chrono::DateTime::from_timestamp_millis(p.guide.from)
                .map(|d| d
                    .with_timezone(&chrono::Local)
                    .format("%a %d %b · %H:%M")
                    .to_string())
                .unwrap_or_default(),
            time(p.guide.from + WINDOW),
            if p.guide.demo {
                " · Sample listings"
            } else {
                ""
            }
        ),
        100,
        246,
        25,
        false,
        MUTED,
        1700,
    );
    if data.channels.is_empty() {
        p.label(c, "No channels available", 100, 406, 32, true, WHITE, 1700);
        p.label(
            c,
            "Return to Watch now to check the connection and channel status.",
            100,
            466,
            26,
            false,
            MUTED,
            1700,
        );
        crate::components::navigation_help(c, p, &[("↔", "Tabs"), ("↩", "Return")], "");
        return;
    }
    let from = p.guide.from;
    let now = p.guide.now();
    let row_start = nav.index.saturating_sub(4);
    let width = 1370.;
    let x0 = 450.;
    p.label(
        c,
        "CHANNEL",
        120,
        style::GUIDE_RULER_Y,
        21,
        true,
        MUTED,
        320,
    );
    for slot in 0..4 {
        let x = x0 + slot as f32 * width / 4.;
        p.label(
            c,
            &time(from + slot * HALF_HOUR),
            x as i32,
            style::GUIDE_RULER_Y,
            23,
            true,
            MUTED,
            300,
        );
    }
    if let Some((x, chip_x)) = marker(from, now) {
        crate::components::now_indicator(
            c,
            p,
            &format!("Now · {}", time(now)),
            x,
            chip_x,
            style::GUIDE_STATUS_Y,
        );
    }
    for (slot, (index, ch)) in data
        .channels
        .iter()
        .enumerate()
        .skip(row_start)
        .take(5)
        .enumerate()
    {
        let y = style::GUIDE_ROWS_Y + slot as i32 * style::GUIDE_ROW_STRIDE;
        c.set_draw_color(style::SEPARATOR);
        let _ = c.fill_rect(Rect::new(100, y + 99, 1720, 1));
        p.label(c, &ch.name, 120, y + 32, 25, true, WHITE, 300);

        let row = p.guide.rows.get(&(ch.id.clone(), from)).cloned();
        let chosen = p.guide.selected(data, index).map(|e| e.start);
        if let Some(row) = row {
            if row.entries.is_empty() {
                p.label(
                    c,
                    if row.error {
                        "Guide unavailable · retrying"
                    } else {
                        "No programmes scheduled"
                    },
                    475,
                    y + 33,
                    24,
                    false,
                    MUTED,
                    1300,
                );
            }
            for entry in &row.entries {
                let a = entry.start.max(from);
                let b = entry.end.min(from + WINDOW);
                if b <= a {
                    continue;
                }
                let x = x0 + (a - from) as f32 / WINDOW as f32 * width;
                let w = ((b - a) as f32 / WINDOW as f32 * width).max(2.) as u32;
                let selected = index == nav.index && !nav.nav && chosen == Some(entry.start);
                rounded_panel(
                    c,
                    Rect::new(x as i32 + 3, y + 3, w.saturating_sub(6).max(1), 92),
                    if selected { style::FOCUS } else { style::CELL },
                    style::CELL_RADIUS,
                );
                if w > 70 {
                    p.label(
                        c,
                        &entry.title,
                        x as i32 + 15,
                        y + 15,
                        24,
                        true,
                        if selected { INK } else { WHITE },
                        w.saturating_sub(25),
                    );
                }
                if w > 150 {
                    p.label(
                        c,
                        &format!("{} · {}", time(entry.start), entry.episode),
                        x as i32 + 15,
                        y + 58,
                        20,
                        false,
                        if selected {
                            Color::RGB(75, 84, 104)
                        } else {
                            MUTED
                        },
                        w.saturating_sub(25),
                    );
                }
            }
            if row.error || row.truncated {
                p.label(
                    c,
                    if row.error {
                        "Cached guide · refresh failed"
                    } else {
                        "Partial schedule"
                    },
                    462,
                    y + 79,
                    15,
                    false,
                    MUTED,
                    1100,
                );
            }
        } else {
            p.label(c, "Loading schedule…", 475, y + 33, 24, false, MUTED, 1300);
        }
    }
    let selected = p.guide.selected(data, nav.index).cloned();
    if let Some(entry) = &selected {
        p.label(
            c,
            &format!(
                "{}  ·  {}–{}",
                entry.title,
                time(entry.start),
                time(entry.end)
            ),
            100,
            936,
            25,
            false,
            WHITE,
            1700,
        );
    }
    let note = if p.guide.preview_now.is_some() {
        "Demo · Time accelerated 300×"
    } else {
        ""
    };
    let current = selected
        .as_ref()
        .is_some_and(|entry| entry.start <= now && now < entry.end);
    let hints = if nav.nav {
        vec![
            ("↔", "Tabs"),
            ("↓", "Browse"),
            ("OK", "Browse"),
            ("↩", "Return"),
        ]
    } else {
        vec![
            ("↔", "Programmes"),
            ("↑↓", "Channels"),
            ("OK", if current { "Open channel" } else { "Details" }),
            ("↩", "Return"),
        ]
    };
    crate::components::navigation_help(c, p, &hints, note);
    let details = p
        .guide
        .detail
        .as_ref()
        .map(|entry| crate::components::Details {
            channel: data
                .channels
                .get(nav.index)
                .map(|ch| ch.name.clone())
                .unwrap_or_default(),
            title: entry.title.clone(),
            timing: format!(
                "{}–{} · {} minutes",
                time(entry.start),
                time(entry.end),
                (entry.end - entry.start) / 60000
            ),
            episode: entry.episode.clone(),
            metadata: entry.metadata.clone(),
            status: if entry.start > now {
                "Upcoming programme"
            } else if entry.end > now {
                "On now"
            } else {
                "Previously aired"
            }
            .into(),
            back: "Back to guide".into(),
        });
    crate::components::details(c, p, details);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prefetch_and_reopening_share_the_same_cached_window() {
        let (mut state, data, _) = fixture();
        let (tx, rx) = std::sync::mpsc::channel();
        state.from = state.from.div_euclid(HALF_HOUR) * HALF_HOUR;
        state.preview_now = Some(state.from + 1000);
        state.prefetch(&tx, &data);
        assert_eq!(rx.try_recv().unwrap().from, state.from);
        state.request(&tx, &data);
        assert!(rx.try_recv().is_err());
        let first = state.from;
        state.from += WINDOW;
        state.request(&tx, &data);
        assert_eq!(rx.try_recv().unwrap().from, first + WINDOW);
        state.from = first;
        state.request(&tx, &data);
        assert!(rx.try_recv().is_err());
    }
    #[test]
    fn guide_refresh_keeps_existing_rows_visible_and_retries_partial_loads() {
        let (mut state, data, _) = fixture();
        let (tx, rx) = std::sync::mpsc::channel();
        state.request(&tx, &data);
        rx.try_recv().unwrap();
        state.last_request.get_mut(&state.from).unwrap().1 = Instant::now() - Duration::from_secs(121);
        state.request(&tx, &data);
        assert!(rx.try_recv().is_ok());
        assert_eq!(state.entries(&data, 0).len(), 2);
        state.rows.clear();
        state.last_request.get_mut(&state.from).unwrap().1 = Instant::now() - Duration::from_secs(21);
        state.request(&tx, &data);
        assert!(rx.try_recv().is_ok());
    }
    #[test]
    fn marker_tracks_time_and_clamps_label_at_window_edges() {
        assert_eq!(marker(0, -1), None);
        assert_eq!(marker(0, WINDOW), None);
        assert_eq!(marker(0, 0), Some((450, 450)));
        assert_eq!(marker(0, WINDOW / 2), Some((1135, 1053)));
        assert_eq!(marker(0, WINDOW - 1), Some((1820, 1656)));
    }
    #[test]
    fn advancing_clock_changes_future_programme_to_current() {
        let (mut state, data, mut nav) = fixture();
        let start = state.entries(&data, 0)[1].start;
        state.cursor = start;
        state.preview_now = Some(start - 1);
        state.key(Key::Ok, &mut nav, &data);
        assert!(state.detail.is_some());
        state.key(Key::Back, &mut nav, &data);
        state.preview_now = Some(start);
        state.key(Key::Ok, &mut nav, &data);
        assert_eq!(nav.page, Page::Player);
    }
    fn fixture() -> (State, Snapshot, Navigation) {
        let mut state = State::default();
        let now = state.now();
        state.from = now - 10_000;
        state.cursor = now;
        let data = Snapshot {
            channels: vec![Channel {
                id: "a".into(),
                name: "A".into(),
                enabled: true,
                on_air: true,
                icon_url: None,
            }],
            ..Default::default()
        };
        state.rows.insert(
            ("a".into(), state.from),
            Row {
                entries: vec![
                    Entry {
                        title: "Now".into(),
                        metadata: ProgramMetadata::default(),
                        episode: "Episode 1".into(),
                        start: now - 5000,
                        end: now + 5000,
                    },
                    Entry {
                        title: "Later".into(),
                        metadata: ProgramMetadata::default(),
                        episode: "Episode 2".into(),
                        start: now + 5000,
                        end: now + 60000,
                    },
                ],
                ..Default::default()
            },
        );
        let nav = Navigation {
            page: Page::FullGuide,
            nav: false,
            ..Default::default()
        };
        (state, data, nav)
    }
    #[test]
    fn future_programme_opens_details_without_tuning() {
        let (mut state, data, mut nav) = fixture();
        state.key(Key::Right, &mut nav, &data);
        state.key(Key::Ok, &mut nav, &data);
        assert_eq!(nav.page, Page::FullGuide);
        assert_eq!(nav.playing_index, None);
        assert_eq!(state.detail.as_ref().unwrap().title, "Later");
        state.key(Key::Back, &mut nav, &data);
        assert!(state.detail.is_none());
        assert_eq!(nav.page, Page::FullGuide);
    }
    #[test]
    fn current_programme_opens_channel_and_can_return_to_timeline() {
        let (mut state, data, mut nav) = fixture();
        state.key(Key::Ok, &mut nav, &data);
        assert_eq!(nav.page, Page::Player);
        assert_eq!(nav.return_page, Page::FullGuide);
        nav.key(Key::Back, 1);
        assert_eq!(nav.page, Page::Player);
        nav.key(Key::Back, 1);
        assert_eq!(nav.page, Page::FullGuide);
    }
    #[test]
    fn at_end_right_advances_two_hours_and_back_restores_overlay() {
        let (mut state, data, mut nav) = fixture();
        let from = state.from;
        let prior = Navigation {
            page: Page::Guide,
            guide_from_player: true,
            overlay_button: true,
            ..Default::default()
        };
        state.enter(prior);
        state.key(Key::Right, &mut nav, &data);
        state.key(Key::Right, &mut nav, &data);
        assert_eq!(state.from, from + WINDOW);
        state.key(Key::Back, &mut nav, &data);
        assert_eq!(nav.page, Page::Guide);
        assert!(nav.guide_from_player && nav.overlay_button);
    }
    #[test]
    fn malformed_times_and_station_assets_are_not_programmes() {
        let wire:WireGuide=serde_json::from_value(serde_json::json!({"serverTimeMs":1000,"programs":[
   {"title":"Good","collectionTitle":"Show","episodeLabel":"S01E02","metadata":{"overview":"An episode description","overviewScope":"episode","rating":"TV-Y","ratingRegion":"US"},"scheduledStart":"2026-10-21T12:00:00Z","scheduledEnd":"2026-10-21T12:30:00Z","type":"program"},
   {"title":"raw-bumper.mp4","scheduledStart":"2026-10-21T12:00:00Z","scheduledEnd":"2026-10-21T12:01:00Z","type":"bumper"},
   {"title":"Bad","scheduledStart":"invalid","scheduledEnd":"invalid","type":"program"}
  ]})).unwrap();
        let (_, entries, _) = parse(wire);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "Show");
        assert_eq!(entries[0].episode, "S01E02 · Good");
        assert_eq!(entries[0].metadata.overview, "An episode description");
        assert_eq!(entries[0].metadata.facts(), "TV-Y (US)");
    }
    #[test]
    fn failed_refresh_preserves_cached_schedule() {
        let (mut state, data, _) = fixture();
        state.accept(Reply {
            from: state.from,
            channel: "a".into(),
            result: Err("Offline".into()),
        });
        assert_eq!(state.entries(&data, 0).len(), 2);
        assert!(state.rows[&("a".into(), state.from)].error);
    }
}
