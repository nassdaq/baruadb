# BaruaDB — handover notes for the next agent

Read this first, then [README.md](README.md) (setup and API) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (design). This file is the
context those two don't carry: why things are the way they are, what is
proven, what isn't, and how to work on it without breaking it.

## 1. What we are building, and for whom

- The owner (Kelvin, kelvin@neurotech.africa) wants a **cheap Neon
  replacement**. Customers today pay Neon for Postgres databases that are
  **small (200 MB – 1.6 GB) but busy**.
- Budget mindset: as cheap as possible. Available infra:
  - **Cloudflare R2:** storage.
  - **Cloudflare Workers + D1:** control plane.
  - **Small Linode boxes:** compute.
- Product feel must be Neon-like: a database URL per database, scale to zero,
  branching, point-in-time restore.
- Domain: **barua.app**, which was already active on Cloudflare in the same
  account. Databases are at `<id>.pg.barua.app`, the console and API at
  `console.barua.app`. The `.tz` plan is abandoned: the registrar could not
  change nameservers from its panel, and there was no reason to keep waiting
  once a working zone existed.
  - `pg.`/`pgapi.` rather than `db.`/`api.` because **barua.tz also serves the
    owner's Barua *mail* product**: a wildcard `A *.barua.tz → 172.233.46.254`
    sends every other name to the mail box, and `api.barua.tz`, `db.barua.tz`,
    `ui.`, `developer.`, `storage.` are live there. For the same reason the R2
    bucket is **`baruadb`** — `barua` holds mail attachments.
- "Barua" is Swahili for letter/mail. The name has no technical meaning.

## 2. Decisions already made — do not reopen without the owner

The owner explicitly asked to **discuss architecture before code**. Propose
changes to these; don't just do them.

| Decision | Why | Rejected alternatives |
|---|---|---|
| **Real Postgres** (16), not SQLite | Customers come from Neon; apps expect Postgres | Durable Objects + SQLite: no box needed, but SQL changes, and per-request/per-row billing gets expensive for busy, write-heavy apps |
| **R2 is the home, box disk is a cache** | 500 GB total doesn't fit a $5 box; the disk holds only awake/recent DBs | Neon-style page server (patched Postgres, remote page reads): far too complex, and slower for small DBs that fit in RAM |
| **One Postgres cluster per database** | Per-DB WAL archive enables per-DB branching, PITR and moves | One shared cluster with many databases: cheaper RAM, but WAL is cluster-wide, so per-DB PITR/move is impossible |
| **Isolation via cgroups v2**, not threads | Postgres is process-based; threads don't isolate | "Each tenant as a Rust thread": would mean writing a database engine |
| **≤10 s data loss on box crash** is acceptable for v1 | Simplicity and cost | Zero loss needs synchronous WAL nodes (planned, §6) |
| **1 MB WAL segments + `archive_timeout=10`** | R2 bills per write op; small segments every ≤10 s keep the loss bound and cost low (~$1.20 per busy DB/month) | Upload per commit: hundreds of dollars a month |
| Workers never touch data | Workers are short-lived, ~128 MB, no raw TCP server | — |
| **Separate branch**, not mixed with WorkingDB | Owner's request | — |

## 3. Repository and branches

- GitHub: `nassdaq/workingdb`.
  - **`barua-db`** has all BaruaDB work.
  - **`barua-main`** is the empty base it merges into.
  - **PR #1** is `barua-db` → `barua-main`.
- `main` and the `ccr-*` branches hold *WorkingDB*, an unrelated toy KV
  database in Rust. Ignore it; the owner said to forget that code.

```
agent/            Rust, binary `barua` (~2.4k lines). Runs on each box.
  src/main.rs     CLI: `serve`, `wal-push` (archive_command), `wal-fetch` (restore_command)
  src/config.rs   every setting, all overridable by BARUA_* env vars
  src/app.rs      state: DbRecord (persisted to state.json), Runtime (running? connections?)
  src/pg.rs       lifecycle: template, create, restore, snapshot, sync, suspend, evict, release, fence
  src/storage.rs  R2 layout, WAL push/fetch, snapshot upload/restore, prune, purge
  src/proxy.rs    Postgres wire proxy: SSLRequest, SNI routing, wake on connect, cancel forwarding
  src/api.rs      agent HTTP API (bearer token), used by the Worker
  src/tasks.rs    background loops: sleeper, evictor, snapshotter, pruner, join/heartbeat
  src/cgroup.rs   per-DB cgroup leaf, pre_exec move into it
  src/lsn.rs      LSN parsing, WAL file name → segment number (1 MB segments!)
  src/stats.rs    box capacity for placement
  src/tls.rs      rustls (ring provider) from PEM files
control/          Cloudflare Worker (TypeScript, no framework) + D1
  src/index.ts    router, auth, databases, branches, boxes, move, cron
  src/infra.ts    agent HTTP client, Cloudflare DNS API
  src/util.ts     ids, passwords, sha256, helpers
  schema.sql      D1 tables: boxes, api_keys, databases
deploy/           install.sh (add a box), barua.service (systemd), barua.env.example
docs/             ARCHITECTURE.md
```

## 4. Invariants — breaking these corrupts data or leaks tenants

1. **A database is served by at most one box.**
   - D1 `databases.box_id` is the owner.
   - Heartbeat responses list each box's databases; the agent **fences** any
     DB not in the list: it stops it and never wakes it.
   - Keep this in any failover work.
2. **A database only ever reads its own archive** (`dbs/<id>/...`), except
   while being created as a branch, when it reads its parent's. It then takes
   its own snapshot before becoming `ready`.
   - Timeline numbers are only unique per database. Mixing archives can
     replay the wrong WAL.
   - This is why there is no "lineage chain" fallback in `wal-fetch`; don't
     add one.
3. **A snapshot exists only once its `.json` is written**, which happens last
   in `upload_snapshot`. Restore and prune only look at `.json` files.
4. **Eviction only uploads a cleanly shut down cluster.** `pg_controldata`
   state must be `shut down`. The cold snapshot is that exact directory.
5. **Restores always run archive recovery and promote**, even "latest" ones.
   Each cold wake therefore bumps the timeline. That's expected and fine;
   don't "optimise" it into a plain start, or WAL archived after the snapshot
   would be lost (failover case).
6. **Customer roles are never superuser.** Admin is `barua_admin`, local unix
   socket only (pg_hba trust on the socket, SCRAM over TCP). Postgres
   inherits the agent's env (R2 keys), which is safe only because tenants
   can't read server env/files.
7. **`ConnectionGuard` before `ensure_ready`** in the proxy, so the sleeper
   can't stop a DB between wake and first byte.
8. **TLS on:** plaintext startup packets are refused.

## 5. Status

### Proven by tests run in this session (local Postgres 16, local dir as fake R2)

- Create (~1 s with first snapshot).
- Proxy:
  - SNI and `options=endpoint=` routing work.
  - Plaintext and wrong passwords are refused.
  - The customer role is not superuser.
- Sleep after idle, wake in ~0.1 s.
- Evict, then cold wake (~0.3 s for a small DB).
- Branch from now (exact LSN) and at a past time: correct rows.
- A branch's cold wake reads only its own archive.
- Move (release + adopt): zero loss.
- `kill -9` crash: a commit from 12 s before survived, one from 0 s before
  was lost (as designed).
- Agent restart keeps databases running.
- Full Worker flow under `wrangler dev` with local D1:
  - the box auto-joins;
  - API key, create, branch, reset password and delete work;
  - tenants are isolated by key.
- `cargo test`, `cargo clippy` (clean) and `tsc --noEmit` pass.

### Written but NOT yet verified

- Real R2 (`object_store` S3 builder against `<account>.r2.cloudflarestorage.com`).
- cgroup limits: needs systemd 254+ for `DelegateSubgroup`, so **Ubuntu
  24.04**. The test sandbox couldn't delegate cgroups; the agent logs a
  warning and runs without limits.
- `deploy/install.sh` on a real box (only `bash -n`). In particular:
  - certbot DNS-01 wildcard;
  - the PGDG repo script;
  - the source build on a 1 GB box (it adds 2 GB swap).
- Cloudflare DNS API calls in `control/src/infra.ts` (per-DB A records,
  multi-box).
- `wrangler deploy` to the real account; CI workflow on GitHub.
- Long-running behaviour:
  - retention pruning (`Storage::prune`) has no test;
  - scheduled snapshots;
  - the evictor under real disk pressure.

### Known gaps / rough edges

- **Connection pooling** is on `<id>-pooler.pg.barua.app`: a PgBouncer per
  database in transaction mode, started and stopped with its Postgres and
  charged to the same cgroup. Measured on one database: 40 direct connections
  cost 80 MB and 40 backends; the same 40 through the pooler cost 41 MB and 4
  backends. Session state does not cross a transaction boundary there - `SET`,
  `LISTEN` and named prepared statements belong on the direct endpoint.
- Branch-from-now when the parent is **asleep** uses target `latest`. Fine,
  but it replays the parent's whole archive after its newest snapshot.
- Restores fetch WAL one segment per process spawn (`wal-fetch`). Slow for
  long replays; prefetching would help. Snapshots bound this.
- Snapshots are triggered by WAL volume (256 MB since the last) with a weekly
  ceiling; a write-heavy DB snapshots often, a quiet one weekly.
- Certificate renewal restarts the agent: open proxied sessions drop, while
  Postgres keeps running (`KillMode=process`).
- Cancel requests are broadcast to all running DBs on the box. Safe, but
  crude.
- D1 status lags up to 20 s (heartbeat). The Worker calls `refresh()` where
  freshness matters.
- `install.sh` clones the GitHub repo: this fails if it is private. Use
  `BARUA_BINARY_URL` (CI artifact / `agent-v*` release) instead.
- No dashboard, no usage metering or billing, no per-tenant quotas beyond
  cgroup limits.

## 6. Suggested next work, in order

1. **Go live on one box.** Follow README "Setup" with the owner. Fix whatever
   breaks in `install.sh`, R2 and cgroups. Then load-test with a few busy
   DBs on a $5 and a $24 Linode and record real numbers for the owner.
2. ~~**Pooler (transaction mode)** behind `<id>-pooler`.~~ Done, with
   PgBouncer rather than by writing SCRAM into the proxy: it authenticates
   clients itself and reaches Postgres over the socket pg_hba already trusts.
   Still worth doing: surface pool saturation in Monitoring, and decide what
   `default_pool_size` should be per plan.
3. **Zero-loss durability:** two tiny WAL nodes (e.g. $5 boxes) as
   synchronous standbys (`synchronous_standby_names`), receiving WAL with
   `pg_receivewal`-like logic and shipping to R2.
4. **Automatic failover:**
   - Worker cron detects a box offline for N minutes, then `move` with
     `force` for its DBs.
   - Fencing (§4.1) already prevents split brain when the box returns.
5. Snapshot when WAL since the last snapshot exceeds X MB. WAL prefetch on
   restore.
6. Dashboard (Workers static assets) and usage metering (awake-seconds,
   storage), for billing.

## 7. How to run and test locally (gotchas included)

- **Postgres refuses to run as root.** Run the agent as a normal user
  (`useradd -m barua`) and install the binary somewhere that user can reach.
- Postgres 16 binaries: `/usr/lib/postgresql/16/bin` (`BARUA_PG_BIN`).
- **Standalone agent**, with a local directory instead of R2:
  ```bash
  BARUA_DATA=/home/barua/t/data BARUA_STORAGE_DIR=/home/barua/t/r2 \
  BARUA_PROXY_ADDR=127.0.0.1:15432 BARUA_API_ADDR=127.0.0.1:18443 \
  BARUA_TLS_CERT=…/cert.pem BARUA_TLS_KEY=…/key.pem \
  BARUA_AGENT_TOKEN=testtoken BARUA_SUSPEND_AFTER=15 barua serve
  ```
  Self-signed wildcard certificate:
  ```bash
  openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem \
    -days 2 -subj "/CN=*.pg.barua.app" -addext "subjectAltName=DNS:*.pg.barua.app"
  ```
  Connect with SNI but no DNS:
  ```bash
  psql "host=<id>.pg.barua.app hostaddr=127.0.0.1 port=15432 user=app dbname=app sslmode=require"
  ```
- Agent API: `curl -k --noproxy '*' --resolve box.pg.barua.app:18443:127.0.0.1 https://box.pg.barua.app:18443/v1/...`
  - **Sandboxes with an HTTPS proxy:** always pass `--noproxy '*'` / set
    `NO_PROXY='*'`, or local calls hang or get reset.
- **Control plane locally:**
  ```bash
  cd control && npm install && npm run db:init:local
  printf 'ADMIN_TOKEN=admintest\nJOIN_TOKEN=jointest\n' > .dev.vars   # gitignored
  NO_PROXY='*' npx wrangler dev --port 8787 --var AGENT_URL_TEMPLATE:http://127.0.0.1:18080
  ```
  Then run a second agent **without TLS**, with:
  ```
  BARUA_API_ADDR=127.0.0.1:18080
  BARUA_CONTROL_URL=http://127.0.0.1:8787
  BARUA_JOIN_TOKEN=jointest
  BARUA_PUBLIC_IP=127.0.0.1
  BARUA_PORT_BASE=56000
  ```
  Without TLS, connect with `options=endpoint=<id>`.
- `@cloudflare/workers-types` must be **v5** to satisfy wrangler 4's peer
  dependency.
- **Shell gotcha:** `pkill -f "barua serve"` or `pkill -f wrangler` kills the
  very shell running it, because its own command line matches. Use
  `pkill -x barua` / `pkill -x workerd`, or kill by PID from
  `postmaster.pid`.
- To stop test Postgres instances: `kill -INT $(head -1 <pgdata>/postmaster.pid)`.
- Manual API scenarios worth re-running after changes:
  - create → connect → sleep → wake;
  - evict → cold wake;
  - `POST /sync`, then a branch with `{"lsn": …}`;
  - a branch with `{"time": …}`;
  - `release`, then create with `restore: {source: self, target: "latest"}`;
  - `kill -9` the postmaster, then delete with `?purge=false`, then restore
    `latest`.

  These are the guarantees the owner was promised. An automated integration
  test script for them would be a good first contribution.

## 8. Working with the owner

- Prefers short, plain answers; often writes in quick English, sometimes
  voice-typed. Confirm intent when a message is ambiguous.
- Wants to agree on design first: present options with costs and a
  recommendation, then build.
- Cost is the top concern. Show numbers per database and per month.
- Commit and push to `barua-db` (PR #1 updates automatically). Don't open new
  PRs or touch `main` unless asked.
