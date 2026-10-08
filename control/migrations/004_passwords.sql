-- The console shows a working connection string, so the password has to be
-- recoverable. Encrypted with a key held in Worker secrets, never in D1.
ALTER TABLE databases ADD COLUMN password_enc TEXT;
