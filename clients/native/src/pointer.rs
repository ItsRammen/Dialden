//! Pointer hit targets use the same logical coordinates and actions as remote focus.
use crate::{
    guide,
    model::{Navigation, Page},
    style,
};
use sdl2::rect::Rect;

pub fn focus(nav: &mut Navigation, guide: &mut guide::State, count: usize, x: i32, y: i32) -> bool {
    let hit = |r: Rect| r.contains_point((x, y));
    if nav.quit_confirm {
        for (index, r) in [Rect::new(560, 560, 380, 64), Rect::new(980, 560, 380, 64)].into_iter().enumerate() {
            if hit(r) { nav.quit_selected = index == 1; return true; }
        }
        return false;
    }
    if nav.modal || guide.detail.is_some() {
        return hit(Rect::new(510, 687, 300, 73));
    }
    if nav.page != Page::Player && !nav.guide_from_player && hit(Rect::new(642, 47, 636, 62)) {
        let previous = nav.clone();
        nav.page =
            [Page::Watch, Page::FullGuide, Page::Settings][((x - 642) / 212).clamp(0, 2) as usize];
        nav.nav = true;
        nav.actions = false;
        if nav.page == Page::FullGuide && previous.page != Page::FullGuide {
            guide.enter(previous);
        }
        return true;
    }
    if nav.guide_from_player {
        if hit(Rect::new(1450, 337, 340, 62)) {
            nav.overlay_button = true;
            return true;
        }
        if hit(Rect::new(115, 460, 1690, 455)) {
            let slot = ((y - 460) / 91) as usize;
            if (y - 460) % 91 >= 78 {
                return false;
            }
            let index = nav.index.saturating_sub(3) + slot;
            if index < count {
                nav.index = index;
                nav.overlay_button = false;
                return true;
            }
        }
        return false;
    }
    match nav.page {
        Page::Watch => {
            if hit(Rect::new(100, 540, 251, 68)) {
                nav.nav = false;
                nav.actions = true;
                nav.action_index = 0;
                return true;
            }
            if hit(Rect::new(100, 794, 1704, 159)) {
                let slot = ((x - 100) / 346) as usize;
                if (x - 100) % 346 >= 320 {
                    return false;
                }
                let index = nav.index.saturating_sub(3) + slot;
                if index < count {
                    nav.nav = false;
                    nav.actions = false;
                    nav.index = index;
                    return true;
                }
            }
        }
        Page::FullGuide => {
            if hit(Rect::new(450, style::GUIDE_ROWS_Y, 1370, 500)) {
                let index =
                    nav.index.saturating_sub(4) + ((y - style::GUIDE_ROWS_Y) / 100) as usize;
                if index < count {
                    nav.index = index;
                    nav.nav = false;
                    guide.cursor = guide.from + ((x - 450) as i64 * guide::WINDOW / 1370);
                    return true;
                }
            }
        }
        Page::Settings => {
            if hit(Rect::new(972, 394, 836, 188)) {
                nav.action_index = ((y - 394) / 96) as usize;
                nav.nav = false;
                return true;
            }
        }
        Page::Player => {
            nav.player_controls = true;
            for (index, r) in [Rect::new(1360, 858, 428, 54), Rect::new(1360, 924, 428, 54)]
                .into_iter()
                .enumerate()
            {
                if hit(r) {
                    nav.action_index = index;
                    return true;
                }
            }
        }
        _ => {}
    }
    false
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pointer_focus_uses_remote_actions_and_ignores_card_gaps() {
        let mut nav = Navigation::default();
        let mut g = guide::State::default();
        assert!(focus(&mut nav, &mut g, 7, 480, 850));
        assert_eq!(nav.index, 1);
        assert!(!nav.nav);
        assert!(!focus(&mut nav, &mut g, 7, 430, 850));
        assert!(!focus(&mut nav, &mut g, 7, 500, 570));
        assert!(focus(&mut nav, &mut g, 7, 200, 570));
        assert!(nav.actions);
        assert_eq!(nav.action_index, 0);
        assert!(focus(&mut nav, &mut g, 7, 1170, 80));
        assert_eq!(nav.page, Page::Settings);
    }
    #[test]
    fn modal_prevents_clicking_underlying_navigation() {
        let mut nav = Navigation::default();
        nav.modal = true;
        let mut g = guide::State::default();
        assert!(!focus(&mut nav, &mut g, 7, 1170, 80));
        assert!(focus(&mut nav, &mut g, 7, 600, 720));
    }
}
