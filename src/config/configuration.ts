import { registerAs } from '@nestjs/config';
import tokenSymbolBlocklist from './token-symbol-blocklist.json';
import blockedCreatorsFile from './blocked-creators.json';
import { flattenResolved, resolveRpcEndpoints } from './rpc-endpoints';

const activeStrategyMode = (): string =>
  process.env.STRATEGY_MODE ?? 'legacy_contract_radar';

const blockedTokenSymbols = tokenSymbolBlocklist.symbols
  .map((entry) => entry.symbol.trim().replace(/^\$/, '').toLowerCase())
  .filter(Boolean);

const resolveConfiguredRpc = () => flattenResolved(resolveRpcEndpoints({
  alchemyApiKey: process.env.ALCHEMY_API_KEY,
  alchemyRpcUrl: process.env.ALCHEMY_RPC_URL,
  infuraApiKey: process.env.INFURA_API_KEY,
  infuraRpcUrl: process.env.INFURA_RPC_URL,
  rpcAlchemyChains: process.env.RPC_ALCHEMY_CHAINS,
  rpcInfuraChains: process.env.RPC_INFURA_CHAINS,
  rpcPaidChains: process.env.RPC_PAID_CHAINS,
  rpcPriority: process.env.RPC_PRIORITY,
  rpcPrimaryTimeoutMs: process.env.RPC_PRIMARY_TIMEOUT_MS,
  rpcFallbackTimeoutMs: process.env.RPC_FALLBACK_TIMEOUT_MS,
  ethereumRpcUrl: process.env.ETHEREUM_RPC_URL,
  ethereumRpcUrlFallback: process.env.ETHEREUM_RPC_URL_FALLBACK,
  ethereumRpcWsUrl: process.env.ETHEREUM_RPC_WS_URL,
  baseRpcUrl: process.env.BASE_RPC_URL,
  baseRpcUrlFallback: process.env.BASE_RPC_URL_FALLBACK,
  baseRpcWsUrl: process.env.BASE_RPC_WS_URL,
  robinhoodRpcUrl: process.env.ROBINHOOD_RPC_URL,
  robinhoodRpcUrlFallback: process.env.ROBINHOOD_RPC_URL_FALLBACK,
  robinhoodRpcWsUrl: process.env.ROBINHOOD_RPC_WS_URL,
  solanaRpcUrl: process.env.SOLANA_RPC_URL,
  solanaRpcWsUrl: process.env.SOLANA_RPC_WS_URL,
}));

let rpcCache: ReturnType<typeof resolveConfiguredRpc> | null = null;
const configuredRpc = () => {
  rpcCache ??= resolveConfiguredRpc();
  return rpcCache;
};

export const appConfig = registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  logDir: process.env.LOG_DIR ?? './logs',
  strategyMode: activeStrategyMode(),
}));

export const redisConfig = registerAs('redis', () => ({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
}));

export const chainConfig = registerAs('chain', () => ({
  // drpc.org provides free archive access (required for binary-search token-age).
  // publicnode.com is the fallback — no archive, but handles latest-state calls on RPC outage.
  rpcProvider: configuredRpc().providerLabel,
  paidChains: configuredRpc().paidChains,
  primaryTimeoutMs: configuredRpc().primaryTimeoutMs,
  fallbackTimeoutMs: configuredRpc().fallbackTimeoutMs,
  ethereumRpcUrl: configuredRpc().ethereumRpcUrl,
  ethereumRpcUrlFallback: configuredRpc().ethereumRpcUrlFallback,
  ethereumRpcUrls: configuredRpc().ethereumRpcUrls,
  ethereumRpcWsUrl: configuredRpc().ethereumRpcWsUrl,
  baseRpcUrl: configuredRpc().baseRpcUrl,
  baseRpcUrlFallback: configuredRpc().baseRpcUrlFallback,
  baseRpcUrls: configuredRpc().baseRpcUrls,
  baseRpcWsUrl: configuredRpc().baseRpcWsUrl,
  robinhoodRpcUrl: configuredRpc().robinhoodRpcUrl,
  robinhoodRpcUrlFallback: configuredRpc().robinhoodRpcUrlFallback,
  robinhoodRpcUrls: configuredRpc().robinhoodRpcUrls,
  robinhoodRpcWsUrl: configuredRpc().robinhoodRpcWsUrl,
  // Robinhood's public RPC currently rejects historical eth_getCode. Keep token
  // age unknown rather than issuing one failing archive call per fresh token.
  robinhoodHistoricalCodeEnabled: process.env.ROBINHOOD_HISTORICAL_CODE_ENABLED === 'true',
  enabledChains: (process.env.COLLECTOR_CHAINS ?? 'ethereum,robinhood')
    .split(',')
    .map((chain) => chain.trim())
    .filter(Boolean),
}));

export const evmFlowConfig = registerAs('evmFlow', () => ({
  enabled: process.env.EVM_FLOW_ENABLED !== 'false',
  chains: (process.env.EVM_FLOW_CHAINS ?? 'ethereum,robinhood')
    .split(',')
    .map((chain) => chain.trim())
    .filter(Boolean),
  factoryPollMs: parseInt(process.env.EVM_FLOW_FACTORY_POLL_MS ?? '3000', 10),
  healthLogMs: parseInt(process.env.EVM_FLOW_HEALTH_LOG_MS ?? '30000', 10),
  freshWatchMs: parseInt(process.env.EVM_FLOW_FRESH_WATCH_MS ?? '300000', 10),
  matureWatchMs: parseInt(process.env.EVM_FLOW_MATURE_WATCH_MS ?? '900000', 10),
  outcomeTrackMs: parseInt(process.env.EVM_FLOW_OUTCOME_TRACK_MS ?? '86400000', 10),
  maxHeadLagBlocks: parseInt(process.env.EVM_FLOW_MAX_HEAD_LAG_BLOCKS ?? '2', 10),
  minExecutableDepthUsd: parseFloat(process.env.EVM_FLOW_MIN_EXECUTABLE_DEPTH_USD ?? '100'),
  maxEntrySlipPct: parseFloat(process.env.EVM_FLOW_MAX_ENTRY_SLIP_PCT ?? '0.10'),
  httpPollMsEthereum: parseInt(process.env.EVM_FLOW_HTTP_POLL_MS_ETHEREUM ?? '12000', 10),
  httpPollMsBase: parseInt(process.env.EVM_FLOW_HTTP_POLL_MS_BASE ?? '4000', 10),
  httpPollMsRobinhood: parseInt(process.env.EVM_FLOW_HTTP_POLL_MS_ROBINHOOD ?? '4000', 10),
  matureBackfillBlocksEthereum: parseInt(process.env.EVM_FLOW_MATURE_BACKFILL_BLOCKS_ETHEREUM ?? '25', 10),
  matureBackfillBlocksBase: parseInt(process.env.EVM_FLOW_MATURE_BACKFILL_BLOCKS_BASE ?? '150', 10),
  matureBackfillBlocksRobinhood: parseInt(process.env.EVM_FLOW_MATURE_BACKFILL_BLOCKS_ROBINHOOD ?? '150', 10),
  registrationMaxBackfillBlocksEthereum: parseInt(process.env.EVM_FLOW_REGISTRATION_MAX_BACKFILL_BLOCKS_ETHEREUM ?? '32', 10),
  registrationMaxBackfillBlocksBase: parseInt(process.env.EVM_FLOW_REGISTRATION_MAX_BACKFILL_BLOCKS_BASE ?? '300', 10),
  registrationMaxBackfillBlocksRobinhood: parseInt(process.env.EVM_FLOW_REGISTRATION_MAX_BACKFILL_BLOCKS_ROBINHOOD ?? '300', 10),
  maxLatestSwapAgeMs: parseInt(process.env.EVM_FLOW_MAX_LATEST_SWAP_AGE_MS ?? '15000', 10),
  initialAddressBatchSize: parseInt(process.env.EVM_FLOW_INITIAL_ADDRESS_BATCH_SIZE ?? '32', 10),
  minBlockCoverage: parseFloat(process.env.EVM_FLOW_MIN_BLOCK_COVERAGE ?? '0.995'),
  robinhoodExperimentMaxTickAgeMs: parseInt(process.env.ROBINHOOD_EXPERIMENT_MAX_TICK_AGE_MS ?? '10000', 10),
  robinhoodExperimentMaxLegLatenessMs: parseInt(process.env.ROBINHOOD_EXPERIMENT_MAX_LEG_LATENESS_MS ?? '3000', 10),
  // A single polling/read miss must not invalidate an otherwise healthy paired sample.
  robinhoodExperimentHealthGraceMs: parseInt(process.env.ROBINHOOD_EXPERIMENT_HEALTH_GRACE_MS ?? '10000', 10),
}));

export const solanaLaunchConfig = registerAs('solanaLaunch', () => ({
  enabled: process.env.SOLANA_LAUNCH_ENABLED !== 'false',
  multiVenueEnabled: process.env.SOLANA_MULTI_VENUE_ENABLED !== 'false',
  rpcUrl: configuredRpc().solanaRpcUrl,
  rpcUrls: configuredRpc().solanaRpcUrls,
  wsUrl: configuredRpc().solanaRpcWsUrl,
  rpcPrimaryTimeoutMs: configuredRpc().primaryTimeoutMs,
  rpcFallbackTimeoutMs: configuredRpc().fallbackTimeoutMs,
  launchApiUrl: process.env.RAYDIUM_LAUNCH_API_URL ?? 'https://launch-mint-v1.raydium.io',
  tradeApiUrl: process.env.RAYDIUM_TRADE_API_URL ?? 'https://transaction-v1.raydium.io',
  pollIntervalMs: parseInt(process.env.SOLANA_LAUNCH_POLL_INTERVAL_MS ?? '10000', 10),
  healthLogMs: parseInt(process.env.SOLANA_LAUNCH_HEALTH_LOG_MS ?? '30000', 10),
  discoveryAgeMs: parseInt(process.env.SOLANA_LAUNCH_DISCOVERY_AGE_MS ?? '300000', 10),
  bootstrapLookbackMs: parseInt(process.env.SOLANA_LAUNCH_BOOTSTRAP_LOOKBACK_MS ?? '86400000', 10),
  bootstrapWatchMs: parseInt(process.env.SOLANA_LAUNCH_BOOTSTRAP_WATCH_MS ?? '1800000', 10),
  watchMs: parseInt(process.env.SOLANA_LAUNCH_WATCH_MS ?? '7200000', 10),
  positionSizeUsd: parseFloat(process.env.SOLANA_LAUNCH_POSITION_SIZE_USD ?? '20'),
  maxEntrySlippagePct: parseFloat(process.env.SOLANA_LAUNCH_MAX_ENTRY_SLIP_PCT ?? '0.03'),
  minRoundTripMultiple: parseFloat(process.env.SOLANA_LAUNCH_MIN_ROUND_TRIP_MULTIPLE ?? '0.80'),
  routeProbeFinishingRate: parseFloat(process.env.SOLANA_LAUNCH_ROUTE_PROBE_FINISHING_RATE ?? '0.95'),
  mintRefreshIntervalMs: parseInt(process.env.SOLANA_LAUNCH_MINT_REFRESH_INTERVAL_MS ?? '30000', 10),
  mintRefreshBatchSize: parseInt(process.env.SOLANA_LAUNCH_MINT_REFRESH_BATCH_SIZE ?? '50', 10),
  routeReadyProbeIntervalMs: parseInt(process.env.SOLANA_ROUTE_READY_PROBE_INTERVAL_MS ?? '15000', 10),
  routeFallbackProbeIntervalMs: parseInt(process.env.SOLANA_ROUTE_FALLBACK_PROBE_INTERVAL_MS ?? '60000', 10),
  maxRouteProbesPerPoll: parseInt(process.env.SOLANA_MAX_ROUTE_PROBES_PER_POLL ?? '10', 10),
  gasUsd: parseFloat(process.env.SOLANA_PAPER_GAS_USD ?? '0.01'),
  hardStopMultiple: parseFloat(process.env.SOLANA_PAPER_HARD_STOP_MULTIPLE ?? '0.80'),
  timeExitMs: parseInt(process.env.SOLANA_PAPER_TIME_EXIT_MS ?? '28800000', 10),
  requestTimeoutMs: parseInt(process.env.SOLANA_REQUEST_TIMEOUT_MS ?? '10000', 10),
  streamBackfillMs: parseInt(process.env.SOLANA_STREAM_BACKFILL_MS ?? '15000', 10),
  lifecyclePollMs: parseInt(process.env.SOLANA_LIFECYCLE_POLL_MS ?? '5000', 10),
  maxTransactionsPerCycle: parseInt(process.env.SOLANA_MAX_TRANSACTIONS_PER_CYCLE ?? '40', 10),
  rpcMinRequestIntervalMs: parseInt(process.env.SOLANA_RPC_MIN_REQUEST_INTERVAL_MS ?? '250', 10),
  rateLimitBackoffMs: parseInt(process.env.SOLANA_RATE_LIMIT_BACKOFF_MS ?? '10000', 10),
  maxQueuedTransactions: parseInt(process.env.SOLANA_MAX_QUEUED_TRANSACTIONS ?? '1000', 10),
  watchBackfillBatchSize: parseInt(process.env.SOLANA_WATCH_BACKFILL_BATCH_SIZE ?? '5', 10),
  maxShadowSignals: parseInt(process.env.SOLANA_MAX_SHADOW_SIGNALS ?? '8', 10),
  maxActivePoolSubscriptions: parseInt(process.env.SOLANA_MAX_ACTIVE_POOL_SUBSCRIPTIONS ?? '8', 10),
  openArmEvalIntervalMs: parseInt(process.env.SOLANA_OPEN_ARM_EVAL_INTERVAL_MS ?? '30000', 10),
  pendingWatchTimeoutMs: parseInt(process.env.SOLANA_PENDING_WATCH_TIMEOUT_MS ?? '120000', 10),
  streamFreshnessMs: parseInt(process.env.SOLANA_STREAM_FRESHNESS_MS ?? '90000', 10),
  streamFreshnessSlots: parseInt(process.env.SOLANA_STREAM_FRESHNESS_SLOTS ?? '225', 10),
  streamWatchdogMs: parseInt(process.env.SOLANA_STREAM_WATCHDOG_MS ?? '10000', 10),
  streamReconnectBaseMs: parseInt(process.env.SOLANA_STREAM_RECONNECT_BASE_MS ?? '5000', 10),
  streamReconnectMaxMs: parseInt(process.env.SOLANA_STREAM_RECONNECT_MAX_MS ?? '120000', 10),
  confirmationSweepMs: parseInt(process.env.SOLANA_CONFIRMATION_SWEEP_MS ?? '10000', 10),
  executionTimelinessMs: parseInt(process.env.SOLANA_EXECUTION_TIMELINESS_MS ?? '60000', 10),
  blockedCreators: (process.env.SOLANA_BLOCKED_CREATORS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
}));

export const apiConfig = registerAs('api', () => ({
  dexscreenerBaseUrl:
    process.env.DEXSCREENER_BASE_URL ?? 'https://api.dexscreener.com',
  geckoterminalBaseUrl:
    process.env.GECKOTERMINAL_BASE_URL ?? 'https://api.geckoterminal.com/api/v2',
  moralisBaseUrl: process.env.MORALIS_BASE_URL ?? 'https://deep-index.moralis.io/api/v2.2',
  moralisApiKey: process.env.MORALIS_API_KEY,
  moralisTrendingLimit: parseInt(process.env.MORALIS_TRENDING_LIMIT ?? '50', 10),
  moralisAuthBackoffMs: parseInt(process.env.MORALIS_AUTH_BACKOFF_MS ?? '3600000', 10),
  birdeyeBaseUrl: process.env.BIRDEYE_BASE_URL ?? 'https://public-api.birdeye.so',
  birdeyeApiKey: process.env.BIRDEYE_API_KEY,
  birdeyeTokenListLimit: parseInt(process.env.BIRDEYE_TOKENLIST_LIMIT ?? '50', 10),
  goplusBaseUrl: process.env.GOPLUS_BASE_URL ?? 'https://api.gopluslabs.io',
  goplusApiKey: process.env.GOPLUS_API_KEY,
  goplusAppKey: process.env.GOPLUS_APP_KEY ?? process.env.GOPLUS_API_KEY,
  goplusAppSecret: process.env.GOPLUS_APP_SECRET,
  goplusMinIntervalMs: parseInt(process.env.GOPLUS_MIN_INTERVAL_MS ?? '2000', 10),
  goplusMaxAttempts: parseInt(process.env.GOPLUS_MAX_ATTEMPTS ?? '2', 10),
  goplusRetryDelayMs: parseInt(process.env.GOPLUS_RETRY_DELAY_MS ?? '2500', 10),
  goplusCircuitBreakerMs: parseInt(process.env.GOPLUS_CIRCUIT_BREAKER_MS ?? '60000', 10),
  honeypotBaseUrl: process.env.HONEYPOT_BASE_URL ?? 'https://api.honeypot.is',
}));

export const collectorConfig = registerAs('collector', () => ({
  autoStart: process.env.COLLECTOR_AUTOSTART != null
    ? process.env.COLLECTOR_AUTOSTART !== 'false'
    : activeStrategyMode() === 'legacy_contract_radar',
  pollIntervalMs: parseInt(process.env.COLLECTOR_POLL_INTERVAL_MS ?? '30000', 10),
  newPoolMaxAgeHours: parseInt(process.env.NEW_POOL_MAX_AGE_HOURS ?? '24', 10),
  matureMomentumMinVol1hUsd: parseFloat(process.env.MATURE_MOMENTUM_MIN_VOL_1H_USD ?? '1000'),
  matureMomentumMinTx1h: parseInt(process.env.MATURE_MOMENTUM_MIN_TX_1H ?? '20', 10),
  matureMomentumMinBuys1h: parseInt(process.env.MATURE_MOMENTUM_MIN_BUYS_1H ?? '10', 10),
  matureMomentumMinLiquidityUsd: parseFloat(process.env.MATURE_MOMENTUM_MIN_LIQUIDITY_USD ?? '1000'),
  geckoTerminalPages: parseInt(process.env.GECKOTERMINAL_PAGES ?? '1', 10),
  geckoTerminalRequestDelayMs: parseInt(process.env.GECKOTERMINAL_REQUEST_DELAY_MS ?? '7000', 10),
  geckoTerminalRateLimitBackoffMs: parseInt(process.env.GECKOTERMINAL_RATE_LIMIT_BACKOFF_MS ?? '300000', 10),
  geckoTerminalStatsCacheTtlMs: parseInt(process.env.GECKOTERMINAL_STATS_CACHE_TTL_MS ?? '600000', 10),
  // RPC-native factory events arrive before third-party pool listings. They are
  // pre-filtered by an on-chain liquidity quote before any risk-provider request.
  factoryDiscoveryEnabled: process.env.FACTORY_DISCOVERY_ENABLED !== 'false',
  factoryDiscoveryHotPollMs: parseInt(process.env.FACTORY_DISCOVERY_HOT_POLL_MS ?? '5000', 10),
  factoryDiscoveryHotAutostart: process.env.FACTORY_DISCOVERY_HOT_AUTOSTART != null
    ? process.env.FACTORY_DISCOVERY_HOT_AUTOSTART !== 'false'
    : activeStrategyMode() === 'legacy_contract_radar',
  factoryDiscoveryInitialLookbackEthereum: parseInt(process.env.FACTORY_DISCOVERY_INITIAL_LOOKBACK_ETHEREUM ?? '30', 10),
  // Keep Base's first query inside public RPC non-archive log limits. Subsequent
  // cycles advance from the in-memory cursor, so this does not slow live discovery.
  factoryDiscoveryInitialLookbackBase: parseInt(process.env.FACTORY_DISCOVERY_INITIAL_LOOKBACK_BASE ?? '120', 10),
  factoryDiscoveryPendingTtlMs: parseInt(process.env.FACTORY_DISCOVERY_PENDING_TTL_MS ?? '1800000', 10),
  factoryDiscoveryMinExecutableDepthUsd: parseFloat(process.env.FACTORY_DISCOVERY_MIN_EXECUTABLE_DEPTH_USD ?? '100'),
  tokenMaxAgeDays: parseFloat(process.env.TOKEN_MAX_AGE_DAYS ?? '7'),
  tokenAgeHardGateEnabled: process.env.TOKEN_AGE_HARD_GATE_ENABLED === 'true',
  moonshotStage0Enabled: process.env.MOONSHOT_STAGE0_ENABLED !== 'false',
  moonshotMinLiquidityUsd: parseFloat(process.env.MOONSHOT_MIN_LIQUIDITY_USD ?? '1000'),
  moonshotMinFdvUsd: parseFloat(process.env.MOONSHOT_MIN_FDV_USD ?? '1000'),
  moonshotMinVol1hUsd: parseFloat(process.env.MOONSHOT_MIN_VOL_1H_USD ?? '1000'),
  moonshotMinTx1h: parseInt(process.env.MOONSHOT_MIN_TX_1H ?? '30', 10),
  moonshotMinBuys1h: parseInt(process.env.MOONSHOT_MIN_BUYS_1H ?? '15', 10),
  promoteCleanUnknownEnabled: process.env.PROMOTE_CLEAN_UNKNOWN_ENABLED !== 'false',
  // Robinhood has no GoPlus/Honeypot coverage yet. Static bytecode checks plus
  // executable liquidity are the paper-entry safety contract for this chain.
  robinhoodPaperEnabled: process.env.ROBINHOOD_PAPER_ENABLED != null
    ? process.env.ROBINHOOD_PAPER_ENABLED !== 'false'
    : process.env.ROBINHOOD_EXPERIMENTAL_PAPER_ENABLED === 'true',
  // EVM flow owns Robinhood paid paper entries. The legacy score/stage lane
  // remains available only for explicit archival reproduction.
  robinhoodLegacyPaperEnabled: process.env.ROBINHOOD_LEGACY_PAPER_ENABLED === 'true',
  robinhoodMinDepthUsd: parseFloat(process.env.ROBINHOOD_MIN_DEPTH_USD ?? process.env.ROBINHOOD_EXPERIMENTAL_MIN_DEPTH_USD ?? '100'),
  robinhoodMinOnchainTvlUsd: parseFloat(process.env.ROBINHOOD_MIN_ONCHAIN_TVL_USD ?? process.env.ROBINHOOD_EXPERIMENTAL_MIN_ONCHAIN_TVL_USD ?? '200'),
  robinhoodMinScore: parseFloat(process.env.ROBINHOOD_MIN_SCORE ?? process.env.ROBINHOOD_EXPERIMENTAL_MIN_SCORE ?? '50'),
  robinhoodShadowMinScore: parseFloat(process.env.ROBINHOOD_SHADOW_MIN_SCORE ?? '30'),
  robinhoodStageMaxPoolAgeHours: parseFloat(process.env.ROBINHOOD_STAGE_MAX_POOL_AGE_HOURS ?? '6'),
  robinhoodStageMinReportedLiquidityUsd: parseFloat(process.env.ROBINHOOD_STAGE_MIN_REPORTED_LIQUIDITY_USD ?? '2500'),
  robinhoodStageStandardLiquidityUsd: parseFloat(process.env.ROBINHOOD_STAGE_STANDARD_LIQUIDITY_USD ?? '5000'),
  robinhoodStageMinFdvUsd: parseFloat(process.env.ROBINHOOD_STAGE_MIN_FDV_USD ?? '1000'),
  robinhoodStageMaxFdvUsd: parseFloat(process.env.ROBINHOOD_STAGE_MAX_FDV_USD ?? '50000000'),
  robinhoodStageBootstrapMinVol5mUsd: parseFloat(process.env.ROBINHOOD_STAGE_BOOTSTRAP_MIN_VOL_5M_USD ?? '250'),
  robinhoodStageBootstrapMinTx1h: parseInt(process.env.ROBINHOOD_STAGE_BOOTSTRAP_MIN_TX_1H ?? '5', 10),
  robinhoodStageBootstrapMinBuys1h: parseInt(process.env.ROBINHOOD_STAGE_BOOTSTRAP_MIN_BUYS_1H ?? '3', 10),
  robinhoodStageMatureMinVol1hUsd: parseFloat(process.env.ROBINHOOD_STAGE_MATURE_MIN_VOL_1H_USD ?? '1000'),
  robinhoodStageMatureMinTx1h: parseInt(process.env.ROBINHOOD_STAGE_MATURE_MIN_TX_1H ?? '20', 10),
  robinhoodStageMatureMinBuys1h: parseInt(process.env.ROBINHOOD_STAGE_MATURE_MIN_BUYS_1H ?? '10', 10),
  robinhoodPrimaryMinFdvToOnchainTvlRatio: parseFloat(process.env.ROBINHOOD_PRIMARY_MIN_FDV_TO_TVL_RATIO ?? '0.5'),
  robinhoodPrimaryMaxEntrySlippagePct: parseFloat(process.env.ROBINHOOD_PRIMARY_MAX_ENTRY_SLIPPAGE_PCT ?? '0.03'),
  robinhoodPrimaryMinRoundTripMultiple: parseFloat(process.env.ROBINHOOD_PRIMARY_MIN_ROUND_TRIP_MULTIPLE ?? '0.80'),
  deployerGateEnabled: process.env.DEPLOYER_GATE_ENABLED !== 'false',
  deployerGateMinDeployments: parseInt(process.env.DEPLOYER_GATE_MIN_DEPLOYMENTS ?? '1', 10),
  deployerGateMinRugLike: parseInt(process.env.DEPLOYER_GATE_MIN_RUG_LIKE ?? '1', 10),
  contractRiskShadowEnabled: process.env.CONTRACT_RISK_SHADOW_ENABLED !== 'false',
  contractRiskShadowMinDepthUsd: parseFloat(process.env.CONTRACT_RISK_SHADOW_MIN_DEPTH_USD ?? '100'),
  deployerGateMinRugRate: parseFloat(process.env.DEPLOYER_GATE_MIN_RUG_RATE ?? '0.5'),
  blockedTokenSymbols,
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
  uniswapV2FactoryEthereum: process.env.UNISWAP_V2_FACTORY_ETHEREUM ?? '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
  uniswapV3FactoryEthereum: process.env.UNISWAP_V3_FACTORY_ETHEREUM ?? '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  uniswapV3FactoryBase: process.env.UNISWAP_V3_FACTORY_BASE ?? '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
  // Uniswap V3 QuoterV2 — verified 2025-06 against official Uniswap deployment docs
  quoterV2Ethereum: process.env.QUOTER_V2_ETHEREUM ?? '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  quoterV2Base:     process.env.QUOTER_V2_BASE     ?? '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  quoterV2Robinhood: process.env.QUOTER_V2_ROBINHOOD ?? '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
  v4PoolManagerEthereum: process.env.V4_POOL_MANAGER_ETHEREUM ?? '0x000000000004444c5dc75cB358380D2e3dE08A90',
  v4PoolManagerBase:     process.env.V4_POOL_MANAGER_BASE     ?? '0x498581ff718922c3f8e6a244956af099b2652b2b',
  v4PoolManagerRobinhood: process.env.V4_POOL_MANAGER_ROBINHOOD ?? '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  v4QuoterEthereum:      process.env.V4_QUOTER_ETHEREUM      ?? '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203',
  v4QuoterBase:          process.env.V4_QUOTER_BASE          ?? '0x0d5e0f971ed27fbff6c2837bf31316121532048d',
  v4QuoterRobinhood:     process.env.V4_QUOTER_ROBINHOOD     ?? '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  v4StateViewEthereum:   process.env.V4_STATE_VIEW_ETHEREUM  ?? '0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
  v4StateViewBase:       process.env.V4_STATE_VIEW_BASE      ?? '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71',
  v4StateViewRobinhood:  process.env.V4_STATE_VIEW_ROBINHOOD  ?? '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
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
    deployer_reputation: parseFloat(process.env.SCORE_W_DEPLOYER_REPUTATION ?? '0.15'),
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
  // PAPER_TRADE_SIZE_USD is the legacy name; keep it as a fallback so the
  // configured paper size cannot silently fall back to a different default.
  positionSizeUsd:    parseFloat(process.env.PAPER_POSITION_SIZE_USD ?? process.env.PAPER_TRADE_SIZE_USD ?? '20'),
  detectionDelaySec:  parseInt(  process.env.PAPER_DETECTION_DELAY_SEC ?? '0', 10), // enter as soon as a candidate survives
  // Optional survival experiment. The primary paper lane enters at discovery t0;
  // delaying the buy changes the opportunity set and must never be the default.
  takeCohortEnabled: process.env.PAPER_TAKE_COHORT_ENABLED === 'true',
  takeCohortChains: (process.env.PAPER_TAKE_COHORT_CHAINS ?? 'ethereum')
    .split(',').map((chain) => chain.trim()).filter(Boolean),
  takeConfirmationDelaySec: parseInt(process.env.PAPER_TAKE_CONFIRMATION_DELAY_SEC ?? '600', 10),
  takeMinPriceMultiple: parseFloat(process.env.PAPER_TAKE_MIN_PRICE_MULTIPLE ?? '1.00'),
  takeMinExecutableDepthUsd: parseFloat(process.env.PAPER_TAKE_MIN_EXECUTABLE_DEPTH_USD ?? '100'),
  takeMinLiquidityRetention: parseFloat(process.env.PAPER_TAKE_MIN_LIQUIDITY_RETENTION ?? '0.80'),
  takeMinV2OnchainTvlUsd: parseFloat(process.env.PAPER_TAKE_MIN_V2_ONCHAIN_TVL_USD ?? '5000'),
  survivalObservationEnabled: process.env.PAPER_SURVIVAL_OBSERVATION_ENABLED !== 'false',
  survivalObservationDelaySec: parseInt(process.env.PAPER_SURVIVAL_OBSERVATION_DELAY_SEC ?? '600', 10),
  evalAutostart:      process.env.PAPER_EVAL_AUTOSTART != null
    ? process.env.PAPER_EVAL_AUTOSTART !== 'false'
    : activeStrategyMode() === 'legacy_contract_radar',
  evalIntervalMs:     parseInt(process.env.PAPER_EVAL_INTERVAL_MS ?? '30000', 10),
  evalYoungWindowSec: parseInt(process.env.PAPER_EVAL_YOUNG_WINDOW_SEC ?? '3600', 10),
  evalYoungIntervalMs: parseInt(process.env.PAPER_EVAL_YOUNG_INTERVAL_MS ?? '30000', 10),
  evalMatureIntervalMs: parseInt(process.env.PAPER_EVAL_MATURE_INTERVAL_MS ?? '300000', 10),
  collectTradeStats:  process.env.PAPER_COLLECT_TRADE_STATS === 'true',
  evalInitialDelayMs: parseInt(process.env.PAPER_EVAL_INITIAL_DELAY_MS ?? '30000', 10),
  sandwichPct:        parseFloat(process.env.PAPER_SANDWICH_PCT        ?? '0.01'),  // 1% MEV/sandwich haircut
  gasUsd:             parseFloat(process.env.PAPER_GAS_USD             ?? '1.5'),   // modeled gas per tx (each way)
  maxEntrySlipPct:    parseFloat(process.env.PAPER_MAX_ENTRY_SLIP_PCT  ?? '0.50'),  // > this at entry → not_entered
  // Exit ladder: sell fractions of the ORIGINAL position when the multiple is crossed.
  // Recover the stake at 2x, realize a further slice at 10x, and retain a small
  // asymmetric tail for the rare true outlier.
  partialProfitTimeExitMs: parseInt(process.env.PAPER_PARTIAL_PROFIT_TIME_EXIT_MS ?? '3600000', 10),
  ladder: [
    { multiple: 2,    sellFraction: 0.80 },
    { multiple: 10,   sellFraction: 0.15 },
    { multiple: 1000, sellFraction: 0.05 },
  ],
  // Status thresholds (on-demand eval).
  liqPullDropPct:        parseFloat(process.env.PAPER_LIQ_PULL_DROP_PCT   ?? '0.60'), // liq down > 60% → liquidity_pulled
  rugLiqUsd:             parseFloat(process.env.PAPER_RUG_LIQ_USD         ?? '50'),   // liq ≤ this → rug
  sellTaxSpikePct:       parseFloat(process.env.PAPER_SELL_TAX_SPIKE_PCT  ?? '0.50'), // sell tax ≥ 50% → unsellable
  maxDrawdownInvalidate: parseFloat(process.env.PAPER_MAX_DRAWDOWN        ?? '0.70'), // drawdown > 70% → invalidate
  hardStopMultiple:      parseFloat(process.env.PAPER_HARD_STOP_MULTIPLE ?? '0.80'),
  priceReadFailureRugThreshold: parseInt(process.env.PAPER_PRICE_READ_FAILURE_RUG_THRESHOLD ?? '3', 10),
  rugLiquidityConfirmationCount: parseInt(process.env.PAPER_RUG_LIQUIDITY_CONFIRMATIONS ?? '1', 10),
  robinhoodRugLiquidityConfirmationCount: parseInt(
    process.env.ROBINHOOD_PAPER_RUG_LIQUIDITY_CONFIRMATIONS ?? '2',
    10,
  ),
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
  autoScreenEnabled: process.env.GEM_AUTOSCREEN_ENABLED !== 'false',
  shadowAutostart: process.env.GEM_SHADOW_AUTOSTART != null
    ? process.env.GEM_SHADOW_AUTOSTART !== 'false'
    : activeStrategyMode() === 'legacy_contract_radar',
  shadowIntervalMs: parseInt(process.env.GEM_SHADOW_INTERVAL_MS ?? '300000', 10),
  shadowInitialDelayMs: parseInt(process.env.GEM_SHADOW_INITIAL_DELAY_MS ?? '180000', 10),
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
    robinhood: {} as Record<string, string>,
  } as Record<string, Record<string, string>>,
}));

export const launchSniperConfig = registerAs('launchSniper', () => ({
  enabled: process.env.LAUNCH_SNIPER_ENABLED != null
    ? process.env.LAUNCH_SNIPER_ENABLED === 'true'
    : activeStrategyMode() === 'launch_sniper_paper',
  mode: process.env.LAUNCH_SNIPER_MODE ?? 'paper',
  bscRpcUrl: process.env.BSC_RPC_URL ?? 'https://bsc.blockrazor.xyz',
  fourMemeApiBaseUrl: process.env.FOUR_MEME_API_BASE_URL ?? 'https://four.meme/meme-api/v1',
  fourMemeTokenManager:
    process.env.FOUR_MEME_TOKEN_MANAGER ?? '0x5c952063c7fc8610ffdb798152d69f0b9550762b',
  pollIntervalMs: parseInt(process.env.LAUNCH_SNIPER_POLL_INTERVAL_MS ?? '3000', 10),
  initialLookbackBlocks: parseInt(process.env.LAUNCH_SNIPER_INITIAL_LOOKBACK_BLOCKS ?? '300', 10),
  maxLogRangeBlocks: parseInt(process.env.LAUNCH_SNIPER_MAX_LOG_RANGE_BLOCKS ?? '25', 10),
  rpcRequestDelayMs: parseInt(process.env.LAUNCH_SNIPER_RPC_REQUEST_DELAY_MS ?? '500', 10),
  rpcTimeoutMs: parseInt(process.env.LAUNCH_SNIPER_RPC_TIMEOUT_MS ?? '15000', 10),
  apiSeedEnabled: process.env.LAUNCH_SNIPER_API_SEED_ENABLED !== 'false',
  apiSeedIntervalMs: parseInt(process.env.LAUNCH_SNIPER_API_SEED_INTERVAL_MS ?? '15000', 10),
  apiSeedPageSize: parseInt(process.env.LAUNCH_SNIPER_API_SEED_PAGE_SIZE ?? '30', 10),
  pollErrorBackoffMs: parseInt(process.env.LAUNCH_SNIPER_POLL_ERROR_BACKOFF_MS ?? '10000', 10),
  rateLimitBackoffMs: parseInt(process.env.LAUNCH_SNIPER_RATE_LIMIT_BACKOFF_MS ?? '60000', 10),
  maxPollBackoffMs: parseInt(process.env.LAUNCH_SNIPER_MAX_BACKOFF_MS ?? '300000', 10),
  heartbeatIntervalMs: parseInt(process.env.LAUNCH_SNIPER_HEARTBEAT_INTERVAL_MS ?? '30000', 10),
  confirmations: parseInt(process.env.LAUNCH_SNIPER_CONFIRMATIONS ?? '1', 10),
  maxTrackedLaunches: parseInt(process.env.LAUNCH_SNIPER_MAX_TRACKED ?? '2000', 10),
  blockedCreators: (blockedCreatorsFile.creators as Array<{ address: string }>)
    .map((entry) => entry.address.trim().toLowerCase())
    .filter((entry) => /^0x[0-9a-f]{40}$/.test(entry)),
  trigger: {
    windowMs: parseInt(process.env.LAUNCH_SNIPER_WINDOW_MS ?? '300000', 10),
    minAgeSec: parseFloat(process.env.LAUNCH_SNIPER_MIN_AGE_SEC ?? '2'),
    minBlocksAfterLaunch: parseInt(process.env.LAUNCH_SNIPER_MIN_BLOCKS_AFTER_LAUNCH ?? '6', 10),
    maxAgeSec: parseFloat(process.env.LAUNCH_SNIPER_MAX_AGE_SEC ?? '300'),
    minBuys: parseInt(process.env.LAUNCH_SNIPER_MIN_BUYS ?? '3', 10),
    minUniqueBuyers: parseInt(process.env.LAUNCH_SNIPER_MIN_UNIQUE_BUYERS ?? '3', 10),
    minBuyQuote: parseFloat(process.env.LAUNCH_SNIPER_MIN_BUY_BNB ?? '0.10'),
    minBuySellRatio: parseFloat(process.env.LAUNCH_SNIPER_MIN_BUY_SELL_RATIO ?? '2'),
    maxLargestBuyerShare: parseFloat(process.env.LAUNCH_SNIPER_MAX_BUYER_SHARE ?? '0.65'),
    minPriceMomentum: parseFloat(process.env.LAUNCH_SNIPER_MIN_PRICE_MOMENTUM ?? '1.02'),
  },
  paper: {
    positionSizeQuote: parseFloat(process.env.LAUNCH_SNIPER_POSITION_BNB ?? '0.02'),
    protocolFeePct: parseFloat(process.env.LAUNCH_SNIPER_PROTOCOL_FEE_PCT ?? '0.01'),
    entrySlippagePct: parseFloat(process.env.LAUNCH_SNIPER_ENTRY_SLIPPAGE_PCT ?? '0.02'),
    exitSlippagePct: parseFloat(process.env.LAUNCH_SNIPER_EXIT_SLIPPAGE_PCT ?? '0.03'),
    stopMultiple: parseFloat(process.env.LAUNCH_SNIPER_STOP_MULTIPLE ?? '0.80'),
    timeExitMs: parseInt(process.env.LAUNCH_SNIPER_TIME_EXIT_MS ?? '3600000', 10),
    momentumWindowMs: parseInt(process.env.LAUNCH_SNIPER_MOMENTUM_WINDOW_MS ?? '30000', 10),
    momentumExitRatio: parseFloat(process.env.LAUNCH_SNIPER_MOMENTUM_EXIT_RATIO ?? '0.70'),
    momentumConfirmations: parseInt(process.env.LAUNCH_SNIPER_MOMENTUM_CONFIRMATIONS ?? '2', 10),
    ladder: [
      { multiple: 2, sellFraction: 0.80 },
      { multiple: 5, sellFraction: 0.15 },
      { multiple: parseFloat(process.env.LAUNCH_SNIPER_RUNNER_MULTIPLE ?? '100'), sellFraction: 0.05 },
    ],
  },
}));

export const telegramConfig = registerAs('telegram', () => ({
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  enabled: process.env.TELEGRAM_ENABLED === 'true',
  minScore: parseFloat(process.env.TELEGRAM_MIN_SCORE ?? '75'),
}));

export const maintenanceConfig = registerAs('maintenance', () => ({
  retentionEnabled: process.env.RESEARCH_RETENTION_ENABLED !== 'false',
  hotRawDays: Math.max(1, parseInt(process.env.RESEARCH_HOT_RAW_DAYS ?? '7', 10)),
  archiveDays: Math.max(7, parseInt(process.env.RESEARCH_ARCHIVE_DAYS ?? '90', 10)),
  batchSize: Math.min(2_000, Math.max(10, parseInt(process.env.RESEARCH_RETENTION_BATCH_SIZE ?? '500', 10))),
  archiveDir: process.env.RESEARCH_ARCHIVE_DIR ?? './logs/archive',
}));

export default [
  appConfig,
  redisConfig,
  chainConfig,
  evmFlowConfig,
  solanaLaunchConfig,
  apiConfig,
  collectorConfig,
  scoringConfig,
  paperConfig,
  gemConfig,
  launchSniperConfig,
  telegramConfig,
  maintenanceConfig,
  explorerConfig,
  onchainConfig,
];
