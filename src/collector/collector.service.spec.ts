import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CollectorService } from './collector.service';
import { FileLoggerService } from '../file-logger/file-logger.service';
import { GeckoTerminalService } from './geckoterminal/geckoterminal.service';
import { DexScreenerService } from './dexscreener/dexscreener.service';
import { MoralisService } from './moralis/moralis.service';
import { BirdeyeService } from './birdeye/birdeye.service';
import { PrismaService } from '../database/prisma.service';
import { RiskEngineService } from '../risk-engine/risk-engine.service';
import { CollectorResult, SupportedChain } from './collector.types';
import { CSV_SCHEMA_VERSION } from '../file-logger/csv-schemas';
import { ContractRiskResult } from '../risk-engine/risk-engine.types';
import { TokenAgeService } from '../onchain/token-age.service';
import { LiquidityVerificationService } from '../onchain/liquidity-verification.service';
import { ScoringService } from '../scoring/scoring.service';
import { PaperService } from '../paper/paper.service';
import { DeployerReputationService } from '../deployer/deployer-reputation.service';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildResult(
  overrides: Partial<CollectorResult['pool']> = {},
  tokenAddress = '0xdeadbeef',
): CollectorResult {
  const chain: SupportedChain = overrides.chain ?? 'ethereum';
  return {
    token: {
      chain,
      tokenAddress,
      symbol: 'GEM',
      name: 'Gem Token',
      source: 'geckoterminal',
    },
    pool: {
      chain,
      poolAddress: '0xpool1',
      dex: 'uniswap_v3',
      token0Address: '0xdeadbeef',
      token1Address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      quoteAsset: 'WETH',
      quoteAssetAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      priceUsd: 0.001,
      liquidityUsd: 50_000,
      fdvUsd: 1_000_000,
      vol5m: 500,
      vol1h: 3_000,
      vol6h: 15_000,
      vol24h: 45_000,
      buys1h: 40,
      sells1h: 20,
      txCount1h: 60,
      poolCreatedAt: new Date(Date.now() - 30 * 60 * 1000),
      source: 'geckoterminal',
      ...overrides,
    },
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('CollectorService', () => {
  let service: CollectorService;
  let module: TestingModule;
  let tempDir: string;

  // Mocks
  const mockToken = { id: 'tok-cuid', chain: 'ethereum', tokenAddress: '0xdeadbeef' };
  const mockPool = { id: 'pool-cuid' };

  const SAFE_RISK: ContractRiskResult = {
    decision: 'CONTRACT_SAFE',
    rejectReasons: [],
    goplusQueried: true,
    honeypotQueried: true,
    merged: { honeypot: false, verified: true },
    cacheHit: false,
  };

  const REJECT_RISK: ContractRiskResult = {
    decision: 'CONTRACT_REJECT',
    rejectReasons: ['honeypot_detected'],
    goplusQueried: true,
    honeypotQueried: true,
    merged: { honeypot: true },
    cacheHit: false,
  };

  const UNKNOWN_RISK: ContractRiskResult = {
    decision: 'CONTRACT_UNKNOWN',
    rejectReasons: [],
    goplusQueried: false,
    honeypotQueried: false,
    merged: {},
    cacheHit: false,
  };

  const CLEAN_UNKNOWN_RISK: ContractRiskResult = {
    decision: 'CONTRACT_UNKNOWN',
    rejectReasons: [],
    goplusQueried: true,
    honeypotQueried: true,
    merged: { honeypot: false, buyTax: 0, sellTax: 0 },
    providerStatus: 'GOPLUS_PARTIAL',
    cacheHit: false,
  };

  const prismaMock = {
    $transaction: jest.fn(),
    token: {
      upsert: jest.fn().mockResolvedValue(mockToken),
      findMany: jest.fn().mockResolvedValue([]),
    },
    deployer: { findUnique: jest.fn().mockResolvedValue(null) },
    pool: {
      upsert: jest.fn().mockResolvedValue(mockPool),
      // null = pool not yet in DB → isNewDiscovery = true (default for tests)
      findUnique: jest.fn().mockResolvedValue(null),
    },
    poolSnapshot: { create: jest.fn().mockResolvedValue({}) },
    rawCollectorPayload: { create: jest.fn().mockResolvedValue({}) },
    contractRiskCheck: { create: jest.fn().mockResolvedValue({}) },
    quarantineToken: { create: jest.fn().mockResolvedValue({ id: 'quat-id' }) },
    scoringHistory: { create: jest.fn().mockResolvedValue({}) },
  };

  const gtMock = {
    getNewPools: jest.fn().mockResolvedValue([]),
    getTrendingPools: jest.fn().mockResolvedValue([]),
  };
  const dsMock = {
    getLatestProfileAddresses: jest.fn().mockResolvedValue([]),
    getLatestBoostAddresses: jest.fn().mockResolvedValue([]),
    getTopBoostAddresses: jest.fn().mockResolvedValue([]),
    getLatestCommunityTakeoverAddresses: jest.fn().mockResolvedValue([]),
    getLatestAdAddresses: jest.fn().mockResolvedValue([]),
    getPairsForTokens: jest.fn().mockResolvedValue([]),
  };
  const moralisMock = {
    getTrendingTokenAddresses: jest.fn().mockResolvedValue([]),
    getLastFetchSummary: jest.fn().mockReturnValue({
      enabled: false,
      requestedChains: 0,
      returned: 0,
      errors: 0,
    }),
  };
  const birdeyeMock = {
    getVolumeTokenAddresses: jest.fn().mockResolvedValue([]),
  };
  const riskMock = { checkToken: jest.fn().mockResolvedValue(SAFE_RISK) };
  // M3A mocks — token age returns "2 days" (passes the 7-day gate); liquidity returns UNSUPPORTED
  const tokenAgeMock = { getTokenAgeDays: jest.fn().mockResolvedValue(2) };
  const liquidityMock = {
    verify: jest.fn().mockResolvedValue({
      liquidityModel: 'UNSUPPORTED_UNKNOWN',
      liquidityVerified: false,
      onchainTvlUsd: null,
      reportedVsOnchainPct: null,
      executableDepthUsd: null,
      slip50: null, slip100: null, slip500: null, slip1000: null,
      spotPriceUsd: null,
      error: 'mock',
    }),
  };
  // Scoring is only invoked when liquidityVerified=true (default mock is false),
  // so this mock just needs to satisfy DI; the return value is unused by default.
  const scoringMock = {
    score: jest.fn().mockReturnValue({
      finalScore: 0,
      liquidityScore: null, depthScore: null, ageScore: null,
      tractionScore: null, divergenceScore: null, deployerReputationScore: null,
      componentsPresent: [],
      componentsMissing: ['liquidity', 'depth', 'age', 'traction', 'divergence', 'deployer_reputation'],
      scoreConfidence: 0,
      band: 'reject_band',
    }),
  };
  // Paper entry only fires when liquidityVerified=true (default mock is false) → DI-only.
  const paperMock = {
    recordEntry: jest.fn().mockResolvedValue(undefined),
    recordResearchEntry: jest.fn().mockResolvedValue(undefined),
  };
  const deployerReputationMock = {
    findBlocklistHit: jest.fn().mockResolvedValue(null),
    summarize: jest.fn().mockResolvedValue(null),
    isRepeatRugger: jest.fn().mockReturnValue(false),
  };

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gem-radar-collector-test-'));

    // Reset all mocks between tests
    jest.clearAllMocks();
    prismaMock.token.upsert.mockResolvedValue(mockToken);
    prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock));
    prismaMock.token.findMany.mockResolvedValue([]);
    prismaMock.deployer.findUnique.mockResolvedValue(null);
    prismaMock.pool.upsert.mockResolvedValue(mockPool);
    prismaMock.pool.findUnique.mockResolvedValue(null); // default: new pool
    prismaMock.poolSnapshot.create.mockResolvedValue({});
    prismaMock.rawCollectorPayload.create.mockResolvedValue({});
    prismaMock.contractRiskCheck.create.mockResolvedValue({});
    prismaMock.quarantineToken.create.mockResolvedValue({ id: 'quat-id' });
    deployerReputationMock.findBlocklistHit.mockResolvedValue(null);
    deployerReputationMock.summarize.mockResolvedValue(null);
    deployerReputationMock.isRepeatRugger.mockReturnValue(false);
    gtMock.getNewPools.mockResolvedValue([]);
    gtMock.getTrendingPools.mockResolvedValue([]);
    dsMock.getLatestProfileAddresses.mockResolvedValue([]);
    dsMock.getLatestBoostAddresses.mockResolvedValue([]);
    dsMock.getTopBoostAddresses.mockResolvedValue([]);
    dsMock.getLatestCommunityTakeoverAddresses.mockResolvedValue([]);
    dsMock.getLatestAdAddresses.mockResolvedValue([]);
    dsMock.getPairsForTokens.mockResolvedValue([]);
    moralisMock.getTrendingTokenAddresses.mockResolvedValue([]);
    moralisMock.getLastFetchSummary.mockReturnValue({
      enabled: false,
      requestedChains: 0,
      returned: 0,
      errors: 0,
    });
    birdeyeMock.getVolumeTokenAddresses.mockResolvedValue([]);
    riskMock.checkToken.mockResolvedValue(SAFE_RISK);
    tokenAgeMock.getTokenAgeDays.mockResolvedValue(2);

    module = await Test.createTestingModule({
      providers: [
        CollectorService,
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: FileLoggerService,
          useFactory: () => {
            const svc = new FileLoggerService({
              get: (k: string) => (k === 'app.logDir' ? tempDir : undefined),
            } as unknown as ConfigService);
            svc.onModuleInit();
            return svc;
          },
        },
        { provide: GeckoTerminalService, useValue: gtMock },
        { provide: DexScreenerService, useValue: dsMock },
        { provide: MoralisService, useValue: moralisMock },
        { provide: BirdeyeService, useValue: birdeyeMock },
        { provide: RiskEngineService, useValue: riskMock },
        { provide: TokenAgeService, useValue: tokenAgeMock },
        { provide: LiquidityVerificationService, useValue: liquidityMock },
        { provide: ScoringService, useValue: scoringMock },
        { provide: PaperService, useValue: paperMock },
        { provide: DeployerReputationService, useValue: deployerReputationMock },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const cfg: Record<string, unknown> = {
                'chain.enabledChains': ['ethereum'],
                'collector.pollIntervalMs': 9_999_999, // effectively never fires in tests
                'collector.newPoolMaxAgeHours': 6,
                'collector.tokenMaxAgeDays': 7,
                'scoring.minLiquidityUsd': 5_000,
                'scoring.minFdvUsd': 10_000,
                'scoring.maxFdvUsd': 50_000_000,
              };
              return cfg[key];
            }),
          },
        },
      ],
    }).compile();

    service = module.get<CollectorService>(CollectorService);

    // onModuleInit starts the interval but does NOT run the first cycle
    service.onModuleInit();
  });

  afterEach(async () => {
    service.onModuleDestroy();
    await module.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ── firstSeenAt write-once ────────────────────────────────────────────────

  it('token upsert CREATE includes firstSeenAt', async () => {
    gtMock.getNewPools.mockResolvedValue([buildResult()]);
    await service.runCollectionCycle();

    const createArg = prismaMock.token.upsert.mock.calls[0][0];
    expect(createArg.create).toHaveProperty('firstSeenAt');
    expect(createArg.create.firstSeenAt).toBeInstanceOf(Date);
  });

  it('token upsert UPDATE does NOT include firstSeenAt', async () => {
    gtMock.getNewPools.mockResolvedValue([buildResult()]);
    await service.runCollectionCycle();

    const updateArg = prismaMock.token.upsert.mock.calls[0][0];
    expect(updateArg.update).not.toHaveProperty('firstSeenAt');
  });

  it('repeated cycles do NOT overwrite firstSeenAt (update clause never has it)', async () => {
    const candidate = buildResult();
    gtMock.getNewPools.mockResolvedValue([candidate]);

    await service.runCollectionCycle();
    await service.runCollectionCycle();

    // Both calls' update clause must lack firstSeenAt
    for (const [call] of prismaMock.token.upsert.mock.calls) {
      expect(call.update).not.toHaveProperty('firstSeenAt');
    }
  });

  it('pool upsert UPDATE is empty (structural fields are write-once)', async () => {
    gtMock.getNewPools.mockResolvedValue([buildResult()]);
    await service.runCollectionCycle();

    const poolUpsertArg = prismaMock.pool.upsert.mock.calls[0][0];
    expect(poolUpsertArg.update).toEqual({});
  });

  // ── Deduplication within one cycle ───────────────────────────────────────

  it('same pool from GT and DS in one cycle is persisted exactly once', async () => {
    const candidate = buildResult({ poolAddress: '0xdup' });
    gtMock.getNewPools.mockResolvedValue([candidate]);
    dsMock.getPairsForTokens.mockResolvedValue([candidate]); // same pool from second source

    await service.runCollectionCycle();

    expect(prismaMock.pool.upsert).toHaveBeenCalledTimes(1);
  });

  it('two different pools in one cycle are each persisted once', async () => {
    gtMock.getNewPools.mockResolvedValue([
      buildResult({ poolAddress: '0xpoolA' }),               // token 0xdeadbeef
      buildResult({ poolAddress: '0xpoolB' }, '0xdeadbeee'), // different token
    ]);

    await service.runCollectionCycle();

    expect(prismaMock.pool.upsert).toHaveBeenCalledTimes(2);
  });

  // ── Rejection logging ─────────────────────────────────────────────────────

  it('stage0 rejects are logged to rejected_tokens.csv', async () => {
    const lowLiq = buildResult({ liquidityUsd: 100 }); // below 5000 floor
    gtMock.getNewPools.mockResolvedValue([lowLiq]);

    await service.runCollectionCycle();

    // Verify NOT persisted
    expect(prismaMock.pool.upsert).not.toHaveBeenCalled();

    // Verify rejected_tokens.csv was written
    const csvPath = path.join(tempDir, 'decisions', 'rejected_tokens.csv');
    expect(fs.existsSync(csvPath)).toBe(true);

    const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2); // header + 1 rejection row
    expect(lines[1]).toContain('liquidity_too_low');
  });

  it('pool_too_old still writes a trajectory snapshot', async () => {
    const oldPool = buildResult({
      poolCreatedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    });
    gtMock.getNewPools.mockResolvedValue([oldPool]);

    await service.runCollectionCycle();

    const trajectoryPath = path.join(tempDir, 'raw', 'trajectory_snapshots.csv');
    expect(fs.existsSync(trajectoryPath)).toBe(true);
    const row = fs.readFileSync(trajectoryPath, 'utf8').trim().split('\n')[1];
    expect(row).toContain('pool_too_old');
    expect(row).toContain('false');

    expect(prismaMock.pool.upsert).not.toHaveBeenCalled();
    expect(paperMock.recordEntry).not.toHaveBeenCalled();
  });

  it('seen-across-cycles tokens keep updating trajectory without reprocessing entry', async () => {
    const candidate = buildResult();
    gtMock.getNewPools.mockResolvedValue([candidate]);

    await service.runCollectionCycle();
    await service.runCollectionCycle();

    const trajectoryPath = path.join(tempDir, 'raw', 'trajectory_snapshots.csv');
    const rows = fs.readFileSync(trajectoryPath, 'utf8').trim().split('\n').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('seen_across_cycles');
    expect(prismaMock.pool.upsert).toHaveBeenCalledTimes(1);
  });

  it('rejected token row contains full candidate metrics', async () => {
    const candidate = buildResult({
      liquidityUsd: 100,
      fdvUsd: 500_000,
      vol1h: 1234,
      buys1h: 7,
      sells1h: 3,
      txCount1h: 10,
      dex: 'aerodrome',
    });
    gtMock.getNewPools.mockResolvedValue([candidate]);

    await service.runCollectionCycle();

    const csvPath = path.join(tempDir, 'decisions', 'rejected_tokens.csv');
    const dataRow = fs.readFileSync(csvPath, 'utf8').trim().split('\n')[1];

    expect(dataRow).toContain('100');           // liquidity_usd
    expect(dataRow).toContain('500000');        // fdv_usd
    expect(dataRow).toContain('1234');          // vol_1h
    expect(dataRow).toContain('aerodrome');     // dex
    expect(dataRow).toContain('REPORTED_ONLY'); // liquidity_trust_level
    expect(dataRow).toContain('false');         // onchain_verified
    expect(dataRow).toContain('stage0');        // stage
  });

  it('rejection row carries run_id and schema_version', async () => {
    gtMock.getNewPools.mockResolvedValue([buildResult({ liquidityUsd: 1 })]);
    await service.runCollectionCycle();

    const csvPath = path.join(tempDir, 'decisions', 'rejected_tokens.csv');
    const dataRow = fs.readFileSync(csvPath, 'utf8').trim().split('\n')[1];
    expect(dataRow).toContain(CSV_SCHEMA_VERSION);
    // run_id is a UUID — just check it's present and non-empty in the right position
    const fields = dataRow.split(',');
    const runIdIndex = 1; // second column
    expect(fields[runIdIndex]).toMatch(/^[0-9a-f-]{36}$/);
  });

  // ── Passed pools are logged to new_pools.csv ─────────────────────────────

  it('passing pool is written to new_pools.csv with run_id and schema_version', async () => {
    gtMock.getNewPools.mockResolvedValue([buildResult()]);
    await service.runCollectionCycle();

    const csvPath = path.join(tempDir, 'raw', 'new_pools.csv');
    expect(fs.existsSync(csvPath)).toBe(true);

    const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(CSV_SCHEMA_VERSION);
    expect(lines[1]).toContain('CONTRACT_SAFE'); // risk_decision column present
    const runIdField = lines[1].split(',')[1];
    expect(runIdField).toMatch(/^[0-9a-f-]{36}$/);
  });

  // ── run_id is consistent within one cycle ────────────────────────────────

  it('all rows from one cycle share the same run_id', async () => {
    gtMock.getNewPools.mockResolvedValue([
      buildResult({ poolAddress: '0xp1', liquidityUsd: 50_000 }),            // passes,  token 0xdeadbeef
      buildResult({ poolAddress: '0xp2', liquidityUsd: 1 }, '0xdeadbeee'),   // rejected, different token
    ]);

    await service.runCollectionCycle();

    const passedCsv = path.join(tempDir, 'raw', 'new_pools.csv');
    const rejectedCsv = path.join(tempDir, 'decisions', 'rejected_tokens.csv');

    const passedRunId = fs.readFileSync(passedCsv, 'utf8').trim().split('\n')[1].split(',')[1];
    const rejectedRunId = fs.readFileSync(rejectedCsv, 'utf8').trim().split('\n')[1].split(',')[1];

    expect(passedRunId).toBe(rejectedRunId);
  });

  // ── Stage0 correctly passes good candidates ───────────────────────────────

  it('candidate with all valid metrics is persisted and NOT in rejected CSV', async () => {
    gtMock.getNewPools.mockResolvedValue([buildResult()]);
    await service.runCollectionCycle();

    expect(prismaMock.token.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.pool.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.poolSnapshot.create).toHaveBeenCalledTimes(1);

    const rejectedPath = path.join(tempDir, 'decisions', 'rejected_tokens.csv');
    expect(fs.existsSync(rejectedPath)).toBe(false);
  });

  // ── RawCollectorPayload DB persistence ────────────────────────────────────

  it('stores GeckoTerminal cycle summary in DB with payload_type="cycle_summary"', async () => {
    gtMock.getNewPools.mockResolvedValue([buildResult()]);
    await service.runCollectionCycle();

    expect(prismaMock.rawCollectorPayload.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          chain: 'ethereum',
          source: 'geckoterminal',
          ts: expect.any(Date),
          payload: expect.objectContaining({
            payload_type: 'cycle_summary',
            pool_count: expect.any(Number),
          }),
        }),
      }),
    );
  });

  it('stores DexScreener cycle summary in DB with chain="multi" and payload_type="cycle_summary"', async () => {
    dsMock.getPairsForTokens.mockResolvedValue([buildResult({ poolAddress: '0xds1' })]);
    await service.runCollectionCycle();

    expect(prismaMock.rawCollectorPayload.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'dexscreener',
          chain: 'multi',
          ts: expect.any(Date),
          payload: expect.objectContaining({ payload_type: 'cycle_summary' }),
        }),
      }),
    );
  });

  it('DexScreener pass combines all discovery feeds before pair lookup', async () => {
    dsMock.getLatestProfileAddresses.mockResolvedValue([
      { chain: 'ethereum', tokenAddress: '0xprofile' },
    ]);
    dsMock.getLatestBoostAddresses.mockResolvedValue([
      { chain: 'ethereum', tokenAddress: '0xboost' },
    ]);
    dsMock.getTopBoostAddresses.mockResolvedValue([
      { chain: 'ethereum', tokenAddress: '0xtopboost' },
    ]);
    dsMock.getLatestCommunityTakeoverAddresses.mockResolvedValue([
      { chain: 'ethereum', tokenAddress: '0xcommunity' },
    ]);
    dsMock.getLatestAdAddresses.mockResolvedValue([
      { chain: 'ethereum', tokenAddress: '0xad' },
    ]);
    moralisMock.getTrendingTokenAddresses.mockResolvedValue([
      { chain: 'ethereum', tokenAddress: '0xmoralis' },
    ]);
    birdeyeMock.getVolumeTokenAddresses.mockResolvedValue([
      { chain: 'ethereum', tokenAddress: '0xbirdeye' },
    ]);

    await service.runCollectionCycle();

    expect(dsMock.getPairsForTokens).toHaveBeenCalledWith([
      { chain: 'ethereum', tokenAddress: '0xprofile' },
      { chain: 'ethereum', tokenAddress: '0xboost' },
      { chain: 'ethereum', tokenAddress: '0xtopboost' },
      { chain: 'ethereum', tokenAddress: '0xcommunity' },
      { chain: 'ethereum', tokenAddress: '0xad' },
      { chain: 'ethereum', tokenAddress: '0xmoralis' },
      { chain: 'ethereum', tokenAddress: '0xbirdeye' },
    ]);
  });

  it('DexScreener pass dedupes the same token across all discovery feeds', async () => {
    dsMock.getLatestProfileAddresses.mockResolvedValue([
      { chain: 'ethereum', tokenAddress: '0xDupe' },
    ]);
    dsMock.getLatestBoostAddresses.mockResolvedValue([
      { chain: 'ethereum', tokenAddress: '0xdupe' },
    ]);
    dsMock.getTopBoostAddresses.mockResolvedValue([
      { chain: 'ethereum', tokenAddress: '0xDUPE' },
    ]);
    dsMock.getLatestCommunityTakeoverAddresses.mockResolvedValue([
      { chain: 'ethereum', tokenAddress: '0xdupe' },
    ]);
    dsMock.getLatestAdAddresses.mockResolvedValue([
      { chain: 'ethereum', tokenAddress: '0xdupe' },
    ]);
    moralisMock.getTrendingTokenAddresses.mockResolvedValue([
      { chain: 'ethereum', tokenAddress: '0xdupe' },
    ]);
    birdeyeMock.getVolumeTokenAddresses.mockResolvedValue([
      { chain: 'ethereum', tokenAddress: '0xdupe' },
    ]);

    await service.runCollectionCycle();

    expect(dsMock.getPairsForTokens).toHaveBeenCalledWith([
      { chain: 'ethereum', tokenAddress: '0xdupe' },
    ]);
  });

  // ── Overlapping cycle guard ───────────────────────────────────────────────

  it('skips overlapping cycles and logs a warning', async () => {
    let releaseCycle!: () => void;
    gtMock.getNewPools.mockImplementationOnce(
      () =>
        new Promise<CollectorResult[]>((resolve) => {
          releaseCycle = () => resolve([]);
        }),
    );

    // First cycle starts and pauses at the first getNewPools await
    const firstCycle = service.runCollectionCycle();

    // isCollecting is now true; a second call must skip immediately
    const warnSpy = jest.spyOn((service as any).logger, 'warn');
    await service.runCollectionCycle();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already in progress'));
    expect(gtMock.getNewPools).toHaveBeenCalledTimes(1);

    // Unblock and finish the first cycle
    releaseCycle();
    await firstCycle;

    // After the first cycle, a new cycle must run normally
    await service.runCollectionCycle();
    expect(gtMock.getNewPools).toHaveBeenCalledTimes(2);
  });

  // ── Risk engine integration ───────────────────────────────────────────────

  it('risk engine is called for each Stage-0-passing candidate', async () => {
    gtMock.getNewPools.mockResolvedValue([buildResult()]);
    await service.runCollectionCycle();

    expect(riskMock.checkToken).toHaveBeenCalledWith(
      'ethereum',
      '0xdeadbeef',
      'GEM',
      'Gem Token',
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
  });

  it('CONTRACT_SAFE — candidate is persisted and written to new_pools.csv', async () => {
    riskMock.checkToken.mockResolvedValue(SAFE_RISK);
    gtMock.getNewPools.mockResolvedValue([buildResult()]);
    await service.runCollectionCycle();

    expect(prismaMock.pool.upsert).toHaveBeenCalledTimes(1);

    const csvPath = path.join(tempDir, 'raw', 'new_pools.csv');
    expect(fs.existsSync(csvPath)).toBe(true);
  });

  it('CONTRACT_REJECT — candidate is NOT persisted and IS logged to contract_rejected_tokens.csv', async () => {
    riskMock.checkToken.mockResolvedValue(REJECT_RISK);
    gtMock.getNewPools.mockResolvedValue([buildResult()]);
    await service.runCollectionCycle();

    expect(prismaMock.pool.upsert).not.toHaveBeenCalled();

    const rejectedPath = path.join(tempDir, 'decisions', 'contract_rejected_tokens.csv');
    expect(fs.existsSync(rejectedPath)).toBe(true);

    const lines = fs.readFileSync(rejectedPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2); // header + 1 row
    expect(lines[1]).toContain('CONTRACT_REJECT');
    expect(lines[1]).toContain('honeypot_detected');
    expect(lines[1]).toContain('true'); // honeypot flag column populated
  });

  it('CONTRACT_UNKNOWN — NOT persisted as pool (goes to quarantine, not new_pools)', async () => {
    riskMock.checkToken.mockResolvedValue(UNKNOWN_RISK);
    gtMock.getNewPools.mockResolvedValue([buildResult()]);
    await service.runCollectionCycle();

    expect(prismaMock.pool.upsert).not.toHaveBeenCalled();
    expect(prismaMock.token.upsert).not.toHaveBeenCalled();
  });

  it('CONTRACT_UNKNOWN — NOT in new_pools.csv', async () => {
    riskMock.checkToken.mockResolvedValue(UNKNOWN_RISK);
    gtMock.getNewPools.mockResolvedValue([buildResult()]);
    await service.runCollectionCycle();

    const csvPath = path.join(tempDir, 'raw', 'new_pools.csv');
    expect(fs.existsSync(csvPath)).toBe(false);
  });

  it('CONTRACT_UNKNOWN — quarantine_tokens.csv created with PENDING status', async () => {
    riskMock.checkToken.mockResolvedValue(UNKNOWN_RISK);
    gtMock.getNewPools.mockResolvedValue([buildResult()]);
    await service.runCollectionCycle();

    const csvPath = path.join(tempDir, 'decisions', 'quarantine_tokens.csv');
    expect(fs.existsSync(csvPath)).toBe(true);

    const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2); // header + 1 row
    expect(lines[1]).toContain('PENDING');
    expect(lines[1]).toContain('0xdeadbeef');
  });

  it('CONTRACT_UNKNOWN with clean trade signals is written to research_candidates.csv only as WATCH_ONLY', async () => {
    riskMock.checkToken.mockResolvedValue(CLEAN_UNKNOWN_RISK);
    gtMock.getNewPools.mockResolvedValue([buildResult()]);
    await service.runCollectionCycle();

    const researchPath = path.join(tempDir, 'decisions', 'research_candidates.csv');
    expect(fs.existsSync(researchPath)).toBe(true);
    const lines = fs.readFileSync(researchPath, 'utf8').trim().split('\n');
    expect(lines[0]).toContain('NOT CONTRACT_SAFE');
    expect(lines[2]).toContain('WATCH_ONLY');
    expect(lines[2]).toContain('GOPLUS_PARTIAL');

    expect(fs.existsSync(path.join(tempDir, 'raw', 'new_pools.csv'))).toBe(false);
    expect(prismaMock.pool.upsert).not.toHaveBeenCalled();
    expect(paperMock.recordEntry).not.toHaveBeenCalled();
    expect(paperMock.recordResearchEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        riskStatus: 'GOPLUS_PARTIAL',
        researchReason: 'contract_unknown_clean_trade_signals',
      }),
    );
  });

  it('clean CONTRACT_UNKNOWN with verified liquidity is promoted into the normal survivor pipeline', async () => {
    (service as any).promoteCleanUnknownEnabled = true;
    riskMock.checkToken.mockResolvedValue(CLEAN_UNKNOWN_RISK);
    liquidityMock.verify.mockResolvedValueOnce({
      liquidityModel: 'V2',
      liquidityVerified: true,
      onchainTvlUsd: 12_345,
      reportedVsOnchainPct: 0.01,
      executableDepthUsd: 500,
      slip50: 0.01,
      slip100: 0.02,
      slip500: 0.08,
      slip1000: 0.15,
      spotPriceUsd: 0.001,
      error: null,
    });
    scoringMock.score.mockReturnValueOnce({
      finalScore: 71,
      liquidityScore: 70,
      depthScore: 65,
      ageScore: 80,
      tractionScore: 75,
      divergenceScore: 60,
      componentsPresent: ['liquidity', 'depth', 'age', 'traction', 'divergence'],
      componentsMissing: [],
      scoreConfidence: 0.5,
      band: 'candidate',
    });
    gtMock.getNewPools.mockResolvedValue([buildResult()]);

    await service.runCollectionCycle();

    const speculativePath = path.join(tempDir, 'decisions', 'speculative_candidates.csv');
    expect(fs.existsSync(speculativePath)).toBe(true);
    const lines = fs.readFileSync(speculativePath, 'utf8').trim().split('\n');
    expect(lines[0]).toContain('NOT CONTRACT_SAFE');
    expect(lines[2]).toContain('CONTRACT_UNKNOWN_LIQUIDITY_VERIFIED');
    expect(lines[2]).toContain('CONTRACT_UNKNOWN');
    expect(lines[2]).toContain('GOPLUS_PARTIAL');

    const newPoolsPath = path.join(tempDir, 'raw', 'new_pools.csv');
    expect(fs.existsSync(newPoolsPath)).toBe(true);
    expect(fs.readFileSync(newPoolsPath, 'utf8')).toContain('CONTRACT_UNKNOWN_PROMOTED_CLEAN_PARTIAL');

    expect(fs.existsSync(path.join(tempDir, 'decisions', 'candidates.csv'))).toBe(true);
    expect(prismaMock.pool.upsert).toHaveBeenCalled();
    expect(paperMock.recordEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenId: 'tok-cuid',
        poolId: 'pool-cuid',
        buyTax: 0,
      }),
    );
    expect(paperMock.recordResearchEntry).toHaveBeenCalled();
  });

  it('clean CONTRACT_UNKNOWN with verified liquidity stays speculative by default', async () => {
    riskMock.checkToken.mockResolvedValue(CLEAN_UNKNOWN_RISK);
    liquidityMock.verify.mockResolvedValueOnce({
      liquidityModel: 'V2',
      liquidityVerified: true,
      onchainTvlUsd: 12_345,
      reportedVsOnchainPct: 0.01,
      executableDepthUsd: 500,
      slip50: 0.01,
      slip100: 0.02,
      slip500: 0.08,
      slip1000: 0.15,
      spotPriceUsd: 0.001,
      error: null,
    });
    scoringMock.score.mockReturnValueOnce({
      finalScore: 71,
      liquidityScore: 70,
      depthScore: 65,
      ageScore: 80,
      tractionScore: 75,
      divergenceScore: 60,
      componentsPresent: ['liquidity', 'depth', 'age', 'traction', 'divergence'],
      componentsMissing: [],
      scoreConfidence: 0.5,
      band: 'candidate',
    });
    gtMock.getNewPools.mockResolvedValue([buildResult()]);

    await service.runCollectionCycle();

    expect(fs.existsSync(path.join(tempDir, 'decisions', 'speculative_candidates.csv'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'raw', 'new_pools.csv'))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, 'decisions', 'candidates.csv'))).toBe(false);
    expect(prismaMock.pool.upsert).not.toHaveBeenCalled();
    expect(paperMock.recordEntry).not.toHaveBeenCalled();
    expect(paperMock.recordResearchEntry).toHaveBeenCalled();
  });

  it('CONTRACT_UNKNOWN without any clean trade signal is quarantined but not research-listed', async () => {
    riskMock.checkToken.mockResolvedValue(UNKNOWN_RISK);
    gtMock.getNewPools.mockResolvedValue([buildResult()]);
    await service.runCollectionCycle();

    expect(fs.existsSync(path.join(tempDir, 'decisions', 'quarantine_tokens.csv'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'decisions', 'research_candidates.csv'))).toBe(false);
  });

  it('CONTRACT_UNKNOWN — QuarantineToken persisted to DB', async () => {
    riskMock.checkToken.mockResolvedValue(UNKNOWN_RISK);
    gtMock.getNewPools.mockResolvedValue([buildResult()]);
    await service.runCollectionCycle();

    expect(prismaMock.quarantineToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tokenAddress: '0xdeadbeef',
          status: 'PENDING',
        }),
      }),
    );
  });

  it('CONTRACT_UNKNOWN — ContractRiskCheck written to DB with null tokenId', async () => {
    riskMock.checkToken.mockResolvedValue(UNKNOWN_RISK);
    gtMock.getNewPools.mockResolvedValue([buildResult()]);
    await service.runCollectionCycle();

    expect(prismaMock.contractRiskCheck.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tokenAddress: '0xdeadbeef',
          decision: 'CONTRACT_UNKNOWN',
          tokenId: undefined, // nullable → undefined maps to null in Prisma
        }),
      }),
    );
  });

  it('CONTRACT_REJECT — NOT in new_pools.csv', async () => {
    riskMock.checkToken.mockResolvedValue(REJECT_RISK);
    gtMock.getNewPools.mockResolvedValue([buildResult()]);
    await service.runCollectionCycle();

    const csvPath = path.join(tempDir, 'raw', 'new_pools.csv');
    expect(fs.existsSync(csvPath)).toBe(false);
  });

  it('CONTRACT_REJECT — ContractRiskCheck written to DB with null tokenId and tokenAddress', async () => {
    riskMock.checkToken.mockResolvedValue(REJECT_RISK);
    gtMock.getNewPools.mockResolvedValue([buildResult()]);
    await service.runCollectionCycle();

    expect(prismaMock.contractRiskCheck.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tokenAddress: '0xdeadbeef',
          decision: 'CONTRACT_REJECT',
          tokenId: undefined, // null tokenId for hard rejects
        }),
      }),
    );
  });

  it('deployer reputation gate rejects repeat rugger even when contract risk is SAFE', async () => {
    const safeWithDeployer: ContractRiskResult = {
      ...SAFE_RISK,
      merged: { ...SAFE_RISK.merged, deployerAddress: '0xrugger' },
    };
    riskMock.checkToken.mockResolvedValue(safeWithDeployer);
    deployerReputationMock.summarize.mockResolvedValue({
      chain: 'ethereum',
      address: '0xrugger',
      deploymentsCount: 3,
      rugLikeCount: 2,
      rugRate: 2 / 3,
      riskScore: 66.67,
    });
    deployerReputationMock.isRepeatRugger.mockReturnValue(true);
    gtMock.getNewPools.mockResolvedValue([buildResult()]);

    await service.runCollectionCycle();

    expect(prismaMock.pool.upsert).not.toHaveBeenCalled();
    expect(prismaMock.contractRiskCheck.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tokenAddress: '0xdeadbeef',
          decision: 'CONTRACT_REJECT',
          rejectReason: 'deployer_repeat_rugger',
          tokenId: undefined,
        }),
      }),
    );

    const rejectedPath = path.join(tempDir, 'decisions', 'contract_rejected_tokens.csv');
    expect(fs.existsSync(rejectedPath)).toBe(true);
    const row = fs.readFileSync(rejectedPath, 'utf8').trim().split('\n')[1];
    expect(row).toContain('deployer_repeat_rugger');
  });

  it('deployer blocklist rejects before liquidity/scoring even when contract risk is SAFE', async () => {
    deployerReputationMock.findBlocklistHit.mockResolvedValue({
      chain: 'ethereum',
      address: '0xblocked',
      source: 'test',
      reason: 'manual_block',
    });
    riskMock.checkToken.mockResolvedValue({
      ...SAFE_RISK,
      merged: { ...SAFE_RISK.merged, deployerAddress: '0xBlocked' },
    });
    gtMock.getNewPools.mockResolvedValue([buildResult()]);

    await service.runCollectionCycle();

    expect(deployerReputationMock.findBlocklistHit).toHaveBeenCalledWith('ethereum', '0xblocked');
    expect(deployerReputationMock.summarize).not.toHaveBeenCalled();
    expect(prismaMock.pool.upsert).not.toHaveBeenCalled();
    expect(liquidityMock.verify).not.toHaveBeenCalled();
    expect(prismaMock.contractRiskCheck.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tokenAddress: '0xdeadbeef',
          decision: 'CONTRACT_REJECT',
          rejectReason: 'deployer_blocklisted',
          tokenId: undefined,
        }),
      }),
    );
  });

  it('same token identity does not reject when the deployer is clean', async () => {
    const candidate = buildResult({}, '0xfeed000000000000000000000000000000000001');
    candidate.token.symbol = 'openhuman';
    candidate.token.name = 'openhuman';
    riskMock.checkToken.mockResolvedValue({
      ...SAFE_RISK,
      merged: { ...SAFE_RISK.merged, deployerAddress: '0xClean' },
    });
    deployerReputationMock.summarize.mockResolvedValue(null);
    gtMock.getNewPools.mockResolvedValue([candidate]);

    await service.runCollectionCycle();

    expect(deployerReputationMock.summarize).toHaveBeenCalledWith('ethereum', '0xclean');
    expect(prismaMock.pool.upsert).toHaveBeenCalled();
    expect(prismaMock.contractRiskCheck.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tokenAddress: '0xfeed000000000000000000000000000000000001',
          decision: 'CONTRACT_SAFE',
          rejectReason: null,
          tokenId: 'tok-cuid',
        }),
      }),
    );
  });

  it('risk engine is NOT called for Stage-0-rejected candidates', async () => {
    gtMock.getNewPools.mockResolvedValue([buildResult({ liquidityUsd: 1 })]); // below floor
    await service.runCollectionCycle();

    expect(riskMock.checkToken).not.toHaveBeenCalled();
  });

  it('old token contract with a fresh pool is allowed through by default', async () => {
    tokenAgeMock.getTokenAgeDays.mockResolvedValue(30);
    riskMock.checkToken.mockResolvedValue(SAFE_RISK);
    gtMock.getNewPools.mockResolvedValue([buildResult()]);

    await service.runCollectionCycle();

    expect(riskMock.checkToken).toHaveBeenCalledWith(
      'ethereum',
      '0xdeadbeef',
      'GEM',
      'Gem Token',
      expect.any(String),
    );
    expect(prismaMock.pool.upsert).toHaveBeenCalled();

    const rejectedPath = path.join(tempDir, 'decisions', 'rejected_tokens.csv');
    if (fs.existsSync(rejectedPath)) {
      expect(fs.readFileSync(rejectedPath, 'utf8')).not.toContain('token_too_old');
    }
  });

  it('old token contract is rejected only when the token-age hard gate is explicitly enabled', async () => {
    (service as any).tokenAgeHardGateEnabled = true;
    tokenAgeMock.getTokenAgeDays.mockResolvedValue(30);
    gtMock.getNewPools.mockResolvedValue([buildResult()]);

    await service.runCollectionCycle();

    expect(riskMock.checkToken).not.toHaveBeenCalled();

    const rejectedPath = path.join(tempDir, 'decisions', 'rejected_tokens.csv');
    expect(fs.readFileSync(rejectedPath, 'utf8')).toContain('token_too_old');
  });

  it('CONTRACT_SAFE — risk check written to DB with tokenId', async () => {
    riskMock.checkToken.mockResolvedValue(SAFE_RISK);
    gtMock.getNewPools.mockResolvedValue([buildResult()]);
    await service.runCollectionCycle();

    expect(prismaMock.contractRiskCheck.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tokenId: 'tok-cuid',
          decision: 'CONTRACT_SAFE',
          goplusQueried: true,
        }),
      }),
    );
  });
});
