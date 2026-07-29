-- Immutable pool eras keep a launch's bonding-curve and post-migration pools
-- distinct. Existing observations are intentionally left untouched.
ALTER TABLE "solana_swap_observations" ADD COLUMN "pool_era_id" TEXT;

CREATE TABLE "solana_pool_eras" (
  "id" TEXT NOT NULL,
  "watch_id" TEXT NOT NULL,
  "venue" TEXT NOT NULL,
  "program_id" TEXT NOT NULL,
  "pool_address" TEXT NOT NULL,
  "quote_mint" TEXT NOT NULL,
  "migration_id" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "started_at" TIMESTAMP(3) NOT NULL,
  "ended_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "solana_pool_eras_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "solana_pool_eras_program_id_pool_address_key"
  ON "solana_pool_eras"("program_id", "pool_address");
CREATE INDEX "solana_pool_eras_watch_id_active_idx"
  ON "solana_pool_eras"("watch_id", "active");
CREATE INDEX "solana_pool_eras_venue_pool_address_active_idx"
  ON "solana_pool_eras"("venue", "pool_address", "active");
CREATE INDEX "solana_swap_observations_pool_era_id_ts_idx"
  ON "solana_swap_observations"("pool_era_id", "ts");

ALTER TABLE "solana_swap_observations"
  ADD CONSTRAINT "solana_swap_observations_pool_era_id_fkey"
  FOREIGN KEY ("pool_era_id") REFERENCES "solana_pool_eras"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "solana_pool_eras"
  ADD CONSTRAINT "solana_pool_eras_watch_id_fkey"
  FOREIGN KEY ("watch_id") REFERENCES "solana_launch_watches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
