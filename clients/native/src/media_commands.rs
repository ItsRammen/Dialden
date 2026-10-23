//! Collapse pending channel requests without interrupting firmware resource acquisition.
#[derive(Debug, PartialEq)]
pub enum Command { Load(u64, String, bool), Mute(bool), Stop, Quit }
pub fn latest(current: Command, next: Command) -> Command {
    match (current, next) {
        (Command::Quit, _) | (_, Command::Quit) => Command::Quit,
        (Command::Load(id, url, _), Command::Mute(muted)) => Command::Load(id, url, muted),
        (Command::Stop, Command::Mute(_)) => Command::Stop,
        (_, next) => next,
    }
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn rapid_switches_only_load_final_selection() {
        let command = latest(latest(Command::Load(1,"old".into(),true),Command::Stop),Command::Load(2,"new".into(),true));
        assert_eq!(latest(command,Command::Mute(false)),Command::Load(2,"new".into(),false));
    }
    #[test] fn quit_and_stop_cannot_be_undone_by_volume() {
        assert_eq!(latest(Command::Quit,Command::Load(2,"new".into(),true)),Command::Quit);
        assert_eq!(latest(Command::Stop,Command::Mute(false)),Command::Stop);
    }
}
