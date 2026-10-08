mod api;
mod app;
mod cgroup;
mod config;
mod lsn;
mod pg;
mod pooler;
mod proxy;
mod stats;
mod storage;
mod tasks;
mod tls;

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;

use crate::config::{Config, StorageConfig};

#[derive(Parser)]
#[command(name = "barua", version, about = "BaruaDB box agent")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
#[allow(clippy::large_enum_variant)]
enum Cmd {
    /// Run the agent: Postgres proxy, API, and background jobs.
    Serve(Config),
    /// Postgres archive_command: upload one WAL file.
    WalPush {
        #[arg(long)]
        db: String,
        path: PathBuf,
        name: String,
        #[command(flatten)]
        storage: StorageConfig,
    },
    /// Postgres restore_command: download one WAL file.
    WalFetch {
        #[arg(long)]
        db: String,
        name: String,
        dest: PathBuf,
        #[command(flatten)]
        storage: StorageConfig,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_env("BARUA_LOG").unwrap_or_else(|_| EnvFilter::new("info")))
        .with_writer(std::io::stderr)
        .init();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    rt.block_on(async move {
        match cli.cmd {
            Cmd::Serve(cfg) => serve(cfg).await,
            Cmd::WalPush {
                db,
                path,
                name,
                storage,
            } => {
                storage::Storage::from_config(&storage)?
                    .wal_push(&db, &path, &name)
                    .await
            }
            Cmd::WalFetch {
                db,
                name,
                dest,
                storage,
            } => {
                if storage::Storage::from_config(&storage)?
                    .wal_fetch(&db, &name, &dest)
                    .await?
                {
                    Ok(())
                } else {
                    // Normal at the end of the archive; Postgres expects non-zero.
                    std::process::exit(1)
                }
            }
        }
    })
}

async fn serve(cfg: Config) -> Result<()> {
    let app = app::App::load(cfg, cgroup::Cgroups::init())?;
    app.storage.check().await?;
    app.ensure_template().await?;
    app.recover_on_startup().await?;
    let proxy_tls = tls::acceptor(&app.cfg, &[])?;
    let api_tls = tls::acceptor(&app.cfg, &[b"h2", b"http/1.1"])?;
    tasks::spawn_all(app.clone());
    tokio::select! {
        r = proxy::serve(app.clone(), proxy_tls) => r,
        r = api::serve(app.clone(), api_tls) => r,
        _ = tokio::signal::ctrl_c() => Ok(()),
    }
}
