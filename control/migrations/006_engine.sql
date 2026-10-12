-- Two engines, one hostname. A database is born as a function - an object
-- that exists only while a query runs - and earns a box when its own numbers
-- say so; it can go back down when it falls quiet. Nothing a customer holds
-- (host, role, database, password) changes when it moves.
ALTER TABLE databases ADD COLUMN engine TEXT NOT NULL DEFAULT 'box';   -- box | function
ALTER TABLE databases ADD COLUMN engine_since TEXT;
-- On the function engine the box's proxy checks the password itself:
-- sha256$<salt>$<hex of sha256("<salt>:<password>")>. Null on the box engine.
ALTER TABLE databases ADD COLUMN auth_verifier TEXT;

-- What a function reports about itself, every few minutes while it is busy.
ALTER TABLE metrics ADD COLUMN queries INTEGER;
ALTER TABLE metrics ADD COLUMN blocks_written INTEGER;
ALTER TABLE metrics ADD COLUMN storage_bytes INTEGER;
ALTER TABLE metrics ADD COLUMN active_ms INTEGER;

-- Odds and ends the cron keeps between runs.
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Every move, so the admin page and the cron can see what happened.
CREATE TABLE IF NOT EXISTS moves (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  db_id     TEXT NOT NULL,
  direction TEXT NOT NULL,      -- up: function -> box | down: box -> function
  reason    TEXT NOT NULL,
  ok        INTEGER NOT NULL,
  detail    TEXT,
  ms        INTEGER,
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS moves_db ON moves(db_id, at DESC);
