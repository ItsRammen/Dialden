//! Render targets contain premultiplied RGB. Do not multiply their alpha twice.
use sdl2::{
    pixels::PixelFormatEnum,
    render::{BlendMode, Canvas, Texture, TextureCreator},
    video::{Window, WindowContext},
};

pub fn straight_alpha(pixels: &mut [u8]) {
    for pixel in pixels.chunks_exact_mut(4) {
        let a = pixel[3] as u32;
        if a == 0 {
            pixel[..3].fill(0);
        } else {
            for channel in &mut pixel[..3] {
                *channel = ((*channel as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
}
pub fn prepare<'a>(
    c: &mut Canvas<Window>,
    scene: &mut Texture<'a>,
    creator: &'a TextureCreator<WindowContext>,
    fallback: &mut Option<Texture<'a>>,
) -> Result<bool, String> {
    use sdl2::sys::{self, SDL_BlendFactor::*, SDL_BlendOperation::*};
    // SAFETY: scene is a live SDL texture; these functions neither retain nor free it.
    let supported = unsafe {
        let mode = sys::SDL_ComposeCustomBlendMode(
            SDL_BLENDFACTOR_ONE,
            SDL_BLENDFACTOR_ONE_MINUS_SRC_ALPHA,
            SDL_BLENDOPERATION_ADD,
            SDL_BLENDFACTOR_ONE,
            SDL_BLENDFACTOR_ONE_MINUS_SRC_ALPHA,
            SDL_BLENDOPERATION_ADD,
        );
        sys::SDL_SetTextureBlendMode(scene.raw(), mode) == 0
    };
    if supported {
        return Ok(true);
    }
    // SDL's software preview renderer may lack custom blending. Convert only this
    // short transition; GPU renderers use the texture directly with no readback.
    let mut pixels = Err("Render target readback failed".to_string());
    c.with_texture_canvas(scene, |target| {
        pixels = target.read_pixels(None, PixelFormatEnum::RGBA32);
    })
    .map_err(|e| e.to_string())?;
    let mut pixels = pixels?;
    straight_alpha(&mut pixels);
    let q = scene.query();
    if fallback.is_none() {
        *fallback = Some(
            creator
                .create_texture_streaming(PixelFormatEnum::RGBA32, q.width, q.height)
                .map_err(|e| e.to_string())?,
        );
    }
    let texture = fallback.as_mut().unwrap();
    texture
        .update(None, &pixels, q.width as usize * 4)
        .map_err(|e| e.to_string())?;
    texture.set_blend_mode(BlendMode::Blend);
    Ok(false)
}
pub fn opacity(texture: &mut Texture, amount: f32, premultiplied: bool) {
    let value = (amount.clamp(0., 1.) * 255.).round() as u8;
    texture.set_alpha_mod(value);
    let rgb = if premultiplied { value } else { 255 };
    texture.set_color_mod(rgb, rgb, rgb);
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn translucent_panel_survives_render_target_round_trip() {
        let original = [145u32, 159, 182];
        let alpha = 24u32;
        let mut pixel = [0, 0, 0, alpha as u8];
        for i in 0..3 {
            pixel[i] = (original[i] * alpha / 255) as u8;
        }
        straight_alpha(&mut pixel);
        for i in 0..3 {
            let direct = original[i] * alpha / 255;
            let through_target = pixel[i] as u32 * alpha / 255;
            assert!(direct.abs_diff(through_target) <= 1);
        }
        let mut edge = [22, 30, 40, 0, 100, 120, 140, 255];
        straight_alpha(&mut edge);
        assert_eq!(edge, [0, 0, 0, 0, 100, 120, 140, 255]);
    }
}
