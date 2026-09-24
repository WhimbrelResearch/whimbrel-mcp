-- Per-tenant capability profile, so a "matches for us" query filters by the
-- client's own capabilities without them passing terms each time. This is
-- calibration living server-side. terms_json is the capability-shaped net the
-- matching tool casts (broad recall); the client's own AI does the fine fit
-- judgment on the returned evidence (precision). capabilities_json carries the
-- capability names/statements so that judgment has the full context.
CREATE TABLE IF NOT EXISTS tenant_profiles (
  tenant_id         TEXT PRIMARY KEY,
  client_name       TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  terms_json        TEXT NOT NULL DEFAULT '[]',
  updated_at        TEXT NOT NULL
);
