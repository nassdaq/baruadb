//! Transaction pooling, so a busy application can hold many connections
//! without paying for a Postgres backend per connection.
//!
//! Forty direct connections to one database cost about 60 MB of the 512 MB a
//! database is allowed. Pooled, those same forty clients share ten backends.
//!
//! PgBouncer does the pooling. Each database gets its own instance on its own
//! port, started and stopped with its Postgres. Clients reach it by asking for
//! `<id>-pooler.<domain>`, which the proxy routes here instead of to Postgres.
//!
//! Authentication: PgBouncer verifies the client's SCRAM exchange itself,
//! fetching the stored verifier through `auth_query` as the admin role over the
//! box-local socket. Its own connections to Postgres go over that same socket,
//! which pg_hba trusts. No password is ever written to disk.

use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use tokio::process::Command;
use tracing::{info, warn};

use crate::app::{App, DbRecord};
use crate::pg::ADMIN_ROLE;

/// Pooler ports live in their own range so they can never collide with the
/// densely allocated Postgres ports.
pub fn port(app: &App, db: &DbRecord) -> u16 {
    app.cfg.pooler_port_base + (db.port - app.cfg.port_base)
}

fn ini_path(app: &App, id: &str) -> PathBuf {
    app.db_dir(id).join("pgbouncer.ini")
}

fn pid_path(app: &App, id: &str) -> PathBuf {
    app.db_dir(id).join("pgbouncer.pid")
}

fn config(app: &App, db: &DbRecord) -> String {
    let dir = app.db_dir(&db.id);
    format!(
        "# Managed by barua. Regenerated every time this database starts.
[databases]
{dbname} = host={socket} port={pgport} dbname={dbname} auth_user={admin}

[pgbouncer]
listen_addr = 127.0.0.1
listen_port = {listen}
unix_socket_dir = {dir}

# The client proves its password to PgBouncer; PgBouncer looks the verifier up
# as the admin role over the local socket, which pg_hba trusts.
auth_type = scram-sha-256
auth_user = {admin}
auth_dbname = {dbname}
auth_query = SELECT usename, passwd FROM pg_shadow WHERE usename = $1

# Transaction pooling: a backend is returned to the pool at the end of every
# transaction. Session state does not survive, which is the trade being made.
pool_mode = transaction
default_pool_size = {pool}
max_client_conn = {clients}
reserve_pool_size = 2
reserve_pool_timeout = 3
server_idle_timeout = 120
server_lifetime = 900

# libpq sends these and a pooled backend cannot honour them per session.
ignore_startup_parameters = extra_float_digits,options,search_path

logfile = {dir}/pgbouncer.log
pidfile = {pid}
",
        dbname = db.database,
        socket = dir.display(),
        pgport = db.port,
        admin = ADMIN_ROLE,
        listen = port(app, db),
        dir = dir.display(),
        pool = app.cfg.pooler_pool_size,
        clients = app.cfg.pooler_max_clients,
        pid = pid_path(app, &db.id).display(),
    )
}

/// Start the pooler for a database that is already up. Never fatal: a database
/// without a pooler still serves direct connections.
pub async fn start(app: &App, db: &DbRecord) -> Result<()> {
    if !app.cfg.pooler {
        return Ok(());
    }
    let ini = ini_path(app, &db.id);
    tokio::fs::write(&ini, config(app, db)).await.context("writing pgbouncer.ini")?;

    let procs = app.cgroups.prepare(&db.id, &app.cfg.db_memory_max, &app.cfg.db_cpu_max);
    let mut cmd = Command::new(&app.cfg.pgbouncer_bin);
    cmd.arg("-d").arg(&ini).kill_on_drop(false);
    if let Some(procs) = procs {
        // SAFETY: `enter` only uses async-signal-safe libc calls.
        unsafe {
            cmd.pre_exec(move || crate::cgroup::enter(&procs));
        }
    }
    let out = cmd.output().await.context("starting pgbouncer")?;
    if !out.status.success() {
        bail!(
            "pgbouncer refused to start: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    info!(db = db.id, port = port(app, db), "pooler listening");
    Ok(())
}

/// Stop the pooler, if one is running. Called wherever Postgres is stopped.
pub async fn stop(app: &App, id: &str) {
    let pid_file = pid_path(app, id);
    let Ok(text) = tokio::fs::read_to_string(&pid_file).await else {
        return;
    };
    let Ok(pid) = text.trim().parse::<i32>() else {
        return;
    };
    // SIGINT asks PgBouncer to finish what it is doing and exit.
    unsafe {
        libc::kill(pid, libc::SIGINT);
    }
    if let Err(e) = tokio::fs::remove_file(&pid_file).await
        && e.kind() != std::io::ErrorKind::NotFound
    {
        warn!(db = id, "could not remove pgbouncer.pid: {e}");
    }
}
