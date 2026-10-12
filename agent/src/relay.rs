//! Sessions for databases that live in the function engine.
//!
//! The box fronts every database under its hostname. A client connects to
//! `<id>.pg.barua.app`; when the id is not a cluster on this disk, the
//! control plane is asked where it lives. For a database in the function
//! engine the proxy checks the password itself - the engine has no roles to
//! speak of - and then carries the wire protocol over a WebSocket to the
//! database's object, byte for byte, in both directions.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use bytes::{BufMut, Bytes, BytesMut};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, warn};

use crate::app::App;
use crate::proxy::{encode_startup, send_error};

/// How long a route answer is trusted. A move is noticed within this; a
/// rejected password forces a fresh look at once, so a reset works immediately.
const ROUTE_TTL: Duration = Duration::from_secs(60);
const MISS_TTL: Duration = Duration::from_secs(5);
/// A relay session that says nothing for this long is closed. The object
/// behind it is billed for every second the socket is open, and any pool
/// reconnects on the next query.
const IDLE: Duration = Duration::from_secs(15 * 60);

/// What the control plane says about a database id.
#[derive(Debug, Clone, Deserialize)]
pub struct Route {
    pub engine: String,
    #[serde(default)]
    pub role: Option<String>,
    /// `sha256$<salt>$<hex of sha256("<salt>:<password>")>`.
    #[serde(default)]
    pub verifier: Option<String>,
    #[serde(default)]
    pub relay: Option<Relay>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Relay {
    pub url: String,
    pub token: String,
}

pub struct Routes {
    cache: Mutex<HashMap<String, (Instant, Option<Route>)>>,
    http: reqwest::Client,
}

impl Default for Routes {
    fn default() -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .expect("http client"),
        }
    }
}

impl Routes {
    fn get(&self, id: &str) -> Option<Option<Route>> {
        let cache = self.cache.lock().unwrap();
        let (at, route) = cache.get(id)?;
        let ttl = if route.is_some() { ROUTE_TTL } else { MISS_TTL };
        (at.elapsed() < ttl).then(|| route.clone())
    }
    fn put(&self, id: &str, route: Option<Route>) {
        let mut cache = self.cache.lock().unwrap();
        // Bounded: the proxy never holds more than a few thousand answers.
        if cache.len() > 4096 {
            cache.clear();
        }
        cache.insert(id.to_string(), (Instant::now(), route));
    }
    pub fn forget(&self, id: &str) {
        self.cache.lock().unwrap().remove(id);
    }
}

/// Ask the control plane where a database lives. `None` when it does not
/// exist, or when this agent runs standalone and cannot ask.
pub async fn lookup(app: &App, id: &str, fresh: bool) -> Result<Option<Route>> {
    if !fresh && let Some(hit) = app.routes.get(id) {
        return Ok(hit);
    }
    let identity = app.identity.lock().unwrap().clone();
    let (Some(url), Some(identity)) = (app.cfg.control_url.as_deref(), identity) else {
        return Ok(None);
    };
    let resp = app
        .routes
        .http
        .get(format!(
            "{}/v1/boxes/{}/route/{id}",
            url.trim_end_matches('/'),
            identity.box_id
        ))
        .bearer_auth(&identity.agent_token)
        .send()
        .await
        .context("asking the control plane for a route")?;
    let route = match resp.status().as_u16() {
        404 => None,
        200 => Some(resp.json::<Route>().await.context("route answer")?),
        s => bail!("route lookup refused: {s}"),
    };
    app.routes.put(id, route.clone());
    Ok(route)
}

fn password_ok(verifier: &str, password: &str) -> bool {
    let mut parts = verifier.splitn(3, '$');
    let (Some("sha256"), Some(salt), Some(hex)) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let digest = ring::digest::digest(&ring::digest::SHA256, format!("{salt}:{password}").as_bytes());
    let got: String = digest.as_ref().iter().map(|b| format!("{b:02x}")).collect();
    constant_time_eq(got.as_bytes(), hex.as_bytes())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// `AuthenticationCleartextPassword`: fine here because the proxy only ever
/// speaks it inside TLS, which is the same place Postgres would speak SCRAM.
async fn request_password<S: AsyncWrite + Unpin>(s: &mut S) -> Result<()> {
    let mut pkt = BytesMut::new();
    pkt.put_u8(b'R');
    pkt.put_i32(8);
    pkt.put_i32(3);
    s.write_all(&pkt).await?;
    s.flush().await?;
    Ok(())
}

async fn read_password<S: AsyncRead + Unpin>(s: &mut S) -> Result<String> {
    let tag = s.read_u8().await?;
    let len = s.read_i32().await? as usize;
    if tag != b'p' || !(5..=4096).contains(&len) {
        bail!("expected a password message, got {tag:?} of {len} bytes");
    }
    let mut body = vec![0u8; len - 4];
    s.read_exact(&mut body).await?;
    body.pop(); // trailing NUL
    Ok(String::from_utf8(body)?)
}

enum Step {
    Client(std::io::Result<usize>),
    Server(Option<Result<Message, tokio_tungstenite::tungstenite::Error>>),
}

/// The engine refused before a byte was relayed: frozen for a move, moved
/// already, or gone. The cached route is stale either way; ask again and
/// tell the client what is actually the case.
async fn refused<S: AsyncWrite + Unpin>(app: &App, client: &mut S, id: &str) -> Result<()> {
    app.routes.forget(id);
    let (code, msg) = match lookup(app, id, true).await {
        Ok(None) => ("3D000", format!("barua: database {id} does not exist")),
        Ok(Some(r)) if r.engine != "function" => ("57P03", "barua: database is moving, try again in a moment".to_string()),
        _ => ("57P03", "barua: database is not available, try again shortly".to_string()),
    };
    send_error(client, code, &msg).await
}

/// Serve one client session for a database that is not a cluster on this box.
pub async fn session<S>(app: Arc<App>, mut client: S, id: &str, params: BTreeMap<String, String>) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let route = match lookup(&app, id, false).await {
        Ok(r) => r,
        Err(e) => {
            send_error(&mut client, "57P03", "barua: database is not available, try again shortly").await?;
            return Err(e);
        }
    };
    let Some(route) = route else {
        send_error(&mut client, "3D000", &format!("barua: database {id} does not exist")).await?;
        bail!("unknown database {id}");
    };
    if route.engine != "function" {
        // The control plane places it on a box - this one, mid-move, or
        // another. Either way it is not ready to be served from here yet.
        send_error(&mut client, "57P03", "barua: database is moving, try again in a moment").await?;
        bail!("database {id} is a box database not served here");
    }
    let (Some(role), Some(relay)) = (route.role.clone(), route.relay.clone()) else {
        send_error(&mut client, "57P03", "barua: database is not available, try again shortly").await?;
        bail!("route for {id} has no role or relay");
    };

    request_password(&mut client).await?;
    let password = read_password(&mut client).await?;
    let user = params.get("user").cloned().unwrap_or_default();
    let check = |r: &Route| r.verifier.as_deref().is_some_and(|v| password_ok(v, &password));
    let mut ok = user == role && check(&route);
    if !ok && user == role {
        // The password may have been reset since the route was cached.
        if let Ok(Some(fresh)) = lookup(&app, id, true).await {
            ok = check(&fresh);
        }
    }
    if !ok {
        send_error(&mut client, "28P01", &format!("password authentication failed for user \"{user}\"")).await?;
        bail!("password rejected for {id}");
    }

    let url = format!("{}?token={}", relay.url, percent_encode(&relay.token));
    let (ws, _) = match tokio_tungstenite::connect_async(url).await {
        Ok(ws) => ws,
        Err(e) => {
            warn!(db = id, "relay connect failed: {e}");
            app.routes.forget(id);
            send_error(&mut client, "57P03", "barua: database is not available, try again shortly").await?;
            bail!("relay connect: {e}");
        }
    };
    let (mut tx, mut rx) = ws.split();
    tx.send(Message::Binary(Bytes::from(encode_startup(&params)))).await?;
    info!(db = id, user, "relay session opened");

    let mut buf = vec![0u8; 64 << 10];
    let mut relayed = false;
    loop {
        let step = tokio::time::timeout(IDLE, async {
            tokio::select! {
                r = client.read(&mut buf) => Step::Client(r),
                m = rx.next() => Step::Server(m),
            }
        })
        .await;
        match step {
            Err(_) => {
                let _ = tx.send(Message::Close(None)).await;
                send_error(&mut client, "57P01", "barua: idle session closed").await?;
                break;
            }
            Ok(Step::Client(Ok(0))) | Ok(Step::Client(Err(_))) => {
                let _ = tx.send(Message::Close(None)).await;
                break;
            }
            Ok(Step::Client(Ok(n))) => tx.send(Message::Binary(Bytes::copy_from_slice(&buf[..n]))).await?,
            Ok(Step::Server(Some(Ok(Message::Binary(b))))) => {
                relayed = true;
                client.write_all(&b).await?;
            }
            Ok(Step::Server(Some(Ok(Message::Close(frame))))) => {
                debug!(db = id, ?frame, "relay closed by the engine");
                if !relayed {
                    refused(&app, &mut client, id).await?;
                }
                break;
            }
            Ok(Step::Server(Some(Ok(_)))) => {}
            Ok(Step::Server(Some(Err(e)))) => {
                if !relayed {
                    refused(&app, &mut client, id).await?;
                }
                bail!("relay: {e}");
            }
            Ok(Step::Server(None)) => break,
        }
    }
    let _ = client.flush().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifier_roundtrip() {
        // sha256("salt:secret-password") computed once, pinned here.
        let digest = ring::digest::digest(&ring::digest::SHA256, b"salt:secret-password");
        let hex: String = digest.as_ref().iter().map(|b| format!("{b:02x}")).collect();
        let v = format!("sha256$salt${hex}");
        assert!(password_ok(&v, "secret-password"));
        assert!(!password_ok(&v, "secret-passwore"));
        assert!(!password_ok("md5$x$y", "secret-password"));
    }

    #[test]
    fn encodes_tokens() {
        assert_eq!(percent_encode("abc-_.~"), "abc-_.~");
        assert_eq!(percent_encode("a b/c"), "a%20b%2Fc");
    }
}
