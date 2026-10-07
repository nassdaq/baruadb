use std::sync::Arc;

use anyhow::{Context, Result, anyhow};
use tokio_rustls::TlsAcceptor;
use tokio_rustls::rustls::ServerConfig;

use crate::config::Config;

/// TLS for both the proxy and the agent API, from the wildcard certificate
/// for `*.db.barua.tz`. `alpn` is set for the HTTP API only.
pub fn acceptor(cfg: &Config, alpn: &[&[u8]]) -> Result<Option<TlsAcceptor>> {
    let (Some(cert), Some(key)) = (&cfg.tls_cert, &cfg.tls_key) else {
        return Ok(None);
    };
    let certs = rustls_pemfile::certs(&mut std::io::BufReader::new(
        std::fs::File::open(cert).with_context(|| format!("opening {cert:?}"))?,
    ))
    .collect::<Result<Vec<_>, _>>()?;
    let key = rustls_pemfile::private_key(&mut std::io::BufReader::new(
        std::fs::File::open(key).with_context(|| format!("opening {key:?}"))?,
    ))?
    .ok_or_else(|| anyhow!("no private key in {key:?}"))?;
    let provider = Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
    let mut config = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(certs, key)?;
    config.alpn_protocols = alpn.iter().map(|p| p.to_vec()).collect();
    Ok(Some(TlsAcceptor::from(Arc::new(config))))
}
