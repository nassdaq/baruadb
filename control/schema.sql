-- BaruaDB control plane (Cloudflare D1)

CREATE TABLE IF NOT EXISTS boxes (
  id               TEXT PRIMARY KEY,          -- box-xxxxxx
  name             TEXT NOT NULL,
  public_ip        TEXT NOT NULL,
  api_url          TEXT NOT NULL,
  agent_token      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active',  -- active | draining | offline
  cpus             INTEGER NOT NULL DEFAULT 0,
  mem_total_mb     INTEGER NOT NULL DEFAULT 0,
  mem_available_mb INTEGER NOT NULL DEFAULT 0,
  disk_free_mb     INTEGER NOT NULL DEFAULT 0,
  databases_awake  INTEGER NOT NULL DEFAULT 0,
  dns_record_id    TEXT,
  created_at       TEXT NOT NULL,
  last_seen        TEXT
);

CREATE TABLE IF NOT EXISTS api_keys (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  key_hash   TEXT NOT NULL UNIQUE,            -- sha256 of the key; the key itself is shown once
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS databases (
  id            TEXT PRIMARY KEY,             -- br-xxxxxxxxxx, also the hostname label
  name          TEXT NOT NULL,
  owner         TEXT NOT NULL,                -- api_keys.id, or 'admin'
  box_id        TEXT NOT NULL REFERENCES boxes(id),
  parent_id     TEXT,
  role          TEXT NOT NULL,
  dbname        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'creating',  -- creating | ready | failed (from heartbeats)
  location      TEXT NOT NULL DEFAULT 'local',     -- local | cold
  running       INTEGER NOT NULL DEFAULT 0,
  connections   INTEGER NOT NULL DEFAULT 0,
  dns_record_id TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS databases_owner ON databases(owner);
CREATE INDEX IF NOT EXISTS databases_box ON databases(box_id);
