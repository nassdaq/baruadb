-- Who signed up from where. A second account opened from a device that
-- already has one is linked to the first and starts with no free allowance:
-- the free tier is per person, not per email address. An admin can raise it.
ALTER TABLE users ADD COLUMN device_id TEXT;       -- long-lived browser cookie
ALTER TABLE users ADD COLUMN device_hash TEXT;     -- client-side fingerprint, sha-256 hex
ALTER TABLE users ADD COLUMN signup_ip TEXT;
ALTER TABLE users ADD COLUMN signup_ua TEXT;
ALTER TABLE users ADD COLUMN signup_country TEXT;
ALTER TABLE users ADD COLUMN linked_to TEXT REFERENCES users(id);  -- the earlier account on the same device
CREATE INDEX IF NOT EXISTS users_device_id ON users(device_id);
CREATE INDEX IF NOT EXISTS users_device_hash ON users(device_hash);
