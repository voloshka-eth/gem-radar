ALTER TABLE "robinhood_entry_experiments"
  ADD COLUMN IF NOT EXISTS "friction_cohort" TEXT NOT NULL DEFAULT 'LEGACY_UNCLASSIFIED',
  ADD COLUMN IF NOT EXISTS "t0_buy_impact_pct" DECIMAL(10,6),
  ADD COLUMN IF NOT EXISTS "t0_sell_impact_pct" DECIMAL(10,6),
  ADD COLUMN IF NOT EXISTS "t0_quote_age_ms" INTEGER,
  ADD COLUMN IF NOT EXISTS "shared_entry_quote_id" TEXT;

CREATE INDEX IF NOT EXISTS "robinhood_entry_experiments_config_hash_friction_cohort_status_idx"
  ON "robinhood_entry_experiments"("config_hash", "friction_cohort", "status");
