-- Add-ons: the primitives a customer switches on inside a database. The
-- first is Tasks (durable background work). The shape is general, so
-- webhooks, storage and email can follow without another table.
CREATE TABLE IF NOT EXISTS addons (
  db_id      TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                    -- tasks | …
  key_enc    TEXT,                             -- the add-on's own key, sealed like a password
  settings   TEXT NOT NULL DEFAULT '{}',       -- JSON, e.g. {"handler_url": "…"}
  created_at TEXT NOT NULL,
  PRIMARY KEY (db_id, kind)
);
