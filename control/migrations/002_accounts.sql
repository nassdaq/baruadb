-- Accounts. Until now a database was owned by an API key (or by 'admin');
-- from here a person owns it, and keys belong to a person too.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,              -- usr_xxxxxxxxxx
  email         TEXT NOT NULL UNIQUE,          -- stored lowercased
  password_hash TEXT NOT NULL,                 -- pbkdf2$iterations$salt$hash
  name          TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  db_quota      INTEGER NOT NULL DEFAULT 3,    -- how many databases this person may create
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,                 -- sha256 of the cookie value
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

-- Existing rows keep working: owner stays as it was, user_id is simply null
-- for anything created before accounts existed.
ALTER TABLE databases ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE api_keys  ADD COLUMN user_id TEXT REFERENCES users(id);

CREATE INDEX IF NOT EXISTS databases_user ON databases(user_id);
CREATE INDEX IF NOT EXISTS api_keys_user ON api_keys(user_id);
