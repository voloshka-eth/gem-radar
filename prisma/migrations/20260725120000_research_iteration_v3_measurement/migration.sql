-- Additive research-provenance and Solana attribution migration.
-- No historical fills, positions, CSV rows, or strategy outcomes are updated.

ALTER TABLE "solana_experiment_signals" ADD COLUMN "feature_schema_version" TEXT;

ALTER TABLE "solana_launch_watches"
  ADD COLUMN "launch_id" TEXT,
  ADD COLUMN "migration_id" TEXT;

ALTER TABLE "solana_swap_observations"
  ADD COLUMN "attribution_status" TEXT NOT NULL DEFAULT 'RESOLVED',
  ADD COLUMN "launch_id" TEXT,
  ADD COLUMN "migration_id" TEXT,
  ADD COLUMN "pool_address" TEXT,
  ADD COLUMN "token_mint" TEXT;

CREATE TABLE "solana_trade_attribution_issues" (
  "id" TEXT NOT NULL,
  "chain" TEXT NOT NULL DEFAULT 'solana',
  "venue" TEXT NOT NULL,
  "program_id" TEXT NOT NULL,
  "pool_address" TEXT,
  "token_mint" TEXT,
  "signature" TEXT NOT NULL,
  "instruction_index" INTEGER NOT NULL,
  "slot" BIGINT NOT NULL,
  "reason" TEXT NOT NULL,
  "candidate_watch_ids" JSONB,
  "raw_snapshot" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "solana_trade_attribution_issues_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "research_iteration_snapshots" (
  "id" TEXT NOT NULL,
  "iteration" TEXT NOT NULL,
  "git_commit" TEXT NOT NULL,
  "cutoff_at" TIMESTAMP(3) NOT NULL,
  "strategy_versions" JSONB NOT NULL,
  "config_hashes" JSONB NOT NULL,
  "benchmark_summary" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_iteration_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "solana_trade_attribution_issues_reason_created_at_idx"
  ON "solana_trade_attribution_issues"("reason", "created_at");
CREATE UNIQUE INDEX "solana_trade_attribution_issues_program_id_signature_instru_key"
  ON "solana_trade_attribution_issues"("program_id", "signature", "instruction_index");
CREATE UNIQUE INDEX "research_iteration_snapshots_iteration_key"
  ON "research_iteration_snapshots"("iteration");
CREATE INDEX "solana_swap_observations_pool_address_ts_idx"
  ON "solana_swap_observations"("pool_address", "ts");
CREATE INDEX "solana_swap_observations_token_mint_ts_idx"
  ON "solana_swap_observations"("token_mint", "ts");
