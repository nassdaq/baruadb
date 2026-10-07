//! Postgres wire-protocol proxy on :5432.
//!
//! It reads the startup packet, works out which database the client wants,
//! wakes it (restoring it from R2 if it is cold), then pipes bytes both ways.
//! Authentication (SCRAM) happens end to end between client and Postgres.
//!
//! A client picks its database with, in order of preference:
//! - TLS SNI:          `br-k3j9x2m1qa.db.barua.tz` (libpq ≥ 14 sends it)
//! - startup options:  `?options=endpoint%3Dbr-k3j9x2m1qa` (Neon-compatible)
//! - user suffix:      `app--br-k3j9x2m1qa` (for clients that can do neither)

use std::collections::BTreeMap;
use std::sync::Arc;

use anyhow::{Result, anyhow, bail};
use bytes::{BufMut, BytesMut};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;
use tracing::{debug, info, warn};

use crate::app::{App, ConnectionGuard};

const SSL_REQUEST: i32 = 80877103;
const GSSENC_REQUEST: i32 = 80877104;
const CANCEL_REQUEST: i32 = 80877102;
const PROTOCOL_V3: i32 = 196608;
const MAX_STARTUP_LEN: usize = 10_000;

pub async fn serve(app: Arc<App>, tls: Option<TlsAcceptor>) -> Result<()> {
    let listener = TcpListener::bind(&app.cfg.proxy_addr).await?;
    info!(addr = %app.cfg.proxy_addr, tls = tls.is_some(), "postgres proxy listening");
    loop {
        let (sock, peer) = listener.accept().await?;
        let _ = sock.set_nodelay(true);
        let (app, tls) = (app.clone(), tls.clone());
        tokio::spawn(async move {
            if let Err(e) = handle(app, tls, sock).await {
                debug!(%peer, "connection ended: {e:#}");
            }
        });
    }
}

async fn read_packet<S: AsyncRead + Unpin>(s: &mut S) -> Result<(i32, Vec<u8>)> {
    let len = s.read_i32().await? as usize;
    if !(8..=MAX_STARTUP_LEN).contains(&len) {
        bail!("bad startup packet length {len}");
    }
    let code = s.read_i32().await?;
    let mut body = vec![0u8; len - 8];
    s.read_exact(&mut body).await?;
    Ok((code, body))
}

async fn handle(app: Arc<App>, tls: Option<TlsAcceptor>, mut sock: TcpStream) -> Result<()> {
    loop {
        let (code, body) = read_packet(&mut sock).await?;
        match code {
            SSL_REQUEST => match &tls {
                Some(acceptor) => {
                    sock.write_all(b"S").await?;
                    let mut stream = acceptor.accept(sock).await?;
                    let sni = stream.get_ref().1.server_name().map(str::to_owned);
                    let (code, body) = read_packet(&mut stream).await?;
                    if code == CANCEL_REQUEST {
                        return forward_cancel(&app, &body).await;
                    }
                    return session(app, stream, code, body, sni).await;
                }
                None => sock.write_all(b"N").await?,
            },
            GSSENC_REQUEST => sock.write_all(b"N").await?,
            CANCEL_REQUEST => return forward_cancel(&app, &body).await,
            _ if tls.is_some() => {
                send_error(&mut sock, "28000", "barua: SSL is required (use sslmode=require)").await?;
                bail!("plaintext connection refused");
            }
            _ => return session(app, sock, code, body, None).await,
        }
    }
}

fn parse_params(body: &[u8]) -> Result<BTreeMap<String, String>> {
    let mut params = BTreeMap::new();
    let mut parts = body.split(|b| *b == 0);
    while let Some(k) = parts.next() {
        if k.is_empty() {
            break;
        }
        let v = parts.next().ok_or_else(|| anyhow!("truncated startup packet"))?;
        params.insert(String::from_utf8(k.to_vec())?, String::from_utf8(v.to_vec())?);
    }
    Ok(params)
}

fn encode_startup(params: &BTreeMap<String, String>) -> Vec<u8> {
    let mut buf = BytesMut::new();
    buf.put_i32(0);
    buf.put_i32(PROTOCOL_V3);
    for (k, v) in params {
        buf.put_slice(k.as_bytes());
        buf.put_u8(0);
        buf.put_slice(v.as_bytes());
        buf.put_u8(0);
    }
    buf.put_u8(0);
    let len = buf.len() as i32;
    buf[0..4].copy_from_slice(&len.to_be_bytes());
    buf.to_vec()
}

/// Work out the database id and strip routing hints from the params.
fn route(app: &App, params: &mut BTreeMap<String, String>, sni: Option<&str>) -> Option<String> {
    let exists = |id: &str| app.meta(|m| m.databases.contains_key(id));

    // Options are always cleaned so Postgres never sees `endpoint=`.
    let mut from_options = None;
    if let Some(opts) = params.get("options").cloned() {
        let mut rest = vec![];
        let mut tokens = opts.split_whitespace().peekable();
        while let Some(t) = tokens.next() {
            let candidate = if t == "-c" { tokens.peek().copied() } else { Some(t) };
            match candidate
                .map(|c| c.trim_start_matches("--"))
                .and_then(|c| c.strip_prefix("endpoint="))
            {
                Some(id) if from_options.is_none() => {
                    from_options = Some(id.to_string());
                    if t == "-c" {
                        tokens.next();
                    }
                }
                _ => rest.push(t),
            }
        }
        if rest.is_empty() {
            params.remove("options");
        } else {
            params.insert("options".into(), rest.join(" "));
        }
    }

    if let Some(host) = sni
        && let Some(label) = host.strip_suffix(&format!(".{}", app.cfg.domain))
    {
        // `<id>-pooler` is reserved for the upcoming pooler; route it directly for now.
        let id = label.strip_suffix("-pooler").unwrap_or(label);
        if exists(id) {
            return Some(id.into());
        }
    }
    if from_options.is_some() {
        return from_options;
    }
    if let Some(user) = params.get("user").cloned()
        && let Some((role, id)) = user.rsplit_once("--")
        && exists(id)
    {
        params.insert("user".into(), role.into());
        return Some(id.into());
    }
    None
}

async fn send_error<S: AsyncWrite + Unpin>(s: &mut S, code: &str, msg: &str) -> Result<()> {
    let mut body = BytesMut::new();
    for (tag, val) in [(b'S', "FATAL"), (b'V', "FATAL"), (b'C', code), (b'M', msg)] {
        body.put_u8(tag);
        body.put_slice(val.as_bytes());
        body.put_u8(0);
    }
    body.put_u8(0);
    let mut pkt = BytesMut::new();
    pkt.put_u8(b'E');
    pkt.put_i32(body.len() as i32 + 4);
    pkt.put_slice(&body);
    s.write_all(&pkt).await?;
    s.flush().await?;
    Ok(())
}

async fn session<S>(app: Arc<App>, mut client: S, code: i32, body: Vec<u8>, sni: Option<String>) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    if code != PROTOCOL_V3 {
        send_error(&mut client, "0A000", "unsupported frontend protocol").await?;
        bail!("unsupported protocol {code}");
    }
    let mut params = parse_params(&body)?;
    let Some(id) = route(&app, &mut params, sni.as_deref()) else {
        let msg = format!(
            "barua: unknown database; connect to <database-id>.{} with sslmode=require",
            app.cfg.domain
        );
        send_error(&mut client, "3D000", &msg).await?;
        bail!("no database in startup packet (sni={sni:?})");
    };
    if app.db(&id).is_err() {
        send_error(
            &mut client,
            "3D000",
            &format!("barua: database {id} does not exist on this box"),
        )
        .await?;
        bail!("unknown database {id}");
    }

    // Count the session before waking so the reaper can't put the database
    // back to sleep between start-up and the first byte.
    let _guard = ConnectionGuard::new(app.runtime(&id));
    let db = match app.ensure_ready(&id).await {
        Ok(db) => db,
        Err(e) => {
            warn!(db = id, "wake failed: {e:#}");
            send_error(
                &mut client,
                "57P03",
                "barua: database is not available, try again shortly",
            )
            .await?;
            return Err(e);
        }
    };

    let mut server = TcpStream::connect(("127.0.0.1", db.port)).await?;
    server.set_nodelay(true)?;
    server.write_all(&encode_startup(&params)).await?;
    tokio::io::copy_bidirectional(&mut client, &mut server).await?;
    Ok(())
}

/// Cancel keys belong to one backend and we don't track which. Postgres
/// ignores keys that don't match, so sending the request to every running
/// database is safe and cheap.
async fn forward_cancel(app: &App, body: &[u8]) -> Result<()> {
    let mut pkt = BytesMut::new();
    pkt.put_i32(16);
    pkt.put_i32(CANCEL_REQUEST);
    pkt.put_slice(body);
    for (id, _) in app.running() {
        if let Ok(db) = app.db(&id)
            && let Ok(mut s) = TcpStream::connect(("127.0.0.1", db.port)).await
        {
            let _ = s.write_all(&pkt).await;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_roundtrip() {
        let mut p = BTreeMap::new();
        p.insert("user".to_string(), "alice".to_string());
        p.insert("database".to_string(), "app".to_string());
        let pkt = encode_startup(&p);
        assert_eq!(i32::from_be_bytes(pkt[0..4].try_into().unwrap()) as usize, pkt.len());
        assert_eq!(parse_params(&pkt[8..]).unwrap(), p);
    }
}
