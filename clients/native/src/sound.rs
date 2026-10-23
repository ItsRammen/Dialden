//! Original, quiet UI cues. Independent of the programme decoder and its volume.
use sdl2::audio::{AudioQueue, AudioSpecDesired};
use std::time::{Duration, Instant};
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Cue { Move, Select, Back, Launch }
pub fn samples(cue: Cue, rate: i32) -> Vec<f32> {
    if cue == Cue::Launch { return launch_wave(rate); }
    // A small cushioned impact, not a notification or a musical pitch sweep.
    // Related resonances give the three actions a consistent material character.
    let (duration, body, overtone, decay, gain) = match cue {
        Cue::Move => (0.042, 510.0, 1330.0, 0.010, 0.038),
        Cue::Select => (0.080, 640.0, 1600.0, 0.018, 0.044),
        Cue::Back => (0.065, 390.0, 980.0, 0.014, 0.040),
        Cue::Launch => unreachable!(),
    };
    let count = (duration * rate as f32) as usize;
    let mut seed = 0x62ab_41d3u32;
    let mut texture = 0.0;
    (0..count).map(|i| {
        let t = i as f32 / rate as f32;
        // Smooth attack and tail keep even rapid remote input free of hard clicks.
        let attack = (t / 0.003).min(1.0);
        let attack = attack * attack * (3.0 - 2.0 * attack);
        let tail = ((count - 1 - i) as f32 / (rate as f32 * 0.008)).min(1.0);
        let tail = tail * tail * (3.0 - 2.0 * tail);
        let envelope = attack * (-t / decay).exp() * tail;
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        let noise = (seed >> 8) as f32 / 8388607.5 - 1.0;
        let filter = 1.0 - (-std::f32::consts::TAU * 1800.0 / rate as f32).exp();
        texture += filter * (noise - texture);
        let body = (std::f32::consts::TAU * body * t).sin();
        let shimmer = (std::f32::consts::TAU * overtone * t).sin() * (-t / 0.008).exp();
        gain * envelope * (0.78 * body + 0.16 * shimmer + 0.06 * texture)
    }).collect()
}

// A single soft swell: airy texture over a warm, resolving resonance.
// No sampled system sounds, sharp attack, or sustained notification chime.
fn launch_wave(rate: i32) -> Vec<f32> {
    let duration = 0.72;
    let count = (rate as f32 * duration) as usize;
    let mut seed = 0x1c37_f31au32;
    let mut air = 0.0;
    (0..count).map(|i| {
        let t = i as f32 / rate as f32;
        let progress = i as f32 / (count - 1) as f32;
        let envelope = (std::f32::consts::PI * progress).sin().powi(2);
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        let noise = (seed >> 8) as f32 / 8388607.5 - 1.0;
        let cutoff = 450.0 + 1100.0 * envelope;
        air += (1.0 - (-std::f32::consts::TAU * cutoff / rate as f32).exp()) * (noise-air);
        let tone = (std::f32::consts::TAU * 330.0 * t).sin() * 0.55
            + (std::f32::consts::TAU * 495.0 * t).sin() * 0.25;
        0.027 * envelope * (tone + air * 0.20)
    }).collect()
}
pub struct Sounds {
    queue: Option<AudioQueue<f32>>,
    attempted: bool,
    last: Option<Instant>,
    pub suppressed: bool,
}
impl Sounds {
    pub fn new(suppressed: bool) -> Self { Self { queue: None, attempted: false, last: None, suppressed } }
    pub fn play(&mut self, sdl: &sdl2::Sdl, cue: Cue, enabled: bool) {
        if !enabled || self.suppressed { if let Some(q) = &self.queue { q.clear(); } return; }
        if cue == Cue::Move && self.last.is_some_and(|t| t.elapsed() < Duration::from_millis(85)) { return; }
        if !self.attempted {
            self.attempted = true;
            let opened = sdl.audio().and_then(|a| a.open_queue::<f32, _>(None, &AudioSpecDesired { freq: Some(48000), channels: Some(1), samples: Some(512) }));
            match opened {
                Ok(q) => { q.resume(); self.queue = Some(q); crate::platform::diagnostic("menu_audio ready"); }
                Err(e) => crate::platform::diagnostic(&format!("menu_audio unavailable: {e}")),
            }
        }
        if let Some(q) = &self.queue {
            // Never accumulate stale navigation sounds. Let a previous short cue finish.
            if q.size() > 48000 / 10 * 4 { return; }
            if let Err(e) = q.queue_audio(&samples(cue, q.spec().freq)) { crate::platform::diagnostic(&format!("menu_audio queue failed: {e}")); }
            self.last = Some(Instant::now());
        }
    }
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn launch_is_one_quiet_swell_with_silent_edges() {
        let wave = samples(Cue::Launch, 48000);
        assert_eq!(wave.len(), 34560);
        assert!(wave.iter().all(|v| v.is_finite() && v.abs() < 0.028));
        assert!(wave[0].abs() < 1e-6 && wave.last().unwrap().abs() < 1e-6);
        let energy = |a: usize, b: usize| wave[a..b].iter().map(|v| v*v).sum::<f32>() / (b-a) as f32;
        assert!(energy(12000, 22000) > energy(0, 4000) * 10.0);
    }
    #[test] fn cues_are_short_quiet_and_fade_at_both_ends() {
        for cue in [Cue::Move, Cue::Select, Cue::Back] {
            let data = samples(cue, 48000);
            assert!(data.len() <= 4800 && data.len() >= 1600);
            assert!(data.iter().all(|v| v.is_finite() && v.abs() <= 0.041));
            assert!(data[0].abs() < 1e-6 && data.last().unwrap().abs() < 1e-6);
            assert!(data.iter().any(|v| v.abs() > 0.01));
        }
    }
}
