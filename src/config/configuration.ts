import { registerAs } from '@nestjs/config';

export const appConfig = registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  logDir: process.env.LOG_DIR ?? './logs',
}));

export const redisConfig = registerAs('redis', () => ({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
}));

export const chainConfig = registerAs('chain', () => ({
  // drpc.org provides free archive access (required for binary-search token-age).
  // publicnode.com is the fallback — no archive, but handles latest-state calls on RPC outage.
  ethereumRpcUrl:         process.env.ETHEREUM_RPC_URL          ?? 'https://eth.drpc.org',
  ethereumRpcUrlFallback: process.env.ETHEREUM_RPC_URL_FALLBACK ?? 'https://ethereum.publicnode.com',
  baseRpcUrl:             process.env.BASE_RPC_URL              ?? 'https://base.drpc.org',
  baseRpcUrlFallback:     process.env.BASE_RPC_URL_FALLBACK     ?? 'https://base.publicnode.com',
  enabledChains: (process.env.COLLECTOR_CHAINS ?? 'ethereum,base').split(','),
}));

export const apiConfig = registerAs('api', () => ({
  dexscreenerBaseUrl:
    process.env.DEXSCREENER_BASE_URL ?? 'https://api.dexscreener.com',
  geckoterminalBaseUrl:
    process.env.GECKOTERMINAL_BASE_URL ?? 'https://api.geckoterminal.com/api/v2',
  goplusBaseUrl: process.env.GOPLUS_BASE_URL ?? 'https://api.gopluslabs.io',
  goplusApiKey: process.env.GOPLUS_API_KEY,
  goplusAppKey: process.env.GOPLUS_APP_KEY ?? process.env.GOPLUS_API_KEY,
  goplusAppSecret: process.env.GOPLUS_APP_SECRET,
  goplusMinIntervalMs: parseInt(process.env.GOPLUS_MIN_INTERVAL_MS ?? '2000', 10),
  goplusMaxAttempts: parseInt(process.env.GOPLUS_MAX_ATTEMPTS ?? '2', 10),
  goplusRetryDelayMs: parseInt(process.env.GOPLUS_RETRY_DELAY_MS ?? '2500', 10),
  honeypotBaseUrl: process.env.HONEYPOT_BASE_URL ?? 'https://api.honeypot.is',
}));

export const collectorConfig = registerAs('collector', () => ({
  autoStart: process.env.COLLECTOR_AUTOSTART !== 'false',
  pollIntervalMs: parseInt(process.env.COLLECTOR_POLL_INTERVAL_MS ?? '120000', 10),
  newPoolMaxAgeHours: parseInt(process.env.NEW_POOL_MAX_AGE_HOURS ?? '6', 10),
  tokenMaxAgeDays: parseFloat(process.env.TOKEN_MAX_AGE_DAYS ?? '7'),
  tokenAgeHardGateEnabled: process.env.TOKEN_AGE_HARD_GATE_ENABLED === 'true',
  moonshotStage0Enabled: process.env.MOONSHOT_STAGE0_ENABLED !== 'false',
  moonshotMinLiquidityUsd: parseFloat(process.env.MOONSHOT_MIN_LIQUIDITY_USD ?? '1000'),
  moonshotMinFdvUsd: parseFloat(process.env.MOONSHOT_MIN_FDV_USD ?? '1000'),
  moonshotMinVol1hUsd: parseFloat(process.env.MOONSHOT_MIN_VOL_1H_USD ?? '1000'),
  moonshotMinTx1h: parseInt(process.env.MOONSHOT_MIN_TX_1H ?? '30', 10),
  moonshotMinBuys1h: parseInt(process.env.MOONSHOT_MIN_BUYS_1H ?? '15', 10),
  promoteCleanUnknownEnabled: process.env.PROMOTE_CLEAN_UNKNOWN_ENABLED === 'true',
  deployerGateEnabled: process.env.DEPLOYER_GATE_ENABLED !== 'false',
  deployerGateMinDeployments: parseInt(process.env.DEPLOYER_GATE_MIN_DEPLOYMENTS ?? '1', 10),
  deployerGateMinRugLike: parseInt(process.env.DEPLOYER_GATE_MIN_RUG_LIKE ?? '1', 10),
  deployerGateMinRugRate: parseFloat(process.env.DEPLOYER_GATE_MIN_RUG_RATE ?? '0.5'),
  blockedDeployers: (process.env.BLOCKED_DEPLOYERS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [chain, tokenAddress] = entry.split(':');
      return { chain, tokenAddress: tokenAddress?.toLowerCase() };
    })
    .filter((entry) => entry.chain && entry.tokenAddress),
  manualProbeTokens: (process.env.MANUAL_PROBE_TOKENS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [chain, tokenAddress] = entry.split(':');
      return { chain, tokenAddress: tokenAddress?.toLowerCase() };
    })
    .filter((entry) => entry.chain && entry.tokenAddress),
}));

// Block-explorer APIs (Etherscan V2 unified API).
// REQUIRED: free API keys at https://etherscan.io/apis — anonymous tier no longer works.
// Both Ethereum and Base use the same base URL; chain is selected by the `chainid` param.
export const explorerConfig = registerAs('explorer', () => ({
  etherscanBaseUrl: process.env.ETHERSCAN_BASE_URL ?? 'https://api.etherscan.io/v2/api',
  etherscanApiKey: process.env.ETHERSCAN_API_KEY ?? '',
  // Basescan also routes through the Etherscan V2 unified API (chainid=8453).
  // A single Etherscan V2 key is valid for both chains, so fall back to it.
  basescanBaseUrl: process.env.BASESCAN_BASE_URL ?? 'https://api.etherscan.io/v2/api',
  basescanApiKey: process.env.BASESCAN_API_KEY ?? process.env.ETHERSCAN_API_KEY ?? '',
}));

// On-chain contract addresses — sourced from official deployment docs.
// QuoterV2: https://developers.uniswap.org/contracts/v3/reference/deployments/
// Aerodrome PoolFactory: https://github.com/aerodrome-finance/contracts (Base mainnet)
export const onchainConfig = registerAs('onchain', () => ({
  // Uniswap V3 QuoterV2 — verified 2025-06 against official Uniswap deployment docs
  quoterV2Ethereum: process.env.QUOTER_V2_ETHEREUM ?? '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  quoterV2Base:     process.env.QUOTER_V2_BASE     ?? '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  // Aerodrome PoolFactory (Base only) — verified 2025-06 against official Aerodrome deployment
  aerodromeFactoryBase: process.env.AERODROME_FACTORY_BASE ?? '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
}));

export const scoringConfig = registerAs('scoring', () => ({
  minLiquidityUsd: parseFloat(process.env.MIN_LIQUIDITY_USD ?? '5000'),
  minFdvUsd: parseFloat(process.env.MIN_FDV_USD ?? '10000'),
  maxFdvUsd: parseFloat(process.env.MAX_FDV_USD ?? '50000000'),
  paperTradeSizeUsd: parseFloat(process.env.PAPER_TRADE_SIZE_USD ?? '200'),
  watchlistScoreThreshold: parseFloat(process.env.WATCHLIST_SCORE_THRESHOLD ?? '60'),
  paperTradeScoreThreshold: parseFloat(process.env.PAPER_TRADE_SCORE_THRESHOLD ?? '75'),

  // ── M4 scoring (HYPOTHESIS — unvalidated; M5 tests whether bands actually outperform) ──
  // Component weights. Renormalized over whichever components have data per snapshot.
  scoreWeights: {
    liquidity:  parseFloat(process.env.SCORE_W_LIQUIDITY  ?? '0.30'),
    depth:      parseFloat(process.env.SCORE_W_DEPTH      ?? '0.25'),
    age:        parseFloat(process.env.SCORE_W_AGE        ?? '0.15'),
    traction:   parseFloat(process.env.SCORE_W_TRACTION   ?? '0.20'),
    divergence: parseFloat(process.env.SCORE_W_DIVERGENCE ?? '0.10'),
  },
  // Band thresholds (unvalidated): <50 reject_band, 50–70 watchlist, 70–85 candidate, 85+ high_band.
  scoreBands: {
    watchlistMin: parseFloat(process.env.SCORE_BAND_WATCHLIST ?? '50'),
    candidateMin: parseFloat(process.env.SCORE_BAND_CANDIDATE ?? '70'),
    highMin:      parseFloat(process.env.SCORE_BAND_HIGH      ?? '85'),
  },
}));

// ── M5 paper-trade evaluator (PAPER ONLY — no keys, no execution, no real orders) ──
// All fills are PESSIMISTIC by mandate: you always pay slippage + sandwich + gas + tax.
// Mid-price is forbidden. These are modeling assumptions, documented as such.
export const paperConfig = registerAs('paper', () => ({
  positionSizeUsd:    parseFloat(process.env.PAPER_POSITION_SIZE_USD   ?? '20'),   // matches user's real sizing
  detectionDelaySec:  parseInt(  process.env.PAPER_DETECTION_DELAY_SEC ?? '300', 10), // 5 min detect→act lag
  sandwichPct:        parseFloat(process.env.PAPER_SANDWICH_PCT        ?? '0.01'),  // 1% MEV/sandwich haircut
  gasUsd:             parseFloat(process.env.PAPER_GAS_USD             ?? '1.5'),   // modeled gas per tx (each way)
  maxEntrySlipPct:    parseFloat(process.env.PAPER_MAX_ENTRY_SLIP_PCT  ?? '0.50'),  // > this at entry → not_entered
  // Exit ladder: sell fractions of the ORIGINAL position when the multiple is crossed.
  // Remainder after the rungs (here 10%) is the moonbag, held until invalidation.
  ladder: [
    { multiple: 2,  sellFraction: 0.50 },
    { multiple: 5,  sellFraction: 0.25 },
    { multiple: 10, sellFraction: 0.15 },
  ],
  // Status thresholds (on-demand eval).
  liqPullDropPct:        parseFloat(process.env.PAPER_LIQ_PULL_DROP_PCT   ?? '0.60'), // liq down > 60% → liquidity_pulled
  rugLiqUsd:             parseFloat(process.env.PAPER_RUG_LIQ_USD         ?? '50'),   // liq ≤ this → rug
  sellTaxSpikePct:       parseFloat(process.env.PAPER_SELL_TAX_SPIKE_PCT  ?? '0.50'), // sell tax ≥ 50% → unsellable
  maxDrawdownInvalidate: parseFloat(process.env.PAPER_MAX_DRAWDOWN        ?? '0.70'), // drawdown > 70% → invalidate
  priceReadFailureRugThreshold: parseInt(process.env.PAPER_PRICE_READ_FAILURE_RUG_THRESHOLD ?? '3', 10),
  evalMaxOpenPositions: parseInt(process.env.PAPER_EVAL_MAX_OPEN_POSITIONS ?? '0', 10),
  // Analysis gates.
  edgeScoreThreshold:    parseFloat(process.env.PAPER_EDGE_SCORE_THRESHOLD ?? '70'),  // "candidate" band min
  minClosedForEdge:      parseInt(  process.env.PAPER_MIN_CLOSED_FOR_EDGE  ?? '50', 10),
  minPerGroupPostmortem: parseInt(  process.env.PAPER_MIN_PER_GROUP        ?? '30', 10),
}));

// ── Shadow gem-tracker (OBSERVATION ONLY — never wired into entry/exit) ──
// Measures the forward-return distribution of the survivor cohort to learn whether
// the funnel has an x10–x1000 tail. All thresholds are config, not hard-wired.
export const gemConfig = registerAs('gem', () => ({
  // FDV-headroom gate: cut dust below the floor; cap entry FDV so x1000 stays geometrically possible.
  minEntryFdvUsd: parseFloat(process.env.GEM_MIN_ENTRY_FDV_USD ?? '1000'),
  maxEntryFdvUsd: parseFloat(process.env.GEM_MAX_ENTRY_FDV_USD ?? '50000'),
  // LP must be ≥ this fraction locked-or-burned to pass the hard gate (undetermined → reject).
  lpLockedMinFraction: parseFloat(process.env.GEM_LP_LOCKED_MIN_FRACTION ?? '0.9'),
  // Forward horizons (minutes from t0) at which the shadow tracker snapshots state.
  // 180 (3h) added to test the "snipe only tokens that survived ≥3h" hypothesis.
  horizonsMin: (process.env.GEM_HORIZONS_MIN ?? '15,60,180,360,1440,4320').split(',').map((s) => parseInt(s, 10)),
  // Re-baseline horizon for the snipe report (forward returns measured FROM this mark).
  snipeBaselineHorizon: process.env.GEM_SNIPE_BASELINE ?? '3h',
  // Rug threshold for the shadow tracker (reuses the paper engine's notion of "gone").
  rugLiqUsd: parseFloat(process.env.GEM_RUG_LIQ_USD ?? '50'),
  // Below this many candidates in a bucket, the outcome report shouts "small sample".
  minSampleWarn: parseInt(process.env.GEM_MIN_SAMPLE_WARN ?? '30', 10),
  // Burn sinks — LP sent here is permanently unrecoverable.
  deadAddresses: [
    '0x0000000000000000000000000000000000000000',
    '0x000000000000000000000000000000000000dead',
  ],
  // Known LP lockers per chain (lowercased). BEST-EFFORT, UNVERIFIED registry — these
  // addresses were NOT re-verified on-chain in this build, so treat lock-by-locker as a
  // softer signal than burn. The RELIABLE path is burn detection (LP held by deadAddresses).
  // An unknown/unmatched locker means "not detected" → not-locked → reject (conservative).
  // Set GEM_LOCKERS via env (chain:addr=name,...) or extend here once addresses are confirmed.
  lockers: {
    ethereum: {
      '0x663a5c229c09b049e36dcc11a9b0d4a8eb9db214': 'Unicrypt(UNCX) v2 (UNVERIFIED)',
      '0xe2fe530c047f2d85298b07d9333c05737f1435fb': 'Team.Finance (UNVERIFIED)',
    } as Record<string, string>,
    base: {
      '0xc4e637d37113192f4f1f060daebd7758de7f4131': 'Unicrypt(UNCX) Base (UNVERIFIED)',
    } as Record<string, string>,
  } as Record<string, Record<string, string>>,
}));

export const telegramConfig = registerAs('telegram', () => ({
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  enabled: process.env.TELEGRAM_ENABLED === 'true',
  minScore: parseFloat(process.env.TELEGRAM_MIN_SCORE ?? '75'),
}));

export default [
  appConfig,
  redisConfig,
  chainConfig,
  apiConfig,
  collectorConfig,
  scoringConfig,
  paperConfig,
  gemConfig,
  telegramConfig,
  explorerConfig,
  onchainConfig,
];
