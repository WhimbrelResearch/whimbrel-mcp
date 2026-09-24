-- Deep research records: the corpus-depth layer (layer 2 of the Step 5 design).
-- One row per (company, version). The shared company core lives here as JSON
-- (leadership, deep evidence, verification, gaps) with a pointer to the full
-- bundle archived in R2; the per-client matching overlay is deliberately not
-- stored here, so a record is reused across every client's brief. Versioned,
-- never overwritten: the latest version is the current record, older ones are
-- retained, matching the audit-bundle and lifecycle model.
CREATE TABLE IF NOT EXISTS research_records (
  company_slug  TEXT NOT NULL,
  version       TEXT NOT NULL,   -- run timestamp; the highest is current
  company_name  TEXT NOT NULL,
  r2_key        TEXT NOT NULL,   -- pointer to the full bundle in R2
  researched_on TEXT,
  core_json     TEXT NOT NULL,   -- the shared company core, no client overlay
  created_at    TEXT NOT NULL,
  PRIMARY KEY (company_slug, version)
);
CREATE INDEX IF NOT EXISTS research_records_by_company
  ON research_records(company_slug, version DESC);
