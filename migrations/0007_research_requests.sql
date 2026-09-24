-- The paid tier's trigger seam (docs/paid-mcp-tier.md). One row per
-- tenant-triggered run request: queue, dedup, audit trail, and allowance
-- ledger in one table. The monthly allowance is a COUNT over these rows
-- (failed excluded), deterministic rather than a KV counter.
--
-- Apply with: npx wrangler d1 execute whimbrel-corpus --remote \
--   --file=migrations/0007_research_requests.sql
CREATE TABLE IF NOT EXISTS research_requests (
  request_id   TEXT PRIMARY KEY,          -- req_<hex>, minted by the worker
  tenant_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,             -- 'research' | 'onboard'
  company_name TEXT NOT NULL DEFAULT '',
  company_slug TEXT NOT NULL DEFAULT '',
  domain       TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL,             -- queued | running | done | failed
  detail       TEXT NOT NULL DEFAULT '',  -- failure reason or progress note
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_requests_by_tenant
  ON research_requests(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS research_requests_by_slug
  ON research_requests(company_slug, status);

-- The decisions no website publishes, gathered by the tenant's own AI and
-- stored verbatim as JSON: goals, disqualifiers, off-limits companies.
-- ALTER is not idempotent; apply once.
ALTER TABLE tenant_profiles ADD COLUMN preferences_json TEXT;
