# BaruaDB architecture

Goal: Neon-like Postgres (URL per database, scale to zero, branching,
point-in-time restore) for many small, busy databases (200 MB – 2 GB) at the
lowest possible cost.

## The one idea: R2 is home, the box disk is a cache

Every database's permanent copy lives in R2 as snapshots plus a continuous
WAL stream. A box only holds databases that are awake or recently used.
Because any box can rebuild any database from R2, boxes are disposable and
the cluster grows by adding boxes.

```
          ┌──────────────── Cloudflare ────────────────┐
          │ Worker (pgapi.barua.tz) ── D1: keys, dbs,     │
          │                              boxes          │
          │ R2: dbs/<id>/snapshots/*  dbs/<id>/wal/*    │
          └──────▲───────────────────────────▲──────────┘
                 │ HTTPS (agent API :443)    │ snapshots + WAL
 ┌───────────────┴───────────────────────────┴─────────────┐
 │ box: barua agent (Rust, Tokio)                           │
 │   proxy :5432 ─ TLS, SNI routing, wake on connect        │
 │   lifecycle  ─ create / sleep / evict / restore          │
 │   jobs       ─ snapshots, retention, heartbeat           │
 │   Postgres per database, each in its own cgroup          │
 └──────────────────────────────────────────────────────────┘
```

## Database lifecycle

| State | Where | Wake time |
|---|---|---|
| **awake** | Postgres running on a box | — |
| **asleep** | stopped, files on the box disk | ~0.1 s |
| **cold** | R2 only | download + start (seconds; ~0.3 s for a small DB in tests) |

- *Create*: copy a pre-initialised template cluster (no `initdb` per
  database), create the owner role and database, take the first snapshot.
  About 1 second.
- *Sleep*: after `BARUA_SUSPEND_AFTER` seconds without sessions. Before
  stopping, the current WAL segment is switched and archived.
- *Evict*: when free disk drops below `BARUA_MIN_FREE_DISK_PCT`, the least
  recently used sleeping databases are uploaded as a "cold" snapshot (a copy
  of the cleanly stopped data directory) and deleted locally.
- *Wake from cold*: newest snapshot + WAL replay, then promote.

## Durability

- `initdb --wal-segsize=1` (1 MB segments) and `archive_timeout = 10`:
  Postgres closes a segment at least every 10 seconds when there were writes,
  and `archive_command` (`barua wal-push`) compresses it with zstd and puts it
  in R2. Idle databases write nothing.
- **A box that dies loses at most ~10 seconds of commits** (verified by a
  `kill -9` test: a commit 12 s before the crash survived, one 0 s before did
  not). Planned: synchronous WAL to two tiny "WAL nodes" for zero loss.
- Snapshots: on creation, every `BARUA_SNAPSHOT_EVERY_HOURS` while awake, and
  on eviction. They bound how much WAL a restore replays.
- Retention: snapshots and WAL older than `BARUA_RETENTION_DAYS` are pruned,
  always keeping the newest snapshot before the window.

R2 cost is dominated by write operations, not storage: one 1 MB segment per
≤10 s of activity is ≤ ~260k PUTs per busy database per month (~$1.20).

## Branching and point-in-time restore

A branch is a new database restored from its parent's R2 history:

- *from now*: the parent switches and archives its WAL, returns that LSN, and
  the branch replays exactly up to it;
- *from a time*: newest parent snapshot before the time, replay to
  `recovery_target_time`.

The branch then takes its own snapshot and archives to its own prefix. From
that moment it never reads anyone else's archive. This matters because
timeline numbers are only unique within one database; mixing archives could
replay the wrong WAL.

## Routing and auth

- Hostname `<id>.pg.barua.tz`, wildcard certificate per box (Let's Encrypt,
  DNS-01 via Cloudflare). The proxy reads SNI to find the database. Fallbacks:
  `options=endpoint=<id>` and user `role--<id>`.
- Plaintext connections are refused when TLS is configured.
- Passwords are checked by Postgres itself (SCRAM, end to end); the proxy
  never sees them in clear.
- Customers get a non-superuser owner role (`CREATEDB CREATEROLE`). Admin
  access exists only over the database's unix socket on the box.

## Isolation

One Postgres cluster per database, each in its own cgroup v2 leaf
(`memory.max`, `cpu.max`, `pids.max`), delegated by systemd
(`Delegate=yes`, `DelegateSubgroup=agent`). A tenant hitting its memory limit
only affects itself. Rust threads are used where they shine: the proxy runs
thousands of sessions as Tokio tasks on two worker threads.

## Cluster

- A box joins with `JOIN_TOKEN` and gets its own agent token; it heartbeats
  every 20 s with capacity (free memory, disk, awake databases).
- New databases go to the online, active box with the most headroom;
  branches prefer the parent's box.
- One box: a wildcard DNS record is enough. More boxes: the Worker creates an
  A record per database (`CF_API_TOKEN`), so a database can move.
- *Move*: the source box releases the database (archive, cold snapshot,
  forget), the target restores it from R2, DNS is updated. No data loss.
- *Dead box*: `move` with `force: true` rebuilds from R2 (≤10 s loss).
  Heartbeat responses list the databases assigned to each box; a box that
  comes back fences (stops, never wakes) any database placed elsewhere, so a
  database is never served by two boxes.

## Not built yet (next steps)

1. **Pooler** (`<id>-pooler.pg.barua.tz`, transaction mode). The hostname is
   reserved and currently routes directly.
2. **Zero-loss WAL** with two small synchronous WAL nodes.
3. **Automatic failover** (today it is one admin call).
4. Dashboard and usage metering.
5. Hot certificate reload (renewal currently restarts the agent; running
   databases keep running, open proxied sessions reconnect).
