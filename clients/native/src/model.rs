use serde::Deserialize;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub on_air: bool,
    #[serde(default)]
    pub icon_url: Option<String>,
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Program {
    #[serde(default)]
    pub metadata: ProgramMetadata,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub collection_title: String,
    #[serde(default)]
    pub episode_label: String,
    #[serde(default)]
    pub duration_ms: f64,
    #[serde(default)]
    pub offset_ms: f64,
    #[serde(default, rename = "type")]
    pub kind: String,
    pub media_id: Option<u64>,
}
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProgramMetadata {
    pub overview: String,
    pub overview_scope: String,
    pub air_date: String,
    pub rating: String,
    pub rating_region: String,
}
impl ProgramMetadata {
    pub fn facts(&self) -> String {
        let mut facts = Vec::new();
        if !self.rating.is_empty() {
            facts.push(if self.rating_region.is_empty() {
                self.rating.clone()
            } else {
                format!("{} ({})", self.rating, self.rating_region)
            });
        }
        if !self.air_date.is_empty() {
            facts.push(format!("First aired {}", self.air_date));
        }
        facts.join(" · ")
    }
}
impl Program {
    pub fn home_description(&self) -> String {
        if self.kind == "interlude" { return "A short station break. Your programme will continue shortly.".into(); }
        let overview = self.metadata.overview.trim();
        if overview.is_empty() { return "Description unavailable.".into(); }
        if self.metadata.overview_scope == "show" {
            format!("About the series · {overview}")
        } else { overview.into() }
    }
    pub fn heading(&self) -> &str {
        if self.kind == "interlude" {
            "Station break"
        } else if self.collection_title.is_empty() {
            &self.title
        } else {
            &self.collection_title
        }
    }
    pub fn subtitle(&self) -> String {
        if self.kind == "interlude" {
            return String::new();
        }
        [
            self.episode_label.as_str(),
            if self.title != self.heading() {
                &self.title
            } else {
                ""
            },
        ]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
    }
    pub fn progress(&self) -> f32 {
        if self.duration_ms > 0.0 {
            (self.offset_ms / self.duration_ms).clamp(0.0, 1.0) as f32
        } else {
            0.0
        }
    }
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveStream {
    pub mode: String,
    pub url: String,
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub live_stream: Option<LiveStream>,
    pub channel_id: String,
    pub program: Option<Program>,
    pub next: Option<Program>,
}
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub channels: Vec<Channel>,
    pub schedules: Vec<Schedule>,
}
impl Snapshot {
    pub fn schedule(&self, id: &str) -> Option<&Schedule> {
        self.schedules.iter().find(|s| s.channel_id == id)
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Page {
    Watch,
    Guide,
    Settings,
    Player,
    FullGuide,
}
#[derive(Clone, Copy, Debug)]
pub enum Key {
    Left,
    Right,
    Up,
    Down,
    Ok,
    Back,
}
#[derive(Clone, Debug)]
pub struct Navigation {
    pub page: Page,
    pub index: usize,
    pub nav: bool,
    pub modal: bool,
    pub quit_confirm: bool,
    pub quit_selected: bool,
    pub quit_requested: bool,
    pub actions: bool,
    pub action_index: usize,
    pub return_page: Page,
    pub guide_from_player: bool,
    pub player_controls: bool,
    pub playing_index: Option<usize>,
    pub overlay_button: bool,
}
impl Default for Navigation {
    fn default() -> Self {
        Self {
            page: Page::Watch,
            index: 0,
            nav: true,
            modal: false,
            quit_confirm: false,
            quit_selected: false,
            quit_requested: false,
            actions: false,
            action_index: 0,
            return_page: Page::Watch,
            guide_from_player: false,
            player_controls: true,
            playing_index: None,
            overlay_button: false,
        }
    }
}
impl Navigation {
    pub fn reconcile(&mut self, old: &Snapshot, new: &Snapshot) {
        if let Some(id) = old.channels.get(self.index).map(|c| &c.id) {
            self.index = new.channels.iter().position(|c| &c.id == id).unwrap_or(0);
        }
        self.playing_index = self
            .playing_index
            .and_then(|index| old.channels.get(index))
            .and_then(|old| new.channels.iter().position(|c| c.id == old.id));
        self.index = self.index.min(new.channels.len().saturating_sub(1));
        if new.channels.is_empty() {
            self.modal = false;
            self.actions = false;
            self.nav = true;
            if self.page == Page::Player {
                self.page = Page::Watch;
            }
        }
    }
    pub fn open_channel(&mut self) {
        if !self.guide_from_player {
            self.return_page = self.page;
        }
        self.playing_index = Some(self.index);
        self.page = Page::Player;
        self.actions = false;
        self.nav = false;
        self.action_index = 0;
        self.player_controls = true;
        self.guide_from_player = false;
    }
    pub fn key(&mut self, key: Key, count: usize) {
        if self.quit_confirm {
            match key {
                Key::Left => self.quit_selected = false,
                Key::Right => self.quit_selected = true,
                Key::Back => self.quit_confirm = false,
                Key::Ok => {
                    self.quit_requested = self.quit_selected;
                    self.quit_confirm = false;
                }
                _ => {}
            }
            return;
        }
        if self.page == Page::Watch && self.nav && !self.modal && !self.actions && matches!(key, Key::Back) {
            self.quit_confirm = true;
            self.quit_selected = false;
            return;
        }
        if self.modal {
            if matches!(key, Key::Back | Key::Ok) {
                self.modal = false;
            }
            return;
        }
        if self.page == Page::Player {
            // Horizontal arrows always zap; vertical arrows follow visible controls.
            if count > 0 && (matches!(key, Key::Left | Key::Right)
                || (!self.player_controls && matches!(key, Key::Up | Key::Down))) {
                self.index = if matches!(key, Key::Up | Key::Left) {
                    (self.index + count - 1) % count
                } else {
                    (self.index + 1) % count
                };
                self.playing_index = Some(self.index);
                return;
            }
            if !self.player_controls && !matches!(key, Key::Back) {
                self.player_controls = true;
                self.action_index = 0;
                return;
            }
            match key {
                Key::Left | Key::Up => self.action_index = 0,
                Key::Right | Key::Down => self.action_index = 1,
                Key::Ok if self.action_index == 0 => {
                    self.page = Page::Guide;
                    self.guide_from_player = true;
                    self.overlay_button = false;
                }
                Key::Back if self.player_controls => self.player_controls = false,
                Key::Back | Key::Ok => {
                    self.page = self.return_page;
                    self.guide_from_player = false;
                }
            }
            return;
        }
        if self.page == Page::Guide && self.guide_from_player {
            if self.overlay_button {
                match key {
                    Key::Ok => {
                        self.page = Page::FullGuide;
                        self.guide_from_player = false;
                        self.overlay_button = false;
                    }
                    Key::Down => self.overlay_button = false,
                    Key::Back => {
                        self.index = self.playing_index.unwrap_or(self.index);
                        self.page = Page::Player;
                        self.guide_from_player = false;
                        self.overlay_button = false;
                    }
                    _ => {}
                }
                return;
            }
            match key {
                Key::Up if self.index == 0 => self.overlay_button = true,
                Key::Back => {
                    self.index = self.playing_index.unwrap_or(self.index);
                    self.page = Page::Player;
                    self.guide_from_player = false;
                    self.player_controls = true;
                }
                Key::Up | Key::Left => self.index = self.index.saturating_sub(1),
                Key::Down | Key::Right => {
                    self.index = (self.index + 1).min(count.saturating_sub(1))
                }
                Key::Ok if count > 0 => self.open_channel(),
                _ => {}
            }
            return;
        }
        if self.actions {
            match key {
                Key::Left | Key::Right => self.action_index = 0,
                Key::Up | Key::Back => {
                    self.actions = false;
                    self.nav = true;
                }
                Key::Down => self.actions = false,
                Key::Ok => {
                    self.actions = false;
                    self.page = Page::FullGuide;
                }
            }
            return;
        }
        match key {
            Key::Back => {
                self.nav = true;
            }
            Key::Up if self.page == Page::Guide && !self.nav && self.index > 0 => self.index -= 1,
            Key::Up if self.page == Page::Watch && !self.nav && count > 0 => self.actions = true,
            Key::Up => self.nav = true,
            Key::Down if self.nav => {
                if count > 0 && self.page != Page::Settings {
                    self.nav = false;
                }
            }
            Key::Down if self.page == Page::Guide => {
                self.index = (self.index + 1).min(count.saturating_sub(1))
            }
            Key::Left | Key::Right if self.nav => {
                let pages = [Page::Watch, Page::FullGuide, Page::Settings];
                let i = pages.iter().position(|p| *p == self.page).unwrap_or(1);
                self.page = pages[if matches!(key, Key::Left) {
                    i.saturating_sub(1)
                } else {
                    (i + 1).min(2)
                }];
            }
            Key::Left => self.index = self.index.saturating_sub(1),
            Key::Right => self.index = (self.index + 1).min(count.saturating_sub(1)),
            Key::Ok if self.nav => {
                if count > 0 && self.page != Page::Settings {
                    self.nav = false;
                }
            }
            Key::Ok if count > 0 && self.page != Page::Settings => self.open_channel(),
            _ => {}
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn home_back_confirms_exit_and_defaults_to_staying() {
        let mut n = Navigation::default();
        n.nav = false;
        n.key(Key::Back, 3);
        assert!(n.nav && !n.quit_confirm);
        n.key(Key::Back, 3);
        assert!(n.quit_confirm && !n.quit_selected);
        n.key(Key::Ok, 3);
        assert!(!n.quit_confirm && !n.quit_requested);
        n.key(Key::Back, 3);
        n.key(Key::Right, 3);
        n.key(Key::Back, 3);
        assert!(!n.quit_requested && !n.quit_confirm);
        n.key(Key::Back, 0);
        assert!(!n.quit_selected);
        n.key(Key::Right, 0);
        n.key(Key::Ok, 0);
        assert!(n.quit_requested);
    }
    #[test]
    fn home_description_distinguishes_series_fallback_from_episode() {
        let mut p = Program::default();
        assert_eq!(p.home_description(), "Description unavailable.");
        p.metadata.overview = "A family goes camping.".into();
        p.metadata.overview_scope = "episode".into();
        assert_eq!(p.home_description(), "A family goes camping.");
        p.metadata.overview_scope = "show".into();
        assert_eq!(p.home_description(), "About the series · A family goes camping.");
        p.kind = "interlude".into();
        assert_eq!(p.home_description(), "A short station break. Your programme will continue shortly.");
    }
    #[test]
    fn metadata_is_optional_and_subtitles_do_not_duplicate_titles() {
        let old: Program = serde_json::from_str(
            r#"{"title":"Episode","collectionTitle":"Show","episodeLabel":"S01E02"}"#,
        )
        .unwrap();
        assert_eq!(old.metadata, ProgramMetadata::default());
        assert_eq!(old.subtitle(), "S01E02 · Episode");
        let new: Program = serde_json::from_str(r#"{"title":"Movie","metadata":{"overview":"A story","rating":"PG","ratingRegion":"AU"}}"#).unwrap();
        assert_eq!(new.subtitle(), "");
        assert_eq!(new.metadata.facts(), "PG (AU)");
    }
    #[test]
    fn legacy_guide_tab_navigation_returns_to_main_tabs() {
        let mut nav = Navigation {
            page: Page::Guide,
            nav: true,
            ..Default::default()
        };
        nav.key(Key::Right, 1);
        assert_eq!(nav.page, Page::Settings);
    }
    #[test]
    fn empty_catalog_cannot_open_modal() {
        let mut n = Navigation::default();
        n.key(Key::Down, 0);
        n.key(Key::Right, 0);
        n.key(Key::Ok, 0);
        assert!(n.nav);
        assert!(!n.modal);
        assert_eq!(n.index, 0);
    }
    #[test]
    fn back_from_channel_restores_selection() {
        let mut n = Navigation::default();
        n.key(Key::Down, 5);
        n.key(Key::Right, 5);
        n.key(Key::Ok, 5);
        assert_eq!(n.page, Page::Player);
        n.key(Key::Back, 5);
        assert_eq!(n.page, Page::Player);
        assert!(!n.player_controls);
        n.key(Key::Back, 5);
        assert_eq!(n.page, Page::Watch);
        assert_eq!(n.index, 1);
        assert!(!n.nav);
    }
    #[test]
    fn refresh_preserves_channel_identity() {
        let ch = |id: &str| Channel {
            id: id.into(),
            ..Default::default()
        };
        let old = Snapshot {
            channels: vec![ch("a"), ch("b")],
            ..Default::default()
        };
        let new = Snapshot {
            channels: vec![ch("b"), ch("a")],
            ..Default::default()
        };
        let mut n = Navigation {
            index: 1,
            ..Default::default()
        };
        n.reconcile(&old, &new);
        assert_eq!(n.index, 0);
    }
    #[test]
    fn single_hero_action_opens_guide_without_losing_channel() {
        let mut n = Navigation::default();
        n.key(Key::Down, 5);
        n.key(Key::Right, 5);
        n.key(Key::Up, 5);
        assert!(n.actions);
        n.key(Key::Right, 5);
        assert!(!n.modal);
        n.key(Key::Ok, 5);
        assert_eq!(n.page, Page::FullGuide);
        assert_eq!(n.index, 1);
        assert!(!n.actions);
        assert!(!n.nav);
    }
    #[test]
    fn action_row_can_return_to_tabs_or_channel_row() {
        let mut n = Navigation::default();
        n.key(Key::Down, 3);
        n.key(Key::Up, 3);
        n.key(Key::Down, 3);
        assert!(!n.actions && !n.nav);
        n.key(Key::Up, 3);
        n.key(Key::Up, 3);
        assert!(n.nav && !n.actions);
    }
    #[test]
    fn channel_guide_and_back_keep_context() {
        let mut n = Navigation {
            nav: false,
            index: 2,
            ..Default::default()
        };
        n.key(Key::Ok, 5);
        assert_eq!(n.page, Page::Player);
        n.key(Key::Ok, 5);
        assert_eq!(n.page, Page::Guide);
        n.key(Key::Back, 5);
        assert_eq!(n.page, Page::Player);
        n.key(Key::Ok, 5);
        n.key(Key::Down, 5);
        n.key(Key::Ok, 5);
        assert_eq!(n.page, Page::Player);
        assert_eq!(n.index, 3);
        n.key(Key::Back, 5);
        assert_eq!(n.page, Page::Player);
        assert!(!n.player_controls);
        n.key(Key::Back, 5);
        assert_eq!(n.page, Page::Watch);
    }
    #[test]
    fn channel_keys_tune_with_hidden_controls_and_preserve_back_destination() {
        let mut n = Navigation::default();
        n.open_channel();
        n.player_controls = false;
        n.key(Key::Up, 3);
        assert_eq!(n.index, 2);
        assert_eq!(n.playing_index, Some(2));
        n.key(Key::Down, 3);
        assert_eq!(n.index, 0);
        assert_eq!(n.page, Page::Player);
        n.key(Key::Back, 3);
        assert_eq!(n.page, Page::Watch);
    }
    #[test]
    fn visible_player_menu_uses_vertical_focus_without_tuning() {
        let mut n = Navigation::default();
        n.open_channel();
        n.key(Key::Down, 5);
        assert_eq!(n.index, 0);
        assert_eq!(n.action_index, 1);
        n.key(Key::Up, 5);
        assert_eq!(n.action_index, 0);
        n.key(Key::Back, 5);
        assert!(!n.player_controls);
        n.key(Key::Down, 5);
        assert_eq!(n.playing_index, Some(1));
        assert!(!n.player_controls);
    }
    #[test]
    fn horizontal_arrows_tune_with_visible_or_hidden_controls() {
        for visible in [true, false] {
            let mut n = Navigation::default();
            n.open_channel();
            n.player_controls = visible;
            n.key(Key::Left, 3);
            assert_eq!(n.playing_index, Some(2));
            n.key(Key::Right, 3);
            assert_eq!(n.playing_index, Some(0));
            assert_eq!(n.player_controls, visible);
            assert_eq!(n.return_page, Page::Watch);
        }
        let mut n = Navigation::default();
        n.open_channel();
        n.key(Key::Right, 0); // No modulo-by-zero on an empty catalog.
    }
    #[test]
    fn first_ok_reveals_hidden_controls_without_opening_guide() {
        let mut n = Navigation::default();
        n.open_channel();
        n.player_controls = false;
        n.key(Key::Ok, 4);
        assert!(n.player_controls);
        assert_eq!(n.page, Page::Player);
        n.key(Key::Ok, 4);
        assert_eq!(n.page, Page::Guide);
    }
    #[test]
    fn overlay_browsing_preserves_playing_channel_until_ok() {
        let mut n = Navigation {
            index: 1,
            nav: false,
            ..Default::default()
        };
        n.open_channel();
        n.key(Key::Ok, 5);
        n.key(Key::Down, 5);
        assert_eq!(n.index, 2);
        assert_eq!(n.playing_index, Some(1));
        n.key(Key::Back, 5);
        assert_eq!(n.index, 1);
        assert_eq!(n.page, Page::Player);
        n.key(Key::Ok, 5);
        n.key(Key::Up, 5);
        n.key(Key::Up, 5);
        assert_eq!(n.index, 0);
        assert!(!n.nav);
    }
    #[test]
    fn interlude_filename_is_not_a_show_title() {
        let p = Program {
            title: "nick--filler--long.mp4".into(),
            kind: "interlude".into(),
            ..Default::default()
        };
        assert_eq!(p.heading(), "Station break");
        assert_eq!(p.progress(), 0.0);
    }
}
