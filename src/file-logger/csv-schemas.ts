// All CSV column definitions live here.
// Adding a field: extend the interface, add an entry to the headers array,
// bump CSV_SCHEMA_VERSION.  Never reorder existing columns — append only.

export const CSV_SCHEMA_VERSION = '1.3.0'; // M5 paper-trade evaluator

export interface CsvHeader {
  id: string;   // matches the key in the row object
  title: string; // written as the CSV column header
}

// ─── raw/new_pools.csv ─────────────────────────────────────────────────────────
export interface NewPoolRow {
  ts: string;
  run_id: string;
  schema_version: string;
  chain: string;
  token_address: string;
  token_symbol: string;
  token_name: string;
  pool_address: string;
  dex: string;
  quote_asset: string;
  price_usd: string;
  liquidity_usd: string;
  fdv_usd: string;
  vol_5m: string;
  vol_1h: string;
  vol_6h: string;
  vol_24h: string;
  buys_1h: string;
  sells_1h: string;
  pool_created_at: string;
  source: string;
  // M2A: marks whether the contract risk check succeeded
  // CONTRACT_UNKNOWN rows must NOT be forwarded to future scoring/paper-trading
  risk_decision: string; // CONTRACT_SAFE | CONTRACT_UNKNOWN
}

export const NEW_POOL_HEADERS: CsvHeader[] = [
  { id: 'ts', title: 'ts' },
  { id: 'run_id', title: 'run_id' },
  { id: 'schema_version', title: 'schema_version' },
  { id: 'chain', title: 'chain' },
  { id: 'token_address', title: 'token_address' },
  { id: 'token_symbol', title: 'token_symbol' },
  { id: 'token_name', title: 'token_name' },
  { id: 'pool_address', title: 'pool_address' },
  { id: 'dex', title: 'dex' },
  { id: 'quote_asset', title: 'quote_asset' },
  { id: 'price_usd', title: 'price_usd' },
  { id: 'liquidity_usd', title: 'liquidity_usd' },
  { id: 'fdv_usd', title: 'fdv_usd' },
  { id: 'vol_5m', title: 'vol_5m' },
  { id: 'vol_1h', title: 'vol_1h' },
  { id: 'vol_6h', title: 'vol_6h' },
  { id: 'vol_24h', title: 'vol_24h' },
  { id: 'buys_1h', title: 'buys_1h' },
  { id: 'sells_1h', title: 'sells_1h' },
  { id: 'pool_created_at', title: 'pool_created_at' },
  { id: 'source', title: 'source' },
  { id: 'risk_decision', title: 'risk_decision' },
];

// ─── decisions/rejected_tokens.csv ────────────────────────────────────────────
// Full candidate context is preserved so the rejection set can be used as
// training data to tune Stage 0 thresholds.
export interface RejectedTokenRow {
  ts: string;
  run_id: string;
  schema_version: string;
  chain: string;
  token_address: string;
  token_symbol: string;
  token_name: string;
  pool_address: string;
  dex: string;
  quote_asset: string;
  price_usd: string;
  liquidity_usd: string;
  fdv_usd: string;
  vol_5m: string;
  vol_1h: string;
  vol_6h: string;
  vol_24h: string;
  buys_1h: string;
  sells_1h: string;
  tx_count_1h: string;
  pool_created_at: string;
  pool_age_minutes: string;
  stage: string;
  reason: string;
  source: string;
  // M1 placeholders — will be populated in M2+ after on-chain verification
  liquidity_trust_level: string; // always "REPORTED_ONLY" in M1
  onchain_verified: string;      // always "false" in M1
}

export const REJECTED_TOKEN_HEADERS: CsvHeader[] = [
  { id: 'ts', title: 'ts' },
  { id: 'run_id', title: 'run_id' },
  { id: 'schema_version', title: 'schema_version' },
  { id: 'chain', title: 'chain' },
  { id: 'token_address', title: 'token_address' },
  { id: 'token_symbol', title: 'token_symbol' },
  { id: 'token_name', title: 'token_name' },
  { id: 'pool_address', title: 'pool_address' },
  { id: 'dex', title: 'dex' },
  { id: 'quote_asset', title: 'quote_asset' },
  { id: 'price_usd', title: 'price_usd' },
  { id: 'liquidity_usd', title: 'liquidity_usd' },
  { id: 'fdv_usd', title: 'fdv_usd' },
  { id: 'vol_5m', title: 'vol_5m' },
  { id: 'vol_1h', title: 'vol_1h' },
  { id: 'vol_6h', title: 'vol_6h' },
  { id: 'vol_24h', title: 'vol_24h' },
  { id: 'buys_1h', title: 'buys_1h' },
  { id: 'sells_1h', title: 'sells_1h' },
  { id: 'tx_count_1h', title: 'tx_count_1h' },
  { id: 'pool_created_at', title: 'pool_created_at' },
  { id: 'pool_age_minutes', title: 'pool_age_minutes' },
  { id: 'stage', title: 'stage' },
  { id: 'reason', title: 'reason' },
  { id: 'source', title: 'source' },
  { id: 'liquidity_trust_level', title: 'liquidity_trust_level' },
  { id: 'onchain_verified', title: 'onchain_verified' },
];

// ─── decisions/scoring_history.csv ────────────────────────────────────────────
// M4 scoring. Append-only. One row per CONTRACT_SAFE + liquidity_verified survivor
// per cycle. Component columns are EMPTY (not 0, not 50) when that component had no
// data and was omitted from the weighted average. UNVALIDATED ranking hypothesis —
// not edge, not backtested, not a buy signal.
export interface ScoringHistoryRow {
  ts: string;
  run_id: string;
  schema_version: string;
  chain: string;
  token_address: string;
  pool_address: string;
  liquidity_model: string;       // V2 | V3
  liquidity_score: string;
  depth_score: string;
  age_score: string;
  traction_score: string;
  divergence_score: string;      // higher = healthier divergence (V2); empty for V3 (structural)
  final_score: string;
  band: string;                  // reject_band | watchlist | candidate | high_band
  score_confidence: string;      // computed / FULL intended model (0–1); ~0.5 today, never 1.0
  components_present: string;    // semicolon-joined component keys
  components_missing: string;    // implemented-without-data + unimplemented rug-vector components
}

export const SCORING_HISTORY_HEADERS: CsvHeader[] = [
  { id: 'ts', title: 'ts' },
  { id: 'run_id', title: 'run_id' },
  { id: 'schema_version', title: 'schema_version' },
  { id: 'chain', title: 'chain' },
  { id: 'token_address', title: 'token_address' },
  { id: 'pool_address', title: 'pool_address' },
  { id: 'liquidity_model', title: 'liquidity_model' },
  { id: 'liquidity_score', title: 'liquidity_score' },
  { id: 'depth_score', title: 'depth_score' },
  { id: 'age_score', title: 'age_score' },
  { id: 'traction_score', title: 'traction_score' },
  { id: 'divergence_score', title: 'divergence_score' },
  { id: 'final_score', title: 'final_score' },
  { id: 'band', title: 'band' },
  { id: 'score_confidence', title: 'score_confidence' },
  { id: 'components_present', title: 'components_present' },
  { id: 'components_missing', title: 'components_missing' },
];

// ─── decisions/watchlist_tokens.csv ───────────────────────────────────────────
export interface WatchlistTokenRow {
  ts: string;
  run_id: string;
  schema_version: string;
  chain: string;
  token_address: string;
  token_symbol: string;
  pool_address: string;
  final_score: string;
  liquidity_usd: string;
  fdv_usd: string;
  dexscreener_url: string;
}

export const WATCHLIST_TOKEN_HEADERS: CsvHeader[] = [
  { id: 'ts', title: 'ts' },
  { id: 'run_id', title: 'run_id' },
  { id: 'schema_version', title: 'schema_version' },
  { id: 'chain', title: 'chain' },
  { id: 'token_address', title: 'token_address' },
  { id: 'token_symbol', title: 'token_symbol' },
  { id: 'pool_address', title: 'pool_address' },
  { id: 'final_score', title: 'final_score' },
  { id: 'liquidity_usd', title: 'liquidity_usd' },
  { id: 'fdv_usd', title: 'fdv_usd' },
  { id: 'dexscreener_url', title: 'dexscreener_url' },
];

// ─── decisions/paper_entries.csv ──────────────────────────────────────────────
// M5 PAPER entry, recorded once at discovery with PESSIMISTIC modeled fill.
// `entered=false` rows carry not_entered_reason. NOT a buy signal.
export interface PaperEntryRow {
  ts: string;
  run_id: string;
  schema_version: string;
  chain: string;
  token_address: string;
  symbol: string;
  pool_address: string;
  liquidity_model: string;
  first_seen_at: string;
  detection_delay_sec: string;
  opened_at: string;
  size_usd: string;
  spot_price_usd: string;
  entry_price_effective_usd: string;
  slippage_pct: string;
  sandwich_pct: string;
  gas_usd: string;
  buy_tax_pct: string;
  tokens_bought: string;
  onchain_liq_entry_usd: string;
  entered: string;                 // true | false
  not_entered_reason: string;
  final_score: string;
  band: string;
  score_confidence: string;
}

export const PAPER_ENTRY_HEADERS: CsvHeader[] = [
  { id: 'ts', title: 'ts' },
  { id: 'run_id', title: 'run_id' },
  { id: 'schema_version', title: 'schema_version' },
  { id: 'chain', title: 'chain' },
  { id: 'token_address', title: 'token_address' },
  { id: 'symbol', title: 'symbol' },
  { id: 'pool_address', title: 'pool_address' },
  { id: 'liquidity_model', title: 'liquidity_model' },
  { id: 'first_seen_at', title: 'first_seen_at' },
  { id: 'detection_delay_sec', title: 'detection_delay_sec' },
  { id: 'opened_at', title: 'opened_at' },
  { id: 'size_usd', title: 'size_usd' },
  { id: 'spot_price_usd', title: 'spot_price_usd' },
  { id: 'entry_price_effective_usd', title: 'entry_price_effective_usd' },
  { id: 'slippage_pct', title: 'slippage_pct' },
  { id: 'sandwich_pct', title: 'sandwich_pct' },
  { id: 'gas_usd', title: 'gas_usd' },
  { id: 'buy_tax_pct', title: 'buy_tax_pct' },
  { id: 'tokens_bought', title: 'tokens_bought' },
  { id: 'onchain_liq_entry_usd', title: 'onchain_liq_entry_usd' },
  { id: 'entered', title: 'entered' },
  { id: 'not_entered_reason', title: 'not_entered_reason' },
  { id: 'final_score', title: 'final_score' },
  { id: 'band', title: 'band' },
  { id: 'score_confidence', title: 'score_confidence' },
];

// ─── decisions/position_ticks.csv ─────────────────────────────────────────────
// M5 extension — one row per OPEN position per `npm run eval` run. COLLECTION ONLY:
// captures post-t0 rug signals (sellers/buyers, re-run sell simulation) so that, once
// enough positions close, we can see whether they separate rugs from survivors. These
// signals are NOT yet wired into any exit/invalidation rule.
export interface PositionTickRow {
  ts: string;
  run_id: string;
  chain: string;
  token_address: string;
  pool_address: string;
  price_now: string;
  onchain_liquidity_usd: string;
  unique_buyers: string;
  unique_sellers: string;
  sellers_to_buyers_ratio: string; // unique_sellers / max(unique_buyers, 1)
  buys: string;
  sells: string;
  sell_to_buy_vol_ratio: string;   // empty when the source does not split buy/sell volume
  sell_sim_ok: string;             // re-run sell simulation passed now? (true|false|empty=unknown)
  sell_tax_now: string;
  multiple_vs_entry: string;
  status: string;
}

export const POSITION_TICK_HEADERS: CsvHeader[] = [
  { id: 'ts', title: 'ts' },
  { id: 'run_id', title: 'run_id' },
  { id: 'chain', title: 'chain' },
  { id: 'token_address', title: 'token_address' },
  { id: 'pool_address', title: 'pool_address' },
  { id: 'price_now', title: 'price_now' },
  { id: 'onchain_liquidity_usd', title: 'onchain_liquidity_usd' },
  { id: 'unique_buyers', title: 'unique_buyers' },
  { id: 'unique_sellers', title: 'unique_sellers' },
  { id: 'sellers_to_buyers_ratio', title: 'sellers_to_buyers_ratio' },
  { id: 'buys', title: 'buys' },
  { id: 'sells', title: 'sells' },
  { id: 'sell_to_buy_vol_ratio', title: 'sell_to_buy_vol_ratio' },
  { id: 'sell_sim_ok', title: 'sell_sim_ok' },
  { id: 'sell_tax_now', title: 'sell_tax_now' },
  { id: 'multiple_vs_entry', title: 'multiple_vs_entry' },
  { id: 'status', title: 'status' },
];

// ─── decisions/paper_exits.csv ────────────────────────────────────────────────
// M5 PAPER exit events (ladder sells + invalidation sells), one row per event,
// each with PESSIMISTIC modeled proceeds. Written on demand by `npm run eval`.
export interface PaperExitRow {
  ts: string;
  run_id: string;
  schema_version: string;
  chain: string;
  token_address: string;
  symbol: string;
  pool_address: string;
  event_type: string;        // LADDER_SELL | INVALIDATE_SELL
  status: string;            // alive | liquidity_pulled | unsellable | rug
  price_usd: string;
  multiple: string;
  fraction: string;          // fraction of original position sold in this event
  tokens: string;
  net_usd: string;           // pessimistic net proceeds
  slip_pct: string;
  realized_multiple_total: string; // cumulative realized value / size after this event
  note: string;
}

export const PAPER_EXIT_HEADERS: CsvHeader[] = [
  { id: 'ts', title: 'ts' },
  { id: 'run_id', title: 'run_id' },
  { id: 'schema_version', title: 'schema_version' },
  { id: 'chain', title: 'chain' },
  { id: 'token_address', title: 'token_address' },
  { id: 'symbol', title: 'symbol' },
  { id: 'pool_address', title: 'pool_address' },
  { id: 'event_type', title: 'event_type' },
  { id: 'status', title: 'status' },
  { id: 'price_usd', title: 'price_usd' },
  { id: 'multiple', title: 'multiple' },
  { id: 'fraction', title: 'fraction' },
  { id: 'tokens', title: 'tokens' },
  { id: 'net_usd', title: 'net_usd' },
  { id: 'slip_pct', title: 'slip_pct' },
  { id: 'realized_multiple_total', title: 'realized_multiple_total' },
  { id: 'note', title: 'note' },
];

// ─── raw/contract_risk_checks.csv ─────────────────────────────────────────────
// All risk-check results (safe, reject, unknown). 24 fields.
// Field order is append-only — never reorder.
export interface ContractRiskRow {
  // original 19 fields (M1 placeholder, now fully populated)
  ts: string;
  run_id: string;
  schema_version: string;
  chain: string;
  token_address: string;
  token_symbol: string;
  source: string;           // 'goplus'
  verified: string;         // 'true' | 'false' | ''
  honeypot: string;
  buy_tax: string;          // percentage, e.g. '1.00'
  sell_tax: string;
  can_mint: string;
  can_blacklist: string;
  can_pause: string;
  is_proxy: string;
  owner_renounced: string;
  lp_locked_or_burned: string;
  hard_reject: string;      // 'true' | 'false'
  reject_reason: string;    // first reason code, or ''
  // 5 fields added in M2A (appended — never inserted before existing)
  token_name: string;
  goplus_queried: string;   // 'true' | 'false'
  honeypot_queried: string;
  decision: string;         // CONTRACT_SAFE | CONTRACT_REJECT | CONTRACT_UNKNOWN
  reject_reasons: string;   // semicolon-joined list of reason codes, or ''
}

export const CONTRACT_RISK_HEADERS: CsvHeader[] = [
  { id: 'ts', title: 'ts' },
  { id: 'run_id', title: 'run_id' },
  { id: 'schema_version', title: 'schema_version' },
  { id: 'chain', title: 'chain' },
  { id: 'token_address', title: 'token_address' },
  { id: 'token_symbol', title: 'token_symbol' },
  { id: 'source', title: 'source' },
  { id: 'verified', title: 'verified' },
  { id: 'honeypot', title: 'honeypot' },
  { id: 'buy_tax', title: 'buy_tax' },
  { id: 'sell_tax', title: 'sell_tax' },
  { id: 'can_mint', title: 'can_mint' },
  { id: 'can_blacklist', title: 'can_blacklist' },
  { id: 'can_pause', title: 'can_pause' },
  { id: 'is_proxy', title: 'is_proxy' },
  { id: 'owner_renounced', title: 'owner_renounced' },
  { id: 'lp_locked_or_burned', title: 'lp_locked_or_burned' },
  { id: 'hard_reject', title: 'hard_reject' },
  { id: 'reject_reason', title: 'reject_reason' },
  // M2A additions
  { id: 'token_name', title: 'token_name' },
  { id: 'goplus_queried', title: 'goplus_queried' },
  { id: 'honeypot_queried', title: 'honeypot_queried' },
  { id: 'decision', title: 'decision' },
  { id: 'reject_reasons', title: 'reject_reasons' },
];

// ─── decisions/quarantine_tokens.csv ─────────────────────────────────────────
// CONTRACT_UNKNOWN tokens — both GoPlus and Honeypot.is were unavailable.
// These are NOT in new_pools.csv and must NOT be forwarded to scoring / paper-trading.
export interface QuarantineTokenRow {
  ts: string;
  run_id: string;
  schema_version: string;
  chain: string;
  token_address: string;
  token_symbol: string;
  token_name: string;
  pool_address: string;
  dex: string;
  status: string; // PENDING | RESOLVED | ABANDONED
}

export const QUARANTINE_TOKEN_HEADERS: CsvHeader[] = [
  { id: 'ts', title: 'ts' },
  { id: 'run_id', title: 'run_id' },
  { id: 'schema_version', title: 'schema_version' },
  { id: 'chain', title: 'chain' },
  { id: 'token_address', title: 'token_address' },
  { id: 'token_symbol', title: 'token_symbol' },
  { id: 'token_name', title: 'token_name' },
  { id: 'pool_address', title: 'pool_address' },
  { id: 'dex', title: 'dex' },
  { id: 'status', title: 'status' },
];

// ─── decisions/contract_rejected_tokens.csv ───────────────────────────────────
// Tokens that received CONTRACT_REJECT — hard-blocked before DB persistence.
export interface ContractRejectedTokenRow {
  ts: string;
  run_id: string;
  schema_version: string;
  chain: string;
  token_address: string;
  token_symbol: string;
  token_name: string;
  pool_address: string;
  decision: string;       // always 'CONTRACT_REJECT'
  reject_reasons: string; // semicolon-joined reason codes
  // Key risk flags from merged GoPlus + Honeypot.is data
  honeypot: string;     // 'true' | 'false' | ''
  sell_tax: string;     // percentage, e.g. '15.00'  | ''
  buy_tax: string;
  can_mint: string;
  can_blacklist: string;
  can_pause: string;
  is_proxy: string;
}

export const CONTRACT_REJECTED_TOKEN_HEADERS: CsvHeader[] = [
  { id: 'ts', title: 'ts' },
  { id: 'run_id', title: 'run_id' },
  { id: 'schema_version', title: 'schema_version' },
  { id: 'chain', title: 'chain' },
  { id: 'token_address', title: 'token_address' },
  { id: 'token_symbol', title: 'token_symbol' },
  { id: 'token_name', title: 'token_name' },
  { id: 'pool_address', title: 'pool_address' },
  { id: 'decision', title: 'decision' },
  { id: 'reject_reasons', title: 'reject_reasons' },
  { id: 'honeypot', title: 'honeypot' },
  { id: 'sell_tax', title: 'sell_tax' },
  { id: 'buy_tax', title: 'buy_tax' },
  { id: 'can_mint', title: 'can_mint' },
  { id: 'can_blacklist', title: 'can_blacklist' },
  { id: 'can_pause', title: 'can_pause' },
  { id: 'is_proxy', title: 'is_proxy' },
];

// ─── raw/pool_snapshots.csv ────────────────────────────────────────────────────
// One row per SAFE candidate per cycle — intentionally repeats across cycles.
// This is the trajectory time-series for backtesting; do NOT dedup this file.
export interface PoolSnapshotRow {
  ts: string;
  run_id: string;
  schema_version: string;
  chain: string;
  token_address: string;
  pool_address: string;
  price_usd: string;
  liquidity_usd: string;
  fdv_usd: string;
  vol_5m: string;
  vol_1h: string;
  vol_6h: string;
  vol_24h: string;
  buys_1h: string;
  sells_1h: string;
  source: string;
}

// ─── raw/pool_liquidity_snapshots.csv ─────────────────────────────────────────
// One row per CONTRACT_SAFE candidate per cycle (after on-chain liquidity check).
// Append-only. Never cache on-chain data — it changes per block.
export interface PoolLiquiditySnapshotRow {
  ts: string;
  run_id: string;
  schema_version: string;
  chain: string;
  token_address: string;
  pool_address: string;
  dex: string;
  liquidity_model: string;      // V2 | V3 | UNSUPPORTED_*
  liquidity_verified: string;   // true | false
  reported_liquidity_usd: string;
  onchain_tvl_usd: string;
  reported_vs_onchain_pct: string; // fraction (positive = inflated)
  executable_depth_usd: string;
  slip_50: string;
  slip_100: string;
  slip_500: string;
  slip_1000: string;
  spot_price_usd: string;
  error: string;                // non-empty when liquidity_verified=false
}

export const POOL_LIQUIDITY_SNAPSHOT_HEADERS: CsvHeader[] = [
  { id: 'ts',                     title: 'ts' },
  { id: 'run_id',                 title: 'run_id' },
  { id: 'schema_version',         title: 'schema_version' },
  { id: 'chain',                  title: 'chain' },
  { id: 'token_address',          title: 'token_address' },
  { id: 'pool_address',           title: 'pool_address' },
  { id: 'dex',                    title: 'dex' },
  { id: 'liquidity_model',        title: 'liquidity_model' },
  { id: 'liquidity_verified',     title: 'liquidity_verified' },
  { id: 'reported_liquidity_usd', title: 'reported_liquidity_usd' },
  { id: 'onchain_tvl_usd',        title: 'onchain_tvl_usd' },
  { id: 'reported_vs_onchain_pct', title: 'reported_vs_onchain_pct' },
  { id: 'executable_depth_usd',   title: 'executable_depth_usd' },
  { id: 'slip_50',                title: 'slip_50' },
  { id: 'slip_100',               title: 'slip_100' },
  { id: 'slip_500',               title: 'slip_500' },
  { id: 'slip_1000',              title: 'slip_1000' },
  { id: 'spot_price_usd',         title: 'spot_price_usd' },
  { id: 'error',                  title: 'error' },
];

// ─── decisions/candidates.csv ─────────────────────────────────────────────────
// SURVIVOR WATCHLIST. One row per token that passed EVERYTHING:
//   CONTRACT_SAFE  +  token-age ok  +  liquidity_verified=true.
// This is a research queue, NOT a recommendation. See CANDIDATE_CAVEAT below —
// it is written as the first line of the file so the warning travels with the data.
export const CANDIDATE_CAVEAT =
  '# Survivors = passed scam/liquidity filters only. NOT scored, NOT backtested, ' +
  'NOT a buy signal. Research queue, not recommendations.';

export interface CandidateRow {
  ts: string;
  run_id: string;
  chain: string;
  token_address: string;
  symbol: string;
  name: string;
  model: string;                   // "<dex> / <liquidity_model>"  e.g. "Uniswap V3 (Base) / V3"
  onchain_tvl_usd: string;
  reported_vs_onchain_pct: string;
  slip_100: string;
  slip_1000: string;
  fdv_usd: string;
  age_days: string;
}

export const CANDIDATE_HEADERS: CsvHeader[] = [
  { id: 'ts',                      title: 'ts' },
  { id: 'run_id',                  title: 'run_id' },
  { id: 'chain',                   title: 'chain' },
  { id: 'token_address',           title: 'token_address' },
  { id: 'symbol',                  title: 'symbol' },
  { id: 'name',                    title: 'name' },
  { id: 'model',                   title: 'model' },
  { id: 'onchain_tvl_usd',         title: 'onchain_tvl_usd' },
  { id: 'reported_vs_onchain_pct', title: 'reported_vs_onchain_pct' },
  { id: 'slip_100',                title: 'slip_100' },
  { id: 'slip_1000',               title: 'slip_1000' },
  { id: 'fdv_usd',                 title: 'fdv_usd' },
  { id: 'age_days',                title: 'age_days' },
];

export const POOL_SNAPSHOT_HEADERS: CsvHeader[] = [
  { id: 'ts', title: 'ts' },
  { id: 'run_id', title: 'run_id' },
  { id: 'schema_version', title: 'schema_version' },
  { id: 'chain', title: 'chain' },
  { id: 'token_address', title: 'token_address' },
  { id: 'pool_address', title: 'pool_address' },
  { id: 'price_usd', title: 'price_usd' },
  { id: 'liquidity_usd', title: 'liquidity_usd' },
  { id: 'fdv_usd', title: 'fdv_usd' },
  { id: 'vol_5m', title: 'vol_5m' },
  { id: 'vol_1h', title: 'vol_1h' },
  { id: 'vol_6h', title: 'vol_6h' },
  { id: 'vol_24h', title: 'vol_24h' },
  { id: 'buys_1h', title: 'buys_1h' },
  { id: 'sells_1h', title: 'sells_1h' },
  { id: 'source', title: 'source' },
];
