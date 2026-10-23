//! Shared non-interactive status ornament. Never uses navigation focus styling.
use crate::{Paint, WHITE};
use sdl2::{pixels::Color, rect::Rect, render::Canvas, video::Window};

pub fn now_indicator(
    c: &mut Canvas<Window>,
    p: &mut Paint,
    label: &str,
    x: i32,
    chip_x: i32,
    y: i32,
) {
    let rest = Rect::new(450, y, 164, 36);
    let chip = Rect::new(chip_x, y, 164, 36);
    p.glass
        .draw_at(c, rest, chip, crate::glass::Material::Control);
    p.centered(c, label, chip, 20, true, WHITE);
    // A single feathered light bar marks the exact time; no trails or row marks.
    // Draw directly: this small ornament never allocates a moving glass texture.
    for dy in -6i32..=6 {
        for dx in -24..=24 {
            let falloff = (-((dx as f32 / 13.).powi(2) + (dy as f32 / 3.).powi(2))).exp();
            let core = if dy.abs() <= 1 {
                (1. - (dx as f32 / 15.).abs()).max(0.) * 64.
            } else {
                0.
            };
            let alpha = (falloff * 30. + core) as u8;
            let px = x + dx;
            if alpha > 0 && (450..1820).contains(&px) {
                c.set_draw_color(Color::RGBA(175, 214, 216, alpha));
                let _ = c.draw_point((px, y + 44 + dy));
            }
        }
    }
}

/// Content stays matte; only interactive chrome uses optical glass.
pub fn content_row(c: &mut Canvas<Window>, r: Rect, focused: bool) {
    crate::rounded_panel(
        c,
        r,
        if focused {
            crate::style::FOCUS
        } else {
            crate::style::CONTENT
        },
        crate::style::CELL_RADIUS,
    );
}
pub fn content_card(c: &mut Canvas<Window>, r: Rect, focused: bool) {
    crate::rounded_panel(
        c,
        r,
        if focused {
            crate::style::FOCUS
        } else {
            crate::style::CONTENT
        },
        crate::style::PANEL_RADIUS,
    );
}
pub fn playback_button(c: &mut Canvas<Window>, p: &mut Paint, text: &str, r: Rect, focused: bool) {
    crate::rounded_panel(
        c,
        r,
        if focused {
            crate::style::FOCUS
        } else {
            Color::RGBA(220, 232, 249, 30)
        },
        36,
    );
    p.centered(
        c,
        text,
        r,
        23,
        true,
        if focused { crate::INK } else { WHITE },
    );
}
pub fn navigation(c: &mut Canvas<Window>, p: &mut Paint, nav: &crate::model::Navigation) {
    use crate::{glass::Material, model::Page};
    crate::surface(c, p, Rect::new(642, 47, 636, 62), Material::Control);
    let target = match nav.page {
        Page::Watch => 0.,
        Page::Settings => 2.,
        _ => 1.,
    };
    let position = p
        .focus
        .entry("navigation-position".into())
        .or_insert_with(|| crate::motion::Spring::at(target))
        .step(target, p.frame_dt, p.reduced_motion);
    crate::rounded_panel(
        c,
        Rect::new(648 + (position * 208.).round() as i32, 53, 208, 50),
        if nav.nav {
            crate::style::FOCUS
        } else {
            Color::RGBA(235, 241, 250, 28)
        },
        31,
    );
    for (i, (label, _page)) in [
        ("Watch now", Page::Watch),
        ("Guide", Page::FullGuide),
        ("Settings", Page::Settings),
    ]
    .iter()
    .enumerate()
    {
        let x = 648 + (i * 208) as i32;
        let width = 208;
        let r = Rect::new(x, 53, width, 50);
        p.centered(
            c,
            label,
            r,
            23,
            true,
            if nav.nav && (i as f32 - position).abs() < 0.5 {
                crate::INK
            } else {
                WHITE
            },
        );
    }
}
#[derive(Clone, PartialEq)]
pub struct Details {
    pub channel: String,
    pub title: String,
    pub timing: String,
    pub episode: String,
    pub metadata: crate::model::ProgramMetadata,
    pub status: String,
    pub back: String,
}
fn details_body(c: &mut Canvas<Window>, p: &mut Paint, d: &Details) {
    p.glass.sheet(c, Rect::new(450, 258, 1020, 564));
    p.label(c, &d.channel, 510, 302, 26, false, crate::MUTED, 900);
    p.title(c, &d.title, 510, 358, 46, 900);
    p.label(
        c,
        &format!("{} · {}", d.status, d.timing),
        510,
        478,
        24,
        false,
        WHITE,
        900,
    );
    p.label(c, &d.episode, 510, 516, 24, false, crate::MUTED, 900);
    p.label(
        c,
        &d.metadata.facts(),
        510,
        552,
        21,
        false,
        crate::MUTED,
        900,
    );
    let overview = if d.metadata.overview.is_empty() {
        "No description available.".into()
    } else if d.metadata.overview_scope == "show" {
        format!("About the show: {}", d.metadata.overview)
    } else {
        d.metadata.overview.clone()
    };
    p.paragraph(c, &overview, 510, 589, 23, 900, 2);
    // An inset action on the sheet, not another glass surface.
    playback_button(c, p, &d.back, Rect::new(510, 687, 300, 73), true);
}
pub fn details(c: &mut Canvas<Window>, p: &mut Paint, requested: Option<Details>) {
    use sdl2::pixels::PixelFormatEnum;
    let open = requested.is_some();
    if let Some(d) = requested {
        if p.details_content.as_ref() != Some(&d) {
            p.modal_texture = None;
            p.details_content = Some(d);
        }
    }
    let amount = p
        .modal
        .step(if open { 1. } else { 0. }, p.frame_dt, p.reduced_motion)
        .clamp(0., 1.);
    if amount <= 0.001 {
        if !open {
            p.modal_texture = None;
            p.details_content = None;
        }
        return;
    }
    let Some(d) = p.details_content.clone() else {
        return;
    };
    if p.modal_texture.is_none() {
        if let Ok(mut texture) =
            p.textures
                .create_texture_target(PixelFormatEnum::RGBA8888, 1920, 1080)
        {
            if c.with_texture_canvas(&mut texture, |target| {
                target.set_draw_color(Color::RGBA(0, 0, 0, 0));
                target.clear();
                details_body(target, p, &d);
            })
            .is_ok()
            {
                texture.set_blend_mode(sdl2::render::BlendMode::Blend);
                p.modal_texture = Some(texture);
            }
        }
    }
    c.set_draw_color(Color::RGBA(0, 0, 0, (145. * amount) as u8));
    let _ = c.fill_rect(Rect::new(0, 0, 1920, 1080));
    if let Some(texture) = p.modal_texture.as_mut() {
        texture.set_alpha_mod((255. * amount) as u8);
        let w = (1020. * (0.98 + 0.02 * amount)) as u32;
        let h = (564. * (0.98 + 0.02 * amount)) as u32;
        let dest = Rect::new(
            (1920 - w) as i32 / 2,
            (1080 - h) as i32 / 2 + ((1. - amount) * 20.) as i32,
            w,
            h,
        );
        let _ = c.copy(texture, Rect::new(450, 258, 1020, 564), dest);
    } else {
        details_body(c, p, &d);
    }
}

/// One Now/Up Next row for full-page and playback-overlay guides.
pub fn channel_guide_row(
    c: &mut Canvas<Window>,
    p: &mut Paint,
    r: Rect,
    channel: &crate::model::Channel,
    schedule: Option<&crate::model::Schedule>,
    focused: bool,
    playing: bool,
) {
    content_row(c, r, focused);
    let fg = if focused { crate::INK } else { WHITE };
    let sub = if focused {
        Color::RGB(75, 84, 104)
    } else {
        crate::MUTED
    };
    let y = r.y();
    p.label(c, &channel.name, 140, y + 13, 25, true, fg, 355);
    if playing {
        p.label(c, "Playing", 140, y + 47, 18, false, sub, 355);
    }
    for (x, program, fallback, width) in [
        (
            520,
            schedule.and_then(|s| s.program.as_ref()),
            "Off air",
            650,
        ),
        (
            1210,
            schedule.and_then(|s| s.next.as_ref()),
            "Not scheduled",
            560,
        ),
    ] {
        p.label(
            c,
            program.map(|v| v.heading()).unwrap_or(fallback),
            x,
            y + 13,
            25,
            true,
            fg,
            width,
        );
        if let Some(program) = program {
            p.label(c, &program.subtitle(), x, y + 47, 19, false, sub, width);
        }
    }
}

/// Startup is a quiet content layer; glass is reserved for the small tuning mark.
pub fn loading(c: &mut Canvas<Window>, p: &mut Paint, seconds: f32) {
    c.set_draw_color(Color::RGB(12, 14, 23));
    c.clear();
    p.glass.loading_background(c, seconds, p.reduced_motion);
    p.centered(c, "dialden", Rect::new(560, 420, 800, 100), 76, true, WHITE);
    p.centered(
        c,
        "Your channels. A moment away.",
        Rect::new(400, 536, 1120, 46),
        27,
        false,
        crate::MUTED,
    );
    // Delay activity feedback so quick launches remain quiet. Fade in without moving text.
    let reveal = crate::motion::loading_feedback(seconds);
    if reveal > 0. {
        for i in 0..3 {
            let pulse = if p.reduced_motion {
                0.65
            } else {
                0.55 + 0.25 * ((seconds - 3.) * 2.4 - i as f32 * 0.8).sin()
            };
            crate::rounded_panel(
                c,
                Rect::new(936 + i * 20, 630, 8, 8),
                Color::RGBA(220, 230, 244, (190. * reveal * pulse) as u8),
                4,
            );
        }
    }
    // Keep routine loading silent. A slow connection gets a discreet explanation.
    if seconds > 8. {
        p.centered(
            c,
            "Still connecting…",
            Rect::new(400, 720, 1120, 36),
            21,
            false,
            crate::MUTED,
        );
    }
    let control = Rect::new(810, 930, 300, 60);
    p.glass.draw(
        c,
        control,
        if p.loading_connection_focus {
            crate::glass::Material::FocusedControl
        } else {
            crate::glass::Material::Control
        },
    );
    p.centered(
        c,
        "↩  Connection",
        control,
        23,
        false,
        if p.loading_connection_focus {
            crate::INK
        } else {
            crate::MUTED
        },
    );
}

/// Shared remote-help footer for top-level pages, including empty states.
pub fn navigation_help(c: &mut Canvas<Window>, p: &mut Paint, hints: &[(&str, &str)], note: &str) {
    navigation_help_at(c, p, hints, 100, 1006);
    p.label(c, note, 1300, 1009, 21, false, crate::MUTED, 530);
}

/// The same remote keycaps inside an animated overlay.
pub fn navigation_help_at(
    c: &mut Canvas<Window>,
    p: &mut Paint,
    hints: &[(&str, &str)],
    mut x: i32,
    y: i32,
) {
    for (key, label) in hints.iter().filter(|(_, label)| !label.is_empty()) {
        crate::rounded_panel(
            c,
            Rect::new(x, y, 48, 31),
            Color::RGBA(224, 238, 255, 25),
            crate::style::PANEL_RADIUS,
        );
        p.centered(c, key, Rect::new(x, y, 48, 31), 18, true, WHITE);
        p.label(c, label, x + 61, y + 3, 21, false, crate::MUTED, 220);
        let width: f32 = label
            .chars()
            .map(|ch| p.font.metrics(ch, 21.).advance_width)
            .sum();
        x += 85 + width.ceil().min(220.) as i32;
    }
}

/// Quiet activity, separate from focus. Brief cache transitions remain invisible.
pub fn playback_activity(c: &mut Canvas<Window>, p: &mut Paint, x: i32, y: i32) {
    // No surrounding plaque: the three softly pulsing points are sufficient.
    for i in 0..3 {
        let alpha = if p.reduced_motion {
            160
        } else {
            (90. + 140. * (0.5 + 0.5 * (p.ambient_seconds * 3.2 - i as f32 * 0.8).sin())) as u8
        };
        crate::rounded_panel(
            c,
            Rect::new(x + 23 + i * 17, y + 16, 7, 7),
            Color::RGBA(240, 247, 255, alpha),
            4,
        );
    }
}
