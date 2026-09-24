-- Enriched columns on the raw signal substrate, so the matching tools can
-- filter on timing and money in SQL: "fresh NIH money, Phase II, over $500k
-- since March." The values are computed once in Python at export time by the
-- same helpers that fill the feed (_amount_usd, nih_award_facts), so the
-- decode logic stays in one place and the worker filters columns, never text.
ALTER TABLE signal_archive ADD COLUMN amount_usd INTEGER;
ALTER TABLE signal_archive ADD COLUMN award_phase TEXT;
ALTER TABLE signal_archive ADD COLUMN award_year INTEGER;
ALTER TABLE signal_archive ADD COLUMN new_award INTEGER;  -- 1 = first-year money

CREATE INDEX IF NOT EXISTS signal_archive_by_kind_date
  ON signal_archive(signal_kind, signal_date DESC);
CREATE INDEX IF NOT EXISTS signal_archive_by_amount
  ON signal_archive(amount_usd);
