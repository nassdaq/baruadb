-- Regions. A box sits in one; a database may ask for one. The function tier
-- has no region of its own (it runs on the edge), so asking for a region is
-- how a customer says "give this database a home on metal, there".
ALTER TABLE boxes ADD COLUMN zone TEXT NOT NULL DEFAULT 'default';
-- NULL = automatic (Barua decides: a function until it earns a box). A value
-- pins the database to a box in that region and keeps it off the light tier.
ALTER TABLE databases ADD COLUMN zone TEXT;
