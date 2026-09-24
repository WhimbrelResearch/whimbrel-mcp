-- Run packs: extra research runs bought when a month's plan allowance runs
-- out.
--
-- Deliberately monthly-scoped rather than a banked balance. The allowance a
-- tenant has in a month is their plan's runs plus the packs they bought that
-- month, computed by summing this table for the month; nothing is ever
-- decremented. That matters for one reason: the monthly usage count already
-- excludes failed runs, so a failed run un-charges itself, and a decrementing
-- balance would have to be credited back by hand to keep the same promise.
--
-- It also matches what a pack is for. Nobody buys one to stockpile; they buy
-- it because they hit the ceiling mid-thought and want to keep going today.
-- The published copy says "adds runs to this month" and means it.
--
-- Apply with: npx wrangler d1 execute whimbrel-corpus --remote \
--   --file=migrations/0010_run_packs.sql
CREATE TABLE IF NOT EXISTS run_packs (
  pack_id      TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  runs         INTEGER NOT NULL,
  stripe_event TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS run_packs_tenant_month
  ON run_packs (tenant_id, created_at);
