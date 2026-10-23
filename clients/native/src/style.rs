//! Shared tokens for LIQUID_GLASS_STANDARD.md. Logical pixels at 1920×1080.
use sdl2::pixels::Color;
pub const TEXT: Color = Color::RGB(246, 247, 251);
pub const SECONDARY: Color = Color::RGB(190, 196, 207);
pub const INK: Color = Color::RGB(25, 29, 36);
pub const PANEL_RADIUS: i32 = 24;
pub const CELL_RADIUS: i32 = 12;
pub const CONTROL_RADIUS: f32 = 36.;
pub const CELL: Color = Color::RGBA(160, 170, 190, 22);
pub const SEPARATOR: Color = Color::RGBA(220, 230, 245, 22);
pub const FOCUS: Color = Color::RGB(234, 239, 246);
pub const GLASS_TINT: [f32; 3] = [103., 110., 123.];
pub const GLASS_DENSITY: f32 = 0.16;
pub const FOCUS_DENSITY: f32 = 0.82;

// The guide reserves separate bands for its subtitle, status, ruler and content.
pub const GUIDE_STATUS_Y: i32 = 294;
pub const GUIDE_RULER_Y: i32 = 360;
pub const GUIDE_ROWS_Y: i32 = 406;
pub const GUIDE_ROW_STRIDE: i32 = 100;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn guide_header_bands_and_summary_have_clearance() {
        assert!(GUIDE_STATUS_Y >= 246 + 25 + 16);
        assert!(GUIDE_STATUS_Y + 44 + 6 + 12 <= GUIDE_RULER_Y);
        assert!(GUIDE_RULER_Y + 23 + 16 <= GUIDE_ROWS_Y);
        assert!(GUIDE_ROWS_Y + 4 * GUIDE_ROW_STRIDE + 98 + 24 <= 936);
    }
}

pub const CONTENT: Color = Color::RGBA(145, 159, 182, 24);
