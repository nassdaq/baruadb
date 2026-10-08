//! Postgres lifecycle for the databases on this box.
//!
//! ```text
//!  create ──► Ready/Local ──(idle)──► asleep (stopped, on disk) ──(disk pressure)──► Cold (R2 only)
//!                 ▲                          │                                            │
//!                 └──────── wake (~1 s) ─────┘◄──────── restore from R2 (seconds) ────────┘
//! ```
//!
//! Every database is its own Postgres cluster: own process, own port, own
//! cgroup, own WAL archive in R2.

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tracing::{info, warn};

use crate::app::{App, ConnectionGuard, DbRecord, Location, Status, random_string};
use crate::lsn::{Lsn, WAL_SEGMENT_MB, segno_of_wal_name};
use crate::storage::{SnapshotInfo, SnapshotKind};

pub const ADMIN_ROLE: &str = "barua_admin";

/// Long enough for an honest query over a slow link, short enough that a
/// runaway one cannot hold a shared box.
const QUERY_TIMEOUT_SECS: u32 = 15;

/// Rows come back as text, exactly as the server renders them: one code path
/// for every type, including ones no driver knows about.
#[derive(Debug, Default, Serialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    /// True when the row cap was hit and later rows were dropped.
    pub truncated: bool,
    pub rows_affected: Option<u64>,
    pub ms: u64,
}

/// Quote an identifier for interpolation into SQL, doubling any embedded quote.
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// How far to replay when restoring from object storage.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Target {
    /// Everything that was archived.
    Latest,
    Lsn(Lsn),
    Time(DateTime<Utc>),
}

async fn run(cmd: &mut Command) -> Result<String> {
    let out = cmd
        .output()
        .await
        .with_context(|| format!("spawning {:?}", cmd.as_std().get_program()))?;
    if !out.status.success() {
        bail!(
            "{} failed ({}): {}{}",
            Path::new(cmd.as_std().get_program()).display(),
            out.status,
            String::from_utf8_lossy(&out.stdout).trim(),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn conf_str(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}
pub fn ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
pub fn literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

pub fn valid_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 63
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
        && s.as_bytes()[0].is_ascii_lowercase()
}

/// `pg_hba.conf`. The maintenance role has no password and only ever
/// arrives over the box-local socket; the reject lines make that a rule
/// rather than a consequence, so a customer typing its name into a client
/// is refused before any password is looked at.
fn hba() -> String {
    format!(
        "\
# Managed by barua. Admin access only over the box-local unix socket.
local all all trust
local replication all trust
host all {admin} 0.0.0.0/0 reject
host all {admin} ::/0 reject
host all all 127.0.0.1/32 scram-sha-256
host all all ::1/128 scram-sha-256
",
        admin = ADMIN_ROLE
    )
}

/// What a customer sees when they open their database in a client is the
/// whole cluster: every role and every database, including ours. Postgres
/// cannot hide a role name, so the next best thing: say plainly what it is,
/// and close the doors around it. Idempotent; run on creation and after
/// every wake, so databases from before this get it too.
fn tidy_sql() -> String {
    format!(
        "COMMENT ON ROLE {admin} IS 'Barua Database maintenance role: takes backups and handles sleep and wake. Not for use by applications.';
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
COMMENT ON DATABASE postgres IS 'Maintenance database used by Barua. Your data is not here.';",
        admin = ident(ADMIN_ROLE)
    )
}

impl App {
    fn exe(&self) -> Result<String> {
        Ok(std::env::current_exe()?.to_string_lossy().into_owned())
    }

    /// One pre-initialised empty cluster; new databases are copies of it,
    /// which takes well under a second instead of a full initdb.
    pub async fn ensure_template(&self) -> Result<()> {
        let _g = self.template_lock.lock().await;
        let dir = self.cfg.template_dir();
        if dir.join("PG_VERSION").exists() {
            return Ok(());
        }
        let tmp = self.cfg.data_dir.join("template.tmp");
        let _ = tokio::fs::remove_dir_all(&tmp).await;
        run(Command::new(self.cfg.pg("initdb"))
            .arg("-D")
            .arg(&tmp)
            .args(["-U", ADMIN_ROLE, "-E", "UTF8", "--locale=C.UTF-8", "--auth-local=trust"])
            .args(["--auth-host=scram-sha-256", "--data-checksums", "--no-instructions"])
            .arg(format!("--wal-segsize={WAL_SEGMENT_MB}")))
        .await?;
        let conf = tmp.join("postgresql.conf");
        let mut text = tokio::fs::read_to_string(&conf).await?;
        text.push_str("\ninclude_if_exists 'barua.conf'\n");
        tokio::fs::write(&conf, text).await?;
        tokio::fs::write(tmp.join("pg_hba.conf"), hba()).await?;
        tokio::fs::rename(&tmp, &dir).await?;
        info!("template cluster ready");
        Ok(())
    }

    async fn write_conf(&self, db: &DbRecord, restore: Option<(&str, Target)>) -> Result<()> {
        let exe = self.exe()?;
        let mut c = vec![
            format!("port = {}", db.port),
            "listen_addresses = '127.0.0.1'".into(),
            format!(
                "unix_socket_directories = {}",
                conf_str(&self.db_dir(&db.id).to_string_lossy())
            ),
            format!("max_connections = {}", self.cfg.db_max_connections),
            "superuser_reserved_connections = 3".into(),
            // Small per-database footprint; the OS page cache is shared.
            "shared_buffers = '32MB'".into(),
            "work_mem = '4MB'".into(),
            "maintenance_work_mem = '32MB'".into(),
            "min_wal_size = '32MB'".into(),
            "max_wal_size = '256MB'".into(),
            "wal_level = replica".into(),
            "wal_compression = on".into(),
            "max_wal_senders = 3".into(),
            "archive_mode = on".into(),
            format!(
                "archive_command = {}",
                conf_str(&format!("{exe} wal-push --db {} %p %f", db.id))
            ),
            // Close a segment at least this often when there was activity:
            // a lost box loses at most this many seconds of commits, and R2
            // sees at most one PUT per interval.
            format!(
                "archive_timeout = {}",
                db.archive_timeout_secs.unwrap_or(self.cfg.archive_timeout_secs)
            ),
            "log_line_prefix = '%m [%p] %q%u@%d '".into(),
        ];
        if let Some((source, target)) = restore {
            c.push(format!(
                "restore_command = {}",
                conf_str(&format!("{exe} wal-fetch --db {source} %f %p"))
            ));
            c.push("recovery_target_action = 'promote'".into());
            match target {
                Target::Latest => {}
                Target::Lsn(l) => c.push(format!("recovery_target_lsn = '{l}'")),
                Target::Time(t) => c.push(format!("recovery_target_time = {}", conf_str(&t.to_rfc3339()))),
            }
        }
        c.push(String::new());
        let pgdata = self.pgdata(&db.id);
        tokio::fs::write(pgdata.join("barua.conf"), c.join("\n")).await?;
        tokio::fs::write(pgdata.join("pg_hba.conf"), hba()).await?;
        Ok(())
    }

    /// Start Postgres inside the database's cgroup.
    async fn start_pg(&self, id: &str) -> Result<()> {
        let procs = self.cgroups.prepare(id, &self.cfg.db_memory_max, &self.cfg.db_cpu_max);
        let mut cmd = Command::new(self.cfg.pg("pg_ctl"));
        cmd.arg("-D")
            .arg(self.pgdata(id))
            .arg("-l")
            .arg(self.log_file(id))
            .args(["-w", "-t", "300", "start"]);
        if let Some(procs) = procs {
            // SAFETY: `enter` only uses async-signal-safe libc calls.
            unsafe {
                cmd.pre_exec(move || crate::cgroup::enter(&procs));
            }
        }
        run(&mut cmd)
            .await
            .map_err(|e| anyhow!("{e:#}\n--- postgres.log ---\n{}", self.log_tail(id)))?;

        // The pooler is a convenience, not a dependency: if it will not start,
        // the database is still up and reachable directly.
        if let Ok(db) = self.db(id)
            && let Err(e) = crate::pooler::start(self, &db).await
        {
            warn!(db = id, "pooler did not start: {e:#}");
        }
        Ok(())
    }

    async fn stop_pg(&self, id: &str, mode: &str) -> Result<()> {
        crate::pooler::stop(self, id).await;
        run(Command::new(self.cfg.pg("pg_ctl"))
            .arg("-D")
            .arg(self.pgdata(id))
            .args(["-m", mode, "-w", "-t", "120", "stop"]))
        .await?;
        Ok(())
    }

    pub fn log_tail(&self, id: &str) -> String {
        let s = std::fs::read_to_string(self.log_file(id)).unwrap_or_default();
        let lines: Vec<&str> = s.lines().collect();
        lines[lines.len().saturating_sub(15)..].join("\n")
    }

    pub async fn probe_running(&self, id: &str) -> bool {
        let out = Command::new(self.cfg.pg("pg_ctl"))
            .arg("-D")
            .arg(self.pgdata(id))
            .arg("status")
            .output()
            .await;
        matches!(out, Ok(o) if o.status.success())
    }

    /// Resync runtime state after an agent restart (Postgres outlives us).
    pub async fn recover_on_startup(&self) -> Result<()> {
        for id in self.db_ids() {
            let db = self.db(&id)?;
            if db.status == Status::Creating {
                warn!(db = id, "creation was interrupted by an agent restart");
                if self.probe_running(&id).await {
                    let _ = self.stop_pg(&id, "immediate").await;
                }
                self.update_db(&id, |d| {
                    d.status = Status::Failed;
                    d.error = Some("interrupted by agent restart".into());
                })?;
                continue;
            }
            let up = db.location == Location::Local && self.probe_running(&id).await;
            self.runtime(&id).set_running(up);
            // Postgres outlives the agent (KillMode=process), so a database
            // found running was started under whatever limits the previous
            // agent had. Limits are a box setting: write today's into its
            // live cgroup, which the kernel applies at once.
            if up {
                self.cgroups.prepare(&id, &self.cfg.db_memory_max, &self.cfg.db_cpu_max);
            }
        }
        Ok(())
    }

    /// Admin connection over the database's unix socket.
    pub async fn admin_client(&self, db: &DbRecord, dbname: &str) -> Result<tokio_postgres::Client> {
        let mut cfg = tokio_postgres::Config::new();
        cfg.host_path(self.db_dir(&db.id))
            .port(db.port)
            .user(ADMIN_ROLE)
            .dbname(dbname)
            .application_name("barua")
            .connect_timeout(Duration::from_secs(10));
        let (client, conn) = cfg.connect(tokio_postgres::NoTls).await?;
        tokio::spawn(conn);
        Ok(client)
    }

    /// Make sure the database can take a connection: restore it from R2 if
    /// it is cold, start it if it is asleep. Called on every proxied connect.
    pub async fn ensure_ready(&self, id: &str) -> Result<DbRecord> {
        let rt = self.runtime(id);
        let db = self.db(id)?;
        if db.fenced {
            bail!("database {id} has moved to another box");
        }
        if db.status != Status::Ready {
            bail!("database {id} is {:?}", db.status);
        }
        if rt.is_running() {
            return Ok(db);
        }
        let _g = rt.lifecycle.lock().await;
        let db = self.db(id)?;
        if rt.is_running() {
            return Ok(db);
        }
        let started = std::time::Instant::now();
        if db.location == Location::Cold {
            self.restore_into_place(&db, id, Target::Latest).await?;
            self.update_db(id, |d| d.location = Location::Local)?;
            info!(
                db = id,
                ms = started.elapsed().as_millis() as u64,
                "restored cold database from storage"
            );
        } else if !self.probe_running(id).await {
            // Both files are derived from config and the record: writing them
            // on every start means a changed knob reaches old databases too.
            self.write_conf(&db, None).await?;
            self.start_pg(id).await?;
        }
        rt.set_running(true);
        rt.touch();
        self.update_db(id, |d| d.last_used_at = Utc::now())?;
        info!(db = id, ms = started.elapsed().as_millis() as u64, "database awake");
        // A few milliseconds over the local socket; never a reason to fail
        // the wake a client is waiting on.
        match self.admin_client(&db, "postgres").await {
            Ok(c) => {
                if let Err(e) = c.batch_execute(&tidy_sql()).await {
                    warn!(db = id, "catalog tidy failed: {e:#}");
                }
            }
            Err(e) => warn!(db = id, "catalog tidy: no admin connection: {e:#}"),
        }
        self.db(id)
    }

    /// Unpack a snapshot of `source` into this database's directory and
    /// replay WAL up to `target`, then promote. Leaves Postgres running.
    async fn restore_into_place(&self, db: &DbRecord, source: &str, target: Target) -> Result<()> {
        let snaps = self.storage.list_snapshots(source).await?;
        let snap = snaps
            .iter()
            .rev()
            .find(|s| match target {
                Target::Latest => true,
                Target::Lsn(l) => s.end_lsn <= l,
                Target::Time(t) => s.taken_at <= t,
            })
            .cloned()
            .ok_or_else(|| anyhow!("no snapshot of {source} old enough for {target:?}"))?;

        let dir = self.db_dir(&db.id);
        let pgdata = self.pgdata(&db.id);
        tokio::fs::create_dir_all(&dir).await?;
        if pgdata.exists() {
            tokio::fs::remove_dir_all(&pgdata).await?;
        }
        self.storage.restore_snapshot(&snap, &pgdata).await?;
        set_mode_0700(&pgdata)?;
        for stale in ["postmaster.pid", "postmaster.opts", "standby.signal", "barua.conf"] {
            let _ = tokio::fs::remove_file(pgdata.join(stale)).await;
        }
        tokio::fs::write(pgdata.join("recovery.signal"), "").await?;
        self.write_conf(db, Some((source, target))).await?;
        self.start_pg(&db.id).await?;

        let deadline = std::time::Instant::now() + Duration::from_secs(3600);
        loop {
            let in_recovery = match self.admin_client(db, "postgres").await {
                Ok(c) => c.query_one("SELECT pg_is_in_recovery()", &[]).await?.get::<_, bool>(0),
                Err(_) if !self.probe_running(&db.id).await => {
                    bail!("postgres exited during recovery:\n{}", self.log_tail(&db.id))
                }
                Err(_) => true,
            };
            if !in_recovery {
                break;
            }
            if std::time::Instant::now() > deadline {
                bail!("recovery did not finish within an hour");
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        // Back to a normal config so later restarts don't re-enter recovery.
        self.write_conf(db, None).await
    }

    /// Create a database: either empty (from the template) or restored from
    /// `source`'s storage up to `target` (branches, point-in-time restores,
    /// moving a database between boxes). Runs in the background; poll status.
    pub async fn create(
        &self,
        id: &str,
        role: &str,
        database: &str,
        password: Option<&str>,
        source: Option<(&str, Target)>,
    ) -> Result<()> {
        let result = async {
            match source {
                None => {
                    let password = password.ok_or_else(|| anyhow!("password is required"))?;
                    self.create_empty(id, role, database, password).await?
                }
                Some((src, target)) => {
                    let db = self.db(id)?;
                    let rt = self.runtime(id);
                    let _g = rt.lifecycle.lock().await;
                    self.restore_into_place(&db, src, target).await?;
                    rt.set_running(true);
                    rt.touch();
                    if let Some(pw) = password {
                        let c = self.admin_client(&db, "postgres").await?;
                        c.batch_execute(&format!("ALTER ROLE {} PASSWORD {}", ident(role), literal(pw)))
                            .await?;
                    }
                }
            }
            // Own first snapshot: from now on this database never needs
            // anyone else's archive.
            self.snapshot_running(&self.db(id)?).await?;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        match &result {
            Ok(()) => self.update_db(id, |d| {
                d.status = Status::Ready;
                d.error = None;
            })?,
            Err(e) => {
                warn!(db = id, "create failed: {e:#}");
                if self.probe_running(id).await {
                    let _ = self.stop_pg(id, "immediate").await;
                }
                self.runtime(id).set_running(false);
                self.update_db(id, |d| {
                    d.status = Status::Failed;
                    d.error = Some(format!("{e:#}"));
                })?;
            }
        }
        result
    }

    async fn create_empty(&self, id: &str, role: &str, database: &str, password: &str) -> Result<()> {
        self.ensure_template().await?;
        let db = self.db(id)?;
        let rt = self.runtime(id);
        let _g = rt.lifecycle.lock().await;
        tokio::fs::create_dir_all(self.db_dir(id)).await?;
        run(Command::new("cp")
            .args(["-a", "--reflink=auto"])
            .arg(self.cfg.template_dir())
            .arg(self.pgdata(id)))
        .await?;
        self.write_conf(&db, None).await?;
        self.start_pg(id).await?;
        rt.set_running(true);
        rt.touch();
        let admin = self.admin_client(&db, "postgres").await?;
        // A normal (non-superuser) owner: customers can never reach the box.
        admin
            .batch_execute(&format!(
                "CREATE ROLE {} LOGIN CREATEDB CREATEROLE PASSWORD {}",
                ident(role),
                literal(password)
            ))
            .await?;
        // Separate statement: CREATE DATABASE can't run in a transaction block.
        admin
            .batch_execute(&format!("CREATE DATABASE {} OWNER {}", ident(database), ident(role)))
            .await?;
        admin.batch_execute(&tidy_sql()).await?;
        let c = self.admin_client(&db, database).await?;
        c.batch_execute(&format!("ALTER SCHEMA public OWNER TO {}", ident(role)))
            .await?;
        Ok(())
    }

    /// Online snapshot (pg_basebackup) of a database to storage.
    pub async fn snapshot(&self, id: &str) -> Result<SnapshotInfo> {
        let db = self.ensure_ready(id).await?;
        self.snapshot_running(&db).await
    }

    async fn snapshot_running(&self, db: &DbRecord) -> Result<SnapshotInfo> {
        let id = db.id.as_str();
        let _keep_awake = ConnectionGuard::new(self.runtime(id));
        let tmp = self
            .db_dir(id)
            .join(format!("snap-{}", random_string(6).to_lowercase()));
        let res = async {
            run(Command::new(self.cfg.pg("pg_basebackup"))
                .arg("-h")
                .arg(self.db_dir(id))
                .arg("-p")
                .arg(db.port.to_string())
                .args(["-U", ADMIN_ROLE, "-X", "fetch", "-c", "fast", "--no-sync", "-D"])
                .arg(&tmp))
            .await?;
            let (start, end) = manifest_wal_range(&tmp.join("backup_manifest")).await?;
            let taken_at = Utc::now();
            self.storage
                .upload_snapshot(id, &tmp, SnapshotKind::Online, taken_at, start, end)
                .await
        }
        .await;
        let _ = tokio::fs::remove_dir_all(&tmp).await;
        let info = res?;
        self.update_db(id, |d| {
            d.last_snapshot_at = Some(info.taken_at);
            d.last_snapshot_lsn = Some(info.end_lsn);
        })?;
        info!(db = id, key = info.key, "snapshot uploaded");
        Ok(info)
    }

    /// Bytes of WAL written since the last snapshot ended, read from the
    /// running server. `u64::MAX` when no snapshot has recorded an LSN yet,
    /// so such a database is snapshotted at the next opportunity.
    pub async fn wal_since_snapshot(&self, db: &DbRecord) -> Result<u64> {
        let Some(base) = db.last_snapshot_lsn else {
            return Ok(u64::MAX);
        };
        let c = self.admin_client(db, "postgres").await?;
        let cur: String = c.query_one("SELECT pg_current_wal_lsn()::text", &[]).await?.get(0);
        Ok(cur.parse::<Lsn>()?.0.saturating_sub(base.0))
    }

    /// Close the current WAL segment and wait until it is in storage.
    /// Returns the LSN everything up to which is now safely archived.
    async fn flush_wal(&self, db: &DbRecord) -> Result<Lsn> {
        let c = self.admin_client(db, "postgres").await?;
        let lsn: String = c.query_one("SELECT pg_current_wal_lsn()::text", &[]).await?.get(0);
        let lsn: Lsn = lsn.parse()?;
        c.simple_query("SELECT pg_switch_wal()").await?;
        let wanted: String = c
            .query_one("SELECT pg_walfile_name($1::text::pg_lsn)", &[&lsn.to_string()])
            .await?
            .get(0);
        let wanted = segno_of_wal_name(&wanted).unwrap_or(0);
        let deadline = std::time::Instant::now() + Duration::from_secs(120);
        loop {
            let row = c
                .query_one("SELECT coalesce(last_archived_wal, '') FROM pg_stat_archiver", &[])
                .await?;
            let last: String = row.get(0);
            if segno_of_wal_name(&last).is_some_and(|s| s >= wanted) {
                return Ok(lsn);
            }
            if std::time::Instant::now() > deadline {
                bail!("WAL archiving is behind (last archived {last:?}); check storage credentials");
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    /// Run SQL on a customer's behalf, for the dashboard's table browser and
    /// SQL editor.
    ///
    /// The agent is the only thing holding a privileged local connection, so
    /// the alternative would be handing database passwords to a browser. It
    /// connects as the admin over the unix socket and then drops to the
    /// customer's own role, which means this endpoint can never read or change
    /// anything the owner of the database could not. A statement timeout keeps
    /// one bad query from pinning a shared box, and rows are capped so a
    /// `SELECT *` on a large table cannot be turned into a denial of service.
    pub async fn query(&self, id: &str, sql: &str, limit: usize) -> Result<QueryResult> {
        use tokio_postgres::SimpleQueryMessage;

        let db = self.ensure_ready(id).await?;
        let _conn = ConnectionGuard::new(self.runtime(id));
        let client = self.admin_client(&db, &db.database).await?;
        client
            .batch_execute(&format!(
                "SET ROLE {}; SET statement_timeout = '{}s'; \
                 SET idle_in_transaction_session_timeout = '30s';",
                quote_ident(&db.role),
                QUERY_TIMEOUT_SECS,
            ))
            .await
            .context("preparing the session")?;

        let started = std::time::Instant::now();
        let messages = client.simple_query(sql).await?;
        let ms = started.elapsed().as_millis() as u64;

        let mut out = QueryResult { ms, ..Default::default() };
        for message in messages {
            match message {
                SimpleQueryMessage::RowDescription(columns) => {
                    out.columns = columns.iter().map(|c| c.name().to_string()).collect();
                }
                SimpleQueryMessage::Row(row) => {
                    if out.columns.is_empty() {
                        out.columns = row.columns().iter().map(|c| c.name().to_string()).collect();
                    }
                    if out.rows.len() >= limit {
                        out.truncated = true;
                        continue;
                    }
                    out.rows.push((0..row.len()).map(|i| row.get(i).map(str::to_string)).collect());
                }
                SimpleQueryMessage::CommandComplete(n) => out.rows_affected = Some(n),
                _ => {}
            }
        }
        Ok(out)
    }

    /// For branching "from now": everything up to the returned LSN is in
    /// storage. `None` means the database is stopped and fully archived, so
    /// branch from its latest state.
    pub async fn sync(&self, id: &str) -> Result<Option<Lsn>> {
        let db = self.db(id)?;
        let rt = self.runtime(id);
        let _g = rt.lifecycle.lock().await;
        if !rt.is_running() {
            return Ok(None);
        }
        let lsn = self.flush_wal(&db).await?;
        // Nothing was written since the previous switch, so the LSN rests on a
        // segment boundary. pg_switch_wal() does not open a segment for it and
        // no archived WAL ever reaches it, so recovering to it dies with
        // "recovery ended before configured recovery target was reached".
        // "Now" and "everything archived" are the same point here.
        if lsn.is_segment_boundary() {
            return Ok(None);
        }
        Ok(Some(lsn))
    }

    /// Stop an idle database (scale to zero). `force` ignores open sessions.
    pub async fn suspend(&self, id: &str, force: bool) -> Result<bool> {
        let rt = self.runtime(id);
        let _g = rt.lifecycle.lock().await;
        if !rt.is_running() || (!force && rt.connections() > 0) {
            return Ok(false);
        }
        let db = self.db(id)?;
        if let Err(e) = self.flush_wal(&db).await {
            warn!(db = id, "could not flush WAL before suspend: {e:#}");
        }
        self.stop_pg(id, "fast").await?;
        rt.set_running(false);
        self.update_db(id, |d| d.last_used_at = Utc::now())?;
        info!(db = id, "database asleep");
        Ok(true)
    }

    /// Push a sleeping database entirely to storage and free its disk.
    pub async fn evict(&self, id: &str) -> Result<bool> {
        let db = self.db(id)?;
        if db.location == Location::Cold || db.status != Status::Ready {
            return Ok(false);
        }
        if self.runtime(id).is_running() && !self.suspend(id, false).await? {
            return Ok(false); // in use
        }
        let rt = self.runtime(id);
        let _g = rt.lifecycle.lock().await;
        if rt.is_running() {
            return Ok(false);
        }
        let pgdata = self.pgdata(id);
        let control = run(Command::new(self.cfg.pg("pg_controldata")).arg("-D").arg(&pgdata)).await?;
        let state = control_field(&control, "Database cluster state").unwrap_or_default();
        if state != "shut down" {
            bail!("refusing to evict {id}: cluster state is {state:?}");
        }
        let ckpt: Lsn = control_field(&control, "Latest checkpoint location")
            .ok_or_else(|| anyhow!("no checkpoint"))?
            .parse()?;
        let redo: Lsn = control_field(&control, "Latest checkpoint's REDO location")
            .ok_or_else(|| anyhow!("no redo"))?
            .parse()?;
        let info = self
            .storage
            .upload_snapshot(id, &pgdata, SnapshotKind::Cold, Utc::now(), redo, ckpt)
            .await?;
        tokio::fs::remove_dir_all(&pgdata).await?;
        let _ = tokio::fs::remove_file(self.log_file(id)).await;
        self.update_db(id, |d| {
            d.location = Location::Cold;
            d.last_snapshot_at = Some(info.taken_at);
            d.last_snapshot_lsn = Some(info.end_lsn);
        })?;
        info!(db = id, "database evicted to storage");
        Ok(true)
    }

    /// Hand a database over to another box: push it to storage and forget it.
    pub async fn release(&self, id: &str) -> Result<()> {
        let db = self.db(id)?;
        if db.location == Location::Local {
            if self.runtime(id).is_running() {
                self.suspend(id, true).await?;
            }
            if !self.evict(id).await? {
                bail!("could not push {id} to storage");
            }
        }
        self.forget(id).await
    }

    async fn forget(&self, id: &str) -> Result<()> {
        let rt = self.runtime(id);
        let _g = rt.lifecycle.lock().await;
        if self.probe_running(id).await {
            let _ = self.stop_pg(id, "immediate").await;
        }
        rt.set_running(false);
        let dir = self.db_dir(id);
        if dir.exists() {
            tokio::fs::remove_dir_all(&dir).await?;
        }
        self.cgroups.remove(id);
        self.update_meta(|m| {
            m.databases.remove(id);
            Ok(())
        })
    }

    pub async fn delete(&self, id: &str, purge: bool) -> Result<()> {
        self.forget(id).await?;
        if purge {
            self.storage.purge(id).await?;
        }
        info!(db = id, purge, "database deleted");
        Ok(())
    }

    pub async fn set_password(&self, id: &str, password: &str) -> Result<()> {
        let db = self.ensure_ready(id).await?;
        let _g = ConnectionGuard::new(self.runtime(id));
        let c = self.admin_client(&db, "postgres").await?;
        c.batch_execute(&format!(
            "ALTER ROLE {} PASSWORD {}",
            ident(&db.role),
            literal(password)
        ))
        .await?;
        Ok(())
    }

    /// Stop serving a database the control plane has placed elsewhere.
    pub async fn fence(&self, id: &str) -> Result<()> {
        self.update_db(id, |d| d.fenced = true)?;
        let rt = self.runtime(id);
        let _g = rt.lifecycle.lock().await;
        if self.probe_running(id).await {
            self.stop_pg(id, "fast").await?;
        }
        rt.set_running(false);
        warn!(db = id, "database fenced: the control plane placed it on another box");
        Ok(())
    }
}

fn control_field(out: &str, key: &str) -> Option<String> {
    out.lines().find_map(|l| {
        l.strip_prefix(key)?
            .trim_start()
            .strip_prefix(':')
            .map(|v| v.trim().to_string())
    })
}

/// Start/end WAL positions of a base backup, from its backup_manifest.
async fn manifest_wal_range(path: &Path) -> Result<(Lsn, Lsn)> {
    let v: serde_json::Value = serde_json::from_slice(&tokio::fs::read(path).await?)?;
    let ranges = v["WAL-Ranges"]
        .as_array()
        .ok_or_else(|| anyhow!("backup_manifest has no WAL-Ranges"))?;
    let start = ranges
        .first()
        .and_then(|r| r["Start-LSN"].as_str())
        .ok_or_else(|| anyhow!("no Start-LSN"))?;
    let end = ranges
        .last()
        .and_then(|r| r["End-LSN"].as_str())
        .ok_or_else(|| anyhow!("no End-LSN"))?;
    Ok((start.parse()?, end.parse()?))
}

fn set_mode_0700(p: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}
