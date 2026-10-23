//! Small, desktop-only libmpv render adapter. FFI follows installed mpv client/render headers.
//! All handles stay on the SDL thread; mpv owns its demux, network and audio threads.
use super::{HEIGHT, WIDTH};
use std::{
    ffi::{c_char, c_int, c_void, CStr, CString},
    ptr,
};
#[repr(C)]
struct Param {
    kind: c_int,
    data: *mut c_void,
}
#[repr(C)]
struct Event {
    id: c_int,
    error: c_int,
    userdata: u64,
    data: *mut c_void,
}
#[repr(C)]
struct Property {
    name: *const c_char,
    format: c_int,
    data: *mut c_void,
}
// Only the stable prefix is accessed; mpv may append fields.
#[repr(C)]
struct End {
    reason: c_int,
    error: c_int,
}
#[link(name = "mpv")]
unsafe extern "C" {
    fn mpv_create() -> *mut c_void;
    fn mpv_initialize(h: *mut c_void) -> c_int;
    fn mpv_set_option_string(h: *mut c_void, n: *const c_char, v: *const c_char) -> c_int;
    fn mpv_command(h: *mut c_void, args: *const *const c_char) -> c_int;
    fn mpv_wait_event(h: *mut c_void, timeout: f64) -> *const Event;
    fn mpv_observe_property(h: *mut c_void, id: u64, n: *const c_char, format: c_int) -> c_int;
    fn mpv_error_string(code: c_int) -> *const c_char;
    fn mpv_render_context_create(r: *mut *mut c_void, h: *mut c_void, p: *mut Param) -> c_int;
    fn mpv_render_context_update(r: *mut c_void) -> u64;
    fn mpv_render_context_render(r: *mut c_void, p: *mut Param) -> c_int;
    fn mpv_render_context_free(r: *mut c_void);
    fn mpv_terminate_destroy(h: *mut c_void);
}
fn check(code: c_int) -> Result<(), String> {
    if code >= 0 {
        Ok(())
    } else {
        Err(unsafe { CStr::from_ptr(mpv_error_string(code)) }
            .to_string_lossy()
            .into_owned())
    }
}
fn param<T>(kind: c_int, v: *mut T) -> Param {
    Param {
        kind,
        data: v.cast(),
    }
}
fn end() -> Param {
    Param {
        kind: 0,
        data: ptr::null_mut(),
    }
}

pub struct Decoder {
    handle: *mut c_void,
    render: *mut c_void,
    // u64 allocation meets mpv's minimum 4-byte alignment (a Vec<u8> does not guarantee it).
    pixels: Vec<u64>,
    loaded: bool,
    buffering: bool,
    position: Option<f64>,
}
impl Decoder {
    pub fn new() -> Result<Self, String> {
        let handle = unsafe { mpv_create() };
        if handle.is_null() {
            return Err("Could not create the decoder".into());
        }
        let mut d = Self {
            handle,
            render: ptr::null_mut(),
            pixels: vec![0; (WIDTH * HEIGHT / 2) as usize],
            loaded: false,
            buffering: true,
            position: None,
        };
        // Never load the user's mpv scripts/config or expose its keyboard/OSD over our UI.
        for (n, v) in [
            ("config", "no"),
            ("load-scripts", "no"),
            ("vo", "libmpv"),
            ("hwdec", "no"),
            ("terminal", "no"),
            ("osd-level", "0"),
            ("input-default-bindings", "no"),
            ("network-timeout", "10"),
            ("cache", "yes"),
            ("demuxer-max-bytes", "32MiB"),
            ("demuxer-max-back-bytes", "0"),
            ("mute", "yes"),
        ] {
            let (n, v) = (CString::new(n).unwrap(), CString::new(v).unwrap());
            check(unsafe { mpv_set_option_string(handle, n.as_ptr(), v.as_ptr()) })?;
        }
        #[cfg(test)]
        if std::env::var_os("DIALDEN_TEST_STREAM").is_some() {
            check(unsafe { mpv_set_option_string(handle, c"ao".as_ptr(), c"null".as_ptr()) })?;
        }
        check(unsafe { mpv_initialize(handle) })?;
        let mut params = [
            Param {
                kind: 1,
                data: c"sw".as_ptr() as *mut c_void,
            },
            end(),
        ];
        check(unsafe { mpv_render_context_create(&mut d.render, handle, params.as_mut_ptr()) })?;
        check(unsafe { mpv_observe_property(handle, 1, c"paused-for-cache".as_ptr(), 3) })?;
        check(unsafe { mpv_observe_property(handle, 2, c"time-pos".as_ptr(), 5) })?;
        Ok(d)
    }
    fn command(&mut self, args: &[&str]) -> Result<(), String> {
        let args: Vec<_> = args
            .iter()
            .map(|s| CString::new(*s))
            .collect::<Result<_, _>>()
            .map_err(|_| "Invalid stream address")?;
        let mut ptrs: Vec<_> = args.iter().map(|s| s.as_ptr()).collect();
        ptrs.push(ptr::null());
        // Commands enqueue playback internally; loadfile does not wait for HTTP or decoding.
        check(unsafe { mpv_command(self.handle, ptrs.as_ptr()) })
    }
    pub fn load(&mut self, url: &str, muted: bool) -> Result<(), String> {
        self.stop();
        // stop completes before this drain: old END_FILE/property events cannot label a new tune.
        while unsafe { (*mpv_wait_event(self.handle, 0.)).id } != 0 {}
        self.mute(muted)?;
        self.command(&["loadfile", url, "replace"])?;
        self.buffering = true;
        Ok(())
    }
    pub fn mute(&mut self, muted: bool) -> Result<(), String> {
        self.command(&["set", "mute", if muted { "yes" } else { "no" }])
    }
    pub fn stop(&mut self) {
        let _ = self.command(&["stop"]);
        self.loaded = false;
        self.position = None;
    }
    pub fn buffering(&self) -> bool {
        self.buffering
    }
    pub fn position(&self) -> Option<f64> {
        self.position
    }
    pub fn poll(&mut self) -> Result<Option<&[u8]>, String> {
        // mpv's event pointers are borrowed only until the next wait_event call.
        loop {
            unsafe {
                let e = &*mpv_wait_event(self.handle, 0.);
                match e.id {
                    0 => break,
                    7 if !e.data.is_null() => {
                        let end = &*e.data.cast::<End>();
                        if end.reason == 0 {
                            return Err("The live stream ended".into());
                        }
                        if end.reason == 4 {
                            check(end.error)?;
                            return Err("Stream unavailable".into());
                        }
                    }
                    8 => self.loaded = true,
                    22 if !e.data.is_null() => {
                        let p = &*e.data.cast::<Property>();
                        if !p.data.is_null() && e.userdata == 1 && p.format == 3 {
                            self.buffering = *p.data.cast::<c_int>() != 0;
                        }
                        if self.loaded && !p.data.is_null() && e.userdata == 2 && p.format == 5 {
                            self.position = Some(*p.data.cast::<f64>());
                        }
                    }
                    _ => (),
                }
            }
        }
        let update = unsafe { mpv_render_context_update(self.render) };
        if update & 1 == 0 {
            return Ok(None);
        }
        let mut size = [WIDTH as c_int, HEIGHT as c_int];
        let mut stride = (WIDTH * 4) as usize;
        let mut params = [
            param(17, size.as_mut_ptr()),
            Param {
                kind: 18,
                data: c"rgb0".as_ptr() as *mut c_void,
            },
            param(19, &mut stride),
            param(20, self.pixels.as_mut_ptr()),
            end(),
        ];
        check(unsafe { mpv_render_context_render(self.render, params.as_mut_ptr()) })?;
        if !self.loaded || self.position.is_none() {
            return Ok(None);
        }
        let bytes = unsafe {
            std::slice::from_raw_parts_mut(
                self.pixels.as_mut_ptr().cast::<u8>(),
                (WIDTH * HEIGHT * 4) as usize,
            )
        };
        // rgb0's fourth byte is unspecified, SDL RGBA32 needs opaque alpha.
        for p in bytes.chunks_exact_mut(4) {
            p[3] = 255;
        }
        Ok(Some(bytes))
    }
}
impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe {
            if !self.render.is_null() {
                mpv_render_context_free(self.render);
            }
            mpv_terminate_destroy(self.handle);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires DIALDEN_TEST_STREAM pointing to a local HLS fixture"]
    fn decodes_hls_and_reuses_decoder_for_promotion() {
        let url = std::env::var("DIALDEN_TEST_STREAM").unwrap();
        let mut d = Decoder::new().unwrap();
        d.load(&url, true).unwrap();
        let start = std::time::Instant::now();
        let mut frames = 0;
        let mut first = None;
        let mut changed = false;
        while start.elapsed().as_secs() < 8 {
            if let Some(p) = d.poll().unwrap() {
                if frames == 0 {
                    eprintln!("decoder first frame: {} ms", start.elapsed().as_millis());
                }
                let sample = p.to_vec();
                if let Some(f) = &first {
                    if f != &sample {
                        changed = true;
                    }
                } else {
                    first = Some(sample);
                }
                frames += 1;
            }
            if frames == 5 {
                d.mute(false).unwrap();
            }
            if frames >= 15 && changed {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(16));
        }
        assert!(
            frames >= 15 && changed,
            "expected moving video, got {frames} frames"
        );
        assert!(d.position().unwrap() > 0.);
        d.stop();
        assert!(!d.loaded);
        // A second tune must get fresh frames after cancellation.
        d.load(&url, true).unwrap();
        let start = std::time::Instant::now();
        loop {
            if d.poll().unwrap().is_some() {
                break;
            }
            assert!(start.elapsed().as_secs() < 8);
            std::thread::sleep(std::time::Duration::from_millis(16));
        }
    }
}
