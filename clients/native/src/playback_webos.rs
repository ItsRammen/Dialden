//! LG webOS 6 native HLS adapter. Public ABI signatures follow webos-userland's
//! StarfishMediaAPIs.h; symbols are checked against the TV, no firmware libraries bundled.
use sdl2::rect::Rect;
use crate::media_commands::{Command, latest};
use std::{
    ffi::{c_char, c_int, c_void, CStr, CString},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
type Simple = unsafe extern "C" fn(*mut c_void) -> bool;
type Message = unsafe extern "C" fn(*mut c_void, *const c_char) -> bool;
type Callback = unsafe extern "C" fn(c_int, i64, *const c_char, *mut c_void);
#[link(name = "dl")]
unsafe extern "C" {
    fn dlopen(n: *const c_char, f: c_int) -> *mut c_void;
    fn dlsym(h: *mut c_void, n: *const c_char) -> *mut c_void;
    fn dlclose(h: *mut c_void) -> c_int;
}
#[link(name = "SDL2")]
unsafe extern "C" {
    fn SDL_webOSCreateExportedWindow(kind: c_int) -> *const c_char;
    fn SDL_webOSSetExportedWindow(
        id: *const c_char,
        src: *const sdl2::sys::SDL_Rect,
        dst: *const sdl2::sys::SDL_Rect,
    ) -> c_int;
}
struct Api {
    lib: *mut c_void,
    construct: unsafe extern "C" fn(*mut c_void, *const c_char),
    destroy: unsafe extern "C" fn(*mut c_void),
    load: unsafe extern "C" fn(*mut c_void, *const c_char, Callback, *mut c_void) -> bool,
    play: Simple,
    unload: Simple,
    foreground: Simple,
    volume: Message,
    position: unsafe extern "C" fn(*mut c_void) -> i64,
}
impl Api {
    fn open() -> Result<Self, String> {
        unsafe {
            let lib = dlopen(c"libplayerAPIs.so.1".as_ptr(), 2);
            if lib.is_null() {
                return Err("LG media library unavailable".into());
            }
            macro_rules! sym {
                ($s:literal,$t:ty) => {{
                    let name = CString::new($s).unwrap();
                    let p = dlsym(lib, name.as_ptr());
                    if p.is_null() {
                        dlclose(lib);
                        return Err(format!("Missing LG media entry point: {}", $s));
                    }
                    std::mem::transmute::<*mut c_void, $t>(p)
                }};
            }
            Ok(Self {
                lib,
                construct: sym!(
                    "_ZN17StarfishMediaAPIsC1EPKc",
                    unsafe extern "C" fn(*mut c_void, *const c_char)
                ),
                destroy: sym!(
                    "_ZN17StarfishMediaAPIsD1Ev",
                    unsafe extern "C" fn(*mut c_void)
                ),
                load: sym!(
                    "_ZN17StarfishMediaAPIs4LoadEPKcPFvixS1_PvES2_",
                    unsafe extern "C" fn(*mut c_void, *const c_char, Callback, *mut c_void) -> bool
                ),
                play: sym!("_ZN17StarfishMediaAPIs4PlayEv", Simple),
                unload: sym!("_ZN17StarfishMediaAPIs6UnloadEv", Simple),
                foreground: sym!("_ZN17StarfishMediaAPIs16notifyForegroundEv", Simple),
                volume: sym!("_ZN17StarfishMediaAPIs9setVolumeEPKc", Message),
                position: sym!(
                    "_ZN17StarfishMediaAPIs18getCurrentPlaytimeEv",
                    unsafe extern "C" fn(*mut c_void) -> i64
                ),
            })
        }
    }
}
impl Drop for Api {
    fn drop(&mut self) {
        unsafe {
            dlclose(self.lib);
        }
    }
}
#[derive(Default)]
struct State {
    loaded: bool,
    failed: bool,
    unloaded: bool,
    playing: bool,
    frame: bool,
    clock: Option<f64>,
    buffering: bool,
    error: Option<String>,
    width: u32,
    height: u32,
}
unsafe extern "C" fn event(kind: c_int, number: i64, text: *const c_char, data: *mut c_void) {
    if data.is_null() {
        return;
    }
    let state = &*(data as *const Mutex<State>);
    let Ok(mut s) = state.lock() else {
        return;
    };
    let text = if text.is_null() {
        String::new()
    } else {
        CStr::from_ptr(text).to_string_lossy().into_owned()
    };
    match kind {
        0 => {
            s.frame = true;
            s.clock = Some(number as f64 / 1000.);
        }
        0x16 => s.loaded = true,
        0x17 => s.unloaded = true,
        0x1a => {
            s.playing = true;
            s.buffering = false;
        }
        0x1b => s.playing = false,
        0x1c => s.error = Some("The live stream ended".into()),
        0x12 | 0x13 => {
            s.failed = true;
            s.error = Some(format!(
                "LG media error {number}: {}",
                text.chars().take(300).collect::<String>()
            ))
        }
        0xa => {
            if text.contains("bufferingStart") || text.contains("start buffering") {
                s.buffering = true;
            }
            if text.contains("bufferingEnd") || text.contains("stop buffering") {
                s.buffering = false;
            }
        }
        0x4 => {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                let info = v.get("video").or_else(|| v.get("videoInfo")).unwrap_or(&v);
                if let (Some(w), Some(h)) = (
                    info.get("width").and_then(|v| v.as_u64()),
                    info.get("height").and_then(|v| v.as_u64()),
                ) {
                    s.width = w as u32;
                    s.height = h as u32;
                }
            }
        }
        _ => {}
    }
    if matches!(
        kind,
        0x4 | 0xa | 0x12 | 0x13 | 0x16 | 0x17 | 0x1a | 0x1b | 0x1c
    ) {
        crate::platform::diagnostic(&format!(
            "media event={kind:x} value={number} {}",
            text.chars().take(500).collect::<String>()
        ));
    }
}
// webos-userland reserves >4KiB for the opaque C++ object. Never access its internals.
#[repr(C, align(16))]
struct Storage([u8; 8192]);
struct Engine {
    api: Api,
    object: Box<Storage>,
    state: Arc<Mutex<State>>,
    window: CString,
    load_payload: Option<CString>,
    active: bool,
    started: bool,
    muted: bool,
    position: Option<f64>,
    last_poll: Instant,
}
impl Engine {
    fn new(window: CString) -> Result<Self, String> {
        crate::platform::diagnostic("media opening library");
        let api = Api::open()?;
        crate::platform::diagnostic("media constructing player");
        let mut object = Box::new(Storage([0; 8192]));
        unsafe {
            (api.construct)(object.0.as_mut_ptr().cast(), std::ptr::null());
        }
        crate::platform::diagnostic("media player constructed");
        Ok(Self {
            api,
            object,
            state: Arc::new(Mutex::new(State::default())),
            window,
            load_payload: None,
            active: false,
            started: false,
            muted: true,
            position: None,
            last_poll: Instant::now(),
        })
    }
    fn ptr(&mut self) -> *mut c_void {
        self.object.0.as_mut_ptr().cast()
    }
    pub fn load(&mut self, url: &str, muted: bool) -> Result<(), String> {
        self.stop();
        self.muted = muted;
        self.started = false;
        self.position = None;
        *self
            .state
            .lock()
            .map_err(|_| "LG media state unavailable")? = State::default();
        let payload = super::native_load_payload(url, &self.window.to_string_lossy());
        let payload = CString::new(payload.to_string()).map_err(|e| e.to_string())?;
        self.load_payload = Some(payload);
        let ptr = self.ptr();
        let data = Arc::as_ptr(&self.state) as *mut c_void;
        let ok = unsafe { (self.api.load)(ptr, self.load_payload.as_ref().unwrap().as_ptr(), event, data) };
        self.active = ok;
        if !ok {
            return Err("LG rejected the stream load".into());
        }
        crate::platform::diagnostic("media HLS load accepted");
        Ok(())
    }
    pub fn mute(&mut self, muted: bool) -> Result<(), String> {
        self.muted = muted;
        if !self.started {
            return Ok(());
        }
        let value = if muted {
            c"{\"volume\":0}"
        } else {
            c"{\"volume\":100}"
        };
        let ptr = self.ptr();
        if unsafe { (self.api.volume)(ptr, value.as_ptr()) } {
            Ok(())
        } else {
            Err("LG stream volume update failed".into())
        }
    }
    // Resource allocation continues after Load returns. Unload/destroy before
    // load completion crashes this firmware inside allocateResource(). Wait on
    // the worker thread; the UI remains responsive and newer requests coalesce.
    pub fn stop(&mut self) -> bool {
        if !self.active { return true; }
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self.state.lock().map(|s| s.loaded || s.failed).unwrap_or(false) {
            if Instant::now() >= deadline { return false; }
            std::thread::sleep(Duration::from_millis(10));
        }
        if let Ok(mut s) = self.state.lock() { s.unloaded = false; }
        let ptr = self.ptr();
        unsafe { (self.api.unload)(ptr); }
        let deadline = Instant::now() + Duration::from_secs(3);
        while !self.state.lock().map(|s| s.unloaded).unwrap_or(false) {
            if Instant::now() >= deadline { return false; }
            std::thread::sleep(Duration::from_millis(10));
        }
        self.active = false;
        self.started = false;
        self.position = None;
        true
    }
    pub fn poll(&mut self) -> Result<Option<&[u8]>, String> {
        let (loaded, error) = {
            let mut s = self
                .state
                .lock()
                .map_err(|_| "LG media state unavailable")?;
            (s.loaded, s.error.take())
        };
        if let Some(e) = error {
            return Err(e);
        }
        if !self.active {
            return Ok(None);
        }
        if loaded && !self.started {
            let ptr = self.ptr();
            unsafe {
                (self.api.foreground)(ptr);
            }
            self.started = true;
            self.mute(self.muted)?;
            if !unsafe { (self.api.play)(ptr) } {
                return Err("LG could not start the stream".into());
            }
        }
        if self.started && self.last_poll.elapsed() >= Duration::from_millis(200) {
            let ptr = self.ptr();
            let ms = unsafe { (self.api.position)(ptr) };
            // This firmware emits playback time in event 0; the synchronous
            // getter can stay at zero for HLS. Prefer the callback clock.
            self.position = self
                .state
                .lock()
                .ok()
                .and_then(|s| s.clock)
                .or_else(|| (ms >= 0).then_some(ms as f64 / 1000.));
            self.last_poll = Instant::now();
        }
        let s = self
            .state
            .lock()
            .map_err(|_| "LG media state unavailable")?;
        // Native video is a hardware plane; the empty slice is a readiness signal, never pixels.
        if s.frame || (s.playing && self.position.is_some_and(|p| p > 0.)) {
            Ok(Some(&[]))
        } else {
            Ok(None)
        }
    }
    pub fn buffering(&self) -> bool {
        self.state.lock().map(|s| s.buffering).unwrap_or(false)
    }
    pub fn position(&self) -> Option<f64> {
        self.position
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        self.stop();
        let ptr = self.ptr();
        unsafe {
            (self.api.destroy)(ptr);
        }
    }
}

// A firmware timeout must not free an object that still has native callbacks.
// Quarantine at most one object and stop this worker; retry needs an app restart.
fn retire(engine: &mut Option<Engine>) -> bool {
    if let Some(mut e) = engine.take() {
        if !e.stop() {
            crate::platform::diagnostic("media teardown timed out; preserving native object until process exit");
            std::mem::forget(e);
            return false;
        }
    }
    true
}
#[derive(Clone, Default)]
struct Report {
    ready: bool,
    buffering: bool,
    position: Option<f64>,
    width: u32,
    height: u32,
}
type Updates = Arc<Mutex<Option<(u64, Result<Report, String>)>>>;
pub struct Decoder {
    commands: std::sync::mpsc::Sender<Command>,
    updates: Updates,
    thread: Option<std::thread::JoinHandle<()>>,
    window: CString,
    generation: u64,
    report: Report,
    last_rect: Option<(Rect, u32, u32)>,
}
impl Decoder {
    pub fn new() -> Result<Self, String> {
        let id = unsafe { SDL_webOSCreateExportedWindow(0) };
        if id.is_null() {
            return Err("LG video window unavailable".into());
        }
        let window = unsafe { CStr::from_ptr(id) }.to_owned();
        let (tx, rx) = std::sync::mpsc::channel();
        let updates: Updates = Arc::new(Mutex::new(None));
        let output = updates.clone();
        let worker_window = window.clone();
        let thread = std::thread::Builder::new()
            .name("lg-media".into())
            .spawn(move || {
                let mut engine: Option<Engine> = None;
                let mut generation = 0;
                loop {
                    let command = rx.recv_timeout(Duration::from_millis(20)).map(|mut command| {
                        while let Ok(next) = rx.try_recv() { command = latest(command, next); }
                        command
                    });
                    match command {
                        Ok(Command::Quit)
                        | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => { retire(&mut engine); break; },
                        Ok(Command::Stop) => {
                            if !retire(&mut engine) { break; }
                            continue;
                        }
                        Ok(Command::Load(id, url, muted)) => {
                            generation = id;
                            if !retire(&mut engine) { break; }
                            let mut next = Command::Load(id, url, muted);
                            while let Ok(newer) = rx.try_recv() { next = latest(next, newer); }
                            let (id, url, muted) = match next {
                                Command::Load(id, url, muted) => (id, url, muted),
                                Command::Quit => break,
                                _ => continue,
                            };
                            generation = id;
                            match Engine::new(worker_window.clone()).and_then(|mut e| {
                                e.load(&url, muted)?;
                                Ok(e)
                            }) {
                                Ok(e) => {
                                    engine = Some(e);
                                    continue;
                                }
                                Err(e) => {
                                    if let Ok(mut out) = output.lock() {
                                        *out = Some((generation, Err(e)));
                                    }
                                    continue;
                                }
                            }
                        }
                        Ok(Command::Mute(muted)) => {
                            if let Some(e) = engine.as_mut() {
                                if let Err(error) = e.mute(muted) {
                                    if let Ok(mut out) = output.lock() {
                                        *out = Some((generation, Err(error)));
                                    }
                                    if !retire(&mut engine) { break; }
                                }
                            }
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    }
                    if let Some(e) = engine.as_mut() {
                        let report = e.poll().map(|frame| frame.is_some()).map(|ready| {
                            let (width, height) = e
                                .state
                                .lock()
                                .map(|s| (s.width, s.height))
                                .unwrap_or((0, 0));
                            Report {
                                ready,
                                buffering: e.buffering(),
                                position: e.position(),
                                width,
                                height,
                            }
                        });
                        let failed = report.is_err();
                        if let Err(error) = &report {
                            crate::platform::diagnostic(&format!("media failure: {error}"));
                        }
                        if let Ok(mut out) = output.lock() {
                            *out = Some((generation, report));
                        }
                        if failed {
                            if !retire(&mut engine) { break; }
                        }
                    }
                }
                if let Ok(mut out) = output.lock() {
                    *out = Some((generation, Err("LG media worker stopped. Close and reopen Dialden.".into())));
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self {
            commands: tx,
            updates,
            thread: Some(thread),
            window,
            generation: 0,
            report: Report::default(),
            last_rect: None,
        })
    }
    pub fn load(&mut self, url: &str, muted: bool) -> Result<(), String> {
        self.generation += 1;
        self.report = Report::default();
        self.last_rect = None;
        self.commands
            .send(Command::Load(self.generation, url.to_owned(), muted))
            .map_err(|_| "LG media worker stopped".into())
    }
    pub fn mute(&mut self, muted: bool) -> Result<(), String> {
        self.commands
            .send(Command::Mute(muted))
            .map_err(|_| "LG media worker stopped".into())
    }
    pub fn stop(&mut self) {
        self.generation += 1;
        self.report = Report::default();
        let _ = self.commands.send(Command::Stop);
    }
    pub fn poll(&mut self) -> Result<Option<&[u8]>, String> {
        if let Some((id, report)) = self
            .updates
            .lock()
            .map_err(|_| "LG media worker unavailable")?
            .take()
        {
            if id == self.generation {
                self.report = report?;
            }
        }
        if self.report.ready {
            Ok(Some(&[]))
        } else {
            Ok(None)
        }
    }
    pub fn buffering(&self) -> bool {
        self.report.buffering
    }
    pub fn position(&self) -> Option<f64> {
        self.report.position
    }
    pub fn viewport(&mut self, rect: Rect) {
        let (w, h) = if self.report.width > 0 && self.report.height > 0 {
            (self.report.width, self.report.height)
        } else {
            (1920, 1080)
        };
        if self.last_rect == Some((rect, w, h)) {
            return;
        }
        let scale = (rect.width() as f32 / w as f32).min(rect.height() as f32 / h as f32);
        let dw = (w as f32 * scale).round() as i32;
        let dh = (h as f32 * scale).round() as i32;
        let src = sdl2::sys::SDL_Rect {
            x: 0,
            y: 0,
            w: w as i32,
            h: h as i32,
        };
        let dst = sdl2::sys::SDL_Rect {
            x: rect.x() + (rect.width() as i32 - dw) / 2,
            y: rect.y() + (rect.height() as i32 - dh) / 2,
            w: dw,
            h: dh,
        };
        if unsafe { SDL_webOSSetExportedWindow(self.window.as_ptr(), &src, &dst) } != 0 {
            self.last_rect = Some((rect, w, h));
        }
    }
}
impl Drop for Decoder {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Quit);
        // Never block remote/UI teardown waiting on a firmware call. A live worker owns
        // its object and callback context until destruction; SDL releases its window on exit.
        if self.thread.as_ref().is_some_and(|t| t.is_finished()) {
            let _ = self.thread.take().unwrap().join();
            // One window per app process. Keep it valid for any quarantined
            // firmware object; SDL/process exit reclaims it safely.
        }
    }
}
