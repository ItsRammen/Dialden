//! Settings uses the same grouped surface and explicit focus as setup.
use crate::{
    components,
    model::{Key, Navigation, Page},
    Paint, INK, MUTED, WHITE,
};
use sdl2::{rect::Rect, render::Canvas, video::Window};
pub fn key(nav: &mut Navigation, key: Key, reduced: &mut bool, sounds: &mut bool) -> bool {
    if nav.page != Page::Settings {
        return false;
    }
    if nav.nav {
        if matches!(key, Key::Down | Key::Ok) {
            nav.nav = false;
            nav.action_index = 0;
            return true;
        }
        return false;
    }
    match key {
        Key::Up if nav.action_index > 0 => nav.action_index = 0,
        Key::Up | Key::Back => nav.nav = true,
        Key::Down => nav.action_index = 1,
        Key::Ok if nav.action_index == 1 => *sounds = !*sounds,
        Key::Ok => *reduced = !*reduced,
        _ => {}
    }
    true
}
pub fn draw(c: &mut Canvas<Window>, p: &mut Paint, nav: &Navigation, server: &str, status: &str) {
    p.title(c, "Settings", 100, 174, 52, 1600);
    p.label(
        c,
        "Your connection and viewing preferences",
        100,
        246,
        25,
        false,
        MUTED,
        1600,
    );
    p.label(c, "CONNECTION", 120, 338, 20, true, MUTED, 700);
    p.glass.sheet(c, Rect::new(100, 382, 810, 240));
    p.label(c, "Server", 128, 408, 26, true, WHITE, 740);
    p.label(c, server, 128, 450, 23, false, MUTED, 740);
    c.set_draw_color(sdl2::pixels::Color::RGBA(210, 220, 235, 24));
    let _ = c.draw_line((128, 497), (880, 497));
    p.label(c, "Connection status", 128, 516, 26, true, WHITE, 740);
    p.paragraph(c, status, 128, 558, 22, 740, 2);
    p.label(c, "PREFERENCES", 980, 338, 20, true, MUTED, 780);
    p.glass.sheet(c, Rect::new(960, 382, 860, 280));
    for (index, (title, enabled)) in [("Reduce motion", p.reduced_motion), ("Menu & launch sounds", p.menu_sounds)].into_iter().enumerate() {
        let y = 394 + index as i32 * 96;
        let focused = !nav.nav && nav.action_index == index;
        components::content_row(c, Rect::new(972, y, 836, 92), focused);
        let ink = if focused { INK } else { WHITE };
        p.label(c, title, 996, y + 22, 27, true, ink, 620);
        p.centered(c, if enabled { "On" } else { "Off" }, Rect::new(1660, y+16, 120, 52), 25, true, ink);
    }
    p.label(c, "Press OK to change · Applies to this session", 996, 616, 19, false, MUTED, 770);
    p.label(c, "ABOUT", 120, 700, 20, true, MUTED, 1600);
    p.label(c, "Dialden", 120, 746, 30, true, WHITE, 1600);
    p.paragraph(
        c,
        if cfg!(feature = "webos") { "Live channels, guide and muted channel previews" } else if cfg!(feature = "desktop-player") { "Live channels, guide and muted channel previews" } else { "Browsing build · Rebuild with desktop-player for live playback and muted channel previews." },
        120,
        798,
        25,
        1500,
        2,
    );
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_enters_toggles_and_returns_without_changing_tabs() {
        let mut nav = Navigation {
            page: Page::Settings,
            ..Default::default()
        };
        let mut reduced = false;
        let mut sounds = true;
        assert!(key(&mut nav, Key::Down, &mut reduced, &mut sounds));
        assert!(!nav.nav);
        key(&mut nav, Key::Ok, &mut reduced, &mut sounds);
        assert!(reduced);
        key(&mut nav, Key::Right, &mut reduced, &mut sounds);
        assert!(reduced);
        assert_eq!(nav.page, Page::Settings);
        key(&mut nav, Key::Down, &mut reduced, &mut sounds);
        key(&mut nav, Key::Ok, &mut reduced, &mut sounds);
        assert!(!sounds);
        assert!(reduced);
        key(&mut nav, Key::Back, &mut reduced, &mut sounds);
        assert!(nav.nav);
        assert!(!key(&mut nav, Key::Left, &mut reduced, &mut sounds));
    }
}
