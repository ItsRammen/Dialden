/// Short, monotonic entrance with a soft landing. Input can bypass it immediately.
pub fn entrance(seconds: f32) -> f32 {
    let t = (seconds / 0.6).clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(4)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn entrance_stays_bounded_and_lands_exactly() {
        assert_eq!(entrance(-1.0), 0.0);
        assert_eq!(entrance(0.6), 1.0);
        assert_eq!(entrance(10.0), 1.0);
        let mut previous = 0.0;
        for frame in 0..60 {
            let value = entrance(frame as f32 / 60.0);
            assert!(value >= previous && value <= 1.0);
            previous = value;
        }
    }
}

/// Analytic critically damped spring: stable at different refresh rates, no bounce.
#[derive(Clone, Copy, Debug, Default)]
pub struct Spring {
    pub value: f32,
    velocity: f32,
}
impl Spring {
    pub fn at(value: f32) -> Self {
        Self {
            value,
            velocity: 0.0,
        }
    }
    pub fn step(&mut self, target: f32, dt: f32, reduced: bool) -> f32 {
        if reduced {
            *self = Self::at(target);
            return target;
        }
        let dt = dt.clamp(0.0, 0.1);
        let omega = 20.0;
        let delta = self.value - target;
        let tangent = self.velocity + omega * delta;
        let decay = (-omega * dt).exp();
        self.value = target + (delta + tangent * dt) * decay;
        self.velocity = (self.velocity - omega * tangent * dt) * decay;
        if (self.value - target).abs() < 0.001 && self.velocity.abs() < 0.01 {
            *self = Self::at(target);
        }
        self.value
    }
}
#[cfg(test)]
mod spring_tests {
    use super::*;
    #[test]
    fn reversal_continues_from_current_position() {
        let mut spring = Spring::default();
        for _ in 0..6 {
            spring.step(1., 1. / 60., false);
        }
        let before = spring.value;
        let after = spring.step(0., 1. / 60., false);
        assert!((after - before).abs() < 0.15);
        for _ in 0..100 {
            spring.step(0., 1. / 60., false);
        }
        assert_eq!(spring.value, 0.);
    }
    #[test]
    fn refresh_rates_converge_and_reduced_motion_snaps() {
        let mut a = Spring::default();
        let mut b = Spring::default();
        for _ in 0..12 {
            a.step(1., 1. / 60., false);
        }
        for _ in 0..6 {
            b.step(1., 1. / 30., false);
        }
        assert!((a.value - b.value).abs() < 0.0001);
        assert_eq!(a.step(0., 0., true), 0.);
    }
}

/// Navigation is faster than the one-time launch entrance.
pub fn page_entrance(seconds: f32) -> f32 {
    let t = (seconds / 0.18).clamp(0., 1.);
    1. - (1. - t).powi(4)
}

#[cfg(test)]
mod page_tests {
    use super::*;
    #[test]
    fn pages_finish_before_launch_and_stay_monotonic() {
        assert_eq!(page_entrance(0.24), 1.);
        assert!(entrance(0.24) < 1.);
        let mut last = 0.;
        for i in 0..30 {
            let v = page_entrance(i as f32 / 60.);
            assert!(v >= last && v <= 1.);
            last = v;
        }
    }
}

/// Launch only waits for the first catalogue result, never for artwork or refreshes.
#[derive(Debug)]
pub struct Launch {
    pub waiting: bool,
    pub opacity: f32,
    pub seconds: f32,
}
impl Launch {
    pub fn new(waiting: bool) -> Self {
        Self {
            waiting,
            opacity: if waiting { 1. } else { 0. },
            seconds: 0.,
        }
    }
    pub fn finish(&mut self) {
        self.waiting = false;
    }
    pub fn tick(&mut self, dt: f32, reduced: bool) {
        let dt = dt.clamp(0., 0.1);
        self.seconds += dt;
        if !self.waiting {
            self.opacity = if reduced {
                0.
            } else {
                (self.opacity - dt / 0.36).max(0.)
            };
        }
    }
}
#[cfg(test)]
mod launch_tests {
    use super::*;
    #[test]
    fn readiness_does_not_wait_for_art_or_minimum_duration() {
        let mut launch = Launch::new(true);
        launch.finish();
        launch.tick(0.02, false);
        assert!(launch.opacity < 1.);
        for _ in 0..24 {
            launch.tick(1. / 60., false);
        }
        assert_eq!(launch.opacity, 0.);
        launch.tick(0.1, false);
        assert_eq!(launch.opacity, 0.);
    }
    #[test]
    fn waiting_stays_visible_and_reduced_motion_finishes_immediately() {
        let mut launch = Launch::new(true);
        for _ in 0..100 {
            launch.tick(0.1, true);
        }
        assert_eq!(launch.opacity, 1.);
        launch.finish();
        launch.tick(0., true);
        assert_eq!(launch.opacity, 0.);
    }
}

/// A slow bounded crop across a pre-blurred light field; no pulsing luminance.
pub fn ambient_offset(seconds: f32, reduced: bool) -> (i32, i32) {
    let phase = if reduced {
        0.
    } else {
        seconds * std::f32::consts::TAU / 24.
    };
    (
        (96. + phase.sin() * 80.).round() as i32,
        (54. + (phase * 0.5).sin() * 40.).round() as i32,
    )
}
#[cfg(test)]
mod ambient_tests {
    use super::*;
    #[test]
    fn drift_covers_viewport_and_reduced_motion_is_stationary() {
        for frame in 0..3000 {
            let t = frame as f32 / 30.;
            let (x, y) = ambient_offset(t, false);
            assert!((0..=192).contains(&x) && (0..=108).contains(&y));
            assert_eq!(ambient_offset(t, true), (96, 54));
        }
        assert_ne!(ambient_offset(0., false), ambient_offset(6., false));
    }
}

/// Separate activity feedback appears only for longer initial connections.
pub fn loading_feedback(seconds: f32) -> f32 {
    ((seconds - 3.) / 0.5).clamp(0., 1.)
}
#[cfg(test)]
mod feedback_tests {
    use super::*;
    #[test]
    fn short_launches_stay_quiet_and_feedback_fades_in() {
        assert_eq!(loading_feedback(0.), 0.);
        assert_eq!(loading_feedback(3.), 0.);
        assert_eq!(loading_feedback(3.25), 0.5);
        assert_eq!(loading_feedback(3.5), 1.);
        assert_eq!(loading_feedback(30.), 1.);
    }
}

/// Travelling waves bend and widen the ribbon rather than translating a static image.
pub fn ribbon_shape(u: f32, seconds: f32, layer: usize, reduced: bool) -> (f32, f32) {
    let t = if reduced { 0. } else { seconds * 0.24 };
    let phase = layer as f32 * 0.85;
    let centre =
        710. + 105. * (u * 5.2 - t + phase).sin() + 32. * (u * 9. - t * 0.63 + phase).sin();
    let width = 155. + 65. * (u * 4.8 + t * 0.7 + phase).sin();
    (centre, width)
}
#[cfg(test)]
mod ribbon_tests {
    use super::*;
    #[test]
    fn ribbon_bends_instead_of_only_drifting_and_stays_bounded() {
        let displacement = |u| ribbon_shape(u, 4., 0, false).0 - ribbon_shape(u, 0., 0, false).0;
        assert!((displacement(0.2) - displacement(0.8)).abs() > 10.);
        for step in 0..100 {
            for layer in 0..2 {
                let u = step as f32 / 99.;
                let (c, w) = ribbon_shape(u, step as f32, layer, false);
                assert!(c - w / 2. > 400. && c + w / 2. < 1000.);
                assert_eq!(
                    ribbon_shape(u, 40., layer, true),
                    ribbon_shape(u, 0., layer, true)
                );
            }
        }
    }
}
