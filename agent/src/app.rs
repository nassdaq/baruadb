//! Agent state: the databases this box hosts (persisted in state.json) and
//! their runtime bookkeeping (running? how many connections?).

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{Context, Result, anyhow};
use chrono::{DateTime, Utc};
use rand::Rng;
use rand::distr::Alphanumeric;
use serde::{Deserialize, Serialize};

use crate::cgroup::Cgroups;
use crate::config::Config;
use crate::storage::Storage;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Being created or restored.
    Creating,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Location {
    /// Data directory is on this box's disk.
    Local,
    /// Only in object storage; restored on next connection.
    Cold,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbRecord {
    pub id: String,
    pub role: String,
    pub database: String,
    pub port: u16,
    /// Database this one was branched from (informational; once ready a
    /// database only ever restores from its own snapshots and WAL).
    pub parent: Option<String>,
    pub status: Status,
    pub location: Location,
    pub error: Option<String>,
    /// The control plane moved this database elsewhere: never wake it here.
    pub fenced: bool,
    pub created_at: DateTime<Utc>,
    pub last_used_at: DateTime<Utc>,
    pub last_snapshot_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Meta {
    pub databases: BTreeMap<String, DbRecord>,
}

/// Credentials handed out by the control plane when this box joined.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Identity {
    pub box_id: String,
    pub agent_token: String,
}

pub struct Runtime {
    /// Serialises start/stop/restore/snapshot for one database.
    pub lifecycle: tokio::sync::Mutex<()>,
    pub running: AtomicBool,
    pub connections: AtomicUsize,
    last_active: Mutex<Instant>,
}

impl Runtime {
    fn new() -> Self {
        Self {
            lifecycle: tokio::sync::Mutex::new(()),
            running: AtomicBool::new(false),
            connections: AtomicUsize::new(0),
            last_active: Mutex::new(Instant::now()),
        }
    }
    pub fn touch(&self) {
        *self.last_active.lock().unwrap() = Instant::now();
    }
    pub fn idle_for(&self) -> std::time::Duration {
        self.last_active.lock().unwrap().elapsed()
    }
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
    pub fn set_running(&self, v: bool) {
        self.running.store(v, Ordering::SeqCst)
    }
    pub fn connections(&self) -> usize {
        self.connections.load(Ordering::SeqCst)
    }
}

/// Holds a database awake while a client session (or internal job) lives.
pub struct ConnectionGuard(Arc<Runtime>);

impl ConnectionGuard {
    pub fn new(rt: Arc<Runtime>) -> Self {
        rt.connections.fetch_add(1, Ordering::SeqCst);
        rt.touch();
        Self(rt)
    }
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.0.touch();
        self.0.connections.fetch_sub(1, Ordering::SeqCst);
    }
}

pub struct App {
    pub cfg: Config,
    pub storage: Storage,
    pub cgroups: Cgroups,
    meta: Mutex<Meta>,
    runtimes: Mutex<HashMap<String, Arc<Runtime>>>,
    pub identity: Mutex<Option<Identity>>,
    /// Ensures only one template initdb runs at a time.
    pub template_lock: tokio::sync::Mutex<()>,
}

pub fn random_string(len: usize) -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(len)
        .map(char::from)
        .collect()
}

fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

impl App {
    pub fn load(cfg: Config, cgroups: Cgroups) -> Result<Arc<Self>> {
        std::fs::create_dir_all(cfg.dbs_dir())?;
        let cfg = Config {
            data_dir: std::fs::canonicalize(&cfg.data_dir)?,
            ..cfg
        };
        let meta = match std::fs::read(cfg.state_file()) {
            Ok(b) => serde_json::from_slice(&b).context("parsing state.json")?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Meta::default(),
            Err(e) => return Err(e.into()),
        };
        let identity = match std::fs::read(cfg.identity_file()) {
            Ok(b) => Some(serde_json::from_slice(&b).context("parsing identity.json")?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        let storage = Storage::from_config(&cfg.storage)?;
        Ok(Arc::new(Self {
            cfg,
            storage,
            cgroups,
            meta: Mutex::new(meta),
            runtimes: Mutex::new(HashMap::new()),
            identity: Mutex::new(identity),
            template_lock: tokio::sync::Mutex::new(()),
        }))
    }

    pub fn save_identity(&self, id: Identity) -> Result<()> {
        write_atomic(&self.cfg.identity_file(), &serde_json::to_vec_pretty(&id)?)?;
        *self.identity.lock().unwrap() = Some(id);
        Ok(())
    }

    /// The bearer token the API accepts.
    pub fn api_token(&self) -> Option<String> {
        self.identity
            .lock()
            .unwrap()
            .as_ref()
            .map(|i| i.agent_token.clone())
            .or_else(|| self.cfg.agent_token.clone())
    }

    pub fn meta<T>(&self, f: impl FnOnce(&Meta) -> T) -> T {
        f(&self.meta.lock().unwrap())
    }

    /// Mutate metadata and persist it atomically.
    pub fn update_meta<T>(&self, f: impl FnOnce(&mut Meta) -> Result<T>) -> Result<T> {
        let mut meta = self.meta.lock().unwrap();
        let out = f(&mut meta)?;
        write_atomic(&self.cfg.state_file(), &serde_json::to_vec_pretty(&*meta)?)?;
        Ok(out)
    }

    pub fn update_db(&self, id: &str, f: impl FnOnce(&mut DbRecord)) -> Result<()> {
        self.update_meta(|m| {
            let db = m
                .databases
                .get_mut(id)
                .ok_or_else(|| anyhow!("database {id} not found"))?;
            f(db);
            Ok(())
        })
    }

    pub fn db(&self, id: &str) -> Result<DbRecord> {
        self.meta(|m| m.databases.get(id).cloned())
            .ok_or_else(|| anyhow!("database {id} not found"))
    }

    pub fn db_ids(&self) -> Vec<String> {
        self.meta(|m| m.databases.keys().cloned().collect())
    }

    pub fn runtime(&self, id: &str) -> Arc<Runtime> {
        self.runtimes
            .lock()
            .unwrap()
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(Runtime::new()))
            .clone()
    }

    pub fn running(&self) -> Vec<(String, Arc<Runtime>)> {
        self.runtimes
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, r)| r.is_running())
            .map(|(i, r)| (i.clone(), r.clone()))
            .collect()
    }

    pub fn db_dir(&self, id: &str) -> PathBuf {
        self.cfg.dbs_dir().join(id)
    }
    pub fn pgdata(&self, id: &str) -> PathBuf {
        self.db_dir(id).join("pgdata")
    }
    pub fn log_file(&self, id: &str) -> PathBuf {
        self.db_dir(id).join("postgres.log")
    }
}
