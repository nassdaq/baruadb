//! Postgres log sequence numbers and WAL file names.

use std::fmt;
use std::str::FromStr;

use anyhow::{Result, anyhow};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Every database is initialised with 1 MB WAL segments (instead of 16 MB)
/// so the forced switch every few seconds ships small files to R2.
pub const WAL_SEGMENT_MB: u64 = 1;
pub const WAL_SEGMENT_SIZE: u64 = WAL_SEGMENT_MB << 20;
const SEGS_PER_XLOGID: u64 = 0x1_0000_0000 / WAL_SEGMENT_SIZE;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct Lsn(pub u64);

impl Lsn {
    pub fn segno(self) -> u64 {
        self.0 / WAL_SEGMENT_SIZE
    }

    /// True when the LSN sits exactly where a segment begins, which is where
    /// `pg_current_wal_lsn()` rests while nothing has been written since the
    /// last switch. No archived WAL ever reaches such an LSN, so it must not
    /// be used as a recovery target.
    pub fn is_segment_boundary(self) -> bool {
        self.0 % WAL_SEGMENT_SIZE == 0
    }
}

impl fmt::Display for Lsn {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:X}/{:X}", self.0 >> 32, self.0 & 0xffff_ffff)
    }
}

impl FromStr for Lsn {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> Result<Self> {
        let (hi, lo) = s.trim().split_once('/').ok_or_else(|| anyhow!("bad LSN {s:?}"))?;
        Ok(Lsn((u64::from_str_radix(hi, 16)? << 32) | u64::from_str_radix(lo, 16)?))
    }
}

impl Serialize for Lsn {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for Lsn {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        String::deserialize(d)?.parse().map_err(serde::de::Error::custom)
    }
}

/// Segment number of a WAL file name like `000000010000000000000042`
/// (optionally with a suffix such as `.partial`). None for `.history` etc.
pub fn segno_of_wal_name(name: &str) -> Option<u64> {
    let name = name.strip_suffix(".zst").unwrap_or(name);
    let base = name.get(..24)?;
    if !base.bytes().all(|b| b.is_ascii_hexdigit()) || name.ends_with(".history") {
        return None;
    }
    if name.len() > 24 && !name[24..].starts_with('.') {
        return None;
    }
    let log = u64::from_str_radix(&base[8..16], 16).ok()?;
    let seg = u64::from_str_radix(&base[16..24], 16).ok()?;
    Some(log * SEGS_PER_XLOGID + seg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lsn_roundtrip() {
        let l: Lsn = "1/2A0000C8".parse().unwrap();
        assert_eq!(l.0, 0x1_2A00_00C8);
        assert_eq!(l.to_string(), "1/2A0000C8");
    }

    #[test]
    fn segment_boundaries() {
        // Where pg_current_wal_lsn() rests when nothing has been written since
        // the last switch: unreachable as a recovery target.
        assert!("0/C00000".parse::<Lsn>().unwrap().is_segment_boundary());
        assert!("0/0".parse::<Lsn>().unwrap().is_segment_boundary());
        assert!("1/0".parse::<Lsn>().unwrap().is_segment_boundary());
        // Anything mid-segment is a real, replayable position.
        assert!(!"0/B13338".parse::<Lsn>().unwrap().is_segment_boundary());
        assert!(!"0/C00001".parse::<Lsn>().unwrap().is_segment_boundary());
    }

    #[test]
    fn wal_names() {
        assert_eq!(segno_of_wal_name("000000010000000000000042.zst"), Some(0x42));
        assert_eq!(
            segno_of_wal_name("000000020000000100000003.partial.zst"),
            Some(4096 + 3)
        );
        assert_eq!(segno_of_wal_name("00000002.history.zst"), None);
        let l: Lsn = "0/42000028".parse().unwrap();
        assert_eq!(l.segno(), 0x420);
    }
}
