-- One row per database per sample. Heartbeats arrive every 20 seconds; the
-- control plane keeps roughly one a minute so a week of history stays small.
CREATE TABLE IF NOT EXISTS metrics (
  db_id        TEXT NOT NULL,
  at           TEXT NOT NULL,          -- ISO 8601
  running      INTEGER NOT NULL,
  connections  INTEGER NOT NULL,
  memory_bytes INTEGER,
  cpu_usec     INTEGER,                -- cumulative; the reader differentiates
  tup_inserted INTEGER,
  tup_updated  INTEGER,
  tup_deleted  INTEGER,
  tup_fetched  INTEGER,
  deadlocks    INTEGER,
  blks_hit     INTEGER,
  blks_read    INTEGER,
  xact_commit  INTEGER,
  xact_rollback INTEGER,
  PRIMARY KEY (db_id, at)
);

CREATE INDEX IF NOT EXISTS metrics_db_at ON metrics(db_id, at DESC);
