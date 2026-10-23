//! Keep the server's bounded lineup ready while the real client is visible.
//! No requests run on the SDL thread; a dead client is also covered by server TTL.
use std::{sync::mpsc, time::Duration};
use url::Url;

pub struct Session {
    sender: mpsc::Sender<Option<String>>,
    desired: Option<String>,
}
impl Session {
    pub fn new(server: Url, client: String) -> Self {
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(10)).build();
            run(receiver, |channel| {
                let (path, body) = request(&client, channel);
                let result = agent.post(server.join(path).unwrap().as_str()).send_json(body);
                match result {
                    Ok(_) => true,
                    Err(error) => {
                        // Direct HLS remains available when talking to an older server.
                        crate::platform::diagnostic(&format!("lineup request failed: {error}"));
                        false
                    }
                }
            });
        });
        Self { sender, desired: None }
    }
    pub fn update(&mut self, channel: Option<String>) {
        if channel != self.desired {
            self.desired = channel.clone();
            let _ = self.sender.send(channel);
        }
    }
}
fn request(client: &str, channel: Option<&str>) -> (&'static str, serde_json::Value) {
    if let Some(channel) = channel {
        ("api/client/v1/session", serde_json::json!({
            "clientId":client,"lastChannelId":channel,"lineup":true,"tuner":false
        }))
    } else {
        ("api/client/v1/session/close", serde_json::json!({"clientId":client}))
    }
}
fn run(receiver: mpsc::Receiver<Option<String>>, mut send: impl FnMut(Option<&str>) -> bool) {
    let mut desired = None;
    let mut attempted = false;
    loop {
        match receiver.recv_timeout(Duration::from_secs(30)) {
            Ok(mut next) => {
                // Only the latest focus matters if HTTP was busy during navigation.
                loop {
                    match receiver.try_recv() {
                        Ok(newer) => next = newer,
                        Err(mpsc::TryRecvError::Empty) => break,
                        Err(mpsc::TryRecvError::Disconnected) => {
                            if attempted { send(None); }
                            return;
                        }
                    }
                }
                desired = next;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if attempted { send(None); }
                return;
            }
        }
        if let Some(channel) = desired.as_deref() {
            // Track attempts, not just successes: a timed-out request may still
            // have created a server lease that must be explicitly closed.
            attempted = true;
            send(Some(channel));
        } else if attempted && send(None) {
            attempted = false;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requests_use_bounded_lineup_without_replacing_playback_with_a_tuner() {
        let (path, body) = request("native-launch-1", Some("nick"));
        assert_eq!(path, "api/client/v1/session");
        assert_eq!(body["lastChannelId"], "nick");
        assert_eq!(body["tuner"], false);
        let (path, body) = request("native-launch-1", None);
        assert_eq!(path, "api/client/v1/session/close");
        assert_eq!(body["clientId"], "native-launch-1");
    }
    #[test]
    fn closes_even_after_timed_out_open_and_coalesces_focus() {
        let (tx, rx) = mpsc::channel();
        tx.send(Some("old".into())).unwrap();
        tx.send(Some("latest".into())).unwrap();
        let mut calls = Vec::new();
        let mut sender = Some(tx);
        run(rx, |channel| {
            calls.push(channel.map(str::to_owned));
            sender.take(); // Simulate app exit while open is in flight.
            false
        });
        assert_eq!(calls, vec![Some("latest".into()), None]);
    }
    #[test]
    fn hide_before_open_does_not_start_any_encoders() {
        let (tx, rx) = mpsc::channel();
        tx.send(Some("nick".into())).unwrap();
        tx.send(None).unwrap();
        drop(tx);
        run(rx, |_| panic!("No session was needed"));
    }
}
