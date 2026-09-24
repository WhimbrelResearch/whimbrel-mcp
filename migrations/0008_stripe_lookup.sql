-- Billing lands by webhook (docs/migration-architecture.md), which arrives
-- knowing only Stripe's customer id, so that is the lookup key on every event
-- after the first. Without this index every renewal is a table scan.
--
-- Apply with: npx wrangler d1 execute whimbrel-corpus --remote \
--   --file=migrations/0008_stripe_lookup.sql
CREATE INDEX IF NOT EXISTS tenants_by_stripe_customer
  ON tenants(stripe_customer_id);
