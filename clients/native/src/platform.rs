//! Platform launch differences. A TV install gets its endpoint from a packaged text file.
pub fn initialize() {
    #[cfg(feature = "webos")]
    {
        // Called before SDL or any network threads exist.
        std::env::set_var("SDL_WEBOS_ACCESS_POLICY_KEYS_BACK", "true");
        std::env::set_var("SDL_RENDER_SCALE_QUALITY", "linear");
    }
}
pub fn configured_server() -> Option<String> {
    if !cfg!(feature = "webos") {
        return None;
    }
    let path = std::env::current_exe().ok()?.parent()?.join("server.txt");
    let server = std::fs::read_to_string(path).ok()?;
    let server = server.trim();
    crate::network::validate_server(server)
        .ok()
        .map(|_| server.to_owned())
}

// The official webOS SDK uses glibc 2.12. Rust/ring expect getauxval (glibc 2.16).
// Read the kernel's aux vector without allocation: this can run during Rust startup.
// Do not replace libc or depend on a newer runtime being present on the TV.
#[cfg(all(feature = "webos", target_arch = "arm", target_os = "linux"))]
#[no_mangle]
pub unsafe extern "C" fn getauxval(key: std::ffi::c_ulong) -> std::ffi::c_ulong {
    use std::ffi::{c_char, c_int, c_void};
    unsafe extern "C" {
        fn open(path: *const c_char, flags: c_int, ...) -> c_int;
        fn read(fd: c_int, bytes: *mut c_void, count: usize) -> isize;
        fn close(fd: c_int) -> c_int;
        fn __errno_location() -> *mut c_int;
    }
    let fd = open(c"/proc/self/auxv".as_ptr(), 0);
    if fd < 0 {
        return 0;
    }
    let mut pair = [0usize; 2];
    let mut found = None;
    for _ in 0..1024 {
        let mut offset = 0;
        while offset < std::mem::size_of_val(&pair) {
            let n = read(
                fd,
                pair.as_mut_ptr().cast::<u8>().add(offset).cast(),
                std::mem::size_of_val(&pair) - offset,
            );
            if n < 0 && *__errno_location() == 4 {
                continue;
            }
            if n <= 0 {
                break;
            }
            offset += n as usize;
        }
        if offset != std::mem::size_of_val(&pair) || pair[0] == 0 {
            break;
        }
        if pair[0] == key as usize {
            found = Some(pair[1] as std::ffi::c_ulong);
            break;
        }
    }
    close(fd);
    match found {
        Some(value) => value,
        None => {
            *__errno_location() = 2;
            0
        }
    }
}

pub fn diagnostic(message: &str) {
    #[cfg(feature = "webos")]
    {
        use std::io::Write;
        let path = "/tmp/dialden-native-diagnostics.log";
        if std::fs::metadata(path)
            .map(|m| m.len() > 128 * 1024)
            .unwrap_or(false)
        {
            let _ = std::fs::remove_file(path);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(f, "{} {}", chrono::Utc::now().to_rfc3339(), message);
        }
    }
    #[cfg(not(feature = "webos"))]
    let _ = message;
}

// Preserve LG's extended scancodes before rust-sdl2 drops unknown enum values.
pub fn events(pump: &mut sdl2::EventPump) -> Vec<sdl2::event::Event> {
    #[cfg(not(feature = "webos"))]
    return pump.poll_iter().take(256).collect();
    #[cfg(feature = "webos")]
    {
        let _ = pump;
        let mut events = Vec::new();
        for _ in 0..256 {
            let mut raw: sdl2::sys::SDL_Event = unsafe { std::mem::zeroed() };
            if unsafe { sdl2::sys::SDL_PollEvent(&mut raw) } == 0 {
                break;
            }
            unsafe {
                // LG inserts inputSource after windowID in keyboard/text events.
                // rust-sdl2 uses upstream SDL layouts. Remove that field before conversion.
                let bytes = std::slice::from_raw_parts_mut(
                    (&mut raw as *mut sdl2::sys::SDL_Event).cast::<u8>(),
                    std::mem::size_of::<sdl2::sys::SDL_Event>(),
                );
                normalize_lg_event(bytes);
                let kind = u32::from_ne_bytes(bytes[..4].try_into().unwrap());
                if kind == 0x300 || kind == 0x301 {
                    // Read raw integers: LG extension values are not valid Rust enum variants.
                    let scan = i32::from_ne_bytes(bytes[16..20].try_into().unwrap());
                    let sym = i32::from_ne_bytes(bytes[20..24].try_into().unwrap());
                    let timestamp = u32::from_ne_bytes(bytes[4..8].try_into().unwrap());
                    let window_id = u32::from_ne_bytes(bytes[8..12].try_into().unwrap());
                    let repeat = bytes[13] != 0;
                    let keycode =
                        remote_key(scan).or_else(|| sdl2::keyboard::Keycode::from_i32(sym));
                    let scancode = sdl2::keyboard::Scancode::from_i32(scan);
                    let keymod = sdl2::keyboard::Mod::from_bits_truncate(u16::from_ne_bytes(
                        bytes[24..26].try_into().unwrap(),
                    ));
                    if kind == 0x300 {
                        diagnostic(&format!("key sym={sym} scan={scan} repeat={repeat}"));
                        events.push(sdl2::event::Event::KeyDown {
                            timestamp,
                            window_id,
                            keycode,
                            scancode,
                            keymod,
                            repeat,
                        });
                    } else {
                        events.push(sdl2::event::Event::KeyUp {
                            timestamp,
                            window_id,
                            keycode,
                            scancode,
                            keymod,
                            repeat,
                        });
                    }
                    continue;
                }
            }
            events.push(sdl2::event::Event::from_ll(raw));
        }
        events
    }
}
#[cfg(any(feature = "webos", test))]
fn remote_key(scan: i32) -> Option<sdl2::keyboard::Keycode> {
    use sdl2::keyboard::Keycode;
    match scan {
        480 => Some(Keycode::PageUp),
        481 => Some(Keycode::PageDown),
        482 => Some(Keycode::Escape),
        _ => None,
    }
}
#[cfg(test)]
mod input_tests {
    use super::*;
    #[test]
    fn maps_lg_keys_without_claiming_home_or_cursor_signals() {
        assert_eq!(remote_key(482), Some(sdl2::keyboard::Keycode::Escape));
        assert_eq!(remote_key(480), Some(sdl2::keyboard::Keycode::PageUp));
        assert_eq!(remote_key(481), Some(sdl2::keyboard::Keycode::PageDown));
        assert_eq!(remote_key(484), None);
        assert_eq!(remote_key(505), None);
    }
}

#[cfg(any(feature = "webos", test))]
fn normalize_lg_event(bytes: &mut [u8]) {
    let kind = u32::from_ne_bytes(bytes[..4].try_into().unwrap());
    let end = match kind {
        0x300 | 0x301 => 36,
        0x302 => 56,
        0x303 => 48,
        _ => return,
    };
    bytes.copy_within(16..end, 12);
    bytes[end - 4..end].fill(0);
}
#[cfg(test)]
mod abi_tests {
    use super::*;
    #[test]
    fn lg_keyboard_source_does_not_shift_key_or_repeat() {
        let mut bytes = [0u8; 56];
        bytes[..4].copy_from_slice(&0x300u32.to_ne_bytes());
        bytes[12..16].copy_from_slice(&123u32.to_ne_bytes());
        bytes[16] = 1;
        bytes[17] = 1;
        bytes[20..24].copy_from_slice(&79u32.to_ne_bytes());
        bytes[24..28].copy_from_slice(&(1073741903i32).to_ne_bytes());
        normalize_lg_event(&mut bytes);
        assert_eq!(bytes[12], 1);
        assert_eq!(bytes[13], 1);
        assert_eq!(u32::from_ne_bytes(bytes[16..20].try_into().unwrap()), 79);
        assert_eq!(
            i32::from_ne_bytes(bytes[20..24].try_into().unwrap()),
            1073741903
        );
    }
    #[test]
    fn mouse_layout_is_unchanged_and_text_skips_source() {
        let mut bytes = [0u8; 56];
        bytes[..4].copy_from_slice(&0x400u32.to_ne_bytes());
        bytes[20] = 90;
        let before = bytes;
        normalize_lg_event(&mut bytes);
        assert_eq!(bytes, before);
        bytes[..4].copy_from_slice(&0x303u32.to_ne_bytes());
        bytes[16..20].copy_from_slice(b"abc\0");
        normalize_lg_event(&mut bytes);
        assert_eq!(&bytes[12..16], b"abc\0");
    }
}
