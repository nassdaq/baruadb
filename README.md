# BaruaDB

**Serverless Postgres on a budget.** Neon-style database URLs, scale to zero,
branching and point-in-time restore, built from a few cheap parts:

| Part | Job |
|---|---|
| **Cloudflare R2** | The permanent home of every database (snapshots + WAL) |
| **Cloudflare Worker + D1** | Control plane: API keys, databases, boxes, placement |
| **Linux boxes** (e.g. Linode) | Run Postgres only for the databases awake right now |

```
 Customer app ── postgresql://app:…@br-k3j9x2m1qa.pg.barua.tz/app ──► box :5432
                                                                     (proxy wakes the DB)
 Dashboard / CLI ── https://pgapi.barua.tz ──► Worker + D1 ──HTTPS──► box agents
 Boxes ── snapshots + WAL every ≤10 s ──► R2
```

A database sleeps after 5 idle minutes and wakes on the next connection
(~0.1 s from disk). When disk runs low, sleeping databases are pushed to R2
entirely and restored on their next connection, so a small disk can serve far
more data than it holds. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Picking this project up? Start with [HANDOVER.md](HANDOVER.md).

## Layout

```
agent/     Rust: the `barua` box agent (proxy, lifecycle, R2 sync, API)
control/   TypeScript: the Cloudflare Worker control plane + D1 schema
deploy/    install.sh (add a box), systemd unit, env reference
docs/      architecture and design decisions
```

## Setup

### 1. Cloudflare (once)

```bash
# R2 bucket + an R2 API token (Object Read & Write on this bucket)
npx wrangler r2 bucket create baruadb

cd control
npm install
npx wrangler d1 create barua          # put the id into wrangler.toml
npm run db:init
npx wrangler secret put ADMIN_TOKEN   # long random string, full access
npx wrangler secret put JOIN_TOKEN    # long random string, lets boxes join
# Needed from the 2nd box on (each database then gets its own DNS record):
npx wrangler secret put CF_API_TOKEN  # Zone.DNS edit on barua.tz
npx wrangler secret put CF_ZONE_ID
npm run deploy                        # serves https://pgapi.barua.tz
```

DNS for one box: add `A  *.pg.barua.tz  → <box IP>` (DNS only, not proxied).

### 2. Add a box (first one, and every one after)

On a fresh Ubuntu 24.04 server, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/nassdaq/workingdb/barua-db/deploy/install.sh -o install.sh
BARUA_JOIN_TOKEN=… \
BARUA_R2_ACCOUNT_ID=… BARUA_R2_ACCESS_KEY_ID=… BARUA_R2_SECRET_ACCESS_KEY=… \
CF_DNS_API_TOKEN=… \
bash install.sh
```

The wildcard certificate is issued over DNS-01, so the box needs write access to
whichever provider is authoritative for the domain: `CF_DNS_API_TOKEN` for
Cloudflare, or `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` for Route 53. Use an
IAM user scoped to `route53:ChangeResourceRecordSets` on that one hosted zone.

It installs Postgres 16, gets a wildcard certificate for `*.pg.barua.tz`,
installs the agent as a systemd service, and the box **joins the cluster by
itself**. New databases are placed on the box with the most free memory.
If the repository is private, pass `BARUA_BINARY_URL` (the CI build artifact)
instead of building from source.

### 3. Use it

```bash
API=https://pgapi.barua.tz
# admin: create an API key for a customer
curl -X POST $API/v1/api-keys -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"name":"juma"}'

# customer: create a database
curl -X POST $API/v1/databases -H "Authorization: Bearer $KEY" -d '{"name":"shop"}'
# → { "connection_uri": "postgresql://app:…@br-k3j9x2m1qa.pg.barua.tz/app?sslmode=require", … }

psql "postgresql://app:…@br-k3j9x2m1qa.pg.barua.tz/app?sslmode=require"

# Pooled: many clients, few backends. Add -pooler to the host.
psql "postgresql://app:…@br-k3j9x2m1qa-pooler.pg.barua.tz/app?sslmode=require"
```

## API

All calls take `Authorization: Bearer <api key>` (or the admin token).

| Method & path | What it does |
|---|---|
| `POST /v1/databases` `{name, role?, database?}` | Create; returns the password once |
| `GET /v1/databases` | List your databases |
| `GET /v1/databases/{id}` | Details + live state (`awake` / `asleep` / `cold`) |
| `DELETE /v1/databases/{id}` | Delete, including its history in R2 |
| `POST /v1/databases/{id}/branches` `{name?, point_in_time?}` | Branch from now, or from any moment in the restore window |
| `GET /v1/databases/{id}/restore-points` | Earliest moment you can branch from |
| `POST /v1/databases/{id}/reset-password` | New password |
| `POST /v1/databases/{id}/suspend` | Put it to sleep now |
| `POST /v1/api-keys` `{name}` | *admin*: new API key |
| `GET /v1/boxes` | *admin*: boxes, capacity, online state |
| `POST /v1/boxes/{id}/drain` `{draining}` | *admin*: stop placing new databases on a box |
| `POST /v1/databases/{id}/move` `{box_id?, force?}` | *admin*: move a database (`force` if its box is dead) |
| `DELETE /v1/boxes/{id}` | *admin*: remove an empty box |

Connecting: libpq ≥ 14 sends the hostname (SNI), which is how the proxy finds
the database. Clients that can't: add `options=endpoint%3D<id>` to the URL
(same as Neon), or use the user name `app--<id>`.

## Development

```bash
cd agent && cargo test && cargo build
# run standalone against a local directory instead of R2 (as a non-root user):
BARUA_DATA=./data BARUA_STORAGE_DIR=./r2 BARUA_AGENT_TOKEN=dev \
BARUA_PROXY_ADDR=127.0.0.1:15432 BARUA_API_ADDR=127.0.0.1:18080 ./target/debug/barua serve

cd control && npm install && npm run db:init:local && npx wrangler dev
```
