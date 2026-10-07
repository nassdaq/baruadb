//! Background jobs: put idle databases to sleep, push sleeping ones to R2
//! when disk runs low, take snapshots, prune old history, and talk to the
//! control plane (join + heartbeat).

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::app::{App, Identity, Location, Status};
use crate::stats::{BoxStats, disk_usage};

pub fn spawn_all(app: Arc<App>) {
    tokio::spawn(sleeper(app.clone()));
    tokio::spawn(evictor(app.clone()));
    tokio::spawn(snapshotter(app.clone()));
    tokio::spawn(pruner(app.clone()));
    tokio::spawn(control_loop(app));
}

/// Scale to zero: stop databases with no sessions for `suspend_after`.
async fn sleeper(app: Arc<App>) {
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    loop {
        tick.tick().await;
        for (id, rt) in app.running() {
            if rt.connections() == 0
                && rt.idle_for() > app.cfg.suspend_after()
                && let Err(e) = app.suspend(&id, false).await
            {
                warn!(db = id, "suspend failed: {e:#}");
            }
        }
    }
}

fn free_pct(app: &App) -> u64 {
    let (total, free) = disk_usage(&app.cfg.data_dir);
    (free * 100).checked_div(total).unwrap_or(100)
}

/// Keep the disk small: least recently used sleeping databases go to R2.
async fn evictor(app: Arc<App>) {
    let mut tick = tokio::time::interval(Duration::from_secs(60));
    loop {
        tick.tick().await;
        let mut candidates: Vec<_> = app.meta(|m| {
            m.databases
                .values()
                .filter(|d| d.status == Status::Ready && d.location == Location::Local && !d.fenced)
                .cloned()
                .collect()
        });
        candidates.retain(|d| !app.runtime(&d.id).is_running());
        candidates.sort_by_key(|d| d.last_used_at);
        let cold_after = chrono::Duration::hours(app.cfg.cold_after_hours as i64);
        for db in candidates {
            let stale = app.cfg.cold_after_hours > 0 && Utc::now() - db.last_used_at > cold_after;
            if !stale && free_pct(&app) >= app.cfg.min_free_disk_pct {
                continue;
            }
            match app.evict(&db.id).await {
                Ok(true) => info!(db = db.id, free_pct = free_pct(&app), "evicted to free disk"),
                Ok(false) => {}
                Err(e) => warn!(db = db.id, "eviction failed: {e:#}"),
            }
        }
    }
}

/// Fresh snapshots bound how much WAL a restore has to replay.
async fn snapshotter(app: Arc<App>) {
    let mut tick = tokio::time::interval(Duration::from_secs(600));
    let every = chrono::Duration::hours(app.cfg.snapshot_every_hours.max(1) as i64);
    loop {
        tick.tick().await;
        let due: Vec<String> = app.meta(|m| {
            m.databases
                .values()
                .filter(|d| d.status == Status::Ready && d.location == Location::Local && !d.fenced)
                .filter(|d| d.last_snapshot_at.is_none_or(|t| Utc::now() - t > every))
                .map(|d| d.id.clone())
                .collect()
        });
        for id in due {
            // Only awake databases change; sleeping ones keep their last snapshot.
            if app.runtime(&id).is_running()
                && let Err(e) = app.snapshot(&id).await
            {
                warn!(db = id, "scheduled snapshot failed: {e:#}");
            }
        }
    }
}

/// Drop snapshots and WAL outside the point-in-time window.
async fn pruner(app: Arc<App>) {
    let mut tick = tokio::time::interval(Duration::from_secs(6 * 3600));
    loop {
        tick.tick().await;
        let cutoff = Utc::now() - chrono::Duration::days(app.cfg.retention_days as i64);
        for id in app.db_ids() {
            match app.storage.prune(&id, cutoff).await {
                Ok(0) => {}
                Ok(n) => info!(db = id, objects = n, "pruned old history"),
                Err(e) => warn!(db = id, "prune failed: {e:#}"),
            }
        }
    }
}

#[derive(Serialize)]
struct JoinReq<'a> {
    name: &'a str,
    public_ip: &'a str,
    stats: BoxStats,
}

#[derive(Deserialize)]
struct JoinResp {
    box_id: String,
    agent_token: String,
}

#[derive(Serialize)]
struct DbBeat {
    id: String,
    status: Status,
    location: Location,
    running: bool,
    connections: usize,
    /// Resource use, when the database is up and cgroups are available.
    #[serde(skip_serializing_if = "Option::is_none")]
    memory_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cpu_usec: Option<u64>,
    /// Postgres' own counters, cumulative since the cluster started.
    #[serde(skip_serializing_if = "Option::is_none")]
    pg: Option<PgCounters>,
}

/// Straight from pg_stat_database. All cumulative; rates are the reader's job.
#[derive(Serialize, Default)]
struct PgCounters {
    tup_inserted: i64,
    tup_updated: i64,
    tup_deleted: i64,
    tup_fetched: i64,
    deadlocks: i64,
    blks_hit: i64,
    blks_read: i64,
    xact_commit: i64,
    xact_rollback: i64,
}

#[derive(Serialize)]
struct Heartbeat {
    stats: BoxStats,
    databases: Vec<DbBeat>,
}

#[derive(Deserialize)]
struct HeartbeatResp {
    /// Databases the control plane has placed on this box.
    databases: Option<Vec<String>>,
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .expect("http client")
}

async fn join(app: &App, url: &str) -> Result<Identity> {
    let token = app
        .cfg
        .join_token
        .as_deref()
        .ok_or_else(|| anyhow!("BARUA_JOIN_TOKEN is required to join"))?;
    let ip = app
        .cfg
        .public_ip
        .as_deref()
        .ok_or_else(|| anyhow!("BARUA_PUBLIC_IP is required to join"))?;
    let name = app.cfg.box_name.clone().unwrap_or_else(|| {
        std::fs::read_to_string("/etc/hostname")
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| "box".into())
    });
    let resp = http()
        .post(format!("{url}/v1/boxes/join"))
        .bearer_auth(token)
        .json(&JoinReq {
            name: &name,
            public_ip: ip,
            stats: BoxStats::collect(app),
        })
        .send()
        .await?;
    if !resp.status().is_success() {
        bail!(
            "join refused: {} {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        );
    }
    let j: JoinResp = resp.json().await?;
    Ok(Identity {
        box_id: j.box_id,
        agent_token: j.agent_token,
    })
}

async fn pg_counters(app: &App, id: &str) -> Result<PgCounters> {
    let db = app.db(id)?;
    let client = app.admin_client(&db, &db.database).await?;
    let row = client
        .query_one(
            "SELECT tup_inserted, tup_updated, tup_deleted, tup_fetched, deadlocks,
                    blks_hit, blks_read, xact_commit, xact_rollback
               FROM pg_stat_database WHERE datname = current_database()",
            &[],
        )
        .await?;
    Ok(PgCounters {
        tup_inserted: row.get(0),
        tup_updated: row.get(1),
        tup_deleted: row.get(2),
        tup_fetched: row.get(3),
        deadlocks: row.get(4),
        blks_hit: row.get(5),
        blks_read: row.get(6),
        xact_commit: row.get(7),
        xact_rollback: row.get(8),
    })
}

async fn heartbeat(app: &App, url: &str, id: &Identity) -> Result<()> {
    let mut databases: Vec<DbBeat> = app.meta(|m| {
        m.databases
            .values()
            .map(|d| {
                let rt = app.runtime(&d.id);
                DbBeat {
                    id: d.id.clone(),
                    status: d.status,
                    location: d.location,
                    running: rt.is_running(),
                    connections: rt.connections(),
                    memory_bytes: app.cgroups.memory_current(&d.id),
                    cpu_usec: app.cgroups.cpu_usec(&d.id),
                    pg: None,
                }
            })
            .collect()
    });

    // Ask the running databases for their own counters. One cheap query over
    // the local socket; a sleeping database is left alone so that reading a
    // graph never wakes anything.
    for beat in databases.iter_mut().filter(|b| b.running) {
        if let Ok(counters) = pg_counters(app, &beat.id).await {
            beat.pg = Some(counters);
        }
    }
    let resp = http()
        .post(format!("{url}/v1/boxes/{}/heartbeat", id.box_id))
        .bearer_auth(&id.agent_token)
        .json(&Heartbeat {
            stats: BoxStats::collect(app),
            databases,
        })
        .send()
        .await?;
    if !resp.status().is_success() {
        bail!(
            "heartbeat refused: {} {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        );
    }
    let r: HeartbeatResp = resp.json().await?;
    // Split-brain guard: never serve a database the control plane has moved.
    if let Some(assigned) = r.databases {
        let mine: Vec<_> = app.meta(|m| {
            m.databases
                .values()
                .filter(|d| !d.fenced && d.status != Status::Creating)
                .map(|d| d.id.clone())
                .collect()
        });
        for db in mine.into_iter().filter(|d| !assigned.contains(d)) {
            if let Err(e) = app.fence(&db).await {
                warn!(db, "fence failed: {e:#}");
            }
        }
    }
    Ok(())
}

async fn control_loop(app: Arc<App>) {
    let Some(url) = app.cfg.control_url.clone().map(|u| u.trim_end_matches('/').to_string()) else {
        info!("no BARUA_CONTROL_URL: running standalone");
        return;
    };
    let identity = loop {
        if let Some(id) = app.identity.lock().unwrap().clone() {
            break id;
        }
        match join(&app, &url).await {
            Ok(id) => {
                info!(box_id = id.box_id, "joined the cluster");
                if let Err(e) = app.save_identity(id.clone()) {
                    warn!("could not save identity: {e:#}");
                }
                break id;
            }
            Err(e) => {
                warn!("join failed, retrying in 30 s: {e:#}");
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
        }
    };
    let mut tick = tokio::time::interval(Duration::from_secs(20));
    loop {
        tick.tick().await;
        if let Err(e) = heartbeat(&app, &url, &identity).await {
            warn!("heartbeat failed: {e:#}");
        }
    }
}
