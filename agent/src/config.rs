use std::path::PathBuf;
use std::time::Duration;

use clap::Args;

/// Agent configuration. Every flag can also be set with its `BARUA_*`
/// environment variable; the systemd unit reads them from /etc/barua/barua.env.
#[derive(Args, Debug, Clone)]
pub struct Config {
    /// Root directory for local database copies and agent state.
    #[arg(long, env = "BARUA_DATA", default_value = "/var/lib/barua")]
    pub data_dir: PathBuf,

    /// Directory with the Postgres binaries (initdb, pg_ctl, ...).
    #[arg(long, env = "BARUA_PG_BIN", default_value = "/usr/lib/postgresql/16/bin")]
    pub pg_bin: PathBuf,

    /// Postgres wire-protocol proxy address.
    #[arg(long, env = "BARUA_PROXY_ADDR", default_value = "0.0.0.0:5432")]
    pub proxy_addr: String,

    /// Agent HTTP API address (used by the control plane).
    #[arg(long, env = "BARUA_API_ADDR", default_value = "0.0.0.0:443")]
    pub api_addr: String,

    /// DNS zone databases live under: `<id>.<domain>`.
    #[arg(long, env = "BARUA_DOMAIN", default_value = "db.barua.tz")]
    pub domain: String,

    /// This box's public IPv4 (reported to the control plane on join).
    #[arg(long, env = "BARUA_PUBLIC_IP")]
    pub public_ip: Option<String>,

    /// Human-friendly box name.
    #[arg(long, env = "BARUA_BOX_NAME")]
    pub box_name: Option<String>,

    /// Control plane URL, e.g. https://api.db.barua.tz. Without it the
    /// agent runs standalone and BARUA_AGENT_TOKEN guards its API.
    #[arg(long, env = "BARUA_CONTROL_URL")]
    pub control_url: Option<String>,

    /// One-time token used to join the cluster.
    #[arg(long, env = "BARUA_JOIN_TOKEN", hide_env_values = true)]
    pub join_token: Option<String>,

    /// Static API token for standalone mode (ignored once joined).
    #[arg(long, env = "BARUA_AGENT_TOKEN", hide_env_values = true)]
    pub agent_token: Option<String>,

    /// Suspend a database after this many seconds without connections.
    #[arg(long, env = "BARUA_SUSPEND_AFTER", default_value_t = 300)]
    pub suspend_after_secs: u64,

    /// Evict sleeping databases to R2 when free disk drops below this percent.
    #[arg(long, env = "BARUA_MIN_FREE_DISK_PCT", default_value_t = 20)]
    pub min_free_disk_pct: u64,

    /// Also evict databases that have slept this long (hours, 0 = only on disk pressure).
    #[arg(long, env = "BARUA_COLD_AFTER_HOURS", default_value_t = 0)]
    pub cold_after_hours: u64,

    /// Take a fresh snapshot of awake databases this often (hours).
    #[arg(long, env = "BARUA_SNAPSHOT_EVERY_HOURS", default_value_t = 24)]
    pub snapshot_every_hours: u64,

    /// Point-in-time restore window; older snapshots and WAL are pruned (days).
    #[arg(long, env = "BARUA_RETENTION_DAYS", default_value_t = 7)]
    pub retention_days: u64,

    /// cgroup v2 memory.max for each database (e.g. 512M, 1G, "max").
    #[arg(long, env = "BARUA_DB_MEMORY_MAX", default_value = "512M")]
    pub db_memory_max: String,

    /// cgroup v2 cpu.max for each database ("quota period"; "max 100000" = unlimited).
    #[arg(long, env = "BARUA_DB_CPU_MAX", default_value = "100000 100000")]
    pub db_cpu_max: String,

    /// max_connections for each database.
    #[arg(long, env = "BARUA_DB_MAX_CONNECTIONS", default_value_t = 50)]
    pub db_max_connections: u32,

    /// First local port handed to database Postgres instances.
    #[arg(long, env = "BARUA_PORT_BASE", default_value_t = 55000)]
    pub port_base: u16,

    /// PEM certificate chain (wildcard for *.<domain>). Enables TLS.
    #[arg(long, env = "BARUA_TLS_CERT")]
    pub tls_cert: Option<PathBuf>,

    /// PEM private key for the certificate.
    #[arg(long, env = "BARUA_TLS_KEY")]
    pub tls_key: Option<PathBuf>,

    #[command(flatten)]
    pub storage: StorageConfig,
}

/// Where databases live permanently: R2, or a local directory for testing.
#[derive(Args, Debug, Clone)]
pub struct StorageConfig {
    #[arg(long, env = "BARUA_R2_ACCOUNT_ID")]
    pub r2_account_id: Option<String>,
    #[arg(long, env = "BARUA_R2_BUCKET")]
    pub r2_bucket: Option<String>,
    #[arg(long, env = "BARUA_R2_ACCESS_KEY_ID", hide_env_values = true)]
    pub r2_access_key_id: Option<String>,
    #[arg(long, env = "BARUA_R2_SECRET_ACCESS_KEY", hide_env_values = true)]
    pub r2_secret_access_key: Option<String>,
    /// Use a local directory instead of R2 (development only).
    #[arg(long, env = "BARUA_STORAGE_DIR")]
    pub storage_dir: Option<PathBuf>,
}

impl Config {
    pub fn suspend_after(&self) -> Duration {
        Duration::from_secs(self.suspend_after_secs)
    }
    pub fn dbs_dir(&self) -> PathBuf {
        self.data_dir.join("dbs")
    }
    pub fn template_dir(&self) -> PathBuf {
        self.data_dir.join("template")
    }
    pub fn state_file(&self) -> PathBuf {
        self.data_dir.join("state.json")
    }
    pub fn identity_file(&self) -> PathBuf {
        self.data_dir.join("identity.json")
    }
    pub fn pg(&self, tool: &str) -> PathBuf {
        self.pg_bin.join(tool)
    }
}
