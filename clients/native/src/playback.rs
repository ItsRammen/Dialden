//! One decoder, shared by the muted home preview and full-screen playback.
use crate::model::{Navigation, Page, Snapshot};
use std::time::{Duration, Instant};
use url::Url;

#[cfg(feature = "desktop-player")]
#[path = "playback_mpv.rs"]
mod backend;
#[cfg(all(
    feature = "webos",
    target_arch = "arm",
    not(feature = "desktop-player")
))]
#[path = "playback_webos.rs"]
mod backend;
#[cfg(not(any(
    feature = "desktop-player",
    all(feature = "webos", target_arch = "arm")
)))]
mod backend {
    pub struct Decoder;
    impl Decoder {
        pub fn new() -> Result<Self, String> {
            Err("Playback requires the desktop-player build".into())
        }
        pub fn load(&mut self, _: &str, _: bool) -> Result<(), String> {
            unreachable!()
        }
        pub fn mute(&mut self, _: bool) -> Result<(), String> {
            unreachable!()
        }
        pub fn stop(&mut self) {}
        pub fn poll(&mut self) -> Result<Option<&[u8]>, String> {
            Ok(None)
        }
        pub fn buffering(&self) -> bool {
            false
        }
        pub fn position(&self) -> Option<f64> {
            None
        }
    }
}
// Starfish accepts a positional URL followed by media options (not a URI property).
#[cfg(any(test, all(feature = "webos", target_arch = "arm")))]
pub fn native_load_payload(url: &str, window: &str) -> serde_json::Value {
    serde_json::json!({"args":[url,{"mediaTransportType":"HLS","option":{
        "appId":"com.itsrammen.dialden.native","windowId":window,
        "adaptiveStreaming":{"seamlessPlay":true}
    }}]})
}
#[cfg(test)]
mod native_contract_tests {
    #[test]
    fn hls_uses_positional_url_and_exported_video_window() {
        let p = super::native_load_payload("http://server/live.m3u8?clientId=one", "video-window");
        assert_eq!(p["args"][0], "http://server/live.m3u8?clientId=one");
        assert_eq!(p["args"][1]["mediaTransportType"], "HLS");
        assert_eq!(p["args"][1]["option"]["windowId"], "video-window");
        assert_eq!(p["args"].as_array().unwrap().len(), 2);
    }
}
pub const WIDTH: u32 = 1920;
pub const HEIGHT: u32 = 1080;
#[derive(Clone, Debug, PartialEq)]
pub struct Target {
    pub channel: String,
    pub url: String,
    pub muted: bool,
}

pub fn target(server: &Url, data: &Snapshot, nav: &Navigation, client: &str) -> Option<Target> {
    let playing = nav.page == Page::Player || (nav.page == Page::Guide && nav.guide_from_player);
    if !playing && nav.page != Page::Watch {
        return None;
    }
    let index = if playing {
        nav.playing_index.unwrap_or(nav.index)
    } else {
        nav.index
    };
    let ch = data
        .channels
        .get(index)
        .filter(|ch| ch.enabled && ch.on_air)?;
    let stream = data.schedule(&ch.id)?.live_stream.as_ref()?;
    if stream.mode != "hls" {
        return None;
    }
    let mut url = server.join(&stream.url).ok()?;
    // This API advertises server-relative streams. Never send this client's identity elsewhere.
    if url.origin() != server.origin() || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    url.query_pairs_mut().append_pair("clientId", client);
    Some(Target {
        channel: ch.id.clone(),
        url: url.into(),
        muted: !playing,
    })
}

pub fn is_waiting(status: &str) -> bool {
    status.starts_with("Connecting")
        || status.starts_with("Buffering")
        || status.starts_with("Reconnecting")
}
pub fn is_failure(status: &str) -> bool {
    !status.is_empty() && !is_waiting(status) && !status.starts_with("Live preview")
}

pub struct Player {
    desired: Option<Target>,
    active: Option<Target>,
    changed: Instant,
    loaded_at: Instant,
    decoder: Option<backend::Decoder>,
    retry_at: Option<Instant>,
    retries: u8,
    progress_at: Instant,
    frame_at: Instant,
    position: Option<f64>,
    pub has_frame: bool,
    pub status: String,
}
impl Player {
    pub fn new() -> Self {
        Self {
            desired: None,
            active: None,
            changed: Instant::now(),
            loaded_at: Instant::now(),
            decoder: None,
            retry_at: None,
            retries: 0,
            progress_at: Instant::now(),
            frame_at: Instant::now(),
            position: None,
            has_frame: false,
            status: String::new(),
        }
    }
    #[cfg(all(
        feature = "webos",
        target_arch = "arm",
        not(feature = "desktop-player")
    ))]
    pub fn viewport(&mut self, rect: sdl2::rect::Rect) {
        if let Some(d) = self.decoder.as_mut() {
            d.viewport(rect);
        }
    }
    pub fn channel(&self) -> Option<&str> {
        self.active.as_ref().map(|t| t.channel.as_str())
    }
    pub fn update(&mut self, desired: Option<Target>, now: Instant) {
        let same_stream = |a: &Option<Target>, b: &Option<Target>| {
            a.as_ref().map(|t| (&t.channel, &t.url)) == b.as_ref().map(|t| (&t.channel, &t.url))
        };
        if !same_stream(&self.desired, &desired) {
            if let Some(d) = &mut self.decoder {
                d.stop();
            }
            // Keep the exported window and serial worker across switches. Dropping
            // it starts a second worker while the old firmware unload is pending.
            self.active = None;
            self.has_frame = false;
            self.retries = 0;
            self.retry_at = None;
            self.changed = now;
            self.status.clear();
        }
        // An explicit open after a failed automatic preview is a new user retry.
        if self.retries > 3
            && self.desired.as_ref().is_some_and(|t| t.muted)
            && desired.as_ref().is_some_and(|t| !t.muted)
        {
            self.retries = 0;
            self.retry_at = None;
        }
        self.desired = desired;
        let Some(wanted) = self.desired.clone() else {
            return;
        };
        if let Some(active) = &mut self.active {
            if active.muted != wanted.muted {
                if let Some(d) = &mut self.decoder {
                    if let Err(e) = d.mute(wanted.muted) {
                        self.fail(e, now);
                        return;
                    }
                }
                active.muted = wanted.muted;
            }
            return;
        }
        if self.retries > 3 {
            return;
        }
        if let Some(at) = self.retry_at {
            if now < at {
                return;
            }
        }
        if wanted.muted && now.duration_since(self.changed) < Duration::from_millis(250) {
            return;
        }
        if self.decoder.is_none() {
            match backend::Decoder::new() {
                Ok(d) => self.decoder = Some(d),
                Err(e) => {
                    self.status = e;
                    self.retries = 4;
                    return;
                }
            }
        }
        match self
            .decoder
            .as_mut()
            .unwrap()
            .load(&wanted.url, wanted.muted)
        {
            Ok(()) => {
                eprintln!(
                    "[playback] load channel={} preview={} attempt={}",
                    wanted.channel,
                    wanted.muted,
                    self.retries + 1
                );
                self.active = Some(wanted);
                self.retry_at = None;
                self.loaded_at = now;
                self.progress_at = now;
                self.frame_at = now;
                self.position = None;
                self.has_frame = false;
                self.status = "Connecting…".into();
            }
            Err(e) => self.fail(e, now),
        }
    }
    fn fail(&mut self, error: String, now: Instant) {
        eprintln!("[playback] interrupted: {error}");
        crate::platform::diagnostic(&format!("playback interrupted: {error}"));
        if let Some(d) = &mut self.decoder {
            d.stop();
        }
        self.active = None;
        self.has_frame = false;
        self.retries += 1;
        if self.retries > 3 {
            self.status = format!("Couldn’t play this channel · {error}. Reopen to retry.");
            self.retry_at = None;
        } else {
            self.status = format!("Reconnecting… ({}/3)", self.retries);
            self.retry_at = Some(now + Duration::from_secs(1 << (self.retries - 1)));
        }
    }
    pub fn poll(&mut self, now: Instant, mut frame: impl FnMut(&[u8])) {
        if self.active.is_none() {
            return;
        }
        let d = self.decoder.as_mut().unwrap();
        match d.poll() {
            Ok(Some(pixels)) => {
                if !self.has_frame {
                    crate::platform::diagnostic(&format!(
                        "first frame channel={} elapsed_ms={}",
                        self.active.as_ref().unwrap().channel,
                        now.duration_since(self.loaded_at).as_millis()
                    ));
                }
                frame(pixels);
                self.has_frame = true;
                self.frame_at = now;
            }
            Ok(None) => (),
            Err(e) => {
                self.fail(e, now);
                return;
            }
        }
        let position = d.position();
        if position.is_some() && position != self.position {
            self.position = position;
            self.progress_at = now;
        }
        if now.duration_since(self.frame_at) > Duration::from_secs(20) {
            self.fail("No decoded video for 20 seconds".into(), now);
            return;
        }
        if now.duration_since(self.progress_at) > Duration::from_secs(20) {
            self.fail("No playback progress for 20 seconds".into(), now);
            return;
        }
        self.status = if d.buffering() {
            "Buffering…"
        } else if self.has_frame {
            if self.active.as_ref().unwrap().muted {
                "Live preview · Muted"
            } else {
                ""
            }
        } else {
            "Connecting…"
        }
        .into();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;
    fn catalog() -> Snapshot {
        Snapshot {
            channels: vec![Channel {
                id: "nick".into(),
                enabled: true,
                on_air: true,
                ..Default::default()
            }],
            schedules: vec![Schedule {
                channel_id: "nick".into(),
                live_stream: Some(LiveStream {
                    mode: "hls".into(),
                    url: "/api/live/index.m3u8".into(),
                }),
                ..Default::default()
            }],
        }
    }
    #[test]
    fn preview_target_and_guide_keep_one_channel() {
        let u = Url::parse("http://localhost:1993").unwrap();
        let data = catalog();
        let mut n = Navigation::default();
        assert!(target(&u, &data, &n, "test").unwrap().muted);
        n.nav = false;
        assert!(target(&u, &data, &n, "test").unwrap().muted);
        n.open_channel();
        n.key(Key::Ok, 1);
        let t = target(&u, &data, &n, "test").unwrap();
        assert!(!t.muted);
        assert_eq!(t.channel, "nick");
        n.page = Page::Settings;
        assert!(target(&u, &data, &n, "test").is_none());
    }
    #[test]
    fn stream_must_be_on_air_and_same_origin() {
        let u = Url::parse("http://localhost:1993").unwrap();
        let mut data = catalog();
        let n = Navigation {
            nav: false,
            ..Default::default()
        };
        data.channels[0].on_air = false;
        assert!(target(&u, &data, &n, "test").is_none());
        data.channels[0].on_air = true;
        data.schedules[0].live_stream.as_mut().unwrap().url = "https://other/live.m3u8".into();
        assert!(target(&u, &data, &n, "test").is_none());
    }
    #[test]
    fn dwell_is_cancelled_and_retry_budget_is_bounded() {
        let now = Instant::now();
        let mut p = Player::new();
        let t = Target {
            channel: "a".into(),
            url: "http://localhost/live".into(),
            muted: true,
        };
        p.update(Some(t), now);
        assert!(p.decoder.is_none());
        p.update(None, now + Duration::from_millis(600));
        assert!(p.active.is_none());
        for _ in 0..4 {
            p.fail("offline".into(), now);
        }
        assert!(p.retry_at.is_none());
        assert!(p.status.contains("Reopen"));
    }
    #[cfg(feature = "desktop-player")]
    #[test]
    #[ignore = "requires a local HLS fixture and SDL_VIDEODRIVER=dummy"]
    fn renders_preview_then_promotes_without_reload() {
        use sdl2::pixels::PixelFormatEnum;
        let stream = std::env::var("DIALDEN_TEST_STREAM").unwrap();
        let mut player = Player::new();
        let wanted = Target {
            channel: "nick".into(),
            url: stream,
            muted: true,
        };
        let started = Instant::now();
        player.update(Some(wanted.clone()), started - Duration::from_secs(1));
        player.update(Some(wanted.clone()), started);
        let sdl = sdl2::init().unwrap();
        let video = sdl.video().unwrap();
        let window = video.window("Playback test", 1920, 1080).build().unwrap();
        let mut canvas = window.into_canvas().software().build().unwrap();
        canvas.set_blend_mode(sdl2::render::BlendMode::Blend);
        let tc = canvas.texture_creator();
        let mut paint = crate::Paint::new(&tc);
        paint.reduced_motion = true;
        paint.playback_enabled = true;
        paint.video = Some(
            tc.create_texture_streaming(PixelFormatEnum::RGBA32, WIDTH, HEIGHT)
                .unwrap(),
        );
        let mut frames = 0;
        while frames < 15 {
            player.poll(Instant::now(), |pixels| {
                paint
                    .video
                    .as_mut()
                    .unwrap()
                    .update(None, pixels, WIDTH as usize * 4)
                    .unwrap();
                if frames % 6 == 0 {
                    paint.glass.video_frame(pixels);
                }
                frames += 1;
            });
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "{}",
                player.status
            );
            std::thread::sleep(Duration::from_millis(16));
        }
        paint.video_channel = Some("nick".into());
        paint.playback_status = player.status.clone();
        let mut data = catalog();
        data.channels[0].name = "HLS playback test".into();
        data.schedules[0].program = Some(Program {
            collection_title: "Moving video fixture".into(),
            ..Default::default()
        });
        let mut nav = Navigation {
            nav: false,
            ..Default::default()
        };
        let save = |canvas: &sdl2::render::Canvas<sdl2::video::Window>, name: &str| {
            if let Ok(dir) = std::env::var("DIALDEN_CAPTURE_DIR") {
                let bytes = canvas.read_pixels(None, PixelFormatEnum::RGB24).unwrap();
                image::save_buffer(
                    format!("{dir}/{name}.png"),
                    &bytes,
                    1920,
                    1080,
                    image::ColorType::Rgb8,
                )
                .unwrap();
            }
        };
        crate::draw(
            &mut canvas,
            &mut paint,
            &nav,
            &data,
            &Default::default(),
            "localhost",
            "Connected",
            0.,
        );
        save(&canvas, "native-live-preview");
        let decoder_before = player.decoder.as_ref().unwrap() as *const _;
        let progress_before = player.progress_at;
        player.update(
            Some(Target {
                muted: false,
                ..wanted
            }),
            Instant::now(),
        );
        assert_eq!(decoder_before, player.decoder.as_ref().unwrap() as *const _);
        assert_eq!(progress_before, player.progress_at); // load would reset the clock and frame.
        assert!(player.has_frame);
        assert!(!player.active.as_ref().unwrap().muted);
        nav.open_channel();
        paint.playback_status.clear();
        crate::draw(
            &mut canvas,
            &mut paint,
            &nav,
            &data,
            &Default::default(),
            "localhost",
            "Connected",
            0.,
        );
        save(&canvas, "native-live-player");
        paint.playback_wait = 1.;
        crate::draw(
            &mut canvas,
            &mut paint,
            &nav,
            &data,
            &Default::default(),
            "localhost",
            "Connected",
            0.,
        );
        save(&canvas, "native-buffering-refined");
        paint.playback_wait = 0.;
        nav.key(Key::Ok, data.channels.len());
        crate::draw(
            &mut canvas,
            &mut paint,
            &nav,
            &data,
            &Default::default(),
            "localhost",
            "Connected",
            0.,
        );
        save(&canvas, "native-live-channel-overlay");
        player.update(None, Instant::now());
        assert!(player.active.is_none());
        assert!(!player.has_frame);
    }
}
