//! Interactive first-launch design demo. Discovery and connection results are fixtures.
use crate::{components, model::Key, Paint, MUTED, WHITE};
use sdl2::{rect::Rect, render::Canvas, video::Window};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Stage {
    Welcome,
    Searching,
    Found,
    Empty,
    Manual,
    Testing,
    Failed,
    Connected,
    Options,
}
const KEYS: &str = "abcdefghijklmnopqrstuvwxyz0123456789.-:/";
#[derive(Clone)]
pub struct State {
    pub stage: Stage,
    pub focus: usize,
    pub elapsed: f32,
    pub address: String,
    pub editing: bool,
    pub remote: bool,
    pub error: String,
    pub empty_result: bool,
    pub failed_result: bool,
    pub saved: bool,
    manual_return: Stage,
    options_return: Stage,
    previous: Option<Box<State>>,
    motion_elapsed: f32,
}
impl Default for State {
    fn default() -> Self {
        Self {
            stage: Stage::Welcome,
            focus: 0,
            elapsed: 0.,
            address: String::new(),
            editing: false,
            remote: false,
            error: String::new(),
            empty_result: false,
            failed_result: false,
            saved: false,
            manual_return: Stage::Welcome,
            options_return: Stage::Welcome,
            previous: None,
            motion_elapsed: 0.,
        }
    }
}
impl State {
    pub fn go(&mut self, stage: Stage) {
        self.previous = None;
        if self.stage != stage {
            self.previous = Some(Box::new(self.clone()));
        }
        self.motion_elapsed = 0.;
        if stage == Stage::Searching {
            self.saved = false;
        }
        self.stage = stage;
        self.focus = if matches!(stage, Stage::Searching | Stage::Testing | Stage::Connected) {
            usize::MAX
        } else {
            0
        };
        self.elapsed = 0.;
        self.editing = false;
        self.error.clear();
    }
    pub fn tick(&mut self, dt: f32) {
        self.motion_elapsed += dt.clamp(0., 0.1);
        if self.motion_elapsed >= 0.3 {
            self.previous = None;
        }
        self.elapsed += dt.clamp(0., 0.1);
        if self.stage == Stage::Searching && self.elapsed >= 2. {
            let manual_focused = self.focus == 0;
            self.go(if self.empty_result {
                Stage::Empty
            } else {
                Stage::Found
            });
            if manual_focused {
                self.focus = 1;
            }
        } else if self.stage == Stage::Testing && self.elapsed >= 1.4 {
            self.go(if self.failed_result {
                Stage::Failed
            } else {
                Stage::Connected
            });
        }
    }
    pub fn server_name(&self) -> &str {
        if self.address == "http://192.168.1.20:1993" {
            "Living room · Dialden"
        } else if self.address.is_empty() {
            "Dialden"
        } else {
            &self.address
        }
    }
    pub fn ready_for_home(&self) -> bool {
        self.stage == Stage::Connected && self.elapsed >= 0.8
    }
    fn return_from_options(&mut self) {
        self.go(self.options_return);
        self.focus = if self.stage == Stage::Found { 2 } else { 0 };
    }
    fn options(&mut self) {
        self.options_return = self.stage;
        self.go(Stage::Options);
    }
    pub fn text(&mut self, text: &str) {
        if self.stage == Stage::Manual && self.editing {
            for ch in text.chars().filter(|c| c.is_ascii_graphic()) {
                if self.address.len() < 240 {
                    self.address.push(ch);
                }
            }
        }
    }
    pub fn erase(&mut self) {
        if self.stage == Stage::Manual && self.editing {
            self.address.pop();
        }
    }
    fn manual(&mut self) {
        if !matches!(self.stage, Stage::Manual | Stage::Testing | Stage::Failed) {
            self.manual_return = self.stage;
        }
        self.saved = false;
        self.go(Stage::Manual);
        if self.address.is_empty() {
            self.address = "http://".into();
        }
    }
    fn connect(&mut self) {
        match crate::network::validate_server(self.address.trim()) {
            Ok(url) => {
                if self.remote && url.scheme() != "https" {
                    self.error = "Use an HTTPS address for a remote server.".into();
                } else {
                    self.address = url.as_str().trim_end_matches('/').into();
                    self.go(Stage::Testing);
                }
            }
            Err(_) => self.error = "Enter a full address, such as http://192.168.1.20:1993".into(),
        }
    }
    /// Input can skip the brief connected confirmation; successful connection also advances automatically.
    pub fn key(&mut self, key: Key) -> bool {
        // Input always operates on the destination; settle decorative motion first.
        self.previous = None;
        let before = self.clone();
        let result = self.key_inner(key);
        if self.stage == before.stage && self.editing != before.editing {
            self.previous = Some(Box::new(before));
            self.motion_elapsed = 0.;
        }
        result
    }
    fn key_inner(&mut self, key: Key) -> bool {
        if self.stage == Stage::Manual && self.editing {
            match key {
                Key::Left => self.focus = self.focus.saturating_sub(1),
                Key::Right => self.focus = (self.focus + 1).min(41),
                Key::Up => {
                    self.focus = match self.focus {
                        40 => 30,
                        41 => 39,
                        i => i.saturating_sub(10),
                    }
                }
                Key::Down => {
                    self.focus = if self.focus >= 30 {
                        if self.focus < 35 {
                            40
                        } else {
                            41
                        }
                    } else {
                        self.focus + 10
                    }
                }
                Key::Back => {
                    self.editing = false;
                    self.focus = 2;
                }
                Key::Ok if self.focus < 40 => {
                    self.text(&KEYS.chars().nth(self.focus).unwrap().to_string());
                }
                Key::Ok if self.focus == 40 => self.erase(),
                Key::Ok => {
                    self.editing = false;
                    self.focus = 3;
                }
            }
            return false;
        }
        if self.stage == Stage::Manual {
            let next = match key {
                Key::Left => Some(match self.focus {
                    1 => 0,
                    4 => 3,
                    i => i,
                }),
                Key::Right => Some(match self.focus {
                    0 => 1,
                    3 => 4,
                    i => i,
                }),
                Key::Up => Some(match self.focus {
                    2 => {
                        if self.remote {
                            1
                        } else {
                            0
                        }
                    }
                    3 | 4 => 2,
                    i => i,
                }),
                Key::Down => Some(match self.focus {
                    0 | 1 => 2,
                    2 => 3,
                    i => i,
                }),
                _ => None,
            };
            if let Some(next) = next {
                self.focus = next;
                return false;
            }
        }
        let count = match self.stage {
            Stage::Welcome => 2,
            Stage::Searching | Stage::Testing => 1,
            Stage::Found => 3,
            Stage::Empty => 2,
            Stage::Manual => 5,
            Stage::Failed => 3,
            Stage::Connected => 0,
            Stage::Options => 3,
        };
        if self.stage == Stage::Connected {
            if matches!(key, Key::Back) {
                self.go(Stage::Found);
                return false;
            }
            return matches!(key, Key::Ok);
        }
        if self.focus == usize::MAX {
            match key {
                Key::Up | Key::Down | Key::Left | Key::Right => self.focus = 0,
                Key::Back => {
                    if self.stage == Stage::Testing {
                        self.manual();
                    } else {
                        self.go(Stage::Welcome);
                    }
                }
                Key::Ok => {} // Repeated OK must not activate a newly exposed cancel/options action.
            }
            return false;
        }
        match key {
            Key::Up | Key::Left => self.focus = self.focus.saturating_sub(1),
            Key::Down | Key::Right => self.focus = (self.focus + 1).min(count - 1),
            Key::Back => match self.stage {
                Stage::Welcome => {}
                Stage::Options => self.return_from_options(),
                Stage::Manual => self.go(self.manual_return),
                Stage::Testing | Stage::Failed => self.manual(),
                _ => self.go(Stage::Welcome),
            },
            Key::Ok => match self.stage {
                Stage::Welcome if self.focus == 0 => self.go(Stage::Searching),
                Stage::Welcome => self.manual(),
                Stage::Searching => self.manual(),
                Stage::Found if self.focus == 0 => {
                    self.address = "http://192.168.1.20:1993".into();
                    self.remote = false;
                    self.go(Stage::Testing);
                }
                Stage::Found if self.focus == 1 => self.manual(),
                Stage::Found => self.options(),
                Stage::Empty if self.focus == 0 => self.go(Stage::Searching),
                Stage::Empty => self.manual(),
                Stage::Manual => match self.focus {
                    0 | 1 => {
                        self.remote = self.focus == 1;
                        if matches!(self.address.as_str(), "" | "http://" | "https://") {
                            self.address = if self.remote { "https://" } else { "http://" }.into();
                        }
                        self.error.clear();
                    }
                    2 => {
                        self.editing = true;
                        self.focus = 0;
                    }
                    3 => self.connect(),
                    _ => self.go(self.manual_return),
                },
                Stage::Testing => self.manual(),
                Stage::Failed if self.focus == 0 => self.connect(),
                Stage::Failed if self.focus == 1 => self.manual(),
                Stage::Failed => self.go(Stage::Searching),
                Stage::Connected if self.focus == 0 => return true,
                Stage::Connected => self.go(Stage::Welcome),
                Stage::Options if self.focus == 0 => self.go(Stage::Searching),
                Stage::Options if self.focus == 1 => self.manual(),
                Stage::Options => self.return_from_options(),
            },
        }
        false
    }
}
#[derive(Clone, Copy)]
enum Icon {
    Search,
    Server,
    Address,
    Retry,
    Check,
    Back,
}
fn icon(c: &mut Canvas<Window>, kind: Icon, x: i32, y: i32, color: sdl2::pixels::Color) {
    c.set_draw_color(color);
    let mut line = |a: (i32, i32), b: (i32, i32)| {
        for d in 0..2 {
            let _ = c.draw_line((x + a.0, y + a.1 + d), (x + b.0, y + b.1 + d));
        }
    };
    match kind {
        Icon::Search => {
            for i in 0..24 {
                let a = i as f32 * std::f32::consts::TAU / 24.;
                let b = (i + 1) as f32 * std::f32::consts::TAU / 24.;
                line(
                    (12 + (a.cos() * 9.) as i32, 12 + (a.sin() * 9.) as i32),
                    (12 + (b.cos() * 9.) as i32, 12 + (b.sin() * 9.) as i32),
                );
            }
            line((19, 19), (29, 29));
        }
        Icon::Server => {
            for top in [3, 18] {
                line((2, top), (30, top));
                line((30, top), (30, top + 10));
                line((30, top + 10), (2, top + 10));
                line((2, top + 10), (2, top));
                line((7, top + 5), (9, top + 5));
                line((15, top + 5), (25, top + 5));
            }
        }
        Icon::Address => {
            line((1, 5), (31, 5));
            line((31, 5), (31, 27));
            line((31, 27), (1, 27));
            line((1, 27), (1, 5));
            line((1, 12), (31, 12));
            line((7, 20), (23, 20));
        }
        Icon::Retry => {
            line((25, 9), (19, 3));
            line((19, 3), (7, 3));
            line((7, 3), (2, 11));
            line((2, 11), (2, 23));
            line((2, 23), (10, 29));
            line((10, 29), (24, 29));
            line((24, 29), (30, 21));
            line((25, 0), (25, 10));
            line((25, 10), (15, 10));
        }
        Icon::Check => {
            line((2, 16), (12, 26));
            line((12, 26), (30, 5));
        }
        Icon::Back => {
            line((29, 16), (2, 16));
            line((2, 16), (13, 5));
            line((2, 16), (13, 27));
        }
    }
}
fn small_button(c: &mut Canvas<Window>, p: &mut Paint, label: &str, r: Rect, focus: bool) {
    components::playback_button(c, p, label, r, focus);
}
fn draw_content(c: &mut Canvas<Window>, p: &mut Paint, s: &State) {
    match s.stage {
        Stage::Manual => {
            // One segmented control, with selection distinct from remote focus.
            crate::rounded_panel(c, Rect::new(948, 338, 744, 58), crate::style::CONTENT, 16);
            for i in 0..2 {
                let r = Rect::new(954 + i * 366, 344, 360, 46);
                let focused = !s.editing && s.focus == i as usize;
                let selected = s.remote == (i == 1);
                if focused {
                    components::content_row(c, r, true);
                } else if selected {
                    crate::rounded_panel(c, r, sdl2::pixels::Color::RGBA(230, 240, 255, 30), 12);
                }
                p.centered(
                    c,
                    if i == 0 {
                        "Local network"
                    } else {
                        "Remote server"
                    },
                    r,
                    23,
                    selected,
                    if focused { crate::INK } else { WHITE },
                );
                if selected {
                    c.set_draw_color(if focused { crate::INK } else { WHITE });
                    let _ = c.fill_rect(Rect::new(r.x() + 125, 387, 110, 2));
                }
            }
            p.label(c, "SERVER ADDRESS", 952, 420, 18, true, MUTED, 740);
            components::content_row(c, Rect::new(948, 454, 744, 64), !s.editing && s.focus == 2);
            p.label(
                c,
                &format!("{}{}", s.address, if s.editing { "|" } else { "" }),
                972,
                471,
                25,
                false,
                if !s.editing && s.focus == 2 {
                    crate::INK
                } else {
                    WHITE
                },
                704,
            );
            if s.editing {
                for (i, ch) in KEYS.chars().enumerate() {
                    let r = Rect::new(
                        952 + (i % 10) as i32 * 74,
                        546 + (i / 10) as i32 * 58,
                        66,
                        50,
                    );
                    components::content_row(c, r, s.focus == i);
                    p.centered(
                        c,
                        &ch.to_string(),
                        r,
                        24,
                        false,
                        if s.focus == i { crate::INK } else { WHITE },
                    );
                }
                small_button(c, p, "Delete", Rect::new(952, 816, 210, 58), s.focus == 40);
                small_button(c, p, "Done", Rect::new(1450, 816, 234, 58), s.focus == 41);
            } else {
                p.paragraph(
                    c,
                    if s.error.is_empty() {
                        if s.remote {
                            "Example: https://tv.example.com"
                        } else {
                            "Example: http://192.168.1.20:1993"
                        }
                    } else {
                        &s.error
                    },
                    952,
                    550,
                    22,
                    724,
                    3,
                );
                small_button(c, p, "Connect", Rect::new(952, 692, 288, 62), s.focus == 3);
                small_button(c, p, "Back", Rect::new(1484, 692, 200, 62), s.focus == 4);
            }
        }
        _ => {}
    }
}

#[derive(Clone)]
struct Row {
    id: &'static str,
    icon: Icon,
    title: String,
    detail: String,
    selected: bool,
    action: bool,
}
fn rows(s: &State) -> Vec<Row> {
    let mut result = Vec::new();
    let mut add = |id, icon, title: &str, detail: &str, action: Option<usize>| {
        result.push(Row {
            id,
            icon,
            title: title.into(),
            detail: detail.into(),
            selected: action == Some(s.focus),
            action: action.is_some(),
        });
    };
    let manual = "Local or remote connection";
    let server = if s.address == "http://192.168.1.20:1993" {
        "Living room · Dialden"
    } else {
        "Dialden server"
    };
    match s.stage {
        Stage::Welcome => {
            add(
                "discover",
                Icon::Search,
                "Find a local server",
                "Search this network",
                Some(0),
            );
            add("manual", Icon::Address, "Enter an address", manual, Some(1));
        }
        Stage::Searching => {
            add(
                "discover",
                Icon::Search,
                "Searching this network",
                "Looking for nearby servers…",
                None,
            );
            add("manual", Icon::Address, "Enter an address", manual, Some(0));
        }
        Stage::Found => {
            add(
                "server",
                Icon::Server,
                "Living room · Dialden",
                "192.168.1.20:1993 · Local",
                None,
            );
            add(
                "connect",
                Icon::Check,
                "Connect",
                "Start watching on this server",
                Some(0),
            );
            add("manual", Icon::Address, "Enter an address", manual, Some(1));
            add(
                "options",
                Icon::Address,
                "Other options",
                "Search again or change connection method",
                Some(2),
            );
        }
        Stage::Empty => {
            add(
                "retry-search",
                Icon::Retry,
                "Search again",
                "No servers found · Check that Dialden is running",
                Some(0),
            );
            add("manual", Icon::Address, "Enter an address", manual, Some(1));
        }
        Stage::Testing => {
            add("server", Icon::Server, server, "Checking connection…", None);
            add(
                "cancel",
                Icon::Back,
                "Cancel",
                "Return to your address",
                Some(0),
            );
        }
        Stage::Failed => {
            add(
                "retry-connect",
                Icon::Retry,
                "Try again",
                "Could not connect · Check the server and network",
                Some(0),
            );
            add("edit", Icon::Address, "Edit address", &s.address, Some(1));
            add(
                "discover",
                Icon::Search,
                "Find a local server",
                "Look for another nearby",
                Some(2),
            );
        }
        Stage::Connected => {
            add(
                "server",
                Icon::Server,
                server,
                "Connected · Demo address is not saved",
                None,
            );
        }
        Stage::Options => {
            match s.options_return {
                Stage::Found => add(
                    "server",
                    Icon::Server,
                    "Living room · Dialden",
                    "192.168.1.20:1993 · Local",
                    None,
                ),
                Stage::Searching => add(
                    "discover",
                    Icon::Search,
                    "Search paused",
                    "Choose how you want to connect",
                    None,
                ),
                _ => {}
            }
            add(
                "options",
                Icon::Address,
                "Other options",
                "Choose a connection method",
                None,
            );
            add(
                "retry-search",
                Icon::Retry,
                "Search again",
                "Refresh nearby servers",
                Some(0),
            );
            add("manual", Icon::Address, "Enter an address", manual, Some(1));
            add(
                "back",
                Icon::Back,
                "Close options",
                "Return to your server",
                Some(2),
            );
        }
        Stage::Manual => {}
    }
    result
}
fn draw_row(c: &mut Canvas<Window>, p: &mut Paint, row: &Row, top: i32) {
    if row.selected {
        components::content_row(c, Rect::new(932, top, 776, 96), true);
    }
    let fg = if row.selected { crate::INK } else { WHITE };
    let detail = if row.selected {
        sdl2::pixels::Color::RGB(65, 76, 92)
    } else {
        MUTED
    };
    icon(c, row.icon, 956, top + 31, fg);
    p.label(c, &row.title, 1014, top + 18, 27, true, fg, 620);
    p.label(c, &row.detail, 1014, top + 58, 21, false, detail, 620);
    if (row.id == "discover" && row.detail == "Looking for nearby servers…")
        || (row.id == "server" && row.detail == "Checking connection…")
    {
        for i in 0..3 {
            let alpha = if p.reduced_motion {
                140.
            } else {
                110. + 65. * (p.ambient_seconds * 2.2 - i as f32 * 0.8).sin()
            };
            crate::rounded_panel(
                c,
                Rect::new(1630 + i * 15, top + 44, 6, 6),
                sdl2::pixels::Color::RGBA(220, 230, 244, alpha as u8),
                3,
            );
        }
    }
    if row.action {
        p.label(c, "›", 1660, top + 28, 30, false, fg, 28);
    }
}
fn progress(seconds: f32) -> f32 {
    let t = (seconds / 0.3).clamp(0., 1.);
    t * t * (3. - 2. * t)
}
fn layer(
    c: &mut Canvas<Window>,
    p: &mut Paint,
    opacity: f32,
    draw: impl FnOnce(&mut Canvas<Window>, &mut Paint),
) {
    if opacity <= 0. {
        return;
    }
    if opacity >= 1. {
        draw(c, p);
        return;
    }
    let mut texture = p.setup_layer.take().or_else(|| {
        p.textures
            .create_texture_target(sdl2::pixels::PixelFormatEnum::RGBA8888, 1920, 1080)
            .ok()
    });
    if let Some(texture) = texture.as_mut() {
        let clip = c.clip_rect();
        texture.set_blend_mode(sdl2::render::BlendMode::Blend);
        let rendered = c
            .with_texture_canvas(texture, |target| {
                target.set_clip_rect(None);
                target.set_draw_color(sdl2::pixels::Color::RGBA(0, 0, 0, 0));
                target.clear();
                draw(target, p);
            })
            .is_ok();
        c.set_clip_rect(clip);
        if rendered {
            texture.set_alpha_mod((opacity * 255.) as u8);
            let _ = c.copy(texture, None, None);
        }
    } else {
        draw(c, p);
    }
    p.setup_layer = texture;
}

fn panel(s: &State) -> Rect {
    if s.stage == Stage::Manual {
        Rect::new(920, 310, 800, if s.editing { 620 } else { 500 })
    } else {
        Rect::new(920, 310, 800, rows(s).len() as u32 * 104 + 24)
    }
}
// Outgoing text clears before incoming text appears: never overlap two labels.
fn content_opacity(seconds: f32) -> (bool, f32) {
    if seconds < 0.1 {
        (true, 1. - (seconds / 0.1).clamp(0., 1.))
    } else {
        (false, ((seconds - 0.1) / 0.2).clamp(0., 1.))
    }
}
pub fn draw(c: &mut Canvas<Window>, p: &mut Paint, s: &State) {
    if s.stage == Stage::Connected && !p.reduced_motion {
        let outgoing = (1. - s.elapsed / 0.25).clamp(0., 1.);
        if let Some(previous) = s.previous.as_deref() {
            let mut old = previous.clone();
            old.previous = None;
            layer(c, p, outgoing, |c, p| draw(c, p, &old));
        }
        crate::arrival::welcome(
            c,
            p,
            s.server_name(),
            ((s.elapsed - 0.1) / 0.25).clamp(0., 1.),
        );
        return;
    }

    p.label(c, "dialden", 120, 82, 35, true, WHITE, 400);
    p.label(c, "SET UP YOUR TV", 180, 260, 20, true, MUTED, 600);
    p.title(c, "Connect to Dialden.", 180, 322, 54, 650);
    p.paragraph(
        c,
        "Find your server on this network, or enter its address to bring your channels to this TV.",
        180,
        480,
        26,
        600,
        4,
    );
    let previous = s.previous.as_deref().filter(|_| !p.reduced_motion);
    let mut bounds = panel(s);
    if let Some(old) = previous {
        let from = panel(old);
        let t = (s.motion_elapsed / 0.3).clamp(0., 1.);
        let t = t * t * (3. - 2. * t);
        let mix = |a: i32, b: i32| (a as f32 + (b - a) as f32 * t).round() as i32;
        bounds = Rect::new(
            mix(from.x(), bounds.x()),
            mix(from.y(), bounds.y()),
            mix(from.width() as i32, bounds.width() as i32) as u32,
            mix(from.height() as i32, bounds.height() as i32) as u32,
        );
    }
    p.glass.sheet(c, bounds);
    if let Some(old) = previous {
        let (outgoing, opacity) = content_opacity(s.motion_elapsed);
        let state = if outgoing { old } else { s };
        if old.stage == Stage::Manual && s.stage == Stage::Manual {
            let clip = c.clip_rect();
            c.set_clip_rect(Rect::new(920, 310, 800, 220));
            draw_content(c, p, s);
            c.set_clip_rect(Rect::new(920, 530, 800, 400));
            layer(c, p, opacity, |c, p| draw_content(c, p, state));
            c.set_clip_rect(clip);
        } else {
            layer(c, p, opacity, |c, p| draw_content(c, p, state));
        }
    } else {
        draw_content(c, p, s);
    }
    let old_rows = previous.map(rows).unwrap_or_default();
    let new_rows = rows(s);
    let t = previous.map(|_| progress(s.motion_elapsed)).unwrap_or(1.);
    // Clip inserted rows to the growing surface, not to its final size.
    let clip = c.clip_rect();
    c.set_clip_rect(bounds);
    for (i, row) in old_rows.iter().enumerate() {
        if !new_rows.iter().any(|next| next.id == row.id) {
            layer(c, p, (1. - t * 2.).max(0.), |c, p| {
                draw_row(c, p, row, 322 + i as i32 * 104)
            });
        }
    }
    for (i, row) in new_rows.iter().enumerate() {
        let destination = 322 + i as i32 * 104;
        if let Some((j, old)) = old_rows
            .iter()
            .enumerate()
            .find(|(_, old)| old.id == row.id)
        {
            let y = (322. + j as f32 * 104. + (i as f32 - j as f32) * 104. * t).round() as i32;
            // Stable identity remains visible; only its changing detail swaps in place.
            let visible = Row {
                detail: if t < 0.5 {
                    old.detail.clone()
                } else {
                    row.detail.clone()
                },
                ..row.clone()
            };
            draw_row(c, p, &visible, y);
        } else {
            let limit = new_rows
                .iter()
                .enumerate()
                .skip(i + 1)
                .find_map(|(k, next)| {
                    old_rows.iter().position(|old| old.id == next.id).map(|j| {
                        (322. + j as f32 * 104. + (k as f32 - j as f32) * 104. * t).round() as i32
                    })
                })
                .unwrap_or(bounds.bottom());
            if limit > destination {
                let reveal = Rect::new(
                    bounds.x(),
                    destination,
                    bounds.width(),
                    (limit - destination) as u32,
                );
                c.set_clip_rect(bounds.intersection(reveal));
                layer(c, p, ((t - 0.5) * 2.).clamp(0., 1.), |c, p| {
                    draw_row(c, p, row, destination)
                });
                c.set_clip_rect(bounds);
            }
        }
    }
    c.set_clip_rect(clip);
    p.label(
        c,
        "↑ ↓  Choose     OK  Select     Back  Return",
        180,
        942,
        22,
        false,
        MUTED,
        1100,
    );
    p.label(
        c,
        "Design demo · Simulated connection",
        1260,
        942,
        19,
        false,
        MUTED,
        540,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transitions_keep_one_snapshot_and_input_settles_destination() {
        let mut s = State::default();
        s.key(Key::Ok);
        assert_eq!(s.previous.as_ref().unwrap().stage, Stage::Welcome);
        s.go(Stage::Found);
        assert!(s.previous.as_ref().unwrap().previous.is_none());
        s.key(Key::Down);
        assert!(s.previous.is_none());
        assert_eq!(s.focus, 1);
        s.manual();
        s.focus = 2;
        s.key(Key::Ok);
        assert!(!s.previous.as_ref().unwrap().editing);
        for _ in 0..4 {
            s.tick(0.1);
        }
        assert!(s.previous.is_none());
    }
    #[test]
    fn status_layout_keeps_anchors_and_sizes_to_content() {
        let mut s = State::default();
        let anchor = panel(&s);
        for stage in [
            Stage::Searching,
            Stage::Found,
            Stage::Empty,
            Stage::Testing,
            Stage::Failed,
            Stage::Connected,
        ] {
            s.stage = stage;
            assert_eq!(panel(&s).x(), anchor.x());
            assert_eq!(panel(&s).y(), anchor.y());
            assert_eq!(panel(&s).width(), anchor.width());
        }
        assert_eq!(content_opacity(0.), (true, 1.));
        assert_eq!(content_opacity(0.1), (false, 0.));
        assert_eq!(content_opacity(1.), (false, 1.));
    }
    #[test]
    fn discovery_preserves_manual_action_identity() {
        let mut s = State::default();
        s.stage = Stage::Searching;
        let search = rows(&s);
        assert_eq!(panel(&s).height(), 232);
        s.stage = Stage::Found;
        let found = rows(&s);
        assert_eq!(panel(&s).height(), 440);
        assert_eq!(search[1].id, found[2].id);
        assert_eq!(search[1].title, found[2].title);
        assert_eq!(search[1].detail, found[2].detail);
        s.address = "http://192.168.1.20:1993".into();
        s.stage = Stage::Testing;
        assert_eq!(panel(&s).height(), 232);
        assert_eq!(rows(&s)[0].title, found[0].title);
        assert_eq!(rows(&s)[0].id, found[0].id);
        s.stage = Stage::Empty;
        assert_eq!(panel(&s).height(), 232);
    }
    #[test]
    fn busy_states_do_not_select_fallbacks_or_accept_repeat_ok() {
        let mut s = State::default();
        s.key(Key::Ok);
        assert_eq!(s.focus, usize::MAX);
        s.key(Key::Ok);
        assert_eq!(s.stage, Stage::Searching);
        assert!(rows(&s).iter().all(|r| !r.selected));
        s.key(Key::Down);
        for _ in 0..21 {
            s.tick(0.1);
        }
        assert_eq!(s.stage, Stage::Found);
        assert_eq!(rows(&s).iter().find(|r| r.selected).unwrap().id, "manual");
        s.key(Key::Down);
        s.key(Key::Ok);
        assert_eq!(s.stage, Stage::Options);
        s.key(Key::Back);
        assert_eq!(s.stage, Stage::Found);
        assert_eq!(s.focus, 2);
        s.key(Key::Up);
        s.key(Key::Up);
        s.key(Key::Ok);
        s.key(Key::Ok);
        assert_eq!(s.stage, Stage::Testing);
        assert!(rows(&s).iter().all(|r| !r.selected));
    }
    #[test]
    fn confirmed_connection_continues_without_an_extra_choice() {
        let mut s = State::default();
        s.go(Stage::Connected);
        assert!(rows(&s).iter().all(|r| !r.action));
        assert!(!s.ready_for_home());
        for _ in 0..9 {
            s.tick(0.1);
        }
        assert!(s.ready_for_home());
    }
    #[test]
    fn options_and_manual_entry_preserve_their_context() {
        let mut s = State::default();
        s.go(Stage::Found);
        s.focus = 2;
        s.key(Key::Ok);
        let options = rows(&s);
        assert_eq!(options[0].id, "server");
        assert_eq!(options[1].id, "options");
        s.key(Key::Down);
        s.key(Key::Ok);
        assert_eq!(s.stage, Stage::Manual);
        s.key(Key::Back);
        assert_eq!(s.stage, Stage::Options);
        s.key(Key::Back);
        assert_eq!(s.stage, Stage::Found);
        assert_eq!(s.focus, 2);
    }
    #[test]
    fn starting_discovery_keeps_manual_entry_unchanged_and_direct() {
        let mut s = State::default();
        let before = rows(&s)[1].clone();
        s.key(Key::Ok);
        let during = rows(&s)[1].clone();
        assert_eq!(before.id, during.id);
        assert_eq!(before.title, during.title);
        assert_eq!(before.detail, during.detail);
        assert_eq!(before.action, during.action);
        assert!(!during.selected);
        s.key(Key::Down);
        s.key(Key::Ok);
        assert_eq!(s.stage, Stage::Manual);
    }
    #[test]
    fn keyboard_geometry_and_manual_focus_match_remote_layout() {
        assert_eq!(KEYS.chars().count(), 40);
        let mut s = State::default();
        s.manual();
        s.key(Key::Right);
        assert_eq!(s.focus, 1);
        s.key(Key::Down);
        assert_eq!(s.focus, 2);
        s.key(Key::Ok);
        s.focus = 39;
        s.key(Key::Down);
        assert_eq!(s.focus, 41);
        s.key(Key::Up);
        assert_eq!(s.focus, 39);
    }
    #[test]
    fn discovery_connects_only_after_confirmation() {
        let mut s = State::default();
        s.key(Key::Ok);
        for _ in 0..21 {
            s.tick(0.1);
        }
        assert_eq!(s.stage, Stage::Found);
        s.key(Key::Ok);
        for _ in 0..15 {
            s.tick(0.1);
        }
        assert_eq!(s.stage, Stage::Connected);
        assert!(s.key(Key::Ok));
    }
    #[test]
    fn empty_search_and_cancel_keep_manual_entry_available() {
        let mut s = State {
            empty_result: true,
            ..Default::default()
        };
        s.key(Key::Ok);
        for _ in 0..21 {
            s.tick(0.1);
        }
        assert_eq!(s.stage, Stage::Empty);
        s.key(Key::Down);
        s.key(Key::Ok);
        assert_eq!(s.stage, Stage::Manual);
        s.go(Stage::Searching);
        s.key(Key::Down);
        s.key(Key::Ok);
        s.tick(0.1);
        assert_eq!(s.stage, Stage::Manual);
    }
    #[test]
    fn invalid_addresses_never_reach_success_and_failed_address_is_preserved() {
        let mut s = State {
            address: "bad address".into(),
            ..Default::default()
        };
        s.manual();
        s.focus = 3;
        s.key(Key::Ok);
        assert_eq!(s.stage, Stage::Manual);
        assert!(!s.error.is_empty());
        s.address = "https://tv.example.com".into();
        s.failed_result = true;
        s.key(Key::Ok);
        for _ in 0..15 {
            s.tick(0.1);
        }
        assert_eq!(s.stage, Stage::Failed);
        s.key(Key::Down);
        s.key(Key::Ok);
        assert_eq!(s.address, "https://tv.example.com");
        assert_eq!(s.stage, Stage::Manual);
    }
    #[test]
    fn keyboard_and_remote_validation_work_without_leaking_input_to_navigation() {
        let mut s = State::default();
        s.manual();
        s.remote = true;
        s.focus = 3;
        s.address = "http://tv.example.com".into();
        s.key(Key::Ok);
        assert_eq!(s.stage, Stage::Manual);
        assert!(!s.error.is_empty());
        s.focus = 2;
        s.key(Key::Ok);
        s.text("host");
        s.erase();
        assert!(s.address.ends_with("hos"));
        s.key(Key::Back);
        assert!(!s.editing);
        assert_eq!(s.focus, 2);
    }
}
