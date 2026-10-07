//! R2 (or a local directory) is the permanent home of every database.
//!
//! ```text
//! dbs/{id}/wal/{segment}.zst                     compressed WAL, 1 MB segments
//! dbs/{id}/snapshots/{YYYYMMDDTHHMMSSZ}-{kind}.tar.zst
//! dbs/{id}/snapshots/{YYYYMMDDTHHMMSSZ}-{kind}.json   SnapshotInfo
//! ```
//!
//! A database can be rebuilt anywhere from its newest usable snapshot plus
//! the WAL after it.

use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow, bail};
use chrono::{DateTime, Utc};
use futures::TryStreamExt;
use object_store::aws::AmazonS3Builder;
use object_store::local::LocalFileSystem;
use object_store::path::Path as ObjPath;
use object_store::{ObjectStore, PutPayload, WriteMultipart};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::config::StorageConfig;
use crate::lsn::{Lsn, segno_of_wal_name};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotKind {
    /// pg_basebackup of a running database.
    Online,
    /// Copy of a cleanly stopped data directory (taken on eviction).
    Cold,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotInfo {
    pub key: String,
    pub db_id: String,
    pub kind: SnapshotKind,
    /// When the snapshot became consistent (usable as a restore base).
    pub taken_at: DateTime<Utc>,
    /// WAL needed from here on to replay forward.
    pub start_lsn: Lsn,
    /// Restoring needs WAL replay at least up to here.
    pub end_lsn: Lsn,
}

#[derive(Clone)]
pub struct Storage {
    store: Arc<dyn ObjectStore>,
}

fn ts(t: DateTime<Utc>) -> String {
    t.format("%Y%m%dT%H%M%SZ").to_string()
}

impl Storage {
    pub fn from_config(cfg: &StorageConfig) -> Result<Self> {
        if let Some(bucket) = &cfg.r2_bucket {
            let account = cfg
                .r2_account_id
                .as_deref()
                .ok_or_else(|| anyhow!("BARUA_R2_ACCOUNT_ID is required with BARUA_R2_BUCKET"))?;
            let store = AmazonS3Builder::new()
                .with_bucket_name(bucket)
                .with_region("auto")
                .with_endpoint(format!("https://{account}.r2.cloudflarestorage.com"))
                .with_access_key_id(cfg.r2_access_key_id.clone().unwrap_or_default())
                .with_secret_access_key(cfg.r2_secret_access_key.clone().unwrap_or_default())
                .build()
                .context("building R2 client")?;
            return Ok(Self { store: Arc::new(store) });
        }
        if let Some(dir) = &cfg.storage_dir {
            std::fs::create_dir_all(dir)?;
            return Ok(Self {
                store: Arc::new(LocalFileSystem::new_with_prefix(dir)?),
            });
        }
        bail!("no storage configured: set BARUA_R2_BUCKET (or BARUA_STORAGE_DIR for development)")
    }

    fn wal_key(db: &str, name: &str) -> ObjPath {
        ObjPath::from(format!("dbs/{db}/wal/{name}.zst"))
    }

    /// `archive_command`: compress and upload one WAL file.
    pub async fn wal_push(&self, db: &str, src: &Path, name: &str) -> Result<()> {
        let raw = tokio::fs::read(src).await.with_context(|| format!("reading {src:?}"))?;
        // Forced segment switches leave files mostly zero; zstd makes them tiny.
        let data = tokio::task::spawn_blocking(move || zstd::encode_all(&raw[..], 3)).await??;
        self.store.put(&Self::wal_key(db, name), PutPayload::from(data)).await?;
        Ok(())
    }

    /// `restore_command`. `Ok(false)` means "not in the archive", which
    /// Postgres treats as the end of available WAL.
    ///
    /// Only one database's archive is ever read: a branch replays from its
    /// parent while being created, then takes its own snapshot and is
    /// self-contained from then on. Mixing archives would be unsafe because
    /// timeline numbers are only unique within one database.
    pub async fn wal_fetch(&self, db: &str, name: &str, dest: &Path) -> Result<bool> {
        let data = match self.store.get(&Self::wal_key(db, name)).await {
            Ok(r) => r.bytes().await?,
            Err(object_store::Error::NotFound { .. }) => return Ok(false),
            Err(e) => return Err(e.into()),
        };
        let raw = tokio::task::spawn_blocking(move || zstd::decode_all(&data[..])).await??;
        let tmp = dest.with_extension("barua-tmp");
        tokio::fs::write(&tmp, raw).await?;
        tokio::fs::rename(&tmp, dest).await?;
        Ok(true)
    }

    /// Tar + zstd `dir` and upload it with its metadata.
    pub async fn upload_snapshot(
        &self,
        db: &str,
        dir: &Path,
        kind: SnapshotKind,
        taken_at: DateTime<Utc>,
        start_lsn: Lsn,
        end_lsn: Lsn,
    ) -> Result<SnapshotInfo> {
        let kind_s = match kind {
            SnapshotKind::Online => "online",
            SnapshotKind::Cold => "cold",
        };
        let base = format!("dbs/{db}/snapshots/{}-{kind_s}", ts(taken_at));
        let archive = dir.with_extension("tar.zst");
        {
            let (dir, archive) = (dir.to_path_buf(), archive.clone());
            tokio::task::spawn_blocking(move || -> Result<()> {
                let enc = zstd::Encoder::new(std::fs::File::create(&archive)?, 3)?.auto_finish();
                let mut tar = tar::Builder::new(enc);
                tar.follow_symlinks(false);
                tar.append_dir_all(".", &dir)?;
                tar.into_inner()?;
                Ok(())
            })
            .await??;
        }
        let result = async {
            let mut writer = WriteMultipart::new(
                self.store
                    .put_multipart(&ObjPath::from(format!("{base}.tar.zst")))
                    .await?,
            );
            let mut file = tokio::fs::File::open(&archive).await?;
            let mut buf = vec![0u8; 8 << 20];
            loop {
                let n = file.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                writer.write(&buf[..n]);
            }
            writer.finish().await?;
            let info = SnapshotInfo {
                key: format!("{base}.tar.zst"),
                db_id: db.into(),
                kind,
                taken_at,
                start_lsn,
                end_lsn,
            };
            // The JSON goes last: a snapshot only "exists" once it is complete.
            self.store
                .put(
                    &ObjPath::from(format!("{base}.json")),
                    PutPayload::from(serde_json::to_vec(&info)?),
                )
                .await?;
            Ok::<_, anyhow::Error>(info)
        }
        .await;
        tokio::fs::remove_file(&archive).await.ok();
        result
    }

    pub async fn list_snapshots(&self, db: &str) -> Result<Vec<SnapshotInfo>> {
        let prefix = ObjPath::from(format!("dbs/{db}/snapshots"));
        let metas: Vec<_> = self.store.list(Some(&prefix)).try_collect().await?;
        let mut out = vec![];
        for m in metas.into_iter().filter(|m| m.location.as_ref().ends_with(".json")) {
            let bytes = self.store.get(&m.location).await?.bytes().await?;
            out.push(serde_json::from_slice::<SnapshotInfo>(&bytes)?);
        }
        out.sort_by_key(|s| s.taken_at);
        Ok(out)
    }

    /// Download a snapshot and unpack it into `dest` (must not exist).
    pub async fn restore_snapshot(&self, info: &SnapshotInfo, dest: &Path) -> Result<()> {
        if dest.exists() {
            bail!("{dest:?} already exists");
        }
        let archive = dest.with_extension("tar.zst");
        let mut stream = self.store.get(&ObjPath::from(info.key.as_str())).await?.into_stream();
        let mut file = tokio::fs::File::create(&archive).await?;
        while let Some(chunk) = stream.try_next().await? {
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        drop(file);
        let (archive2, dest) = (archive.clone(), dest.to_path_buf());
        let res = tokio::task::spawn_blocking(move || -> Result<()> {
            std::fs::create_dir_all(&dest)?;
            tar::Archive::new(zstd::Decoder::new(std::fs::File::open(&archive2)?)?).unpack(&dest)?;
            Ok(())
        })
        .await?;
        tokio::fs::remove_file(&archive).await.ok();
        res
    }

    /// Drop snapshots outside the retention window (always keeping the
    /// newest one before it, so the window start stays restorable) and WAL
    /// older than the oldest kept snapshot.
    pub async fn prune(&self, db: &str, cutoff: DateTime<Utc>) -> Result<usize> {
        let snaps = self.list_snapshots(db).await?;
        let Some(anchor) =
            snaps
                .iter()
                .rposition(|s| s.taken_at < cutoff)
                .or(if snaps.is_empty() { None } else { Some(0) })
        else {
            return Ok(0);
        };
        let mut deleted = 0;
        for s in &snaps[..anchor] {
            self.store.delete(&ObjPath::from(s.key.as_str())).await.ok();
            self.store
                .delete(&ObjPath::from(s.key.replace(".tar.zst", ".json")))
                .await?;
            deleted += 1;
        }
        let keep_from = snaps[anchor].start_lsn.segno();
        let prefix = ObjPath::from(format!("dbs/{db}/wal"));
        let wal: Vec<_> = self.store.list(Some(&prefix)).try_collect().await?;
        for m in wal {
            let name = m.location.filename().unwrap_or_default();
            if let Some(segno) = segno_of_wal_name(name)
                && segno < keep_from
            {
                self.store.delete(&m.location).await?;
                deleted += 1;
            }
        }
        Ok(deleted)
    }

    /// Remove everything stored for a database.
    pub async fn purge(&self, db: &str) -> Result<()> {
        let prefix = ObjPath::from(format!("dbs/{db}"));
        let all: Vec<_> = self.store.list(Some(&prefix)).try_collect().await?;
        for m in all {
            self.store.delete(&m.location).await?;
        }
        Ok(())
    }

    /// Round-trip check used at startup so bad credentials fail loudly.
    pub async fn check(&self) -> Result<()> {
        let key = ObjPath::from("_barua/healthcheck");
        self.store
            .put(&key, PutPayload::from_static(b"ok"))
            .await
            .context("writing to object storage")?;
        self.store.get(&key).await.context("reading from object storage")?;
        Ok(())
    }
}
