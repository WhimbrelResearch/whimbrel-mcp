-- Live progress for a run in flight.
--
-- A research run takes minutes and an MCP call must return in seconds, so
-- the tenant's AI is told "queued, ask again" and then has nothing to say
-- while the customer waits. This is the ledger that fixes that: the workflow
-- appends a row as it enters each stage, and the worker reads them back as
-- MCP progress notifications and in research_status.
--
-- Append-only and ordered by seq rather than by timestamp, because two
-- stages inside the same second are common and their order is the point.
--
-- Apply with: npx wrangler d1 execute whimbrel-corpus --remote \
--   --file=migrations/0009_research_progress.sql
CREATE TABLE IF NOT EXISTS research_progress (
  request_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  stage      TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  at         TEXT NOT NULL,
  PRIMARY KEY (request_id, seq)
);
