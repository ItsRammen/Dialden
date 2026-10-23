use crate::model::*;
use serde::Deserialize;
use std::{collections::HashSet, sync::mpsc::Sender, time::Duration};
use url::Url;

pub enum Update {
    Catalog(Snapshot),
    Icon(String, image::RgbaImage),
    Art(u64, image::RgbaImage, crate::glass::Backdrop),
    Error(String),
}
#[derive(Deserialize)]
struct Channels {
    channels: Vec<Channel>,
}
#[derive(Deserialize)]
struct Schedules {
    schedules: Vec<Schedule>,
}
pub fn validate_server(s: &str) -> Result<Url, String> {
    let u = Url::parse(s)
        .map_err(|_| "Enter a full server address, such as http://server:1993".to_string())?;
    if !matches!(u.scheme(), "http" | "https")
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.path() != "/"
    {
        return Err(
            "Use an HTTP or HTTPS server address without credentials, query or path".into(),
        );
    }
    Ok(u)
}
pub(crate) fn json<T: serde::de::DeserializeOwned>(
    agent: &ureq::Agent,
    url: &str,
) -> Result<T, String> {
    let r = agent
        .get(url)
        .call()
        .map_err(|_| "Server unavailable. Keeping the last channel list.".to_string())?;
    use std::io::Read;
    let mut bytes = Vec::new();
    r.into_reader()
        .take(4 * 1024 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read server response".to_string())?;
    serde_json::from_slice(&bytes)
        .map_err(|_| "Server returned an incompatible channel response".into())
}
pub fn run(server: Url, tx: Sender<Update>) {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(8))
        .build();
    let (icon_tx, icon_rx) = std::sync::mpsc::channel::<Vec<(String, String)>>();
    let icon_server = server.clone();
    let updates = tx.clone();
    std::thread::spawn(move || load_icons(icon_server, icon_rx, updates));
    let mut art = HashSet::new();
    loop {
        let mut snapshot_art_count = 0;
        let result = (|| {
            let mut c: Channels = json(&agent, server.join("api/v1/channels").unwrap().as_str())?;
            let s: Schedules = json(
                &agent,
                server.join("api/v1/channels/schedule").unwrap().as_str(),
            )?;
            c.channels.retain(|c| c.enabled);
            Ok::<_, String>(Snapshot {
                channels: c.channels,
                schedules: s.schedules,
            })
        })();
        match result {
            Ok(snapshot) => {
                let _ = icon_tx.send(snapshot.channels.iter().filter_map(|c| c.icon_url.as_ref().map(|url| (c.id.clone(), url.clone()))).collect());
                let ids: Vec<_> = snapshot
                    .schedules
                    .iter()
                    .filter_map(|s| s.program.as_ref()?.media_id)
                    .collect();
                let ids: HashSet<_> = ids.into_iter().collect();
                snapshot_art_count = ids.len();
                art.retain(|id| ids.contains(id));
                if tx.send(Update::Catalog(snapshot)).is_err() {
                    return;
                }
                for id in ids {
                    if art.contains(&id) {
                        continue;
                    }
                    let url = server.join(&format!("api/v1/media/{id}/still")).unwrap();
                    let response = agent
                        .get(url.as_str())
                        .timeout(Duration::from_secs(2))
                        .call();
                    let is_still = response.as_ref().is_ok_and(|r| r.status() == 200);
                    // Never stretch a library thumbnail into a television preview.
                    // Pending stills are retried on the next short catalog refresh.
                    if !is_still { continue; }
                    if let Ok(r) = response {
                        use std::io::Read;
                        let mut bytes = Vec::new();
                        if r.into_reader()
                            .take(4 * 1024 * 1024)
                            .read_to_end(&mut bytes)
                            .is_ok()
                        {
                            let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes));
                            if let Ok(format) = reader.with_guessed_format() {
                                reader = format;
                                let mut limits = image::Limits::default();
                                limits.max_image_width = Some(4096);
                                limits.max_image_height = Some(4096);
                                reader.limits(limits);
                                if let Ok(img) = reader.decode() {
                                    if is_still {
                                        art.insert(id);
                                    }
                                    let backdrop = crate::glass::Backdrop::from_image(&img);
                                    if tx
                                        .send(Update::Art(
                                            id,
                                            img.thumbnail(1920, 1080).to_rgba8(),
                                            backdrop,
                                        ))
                                        .is_err()
                                    {
                                        return;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                if tx.send(Update::Error(e)).is_err() {
                    return;
                }
            }
        }
        std::thread::sleep(Duration::from_secs(if art.len() < snapshot_art_count { 5 } else { 30 }));
    }
}
// Separate worker: unavailable logos never delay the catalog, stills, or playback.
fn load_icons(server: Url, rx: std::sync::mpsc::Receiver<Vec<(String, String)>>, tx: Sender<Update>) {
    use std::{collections::HashMap, io::Read, time::Instant};
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(10)).redirects(0).build();
    let mut cached: HashMap<(String, String), Instant> = HashMap::new();
    while let Ok(mut icons) = rx.recv() {
        while let Ok(latest) = rx.try_recv() { icons = latest; }
        cached.retain(|key, _| icons.contains(key));
        for (id, path) in icons {
            let key = (id.clone(), path.clone());
            if cached.get(&key).is_some_and(|t| t.elapsed() < Duration::from_secs(300)) { continue; }
            let Some(url) = icon_url(&server, &path) else { continue };
            let result = (|| -> Option<image::RgbaImage> {
                let response = agent.get(url.as_str()).call().ok()?;
                let mut bytes = Vec::new();
                response.into_reader().take(5 * 1024 * 1024 + 1).read_to_end(&mut bytes).ok()?;
                if bytes.len() > 5 * 1024 * 1024 { return None; }
                let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), image::ImageFormat::Png);
                let mut limits = image::Limits::default();
                limits.max_image_width = Some(4096); limits.max_image_height = Some(4096);
                reader.limits(limits);
                Some(reader.decode().ok()?.thumbnail(480, 180).to_rgba8())
            })();
            if let Some(img) = result {
                cached.insert(key, Instant::now());
                if tx.send(Update::Icon(id, img)).is_err() { return; }
            }
        }
    }
}
fn icon_url(server: &Url, path: &str) -> Option<Url> {
    let url = server.join(path).ok()?;
    (url.origin() == server.origin() && url.username().is_empty() && url.password().is_none()).then_some(url)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn icons_only_load_from_the_configured_server() {
        let server = Url::parse("http://server:1993").unwrap();
        assert!(icon_url(&server, "/api/v1/channels/nick/icon").is_some());
        assert!(icon_url(&server, "https://other/logo.png").is_none());
        assert!(icon_url(&server, "//other/logo.png").is_none());
        assert!(icon_url(&server, "http://user@server:1993/logo").is_none());
    }
    #[test]
    fn server_validation_rejects_unsafe_or_ambiguous_addresses() {
        for s in [
            "file:///etc/passwd",
            "http://user:pass@host",
            "http://host/path",
            "http://host?token=x",
            "host:1993",
        ] {
            assert!(validate_server(s).is_err(), "{s}");
        }
        assert!(validate_server("http://192.168.1.2:1993").is_ok());
    }
}
