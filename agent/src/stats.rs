//! Box capacity, reported to the control plane so it can place databases.

use std::ffi::CString;
use std::path::Path;

use serde::Serialize;

use crate::app::{App, Location};

#[derive(Debug, Clone, Serialize)]
pub struct BoxStats {
    pub version: &'static str,
    pub cpus: usize,
    pub mem_total_mb: u64,
    pub mem_available_mb: u64,
    pub disk_total_mb: u64,
    pub disk_free_mb: u64,
    pub databases: usize,
    pub databases_local: usize,
    pub databases_awake: usize,
    pub connections: usize,
}

fn meminfo(key: &str) -> u64 {
    std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|s| {
            s.lines().find_map(|l| {
                l.strip_prefix(key)?
                    .trim_start_matches(':')
                    .split_whitespace()
                    .next()?
                    .parse::<u64>()
                    .ok()
            })
        })
        .unwrap_or(0)
        / 1024
}

/// (total, free) bytes of the filesystem holding `path`.
pub fn disk_usage(path: &Path) -> (u64, u64) {
    let Ok(c) = CString::new(path.to_string_lossy().as_bytes()) else {
        return (0, 0);
    };
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return (0, 0);
    }
    let bs = st.f_frsize as u64;
    (st.f_blocks as u64 * bs, st.f_bavail as u64 * bs)
}

impl BoxStats {
    pub fn collect(app: &App) -> Self {
        let (total, free) = disk_usage(&app.cfg.data_dir);
        let (databases, local) = app.meta(|m| {
            (
                m.databases.len(),
                m.databases.values().filter(|d| d.location == Location::Local).count(),
            )
        });
        let running = app.running();
        Self {
            version: env!("CARGO_PKG_VERSION"),
            cpus: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
            mem_total_mb: meminfo("MemTotal"),
            mem_available_mb: meminfo("MemAvailable"),
            disk_total_mb: total >> 20,
            disk_free_mb: free >> 20,
            databases,
            databases_local: local,
            databases_awake: running.len(),
            connections: running.iter().map(|(_, r)| r.connections()).sum(),
        }
    }
}
