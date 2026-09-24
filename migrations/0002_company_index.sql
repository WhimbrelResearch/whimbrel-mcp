-- Enriched per-company view for the company-depth tools (micro_brief,
-- company_timeline). One row per company, the exact object corpus_export()
-- already builds for the KV blob: enrichment and the pool patent/filing union
-- happen once in Python, so the worker reads a composed row and does no
-- enrichment of its own. The raw signal_archive stays the SQL substrate for
-- the future matching tools; this table serves the current lookups as an
-- indexed fetch instead of loading the whole blob into worker memory.
--
-- name_norm is the company name run through the worker's own normalization
-- (lowercase, non-alphanumeric to single spaces, trimmed), so the worker can
-- match a user's query against it directly without porting the Python stem
-- logic to JavaScript.
CREATE TABLE IF NOT EXISTS company_index (
  company_slug  TEXT PRIMARY KEY,   -- the stem, matching the KV blob's keys
  name          TEXT NOT NULL,
  name_norm     TEXT NOT NULL,
  first_tracked TEXT,
  events_json   TEXT NOT NULL,      -- the enriched, sorted events array
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS company_index_by_name ON company_index(name_norm);
