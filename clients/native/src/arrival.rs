//! One-time server arrival. Ordinary tab changes never use this choreography.
use crate::{Paint, MUTED, WHITE};
use sdl2::{
    rect::Rect,
    render::{Canvas, Texture},
    video::Window,
};
pub const DURATION: f32 = 1.15;
pub fn reveal(seconds: f32, delay: f32) -> f32 {
    let t = ((seconds - delay) / 0.65).clamp(0., 1.);
    1. - (1. - t).powi(3)
}
pub fn welcome(c: &mut Canvas<Window>, p: &mut Paint, name: &str, opacity: f32) {
    let alpha = (opacity.clamp(0., 1.) * 255.) as u8;
    let mut white = WHITE;
    white.a = alpha;
    let mut muted = MUTED;
    muted.a = alpha;
    p.centered(c, name, Rect::new(200, 425, 1520, 90), 60, true, white);
    p.centered(
        c,
        "Your channels are ready",
        Rect::new(200, 530, 1520, 48),
        27,
        false,
        muted,
    );
}
pub fn home(
    c: &mut Canvas<Window>,
    scene: &mut Texture,
    seconds: f32,
    premultiplied: bool,
) -> Result<(), String> {
    let mut part = |r: Rect, delay: f32, rise: f32| -> Result<(), String> {
        let amount = reveal(seconds, delay);
        if amount <= 0. {
            return Ok(());
        }
        crate::composite::opacity(scene, amount, premultiplied);
        c.copy(
            scene,
            r,
            Rect::new(
                r.x(),
                r.y() + ((1. - amount) * rise).round() as i32,
                r.width(),
                r.height(),
            ),
        )
    };
    // Non-overlapping transparent regions: navigation, feature, row label, cards, hints.
    part(Rect::new(0, 0, 1920, 150), 0.08, 12.)?;
    part(Rect::new(0, 150, 1920, 550), 0.16, 24.)?;
    part(Rect::new(0, 700, 1920, 80), 0.28, 16.)?;
    for slot in 0..5 {
        part(
            Rect::new(90 + slot * 346, 780, 346, 195),
            0.32 + slot as f32 * 0.045,
            30.,
        )?;
    }
    part(Rect::new(0, 975, 1920, 105), 0.4, 8.)?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arrivals_are_monotonic_bounded_and_all_finish() {
        for delay in [0.08, 0.16, 0.28, 0.32, 0.5] {
            assert_eq!(reveal(0., delay), 0.);
            assert_eq!(reveal(DURATION, delay), 1.);
            let mut previous = 0.;
            for frame in 0..70 {
                let value = reveal(frame as f32 / 60., delay);
                assert!(value >= previous && value <= 1.);
                previous = value;
            }
        }
    }
}
