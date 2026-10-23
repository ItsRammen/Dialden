//! Cached glass compositing over the app's ambient wallpaper. This does not sample video.
use sdl2::{
    pixels::PixelFormatEnum,
    rect::Rect,
    render::{Canvas, Texture, TextureCreator},
    video::{Window, WindowContext},
};
use std::collections::HashMap;
/// Prepared on the network thread so decoding/blur never blocks remote input.
pub struct Backdrop {
    image: image::RgbaImage,
    blurred: image::RgbaImage,
}
impl Backdrop {
    pub fn from_image(source: &image::DynamicImage) -> Self {
        let mut image = source
            .resize_to_fill(960, 540, image::imageops::FilterType::Triangle)
            .to_rgba8();
        for (x, _, pixel) in image.enumerate_pixels_mut() {
            // Bound bright artwork so secondary text remains readable across the canvas.
            let shade = 0.16 + 0.10 * x as f32 / 960.0;
            for i in 0..3 {
                pixel[i] = (pixel[i] as f32 * shade) as u8;
            }
            pixel[3] = 255;
        }
        let blurred = image::imageops::blur(&image, 14.0);
        Self { image, blurred }
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Material {
    Control,
    FocusedControl,
    Sheet,
}
pub struct Glass<'a> {
    video_blur: Option<image::RgbaImage>,
    video_surfaces: HashMap<String, Texture<'a>>,
    creator: &'a TextureCreator<WindowContext>,
    ambient: Texture<'a>,
    #[cfg(not(feature = "webos"))]
    ribbon: Texture<'a>,
    #[cfg(feature = "webos")]
    tv_ribbons: [Texture<'a>; 2],
    still: Option<Texture<'a>>,
    still_blur: Option<image::RgbaImage>,
    blurred: image::RgbaImage,
    surfaces: HashMap<String, Texture<'a>>,
}
fn texture<'a>(creator: &'a TextureCreator<WindowContext>, img: &image::RgbaImage) -> Texture<'a> {
    let mut t = creator
        .create_texture_static(PixelFormatEnum::RGBA32, img.width(), img.height())
        .unwrap();
    t.update(None, img, img.width() as usize * 4).unwrap();
    t.set_blend_mode(sdl2::render::BlendMode::Blend);
    t
}
impl<'a> Glass<'a> {
    pub fn new(creator: &'a TextureCreator<WindowContext>) -> Self {
        let begin = std::time::Instant::now();
        // A precomputed soft light field: motion only changes the texture crop.
        // No per-frame image generation, blur, allocation or glass-cache churn.
        let ambient = image::load_from_memory(include_bytes!("../assets/ambient.png"))
            .expect("embedded ambient")
            .to_rgba8();
        let blurred = image::load_from_memory(include_bytes!("../assets/ambient-blur.png"))
            .expect("embedded ambient blur")
            .to_rgba8();
        // Soft translucent fabric with a fine luminous fold, stretched along a live mesh.
        let band = image::RgbaImage::from_fn(2, 256, |_, y| {
            let v = y as f32 / 255.;
            let body = (std::f32::consts::PI * v).sin().max(0.).powf(1.4);
            let fold = (-((v - 0.32) / 0.025).powi(2)).exp();
            image::Rgba([105, 151, 191, (body * 28. + fold * 48.) as u8])
        });
        #[cfg(not(feature = "webos"))]
        let ribbon = {
            let mut ribbon = texture(creator, &band);
            ribbon.set_scale_mode(sdl2::render::ScaleMode::Linear);
            ribbon
        };
        #[cfg(feature = "webos")]
        let tv_ribbons = [220u16, 100].map(|alpha| {
            let mut layer = band.clone();
            for pixel in layer.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * alpha / 255) as u8;
            }
            texture(creator, &layer)
        });
        crate::platform::diagnostic(&format!("glass_ready_ms={}", begin.elapsed().as_millis()));
        Self {
            video_blur: None,
            video_surfaces: HashMap::new(),
            #[cfg(not(feature = "webos"))]
            ribbon,
            #[cfg(feature = "webos")]
            tv_ribbons,
            ambient: texture(creator, &ambient),
            creator,
            still: None,
            still_blur: None,
            blurred,
            surfaces: HashMap::new(),
        }
    }
    pub fn loading_background(&self, c: &mut Canvas<Window>, seconds: f32, reduced: bool) {
        let _ = c.copy(&self.ambient, None, Rect::new(0, 0, 1920, 1080));
        // Firmware SDL can predate RenderGeometryRaw (SDL 2.0.18). Draw the same
        // ribbon shape in narrow texture strips using the original SDL2 API.
        #[cfg(feature = "webos")]
        for layer in 0..2 {
            for x in (0..1920).step_by(8) {
                let (centre, width) =
                    crate::motion::ribbon_shape((x as f32 + 4.) / 1920., seconds, layer, reduced);
                let rect = Rect::new(
                    x,
                    (centre - width / 2.).round() as i32,
                    8,
                    width.round().max(1.) as u32,
                );
                let _ = c.copy(&self.tv_ribbons[layer], None, rect);
            }
        }
        #[cfg(not(feature = "webos"))]
        {
            use sdl2::{pixels::Color, rect::FPoint, render::Vertex};
            // Fixed-size stack buffers: only the mesh moves, with no per-frame blur or texture upload.
            const N: usize = 96;
            let blank = Vertex {
                position: FPoint::new(0., 0.),
                color: Color::RGBA(255, 255, 255, 255),
                tex_coord: FPoint::new(0., 0.),
            };
            let mut vertices = [blank; (N + 1) * 2];
            let mut indices = [0u16; N * 6];
            for layer in 0..2 {
                for i in 0..=N {
                    let u = i as f32 / N as f32;
                    let (centre, width) = crate::motion::ribbon_shape(u, seconds, layer, reduced);
                    for edge in 0..2 {
                        vertices[i * 2 + edge] = Vertex {
                            position: FPoint::new(u * 1920., centre + (edge as f32 - 0.5) * width),
                            color: Color::RGBA(255, 255, 255, if layer == 0 { 220 } else { 100 }),
                            tex_coord: FPoint::new(u, edge as f32),
                        };
                    }
                }
                for i in 0..N {
                    let a = (i * 2) as u16;
                    indices[i * 6..i * 6 + 6].copy_from_slice(&[
                        a,
                        a + 1,
                        a + 2,
                        a + 1,
                        a + 3,
                        a + 2,
                    ]);
                }
                let _ = c.render_geometry(&vertices, Some(&self.ribbon), &indices[..]);
            }
        }
    }

    // Refresh at most five times a second while controls are visible. No GPU readback.
    pub fn video_frame(&mut self, pixels: &[u8]) {
        if let Some(frame) = image::RgbaImage::from_raw(
            crate::playback::WIDTH,
            crate::playback::HEIGHT,
            pixels.to_vec(),
        ) {
            let small =
                image::imageops::resize(&frame, 240, 135, image::imageops::FilterType::Triangle);
            self.video_blur = Some(image::imageops::blur(&small, 2.5));
            self.video_surfaces.clear();
        }
    }
    pub fn clear_video(&mut self) {
        self.video_blur = None;
        self.video_surfaces.clear();
    }
    pub fn live_sheet(&mut self, c: &mut Canvas<Window>, rest: Rect, dest: Rect) {
        self.live_material(c, rest, dest, false);
    }
    pub fn live_controls(&mut self, c: &mut Canvas<Window>, rest: Rect, dest: Rect) {
        self.live_material(c, rest, dest, true);
    }
    fn live_material(&mut self, c: &mut Canvas<Window>, rest: Rect, dest: Rect, light: bool) {
        let key = format!("{rest:?}:{light}");
        if !self.video_surfaces.contains_key(&key) {
            if self.video_surfaces.len() >= 12 {
                self.video_surfaces.clear();
            }
            let w = rest.width();
            let h = rest.height();
            // Quarter-resolution optical layer, sampled in screen space from the decoded video.
            let scale = if light { 2 } else { 4 };
            let img = image::RgbaImage::from_fn((w / scale).max(1), (h / scale).max(1), |x, y| {
                let px = (x as f32 + 0.5) * scale as f32;
                let py = (y as f32 + 0.5) * scale as f32;
                let radius = 28f32.min(h as f32 / 2.);
                let qx = (px - w as f32 / 2.).abs() - (w as f32 / 2. - radius);
                let qy = (py - h as f32 / 2.).abs() - (h as f32 / 2. - radius);
                let d =
                    (qx.max(0.).powi(2) + qy.max(0.).powi(2)).sqrt() + qx.max(qy).min(0.) - radius;
                let mask = (0.5 - d / scale as f32).clamp(0., 1.);
                let rim = (1. - d.abs() / if light { 2.0 } else { 5.0 }).max(0.);
                let sample = self.video_blur.as_ref().map(|im| {
                    im.get_pixel(
                        ((rest.x() as f32 + px) / 8.).clamp(0., 239.) as u32,
                        ((rest.y() as f32 + py) / 8.).clamp(0., 134.) as u32,
                    )
                });
                let mut out = [0u8; 4];
                for i in 0..3 {
                    out[i] = if let Some(s) = sample {
                        (s[i] as f32 * 0.50 + 8. + rim * 35.).min(255.) as u8
                    } else {
                        (18. + i as f32 * 4. + rim * 65.) as u8
                    };
                }
                let opacity = if light {
                    if sample.is_some() { 205. } else { 155. }
                } else if sample.is_some() { 222. } else { 130. };
                out[3] = (opacity * mask) as u8;
                image::Rgba(out)
            });
            #[allow(unused_mut)]
            let mut layer = texture(self.creator, &img);
            #[cfg(not(feature = "webos"))]
            layer.set_scale_mode(sdl2::render::ScaleMode::Linear);
            self.video_surfaces.insert(key.clone(), layer);
        }
        let _ = c.copy(&self.video_surfaces[&key], None, dest);
    }

    pub fn set_backdrop(&mut self, backdrop: Option<&Backdrop>) {
        self.still = backdrop.map(|b| texture(self.creator, &b.image));
        self.still_blur = backdrop.map(|b| b.blurred.clone());
        self.surfaces.clear();
    }
    pub fn background(&self, c: &mut Canvas<Window>, seconds: f32, reduced: bool) {
        if let Some(still) = &self.still {
            // Only the dimmed backdrop moves; programme art and foreground UI stay still.
            let (x, y) = crate::motion::ambient_offset(seconds, reduced);
            let dx = if reduced { 0 } else { (x - 96) / 5 };
            let dy = if reduced { 0 } else { (y - 54) / 5 };
            let _ = c.copy(still, None, Rect::new(-32 + dx, -18 + dy, 1984, 1116));
        } else {
            self.loading_background(c, seconds, reduced);
        }
    }
    pub fn draw(&mut self, c: &mut Canvas<Window>, r: Rect, material: Material) {
        self.draw_at(c, r, r, material);
    }
    // Moving surfaces reuse their resting texture rather than regenerate glass each frame.
    pub fn draw_at(
        &mut self,
        c: &mut Canvas<Window>,
        r: Rect,
        destination: Rect,
        material: Material,
    ) {
        self.material(c, r, destination, material);
    }
    pub fn sheet(&mut self, c: &mut Canvas<Window>, r: Rect) {
        self.material(c, r, r, Material::Sheet);
    }
    fn material(&mut self, c: &mut Canvas<Window>, r: Rect, destination: Rect, material: Material) {
        let sheet = material == Material::Sheet;
        let key = format!("{r:?}/{material:?}");
        if !self.surfaces.contains_key(&key) {
            if self.surfaces.len() >= 64 {
                self.surfaces.clear();
            }
            let w = r.width();
            let h = r.height();
            let radius = (if sheet {
                32.
            } else {
                crate::style::CONTROL_RADIUS
            })
            .min(w as f32 / 2.)
            .min(h as f32 / 2.);
            let focused = material == Material::FocusedControl;

            let img = image::RgbaImage::from_fn(w, h, |x, y| {
                let px = x as f32 + 0.5;
                let py = y as f32 + 0.5;
                let qx = (px - w as f32 / 2.).abs() - (w as f32 / 2. - radius);
                let qy = (py - h as f32 / 2.).abs() - (h as f32 / 2. - radius);
                let d =
                    (qx.max(0.).powi(2) + qy.max(0.).powi(2)).sqrt() + qx.max(qy).min(0.) - radius;
                let alpha = (0.5 - d).clamp(0., 1.);
                if alpha == 0. {
                    return image::Rgba([0, 0, 0, 0]);
                }
                let depth = (-d).max(0.);
                let rim = (-depth / 0.75).exp();
                let refract = (-depth / 12.).exp() * 11.;
                let sx = ((r.x() as f32 + px + (px / w as f32 - 0.5) * refract) / 2.)
                    .clamp(0., 959.) as u32;
                let sy = ((r.y() as f32 + py + (py / h as f32 - 0.5) * refract) / 2.)
                    .clamp(0., 539.) as u32;
                let base = self
                    .still_blur
                    .as_ref()
                    .unwrap_or(&self.blurred)
                    .get_pixel(sx, sy);
                let gloss = (1. - py / h as f32).powi(3) * 0.065;
                let tint = if focused {
                    crate::style::FOCUS_DENSITY
                } else if sheet {
                    0.62
                } else {
                    crate::style::GLASS_DENSITY
                };
                let tint_color = if focused {
                    [246., 249., 255.]
                } else if sheet {
                    [31., 36., 47.]
                } else {
                    crate::style::GLASS_TINT
                };
                let highlight = rim * (0.18 + 0.40 * (1. - py / h as f32));
                let mut rgb = [0u8; 4];
                for i in 0..3 {
                    let b = base[i] as f32 * (1. - tint) + tint_color[i] * tint;
                    rgb[i] = (b + (255. - b) * (gloss + highlight).min(0.8)).min(255.) as u8;
                }
                rgb[3] = (alpha * 255.) as u8;
                image::Rgba(rgb)
            });
            self.surfaces
                .insert(key.clone(), texture(self.creator, &img));
        }
        let _ = c.copy(&self.surfaces[&key], None, destination);
    }
}
