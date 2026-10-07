//! cgroup v2 limits: every database's Postgres runs in its own cgroup so one
//! tenant cannot eat the box's memory or CPU.
//!
//! Under systemd with `Delegate=yes` the agent owns its service cgroup:
//!
//! ```text
//! /sys/fs/cgroup/system.slice/barua.service/
//!   agent/          <- the agent itself (cgroup v2: no processes in inner nodes)
//!   dbs/<id>/       <- one leaf per database, memory.max + cpu.max
//! ```
//!
//! Everything is best effort: without a delegated cgroup the databases still
//! run, just without limits (logged once at startup).

use std::ffi::CString;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};
use tracing::{info, warn};

#[derive(Clone)]
pub struct Cgroups {
    root: Option<PathBuf>,
}

fn own_cgroup() -> Result<PathBuf> {
    let s = std::fs::read_to_string("/proc/self/cgroup")?;
    let rel = s
        .lines()
        .find_map(|l| l.strip_prefix("0::"))
        .ok_or_else(|| anyhow!("not on cgroup v2"))?;
    Ok(Path::new("/sys/fs/cgroup").join(rel.trim_start_matches('/')))
}

impl Cgroups {
    pub fn disabled() -> Self {
        Self { root: None }
    }

    /// Set up the layout. Returns a disabled handle when we lack permission.
    pub fn init() -> Self {
        match Self::try_init() {
            Ok(root) => {
                info!(root = %root.display(), "cgroup limits enabled");
                Self { root: Some(root) }
            }
            Err(e) => {
                warn!("cgroup limits disabled: {e:#}");
                Self::disabled()
            }
        }
    }

    fn try_init() -> Result<PathBuf> {
        let mut cur = own_cgroup()?;
        // After an agent restart we are already in ".../agent".
        if cur.file_name().is_some_and(|n| n == "agent") {
            cur.pop();
        }
        let agent = cur.join("agent");
        std::fs::create_dir_all(&agent).context("creating agent cgroup (is Delegate=yes set?)")?;
        std::fs::write(agent.join("cgroup.procs"), std::process::id().to_string()).context("moving agent")?;
        std::fs::write(cur.join("cgroup.subtree_control"), "+memory +cpu +pids").context("enabling controllers")?;
        let dbs = cur.join("dbs");
        std::fs::create_dir_all(&dbs)?;
        std::fs::write(dbs.join("cgroup.subtree_control"), "+memory +cpu +pids")?;
        Ok(dbs)
    }

    /// Create/refresh the leaf for a database and return the path of its
    /// `cgroup.procs`, for use in `pre_exec`.
    pub fn prepare(&self, id: &str, memory_max: &str, cpu_max: &str) -> Option<CString> {
        let root = self.root.as_ref()?;
        let dir = root.join(id);
        let res = (|| -> Result<()> {
            std::fs::create_dir_all(&dir)?;
            std::fs::write(dir.join("memory.max"), memory_max)?;
            std::fs::write(dir.join("cpu.max"), cpu_max)?;
            std::fs::write(dir.join("pids.max"), "512")?;
            Ok(())
        })();
        if let Err(e) = res {
            warn!(db = id, "cgroup setup failed: {e:#}");
            return None;
        }
        CString::new(dir.join("cgroup.procs").to_string_lossy().as_bytes()).ok()
    }

    pub fn remove(&self, id: &str) {
        if let Some(root) = &self.root {
            let _ = std::fs::remove_dir(root.join(id));
        }
    }

    /// Current memory use of a database in bytes, if known.
    pub fn memory_current(&self, id: &str) -> Option<u64> {
        let root = self.root.as_ref()?;
        std::fs::read_to_string(root.join(id).join("memory.current"))
            .ok()?
            .trim()
            .parse()
            .ok()
    }
}

/// Move the calling (just-forked) process into the cgroup. Only async-signal
/// safe calls are allowed here because it runs between fork and exec.
pub fn enter(procs: &CString) -> std::io::Result<()> {
    unsafe {
        let fd = libc::open(procs.as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC);
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let n = libc::write(fd, b"0".as_ptr().cast(), 1);
        libc::close(fd);
        if n != 1 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}
