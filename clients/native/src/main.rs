mod arrival;
mod components;
mod composite;
mod glass;
mod guide;
mod model;
mod lineup;
mod motion;
mod network;
mod platform;
mod playback;
#[cfg(any(test, all(feature = "webos", target_arch = "arm")))]
mod media_commands;
mod pointer;
mod settings;
mod sound;
mod setup;
mod style;
use model::*;
use sdl2::{
    event::Event,
    keyboard::Keycode,
    pixels::{Color, PixelFormatEnum},
    rect::Rect,
    render::{Canvas, Texture, TextureCreator},
    video::{Window, WindowContext},
};
use std::{
    collections::HashMap,
    sync::mpsc,
    time::{Duration, Instant},
};

struct Paint<'a> {
    video: Option<Texture<'a>>,
    video_channel: Option<String>,
    icons: HashMap<String, Texture<'a>>,
    playback_status: String,
    playback_wait: f32,
    playback_enabled: bool,
    setup: Option<setup::State>,
    setup_layer: Option<Texture<'a>>,
    arrival_layer: bool,
    tab_layer: bool,
    arrival_name: String,
    glass: glass::Glass<'a>,
    guide: guide::State,
    focus: HashMap<String, motion::Spring>,
    modal: motion::Spring,
    modal_texture: Option<Texture<'a>>,
    details_content: Option<components::Details>,
    frame_dt: f32,
    ambient_seconds: f32,
    loading_connection_focus: bool,
    player_open: motion::Spring,
    player_bar: motion::Spring,
    guide_sheet: motion::Spring,
    reduced_motion: bool,
    menu_sounds: bool,
    textures: &'a TextureCreator<WindowContext>,
    font: fontdue::Font,
    bold: fontdue::Font,
    text: HashMap<String, Texture<'a>>,
}
impl<'a> Paint<'a> {
    fn new(textures: &'a TextureCreator<WindowContext>) -> Self {
        Self {
            video: None,
            video_channel: None,
            icons: HashMap::new(),
            playback_status: String::new(),
            playback_wait: 0.,
            playback_enabled: false,
            setup: None,
            setup_layer: None,
            arrival_layer: false,
            tab_layer: false,
            arrival_name: String::new(),
            glass: glass::Glass::new(textures),
            guide: guide::State::default(),
            focus: HashMap::new(),
            modal: motion::Spring::default(),
            modal_texture: None,
            details_content: None,
            frame_dt: 1.0 / 60.0,
            ambient_seconds: 0.,
            loading_connection_focus: false,
            player_open: motion::Spring::default(),
            player_bar: motion::Spring::default(),
            guide_sheet: motion::Spring::default(),
            reduced_motion: false,
            menu_sounds: true,
            textures,
            font: fontdue::Font::from_bytes(
                include_bytes!("../assets/Inter-Regular.ttf") as &[u8],
                Default::default(),
            )
            .unwrap(),
            bold: fontdue::Font::from_bytes(
                include_bytes!("../assets/Inter-Bold.ttf") as &[u8],
                Default::default(),
            )
            .unwrap(),
            text: HashMap::new(),
        }
    }
    /// Center the visible glyph bounds, not the font's padded raster box.
    fn centered(
        &mut self,
        c: &mut Canvas<Window>,
        text: &str,
        r: Rect,
        size: u32,
        bold: bool,
        color: Color,
    ) {
        let font = if bold { &self.bold } else { &self.font };
        let available = r
            .width()
            .saturating_sub(if r.width() < 80 { 8 } else { 24 })
            .max(1) as f32;
        let mut shown = text.to_string();
        let measure = |s: &str| {
            s.chars()
                .map(|ch| font.metrics(ch, size as f32).advance_width)
                .sum::<f32>()
        };
        if measure(&shown) > available {
            while !shown.is_empty() && measure(&format!("{shown}…")) > available {
                shown.pop();
            }
            shown.push('…');
        }
        let mut top = size as i32;
        let mut bottom = 0;
        for ch in shown.chars() {
            let m = font.metrics(ch, size as f32);
            if m.height > 0 {
                top = top.min(size as i32 - m.height as i32 - m.ymin);
                bottom = bottom.max(size as i32 - m.ymin);
            }
        }
        let x = r.x() + ((r.width() as f32 - measure(&shown)) / 2.).round() as i32;
        let y = r.y() + (r.height() as i32 - (bottom - top)) / 2 - top;
        self.label(c, &shown, x, y, size, bold, color, r.width());
    }
    fn paragraph(
        &mut self,
        c: &mut Canvas<Window>,
        text: &str,
        x: i32,
        y: i32,
        size: u32,
        width: u32,
        limit: usize,
    ) {
        let mut lines = vec![String::new()];
        for word in text.split_whitespace() {
            let line = lines.last().unwrap();
            let trial = if line.is_empty() {
                word.into()
            } else {
                format!("{} {}", line, word)
            };
            let measured: f32 = trial
                .chars()
                .map(|v| self.font.metrics(v, size as f32).advance_width)
                .sum();
            if measured > width as f32 && !line.is_empty() && lines.len() < limit {
                lines.push(word.into());
            } else {
                *lines.last_mut().unwrap() = trial;
            }
        }
        for (i, line) in lines.iter().enumerate() {
            self.label(
                c,
                line,
                x,
                y + i as i32 * (size as i32 + 7),
                size,
                false,
                MUTED,
                width,
            );
        }
    }
    fn title(&mut self, c: &mut Canvas<Window>, s: &str, x: i32, y: i32, size: u32, max: u32) {
        let mut lines = vec![String::new()];
        for word in s.split_whitespace() {
            let i = lines.len() - 1;
            let trial = format!(
                "{}{}{}",
                lines[i],
                if lines[i].is_empty() { "" } else { " " },
                word
            );
            let w: f32 = trial
                .chars()
                .map(|v| self.bold.metrics(v, size as f32).advance_width)
                .sum();
            if w > max as f32 && !lines[i].is_empty() {
                lines.push(word.into());
            } else {
                lines[i] = trial;
            }
        }
        if lines.len() > 2 {
            // Preserve the overflow in line two so label() adds an honest ellipsis.
            let remainder = lines[1..].join(" ");
            lines.truncate(1);
            lines.push(remainder);
        }
        for (i, line) in lines.iter().take(2).enumerate() {
            self.label(
                c,
                line,
                x,
                y + i as i32 * (size as i32 + 8),
                size,
                true,
                WHITE,
                max,
            );
        }
    }
    fn label(
        &mut self,
        c: &mut Canvas<Window>,
        s: &str,
        x: i32,
        y: i32,
        size: u32,
        bold: bool,
        color: Color,
        max: u32,
    ) {
        let key = format!(
            "{s}/{size}/{bold}/{}/{}/{}/{max}",
            color.r, color.g, color.b
        );
        if !self.text.contains_key(&key) {
            if self.text.len() > 256 {
                self.text.clear();
            }
            let f = if bold { &self.bold } else { &self.font };
            let mut chars = String::new();
            let mut width = 0f32;
            for ch in s.chars() {
                let advance = f.metrics(ch, size as f32).advance_width;
                if width + advance > max as f32 {
                    let ellipsis = f.metrics('…', size as f32).advance_width;
                    while width + ellipsis > max as f32 {
                        if let Some(last) = chars.pop() {
                            width -= f.metrics(last, size as f32).advance_width;
                        } else {
                            break;
                        }
                    }
                    chars.push('…');
                    break;
                }
                chars.push(ch);
                width += advance;
            }
            let w = (width.ceil() as u32 + size).min(max).max(1);
            let h = size * 2;
            let mut rgba = vec![0u8; (w * h * 4) as usize];
            let mut pen = 0f32;
            for ch in chars.chars() {
                let (m, bitmap) = f.rasterize(ch, size as f32);
                let top = size as i32 - m.height as i32 - m.ymin;
                for yy in 0..m.height {
                    for xx in 0..m.width {
                        let px = pen as i32 + m.xmin + xx as i32;
                        let py = top + yy as i32;
                        if px >= 0 && py >= 0 && (px as u32) < w && (py as u32) < h {
                            let i = ((py as u32 * w + px as u32) * 4) as usize;
                            rgba[i..i + 4].copy_from_slice(&[
                                color.r,
                                color.g,
                                color.b,
                                bitmap[yy * m.width + xx],
                            ]);
                        }
                    }
                }
                pen += m.advance_width;
            }
            let mut t = self
                .textures
                .create_texture_static(PixelFormatEnum::RGBA32, w, h)
                .unwrap();
            t.update(None, &rgba, (w * 4) as usize).unwrap();
            t.set_blend_mode(sdl2::render::BlendMode::Blend);
            self.text.insert(key.clone(), t);
        }
        let t = self.text.get_mut(&key).unwrap();
        t.set_alpha_mod(color.a);
        let q = t.query();
        let _ = c.copy(t, None, Rect::new(x, y, q.width, q.height));
    }
}
fn panel(c: &mut Canvas<Window>, r: Rect, color: Color) {
    rounded_panel(c, r, color, style::PANEL_RADIUS);
}
fn rounded_panel(c: &mut Canvas<Window>, r: Rect, color: Color, radius: i32) {
    let radius = radius.min(r.height() as i32 / 2).min(r.width() as i32 / 2) as f32;
    // The rectangular middle needs one draw, not one line per pixel row.
    let cap = radius as i32;
    let middle = r.height() as i32 - cap * 2;
    if middle > 0 {
        c.set_draw_color(color);
        let _ = c.fill_rect(Rect::new(r.x(), r.y() + cap, r.width(), middle as u32));
    }
    for dy in (0..cap).chain((r.height() as i32 - cap)..r.height() as i32) {
        let cy = dy as f32 + 0.5;
        let edge = (radius - cy).max(cy - (r.height() as f32 - radius)).max(0.);
        let inset = if edge > 0. {
            radius - (radius * radius - edge * edge).max(0.).sqrt()
        } else {
            0.
        };
        let whole = inset.ceil() as i32;
        c.set_draw_color(color);
        if r.width() as i32 > whole * 2 {
            let _ = c.draw_line(
                (r.x() + whole, r.y() + dy),
                (r.right() - whole - 1, r.y() + dy),
            );
        }
        if whole > 0 {
            let coverage = whole as f32 - inset;
            c.set_draw_color(Color::RGBA(
                color.r,
                color.g,
                color.b,
                (color.a as f32 * coverage) as u8,
            ));
            let _ = c.draw_point((r.x() + whole - 1, r.y() + dy));
            let _ = c.draw_point((r.right() - whole, r.y() + dy));
        }
    }
}
const WHITE: Color = style::TEXT;
const MUTED: Color = style::SECONDARY;
const INK: Color = style::INK;
fn surface(c: &mut Canvas<Window>, p: &mut Paint, r: Rect, material: glass::Material) {
    for (spread, alpha) in [(12, 8), (7, 12), (3, 18)] {
        panel(
            c,
            Rect::new(
                r.x() - spread,
                r.y() + 8,
                r.width() + spread as u32 * 2,
                r.height() + spread as u32,
            ),
            Color::RGBA(0, 0, 0, alpha),
        );
    }
    p.glass.draw(c, r, material);
}
fn button(c: &mut Canvas<Window>, p: &mut Paint, label: &str, r: Rect, focused: bool) {
    surface(
        c,
        p,
        r,
        if focused {
            glass::Material::FocusedControl
        } else {
            glass::Material::Control
        },
    );
    p.centered(c, label, r, 26, true, if focused { INK } else { WHITE });
}
fn draw_chrome(c: &mut Canvas<Window>, p: &mut Paint, nav: &Navigation) {
    p.label(c, "dialden", 80, 49, 37, true, WHITE, 250);
    components::navigation(c, p, nav);
    p.label(
        c,
        &chrono::Local::now().format("%H:%M").to_string(),
        1730,
        61,
        26,
        false,
        MUTED,
        130,
    );
}

fn draw(
    c: &mut Canvas<Window>,
    p: &mut Paint,
    nav: &Navigation,
    data: &Snapshot,
    art: &HashMap<u64, Texture>,
    server: &str,
    status: &str,
    elapsed: f64,
) {
    c.set_draw_color(if p.arrival_layer {
        Color::RGBA(0, 0, 0, 0)
    } else {
        Color::RGB(12, 14, 23)
    });
    c.clear();
    if !p.arrival_layer {
        p.glass.background(c, p.ambient_seconds, p.reduced_motion);
    }
    if let Some(state) = p.setup.clone() {
        setup::draw(c, p, &state);
        return;
    }
    let overlay = nav.page == Page::Guide && nav.guide_from_player;
    let sheet = p
        .guide_sheet
        .step(
            if overlay { 1.0 } else { 0.0 },
            p.frame_dt,
            p.reduced_motion,
        )
        .clamp(0.0, 1.0);
    if (nav.page == Page::Player || overlay) && !data.channels.is_empty() {
        let mut player_nav = nav.clone();
        player_nav.index = nav
            .playing_index
            .unwrap_or(nav.index)
            .min(data.channels.len() - 1);
        if sheet > 0.001 {
            player_nav.player_controls = false;
        }
        draw_player(c, p, &player_nav, data, art, elapsed);
        if sheet > 0.001 {
            draw_guide_overlay(c, p, nav, data, sheet);
        }
        return;
    }
    if !p.tab_layer {
        draw_chrome(c, p, nav);
    }
    if nav.page == Page::FullGuide {
        guide::draw(c, p, nav, data);
        return;
    }
    if nav.page == Page::Settings {
        settings::draw(c, p, nav, server, status);
    } else if data.channels.is_empty() {
        p.title(
            c,
            if status.starts_with("Connecting") {
                "Connecting to your server"
            } else if status.starts_with("Server") || status.starts_with("Could not") {
                "Couldn’t load your channels"
            } else {
                "No channels available"
            },
            100,
            340,
            62,
            1300,
        );
        p.label(
            c,
            if status.starts_with("Connecting") {
                "Loading channels and programme information…"
            } else {
                status
            },
            100,
            460,
            28,
            false,
            MUTED,
            1600,
        );
    } else if nav.page == Page::Watch {
        let ch = &data.channels[nav.index];
        let schedule = data.schedule(&ch.id);
        let program = schedule.and_then(|s| s.program.as_ref());
        // The artwork stays within a raised frame, including when a thumbnail is unavailable.
        panel(c, Rect::new(960, 190, 860, 480), style::CONTENT);
        if cfg!(all(
            feature = "webos",
            target_arch = "arm",
            not(feature = "desktop-player")
        )) && p.video_channel.as_deref() == Some(ch.id.as_str())
        {
            video_aperture(c, Rect::new(990, 220, 800, 420));
        } else if p.video_channel.as_deref() == Some(ch.id.as_str()) && p.video.is_some() {
            copy_video(c, p.video.as_ref().unwrap(), Rect::new(990, 220, 800, 420));
        } else if let Some(t) = program.and_then(|v| v.media_id).and_then(|id| art.get(&id)) {
            let q = t.query();
            let ratio = 800.0 / 420.0;
            let source_ratio = q.width as f32 / q.height as f32;
            let source = if source_ratio > ratio {
                let w = (q.height as f32 * ratio) as u32;
                Rect::new(((q.width - w) / 2) as i32, 0, w, q.height)
            } else {
                let h = (q.width as f32 / ratio) as u32;
                Rect::new(0, ((q.height - h) / 2) as i32, q.width, h)
            };
            let _ = c.copy(t, source, Rect::new(990, 220, 800, 420));
        } else {
            // Programme and channel details already live beside the preview.
            if ch.on_air && !playback::is_failure(&p.playback_status) {
                components::playback_activity(c, p, 1345, 410);
            } else {
                p.centered(c, if ch.on_air { "Preview unavailable" } else { "Off air" }, Rect::new(990, 390, 800, 60), 23, false, MUTED);
            }
        }

        p.title(
            c,
            program.map(|v| v.heading()).unwrap_or("Nothing scheduled"),
            100, 210, 54, 810,
        );
        if let Some(v) = program {
            p.label(c, &v.subtitle(), 100, 350, 25, true, WHITE, 810);
            p.paragraph(c, &v.home_description(), 100, 398, 24, 810, 3);
            let progress = if v.duration_ms > 0. {
                (v.progress() as f64 + elapsed / v.duration_ms).clamp(0., 1.)
            } else { 0. };
            panel(c, Rect::new(100, 508, 810, 3), Color::RGB(63, 69, 87));
            if progress > 0. {
                panel(c, Rect::new(100, 508, (810. * progress) as u32, 3), WHITE);
            }
        }
        button(
            c,
            p,
            "Full guide",
            Rect::new(100, 540, 251, 68),
            nav.actions,
        );
        let next = schedule
            .and_then(|s| s.next.as_ref())
            .map(|v| v.heading())
            .unwrap_or("Schedule unavailable");
        p.label(
            c,
            &format!("Next  ·  {next}"),
            100,
            631,
            25,
            false,
            MUTED,
            810,
        );
        p.label(c, "Your channels", 100, 728, 32, true, WHITE, 1200);
        p.label(
            c,
            &format!("{} channels", data.channels.len()),
            1650,
            735,
            23,
            false,
            MUTED,
            180,
        );
        let start = nav.index.saturating_sub(3);
        for (slot, (index, ch)) in data
            .channels
            .iter()
            .enumerate()
            .skip(start)
            .take(5)
            .enumerate()
        {
            let x = 100 + slot as i32 * 346;
            let focused = index == nav.index && !nav.nav && !nav.actions;
            let lift = p
                .focus
                .entry(ch.id.clone())
                .or_insert_with(|| motion::Spring::at(if focused { 1.0 } else { 0.0 }))
                .step(
                    if focused { 1.0 } else { 0.0 },
                    p.frame_dt,
                    p.reduced_motion,
                );
            let y = 802 - (lift * 8.0).round() as i32;
            components::content_card(c, Rect::new(x, y, 320, 151), focused);
            panel(
                c,
                Rect::new(x + 20, y + 19, 48, 30),
                if focused {
                    Color::RGB(221, 225, 236)
                } else {
                    Color::RGBA(224, 238, 255, 28)
                },
            );
            p.centered(
                c,
                &format!("{:02}", index + 1),
                Rect::new(x + 20, y + 19, 48, 30),
                18,
                true,
                if focused { INK } else { MUTED },
            );
            if let Some(logo) = p.icons.get(&ch.id) {
                let q = logo.query();
                let scale = (226.0 / q.width as f32).min(72.0 / q.height as f32);
                let w = (q.width as f32 * scale).round() as u32;
                let h = (q.height as f32 * scale).round() as u32;
                let _ = c.copy(logo, None, Rect::new(x + 80 + (226 - w as i32) / 2, y + 16 + (72 - h as i32) / 2, w, h));
            } else {
            p.label(
                c,
                &ch.name,
                x + 20,
                y + 59,
                25,
                true,
                if focused { INK } else { WHITE },
                285,
            );            }

            p.label(
                c,
                data.schedule(&ch.id)
                    .and_then(|s| s.program.as_ref())
                    .map(|v| v.heading())
                    .unwrap_or("Off air"),
                x + 20,
                y + 104,
                21,
                false,
                if focused {
                    Color::RGB(85, 92, 112)
                } else {
                    MUTED
                },
                285,
            );
        }
    } else {
        p.label(c, "Now & next", 100, 178, 56, true, WHITE, 1600);
        p.label(
            c,
            "Find something worth staying in for.",
            100,
            252,
            27,
            false,
            MUTED,
            1600,
        );
        p.label(c, "CHANNEL", 140, 325, 20, true, MUTED, 340);
        p.label(c, "ON NOW", 520, 325, 20, true, MUTED, 650);
        p.label(c, "UP NEXT", 1210, 325, 20, true, MUTED, 560);
        let start = nav.index.saturating_sub(4);
        for (slot, (index, ch)) in data
            .channels
            .iter()
            .enumerate()
            .skip(start)
            .take(5)
            .enumerate()
        {
            let y = 373 + slot as i32 * 116;
            let focused = index == nav.index && !nav.nav;
            components::channel_guide_row(
                c,
                p,
                Rect::new(100, y, 1720, 100),
                ch,
                data.schedule(&ch.id),
                focused,
                nav.playing_index == Some(index),
            );
        }
    }
    if nav.page == Page::Watch && p.playback_enabled && !data.channels.is_empty() {
        if p.playback_wait > 0.6 && (p.video_channel.as_deref() == Some(data.channels[nav.index].id.as_str()) || data.schedule(&data.channels[nav.index].id).and_then(|s| s.program.as_ref()).and_then(|v| v.media_id).is_some_and(|id| art.contains_key(&id))) {
            components::playback_activity(c, p, 1345, 410);
        } else if playback::is_failure(&p.playback_status) && (p.video_channel.as_deref() == Some(data.channels[nav.index].id.as_str()) || data.schedule(&data.channels[nav.index].id).and_then(|s| s.program.as_ref()).and_then(|v| v.media_id).is_some_and(|id| art.contains_key(&id))) {
            let r = Rect::new(1490, 590, 290, 40);
            p.glass.live_sheet(c, r, r);
            p.centered(c, "Preview unavailable", r, 20, false, MUTED);
        }
    }
    let action = if nav.page == Page::Settings {
        if nav.nav {
            "Open"
        } else {
            "Change"
        }
    } else if data.channels.is_empty() {
        ""
    } else {
        "Select"
    };
    let note = if data.channels.is_empty() {
        ""
    } else if status.starts_with("Demo") {
        "Demo · Sample listings"
    } else if status.starts_with("Connected") {
        ""
    } else {
        status
    };
    components::navigation_help(
        c,
        p,
        &[
            ("↔", if nav.nav { "Tabs" } else { "Navigate" }),
            ("OK", action),
            ("↩", "Back"),
        ],
        note,
    );
    let details = if nav.modal {
        data.channels.get(nav.index).map(|ch| {
            let program = data.schedule(&ch.id).and_then(|s| s.program.as_ref());
            components::Details {
                channel: ch.name.clone(),
                title: program
                    .map(|v| v.heading())
                    .unwrap_or("Nothing scheduled")
                    .into(),
                timing: program
                    .map(|v| format!("{} minutes", (v.duration_ms / 60000.).round() as u64))
                    .unwrap_or_default(),
                episode: program.map(|v| v.subtitle()).unwrap_or_default(),
                metadata: program.map(|v| v.metadata.clone()).unwrap_or_default(),
                status: if program.is_some() {
                    "On now"
                } else {
                    "Off air"
                }
                .into(),
                back: "Back".into(),
            }
        })
    } else {
        None
    };
    components::details(c, p, details);
    if nav.quit_confirm {
        c.set_draw_color(Color::RGBA(0, 0, 0, 140));
        let _ = c.fill_rect(Rect::new(0, 0, 1920, 1080));
        p.glass.sheet(c, Rect::new(520, 360, 880, 310));
        p.label(c, "Quit Dialden?", 560, 400, 40, true, WHITE, 800);
        p.label(c, "You can come back whenever you’re ready.", 560, 470, 25, false, MUTED, 800);
        components::playback_button(c, p, "Stay", Rect::new(560, 560, 380, 64), !nav.quit_selected);
        components::playback_button(c, p, "Quit", Rect::new(980, 560, 380, 64), nav.quit_selected);
    }
}

fn draw_guide_overlay(
    c: &mut Canvas<Window>,
    p: &mut Paint,
    nav: &Navigation,
    data: &Snapshot,
    amount: f32,
) {
    c.set_draw_color(Color::RGBA(0, 0, 0, (35.0 * amount) as u8));
    let _ = c.fill_rect(Rect::new(0, 0, 1920, 1080));
    let y = 300 + ((1.0 - amount) * 820.0) as i32;
    panel(
        c,
        Rect::new(72, y + 10, 1776, 714),
        Color::RGBA(0, 0, 0, 65),
    );
    p.glass.live_sheet(
        c,
        Rect::new(80, 300, 1760, 710),
        Rect::new(80, y, 1760, 710),
    );

    p.label(c, "Guide", 120, y + 43, 37, true, WHITE, 500);
    components::playback_button(
        c,
        p,
        "Full guide",
        Rect::new(1450, y + 37, 340, 62),
        nav.overlay_button,
    );
    p.label(c, "CHANNEL", 140, y + 119, 19, true, MUTED, 320);
    p.label(c, "ON NOW", 520, y + 119, 19, true, MUTED, 650);
    p.label(c, "UP NEXT", 1210, y + 119, 19, true, MUTED, 530);
    let start = nav.index.saturating_sub(3);
    for (slot, (index, ch)) in data
        .channels
        .iter()
        .enumerate()
        .skip(start)
        .take(5)
        .enumerate()
    {
        let row = y + 160 + slot as i32 * 91;
        let focused = nav.index == index && !nav.overlay_button;
        components::channel_guide_row(
            c,
            p,
            Rect::new(115, row, 1690, 78),
            ch,
            data.schedule(&ch.id),
            focused,
            nav.playing_index == Some(index),
        );
    }
    components::navigation_help_at(
        c,
        p,
        &[
            ("↑↓", "Browse"),
            (
                "OK",
                if nav.overlay_button {
                    "Full guide"
                } else {
                    "Open channel"
                },
            ),
            ("↩", "Close guide"),
        ],
        120,
        y + 648,
    );
}
// Fit the decoder's 16:9 surface without stretching the programme or its letterboxing.
fn video_aperture(c: &mut Canvas<Window>, rect: Rect) {
    c.set_blend_mode(sdl2::render::BlendMode::None);
    c.set_draw_color(Color::RGBA(0, 0, 0, 0));
    let _ = c.fill_rect(rect);
    c.set_blend_mode(sdl2::render::BlendMode::Blend);
}
fn copy_video(c: &mut Canvas<Window>, t: &Texture, rect: Rect) {
    c.set_draw_color(Color::BLACK);
    let _ = c.fill_rect(rect);
    let scale = (rect.width() as f32 / playback::WIDTH as f32)
        .min(rect.height() as f32 / playback::HEIGHT as f32);
    let w = (playback::WIDTH as f32 * scale) as u32;
    let h = (playback::HEIGHT as f32 * scale) as u32;
    let _ = c.copy(
        t,
        None,
        Rect::new(
            rect.x() + (rect.width() - w) as i32 / 2,
            rect.y() + (rect.height() - h) as i32 / 2,
            w,
            h,
        ),
    );
}
fn draw_player(
    c: &mut Canvas<Window>,
    p: &mut Paint,
    nav: &Navigation,
    data: &Snapshot,
    art: &HashMap<u64, Texture>,
    elapsed: f64,
) {
    let ch = &data.channels[nav.index];
    let schedule = data.schedule(&ch.id);
    let program = schedule.and_then(|s| s.program.as_ref());
    let opening = p
        .player_open
        .step(1.0, p.frame_dt, p.reduced_motion)
        .clamp(0.0, 1.0);
    let rect = Rect::new(
        (960.0 * (1.0 - opening)) as i32,
        (190.0 * (1.0 - opening)) as i32,
        (860.0 + 1060.0 * opening) as u32,
        (480.0 + 600.0 * opening) as u32,
    );
    if cfg!(all(
        feature = "webos",
        target_arch = "arm",
        not(feature = "desktop-player")
    )) && p.video_channel.as_deref() == Some(ch.id.as_str())
    {
        video_aperture(c, rect);
    } else if p.video_channel.as_deref() == Some(ch.id.as_str()) && p.video.is_some() {
        copy_video(c, p.video.as_ref().unwrap(), rect);
    } else if let Some(t) = program.and_then(|p| p.media_id).and_then(|id| art.get(&id)) {
        let q = t.query();
        let ratio = rect.width() as f32 / rect.height() as f32;
        let source = if q.width as f32 / q.height as f32 > ratio {
            let w = (q.height as f32 * ratio) as u32;
            Rect::new(((q.width - w) / 2) as i32, 0, w, q.height)
        } else {
            let h = (q.width as f32 / ratio) as u32;
            Rect::new(0, ((q.height - h) / 2) as i32, q.width, h)
        };
        let _ = c.copy(t, source, rect);
    } else {
        if opening >= 0.999 {
            c.set_draw_color(Color::RGB(12, 14, 23));
            let _ = c.fill_rect(rect);
        } else {
            panel(c, rect, Color::RGB(12, 14, 23));
        }
        // Loading is communicated by the small activity indicator alone.
    }
    if p.playback_enabled {
        if p.playback_wait > 0.6 {
            if p.video_channel.as_deref() == Some(ch.id.as_str()) {
                components::playback_activity(c, p, 1750, 60);
            } else {
                components::playback_activity(c, p, 915, 520);
            }
        } else if playback::is_failure(&p.playback_status) {
            let r = Rect::new(510, 90, 900, 100);
            p.glass.live_sheet(c, r, r);
            p.label(
                c,
                "Couldn’t play this channel",
                540,
                108,
                27,
                true,
                WHITE,
                840,
            );
            p.label(
                c,
                "Try another channel, or go back and reopen it.",
                540,
                151,
                22,
                false,
                MUTED,
                840,
            );
        }
    } else {
        p.label(c, "Layout preview", 80, 60, 20, false, MUTED, 400);
    }
    let bar = p
        .player_bar
        .step(
            if nav.player_controls && (!p.playback_enabled || !playback::is_waiting(&p.playback_status)) { 1.0 } else { 0.0 },
            p.frame_dt,
            p.reduced_motion,
        )
        .clamp(0.0, 1.0);
    if bar <= 0.001 {
        return;
    }
    let y = 842 + ((1.0 - bar) * 240.0) as i32;
    p.glass.live_controls(c, Rect::new(100, 842, 1720, 154), Rect::new(100, y, 1720, 154));
    p.label(c, &format!("{}  ·  LIVE", ch.name), 132, y + 16, 20, true, WHITE, 490);
    if let Some(program) = program {
        p.label(c, &program.subtitle(), 650, y + 16, 20, false, WHITE, 652);
    }
    p.label(c, program.map(|p| p.heading()).unwrap_or("Nothing scheduled"),
        132, y + 46, 32, true, WHITE, 1180);
    let next = schedule.and_then(|s| s.next.as_ref()).map(|v| v.heading()).unwrap_or("Not scheduled");
    p.label(c, &format!("Up next · {next}"), 132, y + 91, 21, false, WHITE, 1180);
    if let Some(program) = program {
        let progress = if program.duration_ms > 0. {
            ((program.offset_ms + elapsed) / program.duration_ms).clamp(0., 1.)
        } else { 0. };
        panel(c, Rect::new(132, y + 130, 1170, 3), Color::RGBA(230, 240, 255, 55));
        let width = (1170. * progress) as u32;
        if width > 0 { panel(c, Rect::new(132, y + 130, width, 3), WHITE); }
    }
    for (index, label) in ["Channels & guide", "Back to browse"].iter().enumerate() {
        let r = Rect::new(1360, y + 16 + index as i32 * 66, 428, 54);
        components::playback_button(c, p, label, r, nav.action_index == index);
    }
    let hint = Rect::new(660, y - 70, 600, 46);
    p.glass.live_controls(c, Rect::new(660, 772, 600, 46), hint);
    p.centered(c, "← →  Change channel     ↑ ↓  Controls", hint, 20, false, WHITE);

}
fn demo() -> Snapshot {
    let names = [
        "Nickelodeon",
        "Cartoon Network",
        "Disney Channel",
        "Nick Jr.",
        "Nature & Discovery",
    ];
    let shows = [
        "SpongeBob SquarePants",
        "Adventure Time",
        "Big City Greens",
        "Dora the Explorer",
        "The natural world",
    ];
    Snapshot {
        channels: names
            .iter()
            .enumerate()
            .map(|(i, n)| Channel {
                id: i.to_string(),
                name: n.to_string(),
                enabled: true,
                on_air: true,
                icon_url: None,
            })
            .collect(),
        schedules: shows
            .iter()
            .enumerate()
            .map(|(i, n)| Schedule {
                channel_id: i.to_string(),
                live_stream: None,
                program: Some(Program {
                    title: "An afternoon of favourites".into(),
                    episode_label: "S01E03".into(),
                    metadata: ProgramMetadata {
                        overview: "Sample episode description for the design preview. A familiar day takes an unexpected turn as friends work together to solve a new mystery.".into(),
                        overview_scope: "episode".into(),
                        ..Default::default()
                    },
                    collection_title: n.to_string(),
                    duration_ms: 1800000.,
                    offset_ms: 680000.,
                    ..Default::default()
                }),
                next: Some(Program {
                    collection_title: [
                        "The Fairly OddParents",
                        "The Amazing World of Gumball",
                        "Phineas and Ferb",
                        "Blue’s Clues",
                        "Planet Earth",
                    ][i]
                        .to_string(),
                    ..Default::default()
                }),
            })
            .collect(),
    }
}
fn navigate(
    key: Key,
    nav: &mut Navigation,
    data: &Snapshot,
    guide: &mut guide::State,
    setup: &mut Option<setup::State>,
    reduced_motion: &mut bool,
    menu_sounds: &mut bool,
) {
    if let Some(state) = setup.as_mut() {
        if state.key(key) {
            *setup = None;
            nav.page = Page::Watch;
            nav.nav = false;
        }
        return;
    }
    if settings::key(nav, key, reduced_motion, menu_sounds) {
        return;
    }
    let previous = nav.clone();
    if nav.page == Page::FullGuide {
        guide.key(key, nav, data);
    } else {
        nav.key(key, data.channels.len());
    }
    if nav.page == Page::FullGuide
        && previous.page != Page::FullGuide
        && !(previous.page == Page::Player && previous.return_page == Page::FullGuide)
    {
        guide.enter(previous);
    }
}
fn main() -> Result<(), String> {
    let boot = Instant::now();
    platform::initialize();
    platform::diagnostic("startup");
    let args: Vec<String> = std::env::args().collect();
    let value = |flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    if args.iter().any(|a| a == "--help") {
        println!("Dialden Native preview\n--server http://host:1993 | --demo\n--fullscreen --no-playback --reduce-motion --intro-ms 150 --screenshot file.png --screen guide|actions|details|settings --focus 0");
        return Ok(());
    }
    let demo_mode = args.iter().any(|a| a == "--demo");
    let setup_review = args.iter().any(|a| a == "--setup-review");
    let setup_preview = setup_review || args.iter().any(|a| a == "--setup-flow");
    let setup_screen = value("--screen").is_some_and(|s| s.starts_with("setup"));
    if (setup_preview || setup_screen) && !demo_mode {
        return Err("Setup is a design demo: use --demo --screen setup or --demo --setup-flow --motion-preview DIR".into());
    }
    let server = value("--server")
        .or_else(platform::configured_server)
        .unwrap_or_default();
    if !demo_mode && server.is_empty() {
        return Err("Supply --server http://host:1993 or --demo".into());
    }
    let screenshot = value("--screenshot");
    let preview_dir = value("--motion-preview");
    if setup_preview && preview_dir.is_none() {
        return Err("--setup-flow requires --motion-preview DIR".into());
    }
    if let Some(dir) = &preview_dir {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let sdl = sdl2::init()?;
    let video = sdl.video()?;
    if cfg!(feature = "webos") {
        video.gl_attr().set_alpha_size(8);
    }
    let mut builder = video.window("Dialden", 1920, 1080);
    builder.position_centered().resizable();
    if args.iter().any(|a| a == "--fullscreen")
        || (cfg!(feature = "webos") && screenshot.is_none() && preview_dir.is_none())
    {
        builder.fullscreen_desktop();
    }
    let window = builder.build().map_err(|e| e.to_string())?;
    let cb = window.into_canvas();
    let mut c = if screenshot.is_some() || preview_dir.is_some() {
        cb.software()
    } else {
        cb.present_vsync()
    }
    .build()
    .map_err(|e| e.to_string())?;
    platform::diagnostic(&format!(
        "renderer {:?} startup_ms={}",
        c.info(),
        boot.elapsed().as_millis()
    ));
    c.set_logical_size(1920, 1080).map_err(|e| e.to_string())?;
    c.set_blend_mode(sdl2::render::BlendMode::Blend);
    // Commit an app-owned frame immediately so webOS can dismiss its launch indicator.
    c.set_draw_color(Color::RGB(12, 14, 23));
    c.clear();
    c.present();
    let tc = c.texture_creator();
    let mut p = Paint::new(&tc);
    platform::diagnostic(&format!("paint_ready_ms={}", boot.elapsed().as_millis()));
    if setup_preview || setup_screen {
        let mut state = setup::State::default();
        state.empty_result = value("--setup-result").as_deref() == Some("empty");
        state.failed_result = value("--setup-result").as_deref() == Some("error");
        match value("--screen").as_deref() {
            Some("setup-searching") => state.go(setup::Stage::Searching),
            Some("setup-found") => state.go(setup::Stage::Found),
            Some("setup-empty") => state.go(setup::Stage::Empty),
            Some("setup-manual" | "setup-keyboard") => {
                state.go(setup::Stage::Manual);
                state.address = "https://tv.example.com".into();
                state.remote = true;
                state.focus = 2;
                if value("--screen").as_deref() == Some("setup-keyboard") {
                    state.editing = true;
                    state.focus = 0;
                }
            }
            Some("setup-error" | "setup-saved") => {
                state.address = "http://192.168.1.20:1993".into();
                state.failed_result = true;
                state.saved = value("--screen").as_deref() == Some("setup-saved");
                state.go(if state.saved {
                    setup::Stage::Testing
                } else {
                    setup::Stage::Failed
                });
            }
            Some("setup-options") => state.go(setup::Stage::Options),
            Some("setup-connected") => {
                state.address = "http://192.168.1.20:1993".into();
                state.go(setup::Stage::Connected);
            }
            _ => {}
        }
        p.setup = Some(state);
        video.text_input().start();
    }
    let intro_sample = value("--intro-ms")
        .and_then(|s| s.parse::<f32>().ok())
        .map(|ms| ms.max(0.0) / 1000.0);
    let reduced_motion = args.iter().any(|a| a == "--reduce-motion");
    p.reduced_motion = reduced_motion || (screenshot.is_some() && preview_dir.is_none());
    let mut intro_texture = if !reduced_motion
        && preview_dir.is_none()
        && (screenshot.is_none() || intro_sample.is_some())
    {
        tc.create_texture_target(PixelFormatEnum::RGBA8888, 1920, 1080)
            .ok()
    } else {
        None
    };
    let mut intro_start: Option<Instant> = None;
    let mut straight_scene = None;
    let mut art = HashMap::new();
    let mut backdrops = HashMap::new();
    let mut backdrop_id = None;
    let mut data = if demo_mode {
        demo()
    } else {
        Snapshot::default()
    };
    let fixture = value("--fixture");
    if fixture.is_some() && !demo_mode {
        return Err("--fixture requires --demo".into());
    }
    match fixture.as_deref() {
        Some("empty" | "loading") => data = Snapshot::default(),
        Some("long") => {
            for ch in &mut data.channels {
                ch.name = "A channel with an unusually long display name".into();
            }
            for schedule in &mut data.schedules {
                if let Some(program) = &mut schedule.program {
                    program.collection_title = "A very long programme title that needs to wrap onto a second line without colliding with its metadata".into();
                }
            }
        }
        Some("offline" | "bright" | "busy" | "tuning") | None => {}
        _ => {
            return Err("Unknown fixture: use empty, loading, offline, long, bright, busy or tuning".into())
        }
    }
    if matches!(fixture.as_deref(), Some("bright" | "busy")) {
        let busy = fixture.as_deref() == Some("busy");
        let img = image::RgbaImage::from_fn(960, 540, |x, y| {
            if busy {
                image::Rgba([
                    if (x / 24 + y / 24) % 2 == 0 { 255 } else { 20 },
                    (x % 256) as u8,
                    (y % 256) as u8,
                    255,
                ])
            } else {
                image::Rgba([255, 255, 245, 255])
            }
        });
        p.glass.set_backdrop(Some(&glass::Backdrop::from_image(
            &image::DynamicImage::ImageRgba8(img.clone()),
        )));
        if value("--screen").as_deref() == Some("player") {
            let mut frame = tc.create_texture_streaming(PixelFormatEnum::RGBA32, 960, 540).map_err(|e| e.to_string())?;
            frame.update(None, img.as_raw(), 960 * 4).map_err(|e| e.to_string())?;
            p.video = Some(frame);
            p.video_channel = data.channels.first().map(|c| c.id.clone());
            // Exercise the native-TV translucent fallback, which cannot sample video.
        }
    }
    let mut nav = Navigation::default();
    if value("--screen").as_deref() == Some("guide") {
        nav.page = Page::Guide;
    }
    if value("--screen").as_deref() == Some("settings") {
        nav.page = Page::Settings;
    }
    nav.index = value("--focus").and_then(|s| s.parse().ok()).unwrap_or(0);
    nav.nav = data.channels.is_empty() || nav.page == Page::Settings;
    nav.actions = value("--screen").as_deref() == Some("actions");
    nav.modal = value("--screen").as_deref() == Some("details");
    nav.quit_confirm = demo_mode && value("--screen").as_deref() == Some("quit");
    if value("--screen").as_deref() == Some("player") {
        nav.open_channel();
    }
    if value("--screen").as_deref() == Some("overlay") {
        nav.open_channel();
        nav.key(Key::Ok, data.channels.len());
    }
    if value("--screen").as_deref() == Some("timeline") {
        nav.page = Page::FullGuide;
    }
    let (guide_tx, guide_requests) = mpsc::channel();
    let (guide_results, guide_rx) = mpsc::channel();
    let (tx, rx) = mpsc::channel();
    if !demo_mode {
        let u = network::validate_server(&server)?;
        let guide_server = u.clone();
        std::thread::spawn(move || guide::run(guide_server, guide_requests, guide_results));
        std::thread::spawn(move || network::run(u, tx));
    }
    let playback_server = if !demo_mode
        && screenshot.is_none()
        && preview_dir.is_none()
        && !args.iter().any(|a| a == "--no-playback")
    {
        Some(network::validate_server(&server)?)
    } else {
        None
    };
    p.playback_enabled = playback_server.is_some();
    if demo_mode && fixture.as_deref() == Some("tuning") {
        p.playback_enabled = true;
        p.playback_status = "Connecting…".into();
        p.playback_wait = 1.;
    }
    let mut player = playback::Player::new();
    let client_id = format!(
        "native-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    );
    let mut lineup_session = playback_server.clone().map(|server| lineup::Session::new(server, client_id.clone()));
    let mut status = if demo_mode {
        "Demo · sample listings".into()
    } else {
        "Connecting to your server…".into()
    };
    match fixture.as_deref() {
        Some("loading") => status = "Connecting to your server…".into(),
        Some("empty") => status = "No channels configured. Add channels in the admin panel.".into(),
        Some("offline") => status = "Offline · showing cached listings".into(),
        _ => {}
    }
    let start = Instant::now();
    let mut fresh = Instant::now();
    let mut sounds = sound::Sounds::new(screenshot.is_some() || preview_dir.is_some());
    let mut launch_sound_played = false;
    let mut events = sdl.event_pump()?;
    let mut last_frame = Instant::now();
    let mut measured_frames = 0u32;
    let mut measured_at = Instant::now();
    let mut preview_frame = 0u32;
    let preview_stride = if args.iter().any(|a| a == "--smooth-preview") {
        1
    } else {
        3
    };
    let channel_preview = args.iter().any(|a| a == "--channel-flow");
    let player_preview = args.iter().any(|a| a == "--player-flow");
    let timeline_preview = args.iter().any(|a| a == "--timeline-flow");
    if timeline_preview {
        if !demo_mode || preview_dir.is_none() {
            return Err("--timeline-flow requires --demo --motion-preview DIR".into());
        }
        nav.page = Page::FullGuide;
        nav.nav = false;
        p.guide.cursor = p.guide.from + 5 * 60 * 1000;
        intro_texture = None;
    }
    let tabs_preview = args.iter().any(|a| a == "--tabs-flow");
    if tabs_preview {
        if !demo_mode || preview_dir.is_none() {
            return Err("--tabs-flow requires --demo --motion-preview DIR".into());
        }
        nav.page = Page::Watch;
        nav.nav = true;
        intro_texture = None;
    }
    let guide_preview = args.iter().any(|a| a == "--guide-flow");
    let mut displayed_page = nav.page;
    let mut displayed_setup = p.setup.as_ref().map(|s| s.stage);
    let mut transition_elapsed = 0.0f32;
    let mut page_transition = false;
    let mut transition_prepared: Option<bool> = None;
    let mut server_arrival = false;
    let mut player_idle = 0.0f32;
    let ambient_preview = args.iter().any(|a| a == "--ambient-flow");
    let loading_preview = args.iter().any(|a| a == "--loading-flow");
    if (loading_preview || ambient_preview) && (!demo_mode || preview_dir.is_none()) {
        return Err("Loading previews require --demo --motion-preview DIR".into());
    }
    let mut launch = motion::Launch::new(
        !demo_mode
            || fixture.as_deref() == Some("loading")
            || loading_preview
            || ambient_preview
            || setup_preview,
    );
    let mut loading_texture = tc
        .create_texture_target(PixelFormatEnum::RGBA8888, 1920, 1080)
        .ok();
    if launch.waiting {
        intro_texture = None;
    }

    let mut window_visible = true;
    let mut last_video_glass = Instant::now() - Duration::from_secs(1);
    'app: loop {
        p.frame_dt = if preview_dir.is_some() {
            1.0 / 30.0
        } else {
            last_frame.elapsed().as_secs_f32()
        };
        last_frame = Instant::now();
        p.ambient_seconds += p.frame_dt.clamp(0., 0.1);
        if let Some(state) = p.setup.as_mut() {
            state.tick(p.frame_dt);
            if state.stage == setup::Stage::Connected {
                p.arrival_name = state.server_name().to_string();
            }
        }
        if p.setup.as_ref().is_some_and(setup::State::ready_for_home) {
            p.setup = None;
            nav.page = Page::Watch;
            nav.nav = false;
        }
        if nav.page == Page::Player {
            player_idle += p.frame_dt;
            if player_idle >= 4.0 {
                nav.player_controls = false;
            }
        }
        if timeline_preview {
            p.guide.preview_now =
                Some(p.guide.from + 5 * 60 * 1000 + preview_frame as i64 * 10_000);
        }
        if preview_dir.is_some() {
            if setup_preview && preview_frame == 30 {
                launch.finish();
            }
            if loading_preview && preview_frame == 45 {
                launch.finish();
            }
            let key = if tabs_preview {
                match preview_frame {
                    40 | 100 => Some(Key::Right),
                    145 => Some(Key::Down),
                    165 | 195 => Some(Key::Ok),
                    215 => Some(Key::Back),
                    235 | 280 => Some(Key::Left),
                    _ => None,
                }
            } else if value("--screen").as_deref() == Some("setup-connected") {
                None
            } else if setup_review {
                match preview_frame {
                    70 | 165 | 210 | 260 | 395 => Some(Key::Ok),
                    150 | 155 | 195 | 245 => Some(Key::Down),
                    290 | 320 | 350 => Some(Key::Back),
                    375 | 380 => Some(Key::Up),
                    _ => None,
                }
            } else if setup_preview {
                match preview_frame {
                    70 | 170 => Some(Key::Ok),
                    _ => None,
                }
            } else if ambient_preview {
                None
            } else if loading_preview {
                match preview_frame {
                    80 => Some(Key::Down),
                    100 => Some(Key::Ok),
                    130 => Some(Key::Ok),
                    160 => Some(Key::Down),
                    190 => Some(Key::Back),
                    215 => Some(Key::Back),
                    _ => None,
                }
            } else if timeline_preview {
                match preview_frame {
                    30 | 60 => Some(Key::Down),
                    90 | 120 => Some(Key::Right),
                    135 => Some(Key::Ok),
                    175 => Some(Key::Back),
                    195 => Some(Key::Up),
                    220 => Some(Key::Left),
                    _ => None,
                }
            } else if guide_preview {
                match preview_frame {
                    5 => Some(Key::Ok),
                    35 => Some(Key::Ok),
                    65 => Some(Key::Down),
                    85 => Some(Key::Down),
                    110 => Some(Key::Back),
                    _ => None,
                }
            } else if player_preview {
                match preview_frame {
                    25 => Some(Key::Ok),
                    165 => Some(Key::Ok),
                    190 => Some(Key::Ok),
                    _ => None,
                }
            } else if channel_preview {
                match preview_frame {
                    20 => Some(Key::Right),
                    40 => Some(Key::Ok),
                    70 => Some(Key::Ok),
                    100 => Some(Key::Down),
                    115 => Some(Key::Ok),
                    150 => Some(Key::Back),
                    _ => None,
                }
            } else {
                match preview_frame {
                    20 => Some(Key::Right),
                    40 => Some(Key::Up),
                    55 => Some(Key::Ok),
                    95 => Some(Key::Back),
                    _ => None,
                }
            };
            if let Some(key) = key {
                player_idle = 0.0;
                navigate(
                    key,
                    &mut nav,
                    &data,
                    &mut p.guide,
                    &mut p.setup,
                    &mut p.reduced_motion,
                    &mut p.menu_sounds,
                );
            }
        }
        for event in platform::events(&mut events) {
            let cue = match &event {
                Event::KeyDown { keycode: Some(Keycode::Return | Keycode::KpEnter), repeat: false, .. } | Event::MouseButtonDown { mouse_btn: sdl2::mouse::MouseButton::Left, .. } => Some(sound::Cue::Select),
                Event::KeyDown { keycode: Some(Keycode::Escape | Keycode::Backspace | Keycode::AcBack), repeat: false, .. } => Some(sound::Cue::Back),
                Event::KeyDown { keycode: Some(Keycode::Left | Keycode::Right | Keycode::Up | Keycode::Down), repeat: false, .. } | Event::MouseWheel { .. } => Some(sound::Cue::Move),
                _ => None,
            };
            let before = cue.map(|_| format!("{:?}|{}|{}|{}|{}|{:?}", nav, p.guide.cursor, p.guide.detail.is_some(), p.reduced_motion, p.menu_sounds, p.setup.as_ref().map(|s| (s.stage, s.focus, s.editing))));
            match event {
                Event::Quit { .. } => break 'app,
                Event::Window {
                    win_event:
                        sdl2::event::WindowEvent::Minimized | sdl2::event::WindowEvent::Hidden,
                    ..
                } => window_visible = false,
                Event::Window {
                    win_event: sdl2::event::WindowEvent::Restored | sdl2::event::WindowEvent::Shown,
                    ..
                } => window_visible = true,
                Event::MouseMotion { x, y, .. } if !launch.waiting && p.setup.is_none() => {
                    if nav.page == Page::Player {
                        nav.player_controls = true;
                        player_idle = 0.;
                    }
                    if pointer::focus(&mut nav, &mut p.guide, data.channels.len(), x, y) {
                        launch.opacity = 0.;
                        intro_texture = None;
                        player_idle = 0.;
                    }
                }
                Event::MouseButtonDown {
                    mouse_btn: sdl2::mouse::MouseButton::Left,
                    x,
                    y,
                    ..
                } if !launch.waiting && p.setup.is_none() => {
                    platform::diagnostic(&format!("pointer_click x={x} y={y}"));
                    if nav.page == Page::Player && !nav.player_controls {
                        nav.player_controls = true;
                        nav.action_index = 0;
                        player_idle = 0.;
                        continue;
                    }
                    if pointer::focus(&mut nav, &mut p.guide, data.channels.len(), x, y) {
                        launch.opacity = 0.;
                        intro_texture = None;
                        player_idle = 0.;
                        navigate(
                            Key::Ok,
                            &mut nav,
                            &data,
                            &mut p.guide,
                            &mut p.setup,
                            &mut p.reduced_motion,
                    &mut p.menu_sounds,
                        );
                    }
                }
                Event::MouseWheel { y, .. } if y != 0 && !launch.waiting && p.setup.is_none() => {
                    launch.opacity = 0.;
                    intro_texture = None;
                    player_idle = 0.;
                    let key = if nav.page == Page::Watch && !nav.nav && !nav.actions {
                        if y > 0 {
                            Key::Left
                        } else {
                            Key::Right
                        }
                    } else if y > 0 {
                        Key::Up
                    } else {
                        Key::Down
                    };
                    navigate(
                        key,
                        &mut nav,
                        &data,
                        &mut p.guide,
                        &mut p.setup,
                        &mut p.reduced_motion,
                    &mut p.menu_sounds,
                    );
                }
                Event::TextInput { text, .. } => {
                    if let Some(state) = p.setup.as_mut() {
                        state.text(&text);
                    }
                }
                Event::KeyDown {
                    keycode: Some(k),
                    repeat: false,
                    ..
                } => {
                    if k == Keycode::Backspace && p.setup.as_ref().is_some_and(|s| s.editing) {
                        if let Some(state) = p.setup.as_mut() {
                            state.erase();
                        }
                        continue;
                    }
                    if nav.page == Page::Player && matches!(k, Keycode::PageUp | Keycode::PageDown) {
                        nav.player_controls = false;
                        nav.key(if k == Keycode::PageUp { Key::Up } else { Key::Down }, data.channels.len());
                        player_idle = 0.;
                        continue;
                    }
                    let key = match k {
                        Keycode::Left => Some(Key::Left),
                        Keycode::Right => Some(Key::Right),
                        Keycode::Up | Keycode::PageUp => Some(Key::Up),
                        Keycode::Down | Keycode::PageDown => Some(Key::Down),
                        Keycode::Return | Keycode::KpEnter => Some(Key::Ok),
                        Keycode::Escape | Keycode::Backspace | Keycode::AcBack => Some(Key::Back),
                        _ => None,
                    };
                    if let Some(k) = key {
                        if launch.waiting {
                            match k {
                                Key::Down => p.loading_connection_focus = true,
                                Key::Up => p.loading_connection_focus = false,
                                Key::Back => {
                                    launch.finish();
                                    nav.page = Page::Settings;
                                    nav.nav = true;
                                }
                                Key::Ok if p.loading_connection_focus => {
                                    launch.finish();
                                    nav.page = Page::Settings;
                                    nav.nav = true;
                                }
                                _ => {}
                            }
                            continue;
                        }
                        launch.opacity = 0.; // Ready input always bypasses decoration.
                        player_idle = 0.0;
                        intro_texture = None; // Never make remote input wait for decoration.
                        if !nav.modal
                            && p.guide.detail.is_none()
                            && p.modal.value > 0.0
                            && !matches!(k, Key::Back)
                        {
                            p.modal = motion::Spring::default();
                            p.modal_texture = None;
                        }
                        navigate(
                            k,
                            &mut nav,
                            &data,
                            &mut p.guide,
                            &mut p.setup,
                            &mut p.reduced_motion,
                    &mut p.menu_sounds,
                        );
                    }
                }
                _ => {}
            }
            if nav.quit_requested {
                platform::diagnostic("quit confirmed");
                break 'app;
            }
            if let (Some(before), Some(cue)) = (before, cue) {
                let after = format!("{:?}|{}|{}|{}|{}|{:?}", nav, p.guide.cursor, p.guide.detail.is_some(), p.reduced_motion, p.menu_sounds, p.setup.as_ref().map(|s| (s.stage, s.focus, s.editing)));
                if before != after { sounds.play(&sdl, cue, p.menu_sounds); }
            }
        }
        while let Ok(update) = rx.try_recv() {
            match update {
                network::Update::Icon(id, img) => {
                    if data.channels.iter().any(|c| c.id == id && c.icon_url.is_some()) {
                        if let Ok(mut texture) = tc.create_texture_static(PixelFormatEnum::RGBA32, img.width(), img.height()) {
                            texture.set_blend_mode(sdl2::render::BlendMode::Blend);
                            if texture.update(None, img.as_raw(), img.width() as usize * 4).is_ok() { p.icons.insert(id, texture); }
                        }
                    }
                }
                network::Update::Catalog(new) => {
                    p.icons.retain(|id, _| new.channels.iter().any(|c| &c.id == id && c.icon_url.is_some() && data.channels.iter().any(|old| old.id == c.id && old.icon_url == c.icon_url)));
                    launch.finish();
                    nav.reconcile(&data, &new);
                    p.guide.reconcile(&data, &new);
                    data = new;
                    fresh = Instant::now();
                    status = "Connected · refreshed just now".into();
                    art.retain(|id, _| {
                        data.schedules
                            .iter()
                            .any(|s| s.program.as_ref().and_then(|p| p.media_id) == Some(*id))
                    });
                }
                network::Update::Error(e) => {
                    launch.finish();
                    status = if data.channels.is_empty() {
                        e.replace(
                            " Keeping the last channel list.",
                            " Check the server address in Settings. Retrying automatically.",
                        )
                    } else {
                        e
                    };
                }
                network::Update::Art(id, img, backdrop) => {
                    backdrops.insert(id, backdrop);
                    if backdrop_id == Some(id) {
                        backdrop_id = None;
                    }
                    let mut t = tc
                        .create_texture_static(PixelFormatEnum::RGBA32, img.width(), img.height())
                        .map_err(|e| e.to_string())?;
                    t.update(None, &img, img.width() as usize * 4)
                        .map_err(|e| e.to_string())?;
                    art.insert(id, t);
                }
            }
        }
        while let Ok(reply) = guide_rx.try_recv() {
            p.guide.accept(reply);
        }
        if nav.page == Page::FullGuide {
            if demo_mode {
                p.guide.demo(&data);
            } else {
                p.guide.request(&guide_tx, &data);
            }
        } else if !demo_mode && window_visible && p.setup.is_none() && !launch.waiting {
            p.guide.prefetch(&guide_tx, &data);
        }
        nav.index = nav.index.min(data.channels.len().saturating_sub(1));
        if !demo_mode && fresh.elapsed() > Duration::from_secs(60) && !data.channels.is_empty() {
            status = "Offline · showing saved listings".into();
        }
        if let Some(session) = &mut lineup_session {
            let index = nav.playing_index.filter(|_| nav.page == Page::Player || (nav.page == Page::Guide && nav.guide_from_player)).unwrap_or(nav.index);
            let channel = if window_visible && p.setup.is_none() {
                data.channels.get(index).filter(|ch| ch.enabled && ch.on_air).map(|ch| ch.id.clone())
            } else { None };
            session.update(channel);
        }
        if let Some(server) = &playback_server {
            let desired = if p.setup.is_none() && window_visible {
                playback::target(server, &data, &nav, &client_id)
            } else {
                None
            };
            let unavailable = desired.is_none() && nav.page == Page::Player;
            player.update(desired, Instant::now());
            if p.video_channel.as_deref() != player.channel() {
                p.glass.clear_video();
            }
            #[cfg(all(
                feature = "webos",
                target_arch = "arm",
                not(feature = "desktop-player")
            ))]
            player.viewport(if nav.page == Page::Watch {
                Rect::new(990, 220, 800, 420)
            } else {
                Rect::new(0, 0, 1920, 1080)
            });
            player.poll(Instant::now(), |pixels| {
                if pixels.is_empty() {
                    return;
                }
                if (nav.player_controls || nav.guide_from_player)
                    && last_video_glass.elapsed() >= Duration::from_millis(200)
                {
                    p.glass.video_frame(pixels);
                    last_video_glass = Instant::now();
                }
                if p.video.is_none() {
                    p.video = tc
                        .create_texture_streaming(
                            PixelFormatEnum::RGBA32,
                            playback::WIDTH,
                            playback::HEIGHT,
                        )
                        .ok();
                }
                if let Some(t) = &mut p.video {
                    let _ = t.update(None, pixels, playback::WIDTH as usize * 4);
                }
            });
            p.video_channel = if player.has_frame {
                player.channel().map(str::to_owned)
            } else {
                None
            };
            p.playback_status = if unavailable {
                "This channel has no live stream available".into()
            } else {
                player.status.clone()
            };
        }
        if playback::is_waiting(&p.playback_status) {
            p.playback_wait += p.frame_dt.min(0.1);
        } else {
            p.playback_wait = 0.;
        }
        backdrops.retain(|id, _| art.contains_key(id));
        let selected_backdrop = data
            .channels
            .get(if nav.guide_from_player {
                nav.playing_index.unwrap_or(nav.index)
            } else {
                nav.index
            })
            .and_then(|ch| data.schedule(&ch.id))
            .and_then(|s| s.program.as_ref())
            .and_then(|p| p.media_id)
            .filter(|id| backdrops.contains_key(id));
        if selected_backdrop != backdrop_id {
            p.glass
                .set_backdrop(selected_backdrop.and_then(|id| backdrops.get(&id)));
            p.modal_texture = None;
            backdrop_id = selected_backdrop;
        }
        if displayed_page != nav.page || displayed_setup.is_some() != p.setup.is_some() {
            server_arrival = displayed_setup == Some(setup::Stage::Connected)
                && p.setup.is_none()
                && nav.page == Page::Watch;
            // Stage changes stay in place; track the last setup state separately below.
            displayed_page = nav.page;
            p.modal = motion::Spring::default();
            p.modal_texture = None;
            p.details_content = None;
            page_transition = true;
            transition_prepared = None;
            player_idle = 0.0;
            nav.player_controls = true;
            if nav.page == Page::Player {
                if p.guide_sheet.value == 0.0 {
                    p.player_open = motion::Spring::default();
                }
                p.player_bar = motion::Spring::default();
            }
            if nav.page == Page::Player {
                intro_texture = None;
            }
            if !p.reduced_motion && nav.page != Page::Player && !nav.guide_from_player {
                intro_texture = tc
                    .create_texture_target(PixelFormatEnum::RGBA8888, 1920, 1080)
                    .ok();
                intro_start = None;
                transition_elapsed = 0.0;
            }
        }
        displayed_setup = p.setup.as_ref().map(|s| s.stage);
        if !launch.waiting && launch.opacity == 1. && !p.reduced_motion {
            intro_texture = tc
                .create_texture_target(PixelFormatEnum::RGBA8888, 1920, 1080)
                .ok();
            intro_start = None;
            transition_elapsed = 0.;
            page_transition = false;
            transition_prepared = None;
        }
        if p.reduced_motion {
            intro_texture = None;
            server_arrival = false;
        }
        if !launch_sound_played && !launch.waiting && !data.channels.is_empty() {
            launch_sound_played = true;
            if window_visible && nav.page == Page::Watch {
                sounds.play(&sdl, sound::Cue::Launch, p.menu_sounds);
            }
        }
        launch.tick(p.frame_dt, p.reduced_motion);
        if let Some(scene) = intro_texture.as_mut() {
            p.arrival_layer = server_arrival || page_transition;
            p.tab_layer = page_transition && !server_arrival;
            // Rasterize an incoming tab once, then animate its texture. The live
            // page resumes after 180ms; key input already cancels this transition.
            if !page_transition || server_arrival || transition_prepared.is_none() {
            c.with_texture_canvas(scene, |target| {
                draw(
                    target,
                    &mut p,
                    &nav,
                    &data,
                    &art,
                    if demo_mode { "Demo mode" } else { &server },
                    &status,
                    fresh.elapsed().as_millis() as f64,
                );
            })
            .map_err(|e| e.to_string())?;
            }
            p.arrival_layer = false;
            p.tab_layer = false;
            if intro_start.is_none() {
                intro_start = Some(Instant::now());
                scene.set_blend_mode(sdl2::render::BlendMode::Blend);
            }
            let transparent = server_arrival || page_transition;
            let premultiplied = if page_transition && !server_arrival {
                if let Some(mode) = transition_prepared { mode } else {
                    let mode = composite::prepare(&mut c, scene, &tc, &mut straight_scene)?;
                    transition_prepared = Some(mode);
                    mode
                }
            } else if transparent {
                composite::prepare(&mut c, scene, &tc, &mut straight_scene)?
            } else { false };
            let scene = if transparent && !premultiplied {
                straight_scene.as_mut().unwrap()
            } else {
                scene
            };
            let seconds = intro_sample.unwrap_or_else(|| {
                if preview_dir.is_some() {
                    transition_elapsed
                } else {
                    intro_start.unwrap().elapsed().as_secs_f32()
                }
            });
            let amount = if page_transition {
                motion::page_entrance(seconds)
            } else {
                motion::entrance(seconds)
            };
            transition_elapsed += p.frame_dt;
            p.glass
                .background(&mut c, p.ambient_seconds, p.reduced_motion);
            if server_arrival {
                let name = p.arrival_name.clone();
                arrival::welcome(&mut c, &mut p, &name, (1. - seconds / 0.12).clamp(0., 1.));
                arrival::home(&mut c, scene, seconds, premultiplied)?;
                if seconds >= arrival::DURATION {
                    intro_texture = None;
                    server_arrival = false;
                }
            } else if page_transition {
                // Keep the navigation and background stationary; settle only page content.
                composite::opacity(scene, amount, premultiplied);
                c.copy(
                    scene,
                    Rect::new(0, 150, 1920, 930),
                    Rect::new(0, 150 + ((1. - amount) * 12.) as i32, 1920, 930),
                )?;
                draw_chrome(&mut c, &mut p, &nav);
                if amount >= 1. {
                    intro_texture = None;
                }
            } else {
                scene.set_alpha_mod((amount * 255.0) as u8);
                let scale = 0.985 + 0.015 * amount;
                let w = (1920.0 * scale) as u32;
                let h = (1080.0 * scale) as u32;
                c.copy(
                    scene,
                    None,
                    Rect::new(
                        (1920 - w) as i32 / 2,
                        (1080 - h) as i32 / 2 + ((1.0 - amount) * 12.0) as i32,
                        w,
                        h,
                    ),
                )?;
                if amount >= 1.0 {
                    intro_texture = None;
                }
            }
        } else {
            draw(
                &mut c,
                &mut p,
                &nav,
                &data,
                &art,
                if demo_mode { "Demo mode" } else { &server },
                &status,
                fresh.elapsed().as_millis() as f64,
            );
        }
        if launch.opacity > 0. {
            if let Some(texture) = loading_texture.as_mut() {
                c.with_texture_canvas(texture, |target| {
                    components::loading(target, &mut p, launch.seconds)
                })
                .map_err(|e| e.to_string())?;
                texture.set_blend_mode(sdl2::render::BlendMode::Blend);
                texture.set_alpha_mod((255. * launch.opacity) as u8);
                c.copy(texture, None, None)?;
            } else if launch.waiting {
                components::loading(&mut c, &mut p, launch.seconds);
            }
        } else {
            loading_texture = None;
        }
        c.present();
        measured_frames += 1;
        if measured_frames == 1 && measured_at.duration_since(boot).as_secs() < 10 {
            platform::diagnostic(&format!("first_present_ms={}", boot.elapsed().as_millis()));
        }
        if measured_at.elapsed().as_secs() >= 10 {
            platform::diagnostic(&format!(
                "frames={} interval_ms={} page={:?}",
                measured_frames,
                measured_at.elapsed().as_millis(),
                nav.page
            ));
            measured_frames = 0;
            measured_at = Instant::now();
        }
        if let Some(dir) = &preview_dir {
            if preview_frame % preview_stride == 0 {
                let pixels = c.read_pixels(None, PixelFormatEnum::RGB24)?;
                let (w, h) = c.output_size()?;
                let frame =
                    image::RgbImage::from_raw(w, h, pixels).ok_or("Invalid preview frame")?;
                image::imageops::resize(&frame, 960, 540, image::imageops::FilterType::Triangle)
                    .save(format!("{dir}/{:04}.png", preview_frame / preview_stride))
                    .map_err(|e| e.to_string())?;
            }
            preview_frame += 1;
            if preview_frame
                >= if tabs_preview {
                    340
                } else if setup_review {
                    510
                } else if setup_preview {
                    315
                } else if ambient_preview {
                    if preview_stride == 1 {
                        180
                    } else {
                        360
                    }
                } else if loading_preview {
                    245
                } else if timeline_preview {
                    270
                } else if guide_preview {
                    145
                } else if player_preview {
                    215
                } else if channel_preview {
                    180
                } else {
                    125
                }
            {
                break;
            }
        }
        if let Some(path) = &screenshot {
            if demo_mode || start.elapsed() > Duration::from_secs(12) {
                let pixels = c.read_pixels(None, PixelFormatEnum::RGB24)?;
                let (w, h) = c.output_size()?;
                image::save_buffer(path, &pixels, w, h, image::ColorType::Rgb8)
                    .map_err(|e| e.to_string())?;
                break;
            }
        }
        // Vsync may already have paced this frame; do not add another full frame of delay.
        if let Some(remaining) = Duration::from_micros(16_667).checked_sub(last_frame.elapsed()) {
            std::thread::sleep(remaining);
        }
    }
    Ok(())
}
