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
/// The object behind a relay is billed for every second its socket is
/// open, so a quiet session lets go of it: after this long with nothing
/// from the client, outside a transaction, the WebSocket is closed and the
/// client's own connection is kept. The next query reconnects (half a
/// second or so, mostly the engine reopening) and replays what the client
/// still believes it has - its named prepared statements and the session
/// settings the server reported - before it is forwarded.
const DROP_AFTER: Duration = Duration::from_secs(45);
/// A client that says nothing for this long is closed outright. Holding its
/// socket costs the box next to nothing, so this is generous.
const CLIENT_IDLE: Duration = Duration::from_secs(2 * 3600);
/// How long a reconnect may take, startup and replay included.
const RECONNECT: Duration = Duration::from_secs(20);
/// Messages bigger than this are not inspected, only passed on.
const MAX_SCAN: usize = 256 << 10;
/// Named statements kept for replay, in bytes; past this the session
/// simply never lets go of its socket.
const MAX_PREPARED: usize = 512 << 10;
/// Settings the server reports (ParameterStatus) that a role may SET back.
const REPLAYED: &[&str] = &[
    "application_name",
    "client_encoding",
    "DateStyle",
    "default_transaction_read_only",
    "IntervalStyle",
    "standard_conforming_strings",
    "TimeZone",
    "search_path",
];

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

    let mut link = Link::new(id, relay, params);
    link.run(&app, &mut client).await?;
    let _ = client.flush().await;
    Ok(())
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type WsTx = futures::stream::SplitSink<Ws, Message>;
type WsRx = futures::stream::SplitStream<Ws>;

/// Walks a byte stream as Postgres protocol messages (type byte, length,
/// body) holding at most one partial message, and lets anything too big to
/// be worth looking at stream straight through.
#[derive(Default)]
struct Framer {
    buf: Vec<u8>,
    skip: usize,
}

impl Framer {
    fn reset(&mut self) {
        self.buf.clear();
        self.skip = 0;
    }

    /// Feed bytes; every complete message is rebuilt into `out`, rewritten
    /// when `f` returns a new body. Returns the type of a message that was
    /// too big to hold and went through untouched, if there was one.
    fn pump(&mut self, mut bytes: &[u8], out: &mut Vec<u8>, mut f: impl FnMut(u8, &[u8]) -> Option<Vec<u8>>) -> Option<u8> {
        let mut big = None;
        if self.skip > 0 {
            let n = self.skip.min(bytes.len());
            out.extend_from_slice(&bytes[..n]);
            self.skip -= n;
            bytes = &bytes[n..];
            if bytes.is_empty() {
                return big;
            }
        }
        self.buf.extend_from_slice(bytes);
        let mut i = 0;
        while self.buf.len() - i >= 5 {
            let len = u32::from_be_bytes(self.buf[i + 1..i + 5].try_into().unwrap()) as usize;
            if len < 4 {
                // Not a message boundary after all: pass everything through from here on.
                out.extend_from_slice(&self.buf[i..]);
                self.buf.clear();
                self.skip = usize::MAX / 2;
                return big;
            }
            let total = 1 + len;
            if total > MAX_SCAN {
                big = Some(self.buf[i]);
                out.extend_from_slice(&self.buf[i..]);
                self.skip = total - (self.buf.len() - i);
                self.buf.clear();
                return big;
            }
            if self.buf.len() - i < total {
                break;
            }
            let (tag, body) = (self.buf[i], &self.buf[i + 5..i + total]);
            match f(tag, body) {
                Some(new_body) => out.extend_from_slice(&message(tag, &new_body)),
                None => out.extend_from_slice(&self.buf[i..i + total]),
            }
            i += total;
        }
        self.buf.drain(..i);
        big
    }

    /// Look only; the caller forwards the raw bytes itself.
    fn observe(&mut self, bytes: &[u8], mut f: impl FnMut(u8, &[u8])) {
        let mut sink = Vec::new();
        self.pump(bytes, &mut sink, |tag, body| {
            f(tag, body);
            None
        });
    }
}

fn cstr(body: &[u8]) -> (&[u8], &[u8]) {
    match body.iter().position(|b| *b == 0) {
        Some(n) => (&body[..n], &body[n + 1..]),
        None => (body, &[]),
    }
}

fn message(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut m = Vec::with_capacity(5 + body.len());
    m.push(tag);
    m.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
    m.extend_from_slice(body);
    m
}

/// The variable a `SET` statement names, lowercased: `SET TIME ZONE 'x'`
/// is `timezone`, `SET SESSION search_path TO a, b` is `search_path`.
fn set_key(sql: &str) -> Option<String> {
    let mut words = sql.split(|c: char| c.is_whitespace() || c == '=' || c == ';').filter(|w| !w.is_empty());
    let first = words.next()?.to_ascii_lowercase();
    let mut next = words.next()?.to_ascii_lowercase();
    match first.as_str() {
        "set" => {
            if next == "session" {
                next = words.next()?.to_ascii_lowercase();
            }
            match next.as_str() {
                "local" | "transaction" | "constraints" => None,
                "time" => (words.next()?.eq_ignore_ascii_case("zone")).then(|| "timezone".to_string()),
                _ => Some(next),
            }
        }
        "reset" => Some(next),
        _ => None,
    }
}

/// A client session and the engine socket it uses - when it has one.
struct Link {
    id: String,
    /// Prefix for this link's statement names, so that two clients with the
    /// same names (every Prisma connection calls its first one s0) do not
    /// collide in the engine's one session.
    tag: String,
    relay: Relay,
    params: BTreeMap<String, String>,
    ws: Option<(WsTx, WsRx)>,
    from_client: Framer,
    from_server: Framer,
    /// Named Parse messages as the engine saw them, in the order made,
    /// keyed by the name the client uses.
    prepared: Vec<(String, Vec<u8>)>,
    prepared_bytes: usize,
    /// The client's own SET statements, by variable; replayed verbatim.
    sets: BTreeMap<String, String>,
    /// Settings the server reported after the client changed them.
    settings: BTreeMap<String, String>,
    /// Startup, or a replay, is in progress: nothing the server says is the client's.
    swallowing: bool,
    /// The status byte of the last ReadyForQuery: I idle, T in a transaction, E failed.
    tx_state: u8,
    /// Something made this session unsafe to drop and resume.
    sticky: bool,
    terminated: bool,
    sessions: u32,
}

impl Link {
    fn new(id: &str, relay: Relay, params: BTreeMap<String, String>) -> Self {
        Self {
            id: id.to_string(),
            tag: crate::app::random_string(6).to_ascii_lowercase(),
            relay,
            params,
            ws: None,
            from_client: Framer::default(),
            from_server: Framer::default(),
            prepared: Vec::new(),
            prepared_bytes: 0,
            sets: BTreeMap::new(),
            settings: BTreeMap::new(),
            swallowing: false,
            tx_state: b'I',
            sticky: false,
            terminated: false,
            sessions: 0,
        }
    }

    fn rename(&self, name: &[u8]) -> Vec<u8> {
        if name.is_empty() {
            return Vec::new();
        }
        let mut out = format!("{}_", self.tag).into_bytes();
        out.extend_from_slice(name);
        out
    }

    /// One message from the client: remembered where a resume would need
    /// it, and rewritten where a name must be this link's own.
    fn rewrite(&mut self, tag: u8, body: &[u8]) -> Option<Vec<u8>> {
        match tag {
            b'P' => {
                let (name, rest) = cstr(body);
                if name.is_empty() {
                    return None;
                }
                let mut nb = self.rename(name);
                nb.push(0);
                nb.extend_from_slice(rest);
                let raw = message(tag, &nb);
                let name = String::from_utf8_lossy(name).into_owned();
                self.prepared.retain(|(n, _)| *n != name);
                self.prepared_bytes += raw.len();
                self.prepared.push((name, raw));
                if self.prepared_bytes > MAX_PREPARED {
                    self.sticky = true;
                }
                Some(nb)
            }
            b'B' => {
                let (portal, rest) = cstr(body);
                let (stmt, rest) = cstr(rest);
                if stmt.is_empty() {
                    return None;
                }
                let mut nb = portal.to_vec();
                nb.push(0);
                nb.extend_from_slice(&self.rename(stmt));
                nb.push(0);
                nb.extend_from_slice(rest);
                Some(nb)
            }
            b'D' | b'C' if body.first() == Some(&b'S') => {
                let (name, rest) = cstr(&body[1..]);
                if name.is_empty() {
                    return None;
                }
                if tag == b'C' {
                    let name = String::from_utf8_lossy(name);
                    self.prepared.retain(|(n, _)| *n != name);
                }
                let mut nb = vec![b'S'];
                nb.extend_from_slice(&self.rename(name));
                nb.push(0);
                nb.extend_from_slice(rest);
                Some(nb)
            }
            b'Q' => {
                let sql = String::from_utf8_lossy(cstr(body).0).into_owned();
                let upper = sql.trim_start().to_ascii_uppercase();
                if upper.starts_with("DEALLOCATE") {
                    if upper.contains(" ALL") {
                        self.prepared.clear();
                    } else if let Some(name) = sql.split_whitespace().nth(1) {
                        let name = name.trim_matches(|c| c == '"' || c == ';');
                        self.prepared.retain(|(n, _)| n != name);
                    }
                } else if upper.starts_with("SET ") || upper.starts_with("RESET ") {
                    if upper.starts_with("RESET ALL") {
                        self.sets.clear();
                    } else if let Some(key) = set_key(&sql) {
                        if upper.starts_with("RESET") {
                            self.sets.remove(&key);
                        } else {
                            self.sets.insert(key, sql.clone());
                        }
                    }
                }
                // Session state a resume cannot bring back.
                if upper.starts_with("LISTEN")
                    || upper.starts_with("DECLARE")
                    || upper.contains("TEMP TABLE")
                    || upper.contains("TEMPORARY TABLE")
                    || upper.contains("PG_ADVISORY_LOCK")
                {
                    self.sticky = true;
                }
                None
            }
            b'X' => {
                self.terminated = true;
                None
            }
            _ => None,
        }
    }

    /// The client's bytes, rebuilt for the engine.
    fn forward(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(bytes.len());
        let mut framer = std::mem::take(&mut self.from_client);
        let big = framer.pump(bytes, &mut out, |tag, body| self.rewrite(tag, body));
        self.from_client = framer;
        if big == Some(b'P') {
            self.sticky = true; // a statement too big to remember
        }
        out
    }

    /// What the engine said. Returns true when a ReadyForQuery went by.
    fn note_server(&mut self, bytes: &[u8]) -> bool {
        let mut ready = false;
        let swallowing = self.swallowing;
        let (settings, tx_state) = (&mut self.settings, &mut self.tx_state);
        self.from_server.observe(bytes, |tag, body| match tag {
            b'Z' => {
                ready = true;
                if let Some(s) = body.first() {
                    *tx_state = *s;
                }
            }
            b'S' if !swallowing => {
                let (name, rest) = cstr(body);
                let (value, _) = cstr(rest);
                let name = String::from_utf8_lossy(name).into_owned();
                if REPLAYED.contains(&name.as_str()) {
                    settings.insert(name, String::from_utf8_lossy(value).into_owned());
                }
            }
            _ => {}
        });
        ready
    }

    async fn connect(&mut self) -> Result<()> {
        let url = format!("{}?token={}", self.relay.url, percent_encode(&self.relay.token));
        let (ws, _) = tokio_tungstenite::connect_async(url).await?;
        let (mut tx, rx) = ws.split();
        tx.send(Message::Binary(Bytes::from(encode_startup(&self.params)))).await?;
        self.ws = Some((tx, rx));
        self.from_server.reset();
        self.sessions += 1;
        Ok(())
    }

    async fn send(&mut self, bytes: &[u8]) -> Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        let Some((tx, _)) = self.ws.as_mut() else { bail!("no engine socket") };
        tx.send(Message::Binary(Bytes::copy_from_slice(bytes))).await?;
        Ok(())
    }

    /// Read from the engine until a ReadyForQuery, forwarding nothing.
    async fn drain(&mut self) -> Result<()> {
        self.swallowing = true;
        let result = async {
            loop {
                let Some((_, rx)) = self.ws.as_mut() else { bail!("no engine socket") };
                match rx.next().await {
                    Some(Ok(Message::Binary(b))) => {
                        if self.note_server(&b) {
                            return Ok(());
                        }
                    }
                    Some(Ok(Message::Close(f))) => bail!("engine closed: {f:?}"),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => bail!("engine: {e}"),
                    None => bail!("engine went away"),
                }
            }
        }
        .await;
        self.swallowing = false;
        result
    }

    async fn query(&mut self, sql: &str) -> Result<()> {
        let mut body = sql.as_bytes().to_vec();
        body.push(0);
        self.send(&message(b'Q', &body)).await?;
        self.drain().await
    }

    /// Open a fresh engine session and put back what the client has: the
    /// settings the server reported, the client's own SETs, then its named
    /// statements. Each SET is its own query so one that fails does not take
    /// the rest with it; a statement that fails to parse again surfaces when
    /// the client next uses it.
    async fn resume(&mut self) -> Result<()> {
        self.connect().await?;
        self.drain().await?;
        let settings: Vec<(String, String)> = self.settings.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        for (name, value) in settings {
            self.query(&format!("SET {} TO '{}'", name, value.replace('\'', "''"))).await?;
        }
        let sets: Vec<String> = self.sets.values().cloned().collect();
        for sql in sets {
            self.query(&sql).await?;
        }
        if !self.prepared.is_empty() {
            let mut batch: Vec<u8> = self.prepared.iter().flat_map(|(_, raw)| raw.clone()).collect();
            batch.extend_from_slice(&message(b'S', &[]));
            self.send(&batch).await?;
            self.drain().await?;
        }
        Ok(())
    }

    async fn let_go(&mut self) {
        if let Some((mut tx, _)) = self.ws.take() {
            let _ = tx.send(Message::Close(None)).await;
        }
    }

    async fn run<S>(&mut self, app: &App, client: &mut S) -> Result<()>
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        if let Err(e) = self.connect().await {
            warn!(db = self.id, "relay connect failed: {e}");
            refused(app, client, &self.id).await?;
            bail!("relay connect: {e}");
        }
        info!(db = self.id, user = self.params.get("user").map(String::as_str).unwrap_or(""), "relay session opened");

        let mut buf = vec![0u8; 64 << 10];
        let mut relayed = false;
        let mut last_client = Instant::now();
        let mut dropped = 0u32;
        loop {
            let drop_at = last_client + DROP_AFTER;
            let idle_at = last_client + CLIENT_IDLE;
            let can_drop = self.ws.is_some() && self.tx_state == b'I' && !self.sticky && relayed;
            tokio::select! {
                r = client.read(&mut buf) => match r {
                    Ok(0) | Err(_) => {
                        self.let_go().await;
                        break;
                    }
                    Ok(n) => {
                        last_client = Instant::now();
                        if self.ws.is_none() {
                            // A goodbye needs no engine.
                            if buf[0] == b'X' && self.from_client.buf.is_empty() {
                                break;
                            }
                            match tokio::time::timeout(RECONNECT, self.resume()).await {
                                Ok(Ok(())) => debug!(db = self.id, "engine session resumed"),
                                other => {
                                    let why = match other {
                                        Ok(Err(e)) => e.to_string(),
                                        _ => "timed out".to_string(),
                                    };
                                    warn!(db = self.id, "could not resume the engine session: {why}");
                                    app.routes.forget(&self.id);
                                    send_error(client, "57P03", "barua: database is not available, try again shortly").await?;
                                    break;
                                }
                            }
                        }
                        let out = self.forward(&buf[..n]);
                        self.send(&out).await?;
                    }
                },
                m = recv(&mut self.ws) => match m {
                    Some(Ok(Message::Binary(b))) => {
                        relayed = true;
                        self.note_server(&b);
                        client.write_all(&b).await?;
                    }
                    Some(Ok(Message::Close(frame))) => {
                        debug!(db = self.id, ?frame, "relay closed by the engine");
                        if !relayed {
                            refused(app, client, &self.id).await?;
                        } else if !self.terminated {
                            send_error(client, "57P01", "barua: the database session ended; reconnect").await?;
                        }
                        break;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        if !relayed {
                            refused(app, client, &self.id).await?;
                        }
                        bail!("relay: {e}");
                    }
                    None => break,
                },
                _ = tokio::time::sleep_until(tokio::time::Instant::from_std(drop_at)), if can_drop => {
                    self.let_go().await;
                    dropped += 1;
                    debug!(db = self.id, "quiet: let the engine go");
                },
                _ = tokio::time::sleep_until(tokio::time::Instant::from_std(idle_at)), if self.ws.is_none() => {
                    send_error(client, "57P01", "barua: idle session closed").await?;
                    break;
                },
            }
        }
        self.let_go().await;
        debug!(db = self.id, sessions = self.sessions, dropped, "relay session closed");
        Ok(())
    }
}

/// The engine side of a link, or forever pending when there is none - so a
/// select! branch can wait on it without caring.
async fn recv(ws: &mut Option<(WsTx, WsRx)>) -> Option<Result<Message, tokio_tungstenite::tungstenite::Error>> {
    match ws {
        Some((_, rx)) => rx.next().await,
        None => std::future::pending().await,
    }
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
    fn framer_walks_messages_across_chunks() {
        let a = message(b'P', b"stmt\0select 1\0\0\0");
        let b = message(b'Z', b"I");
        let mut all = a.clone();
        all.extend_from_slice(&b);
        let mut seen = vec![];
        let mut out = vec![];
        let mut f = Framer::default();
        for chunk in all.chunks(3) {
            f.pump(chunk, &mut out, |t, body| {
                seen.push((t, body.len()));
                None
            });
        }
        assert_eq!(seen, vec![(b'P', a.len() - 5), (b'Z', 1)]);
        assert_eq!(out, all, "untouched messages come out byte for byte");
    }

    fn link() -> Link {
        let mut l = Link::new("br-x", Relay { url: "wss://x/wire/br-x".into(), token: "t".into() }, BTreeMap::new());
        l.tag = "abc".into();
        l
    }

    #[test]
    fn link_renames_statements_per_link() {
        let mut l = link();
        let out = l.forward(&message(b'P', b"s0\0select 1\0\0\0"));
        assert_eq!(out, message(b'P', b"abc_s0\0select 1\0\0\0"));
        let out = l.forward(&message(b'B', b"\0s0\0\0\0\0\0\0\0"));
        assert_eq!(out, message(b'B', b"\0abc_s0\0\0\0\0\0\0\0"));
        let out = l.forward(&message(b'D', b"Ss0\0"));
        assert_eq!(out, message(b'D', b"Sabc_s0\0"));
        // Unnamed statements and portals are left alone.
        let raw = message(b'P', b"\0select 2\0\0\0");
        assert_eq!(l.forward(&raw), raw);
        assert_eq!(l.prepared.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), vec!["s0"]);
        assert_eq!(l.prepared[0].1, message(b'P', b"abc_s0\0select 1\0\0\0"), "replay carries the engine's name");
        let out = l.forward(&message(b'C', b"Ss0\0"));
        assert_eq!(out, message(b'C', b"Sabc_s0\0"));
        assert!(l.prepared.is_empty());
    }

    #[test]
    fn link_tracks_sets_settings_and_stickiness() {
        let mut l = link();
        l.forward(&message(b'Q', b"SET search_path TO tenant_7, public\0"));
        l.forward(&message(b'Q', b"set time zone 'UTC'\0"));
        l.forward(&message(b'Q', b"SET LOCAL statement_timeout = 1000\0"));
        assert_eq!(l.sets.keys().cloned().collect::<Vec<_>>(), vec!["search_path", "timezone"]);
        l.forward(&message(b'Q', b"RESET timezone\0"));
        assert_eq!(l.sets.len(), 1);
        assert!(!l.note_server(&message(b'S', b"TimeZone\0Africa/Dar_es_Salaam\0")));
        assert!(!l.note_server(&message(b'S', b"server_version\018.3\0")));
        assert_eq!(l.settings.get("TimeZone").map(String::as_str), Some("Africa/Dar_es_Salaam"));
        assert!(l.settings.get("server_version").is_none());
        assert!(l.note_server(&message(b'Z', b"T")));
        assert_eq!(l.tx_state, b'T');
        assert!(!l.sticky);
        l.forward(&message(b'Q', b"select temperature from readings\0"));
        assert!(!l.sticky, "a word is not a temp table");
        l.forward(&message(b'Q', b"create temp table x(a int)\0"));
        assert!(l.sticky);
        assert_eq!(set_key("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY").as_deref(), Some("characteristics"));
        assert_eq!(set_key("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"), None);
    }

    #[test]
    fn encodes_tokens() {
        assert_eq!(percent_encode("abc-_.~"), "abc-_.~");
        assert_eq!(percent_encode("a b/c"), "a%20b%2Fc");
    }
}
