-- Whimbrel store, D1 schema. Step 2 of docs/migration-architecture.md.
--
-- D1 is SQLite, so the corpus and tenant tables move over almost verbatim from
-- the laptop store (medtech-intelligence-mvp/data/dashboard.sqlite3). The one
-- new table is `tenants`: the paid gate's entitlement record. The operator- and
-- runner-era tables (prospects, review_events, generated_reports, runs) are
-- deliberately left behind; they served the removed dashboard.

-- ---------------------------------------------------------------------------
-- Corpus: the shared, public asset. One row per (company, signal). The thing
-- every client's AI queries. Schema matches signal_archive on the laptop.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signal_archive (
  signal_key     TEXT PRIMARY KEY,
  company_name   TEXT NOT NULL,
  company_slug   TEXT NOT NULL,
  domain         TEXT,
  signal_kind    TEXT NOT NULL,
  signal_summary TEXT NOT NULL DEFAULT '',
  signal_date    TEXT,
  source_url     TEXT,
  statement      TEXT NOT NULL DEFAULT '',
  first_seen     TEXT NOT NULL,
  last_seen      TEXT NOT NULL,
  times_seen     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS signal_archive_by_company ON signal_archive(company_slug);
CREATE INDEX IF NOT EXISTS signal_archive_by_date ON signal_archive(signal_date DESC);
CREATE INDEX IF NOT EXISTS signal_archive_by_kind ON signal_archive(signal_kind);

-- Trial status transitions, part of ingest state (dedupes ClinicalTrials.gov
-- status changes so a re-read of the same trial is not a fresh signal).
CREATE TABLE IF NOT EXISTS trial_states (
  nct_id        TEXT PRIMARY KEY,
  company_slug  TEXT NOT NULL,
  status        TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- The paid gate. One row per client. The access layer reads this on every
-- metered call: no active row -> refuse. Stripe webhooks flip status and
-- paid_through. `tier` maps to which tools and what volume the client gets.
-- api_key_hash is a SHA-256 of the client's key; the raw key is never stored.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  tenant_id     TEXT PRIMARY KEY,          -- stable id, also the client_key below
  name          TEXT NOT NULL,
  domain        TEXT,
  api_key_hash  TEXT UNIQUE,               -- SHA-256 of the bearer key
  tier          TEXT NOT NULL DEFAULT 'trial',
  status        TEXT NOT NULL DEFAULT 'active',  -- active | past_due | canceled
  paid_through  TEXT,                       -- ISO date; NULL for trial
  stripe_customer_id TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tenants_by_key ON tenants(api_key_hash);

-- ---------------------------------------------------------------------------
-- Per-tenant state. `client_key` is the tenant reference (kept as-is from the
-- laptop store to avoid a rename migration; it equals tenants.tenant_id).
-- ---------------------------------------------------------------------------

-- The client's calibration fingerprint, so screening only re-runs on change.
CREATE TABLE IF NOT EXISTS client_screen_state (
  client_key   TEXT PRIMARY KEY,
  fingerprint  TEXT NOT NULL,
  screened_at  TEXT NOT NULL
);

-- Companies surfaced to a client by Standing Watch, awaiting accept/reject.
CREATE TABLE IF NOT EXISTS watch_candidates (
  candidate_id   TEXT PRIMARY KEY,
  client_key     TEXT NOT NULL,
  company_name   TEXT NOT NULL,
  slug           TEXT NOT NULL,
  domain         TEXT,
  signal_kind    TEXT NOT NULL,
  signal_key     TEXT NOT NULL,
  signal_summary TEXT NOT NULL DEFAULT '',
  signal_date    TEXT,
  source_url     TEXT,
  reason         TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL,
  decided_at     TEXT,
  decided_reason TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE(client_key, slug, signal_key)
);
CREATE INDEX IF NOT EXISTS watch_by_client ON watch_candidates(client_key, status);

-- Target companies a client is pursuing, one row per (client, company).
CREATE TABLE IF NOT EXISTS targets (
  target_id     TEXT PRIMARY KEY,
  client_key    TEXT NOT NULL,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  domain        TEXT,
  domain_source TEXT,
  origin        TEXT NOT NULL,
  stage         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(client_key, slug)
);
CREATE INDEX IF NOT EXISTS targets_by_client ON targets(client_key);

-- New signals on a client's accepted targets, the "what changed" feed.
CREATE TABLE IF NOT EXISTS account_events (
  event_id     TEXT PRIMARY KEY,
  client_key   TEXT NOT NULL,
  target_slug  TEXT NOT NULL,
  company_name TEXT NOT NULL,
  signal_kind  TEXT NOT NULL,
  signal_key   TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  event_date   TEXT,
  source_url   TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE(client_key, target_slug, signal_key)
);
CREATE INDEX IF NOT EXISTS account_events_by_client ON account_events(client_key, event_date DESC);
