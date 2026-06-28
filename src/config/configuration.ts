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
  honeypotBaseUrl: process.env.HONEYPOT_BASE_URL ?? 'https://api.honeypot.is',
}));

export const collectorConfig = registerAs('collector', () => ({
  pollIntervalMs: parseInt(process.env.COLLECTOR_POLL_INTERVAL_MS ?? '120000', 10),
  newPoolMaxAgeHours: parseInt(process.env.NEW_POOL_MAX_AGE_HOURS ?? '6', 10),
  tokenMaxAgeDays: parseFloat(process.env.TOKEN_MAX_AGE_DAYS ?? '7'),
}));

// Block-explorer APIs (Etherscan V2 unified API).
// REQUIRED: free API keys at https://etherscan.io/apis — anonymous tier no longer works.
// Both Ethereum and Base use the same base URL; chain is selected by the `chainid` param.
export const explorerConfig = registerAs('explorer', () => ({
  etherscanBaseUrl: process.env.ETHERSCAN_BASE_URL ?? 'https://api.etherscan.io/v2/api',
  etherscanApiKey: process.env.ETHERSCAN_API_KEY ?? '',
  // Basescan also routes through the Etherscan V2 unified API (chainid=8453)
  basescanBaseUrl: process.env.BASESCAN_BASE_URL ?? 'https://api.etherscan.io/v2/api',
  basescanApiKey: process.env.BASESCAN_API_KEY ?? '',
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
  // Analysis gates.
  edgeScoreThreshold:    parseFloat(process.env.PAPER_EDGE_SCORE_THRESHOLD ?? '70'),  // "candidate" band min
  minClosedForEdge:      parseInt(  process.env.PAPER_MIN_CLOSED_FOR_EDGE  ?? '50', 10),
  minPerGroupPostmortem: parseInt(  process.env.PAPER_MIN_PER_GROUP        ?? '30', 10),
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
  telegramConfig,
  explorerConfig,
  onchainConfig,
];
