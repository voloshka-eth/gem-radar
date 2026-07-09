import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RiskEngineService } from './risk-engine.service';
import { GoPlusService } from './providers/goplus.service';
import { HoneypotService } from './providers/honeypot.service';
import { FileLoggerService } from '../file-logger/file-logger.service';
import { NormalizedRiskData } from './risk-engine.types';
import { RISK_REDIS_CLIENT } from './risk-engine.constants';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SAFE_DATA: NormalizedRiskData = {
  verified: true,
  honeypot: false,
  canSell: true,
  buyTax: 0,
  sellTax: 0,
  mintRisk: false,
  blacklistRisk: false,
  pauseRisk: false,
  proxyRisk: false,
  ownerRenounced: true,
  lpLockedOrBurned: true,
};

const HONEYPOT_DATA: NormalizedRiskData = {
  verified: true,
  honeypot: true,
  canSell: false,
  buyTax: 5.0,
  sellTax: 99.0,
};

const HIGH_SELL_TAX_DATA: NormalizedRiskData = {
  verified: true,
  honeypot: false,
  canSell: true,
  buyTax: 1.0,
  sellTax: 15.0,
};

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('RiskEngineService — CSV file creation', () => {
  let service: RiskEngineService;
  let module: TestingModule;
  let tempDir: string;

  const goplusMock = { checkToken: jest.fn(), supportsChain: jest.fn() };
  const honeypotMock = { checkToken: jest.fn(), supportsChain: jest.fn() };
  const redisMock = { get: jest.fn(), setex: jest.fn() };

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gem-radar-risk-test-'));

    jest.clearAllMocks();
    // Both return null by default — the parallel-fail → UNKNOWN path
    goplusMock.checkToken.mockResolvedValue(null);
    honeypotMock.checkToken.mockResolvedValue(null);
    goplusMock.supportsChain.mockReturnValue(true);
    honeypotMock.supportsChain.mockReturnValue(true);
    // Redis returns cache-miss by default
    redisMock.get.mockResolvedValue(null);
    redisMock.setex.mockResolvedValue('OK');

    module = await Test.createTestingModule({
      providers: [
        RiskEngineService,
        { provide: GoPlusService, useValue: goplusMock },
        { provide: HoneypotService, useValue: honeypotMock },
        { provide: RISK_REDIS_CLIENT, useValue: redisMock },
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
      ],
    }).compile();

    service = module.get<RiskEngineService>(RiskEngineService);
  });

  afterEach(async () => {
    await module.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ── contract_risk_checks.csv — CONTRACT_SAFE ─────────────────────────────────

  it('CONTRACT_SAFE — contract_risk_checks.csv is created', async () => {
    goplusMock.checkToken.mockResolvedValue(SAFE_DATA);

    await service.checkToken('ethereum', '0xdeadbeef', 'GEM', 'Gem Token', 'run-safe-1');

    const csvPath = path.join(tempDir, 'raw', 'contract_risk_checks.csv');
    expect(fs.existsSync(csvPath)).toBe(true);
  });

  it('CONTRACT_SAFE — CSV contains correct header columns', async () => {
    goplusMock.checkToken.mockResolvedValue(SAFE_DATA);

    await service.checkToken('ethereum', '0xdeadbeef', 'GEM', 'Gem Token', 'run-safe-2');

    const csvPath = path.join(tempDir, 'raw', 'contract_risk_checks.csv');
    const header = fs.readFileSync(csvPath, 'utf8').trim().split('\n')[0];

    expect(header).toContain('token_address');
    expect(header).toContain('decision');
    expect(header).toContain('goplus_queried');
    expect(header).toContain('honeypot_queried');
    expect(header).toContain('reject_reasons');
    expect(header).toContain('risk_status');
    expect(header).toContain('hard_reject');
  });

  it('CONTRACT_SAFE — data row contains token address, decision, and queried flags', async () => {
    goplusMock.checkToken.mockResolvedValue(SAFE_DATA);
    honeypotMock.checkToken.mockResolvedValue({ honeypot: false, buyTax: 0, sellTax: 0 });

    await service.checkToken('ethereum', '0xdeadbeef', 'GEM', 'Gem Token', 'run-safe-3');

    const csvPath = path.join(tempDir, 'raw', 'contract_risk_checks.csv');
    const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2); // header + 1 row
    expect(lines[1]).toContain('0xdeadbeef');
    expect(lines[1]).toContain('CONTRACT_SAFE');
    expect(lines[1]).toContain('Gem Token');
  });

  it('CONTRACT_SAFE — run_id is written to the data row', async () => {
    goplusMock.checkToken.mockResolvedValue(SAFE_DATA);

    const runId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    await service.checkToken('ethereum', '0xtoken', 'TK', 'Token', runId);

    const csvPath = path.join(tempDir, 'raw', 'contract_risk_checks.csv');
    const dataRow = fs.readFileSync(csvPath, 'utf8').trim().split('\n')[1];
    expect(dataRow).toContain(runId);
  });

  // ── contract_risk_checks.csv — CONTRACT_REJECT ───────────────────────────────

  it('CONTRACT_REJECT — contract_risk_checks.csv is created', async () => {
    goplusMock.checkToken.mockResolvedValue(HONEYPOT_DATA);

    await service.checkToken('base', '0xhoneypot', 'SCAM', 'Scam Token', 'run-reject-1');

    const csvPath = path.join(tempDir, 'raw', 'contract_risk_checks.csv');
    expect(fs.existsSync(csvPath)).toBe(true);
  });

  it('CONTRACT_REJECT — CSV row contains rejection decision and reason codes', async () => {
    goplusMock.checkToken.mockResolvedValue(HONEYPOT_DATA);

    await service.checkToken('base', '0xhoneypot', 'SCAM', 'Scam Token', 'run-reject-2');

    const csvPath = path.join(tempDir, 'raw', 'contract_risk_checks.csv');
    const dataRow = fs.readFileSync(csvPath, 'utf8').trim().split('\n')[1];

    expect(dataRow).toContain('CONTRACT_REJECT');
    expect(dataRow).toContain('honeypot_detected');
  });

  it('CONTRACT_REJECT — hard_reject column is true', async () => {
    goplusMock.checkToken.mockResolvedValue(HONEYPOT_DATA);

    await service.checkToken('base', '0xhoneypot', 'SCAM', 'Scam Token', 'run-reject-3');

    const csvPath = path.join(tempDir, 'raw', 'contract_risk_checks.csv');
    const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
    expect(lines[1]).toContain('true');
  });

  it('CONTRACT_REJECT — high sell tax generates correct reason code', async () => {
    goplusMock.checkToken.mockResolvedValue(HIGH_SELL_TAX_DATA);

    await service.checkToken('ethereum', '0xtax', 'TAX', 'Tax Token', 'run-reject-4');

    const csvPath = path.join(tempDir, 'raw', 'contract_risk_checks.csv');
    const dataRow = fs.readFileSync(csvPath, 'utf8').trim().split('\n')[1];
    expect(dataRow).toContain('CONTRACT_REJECT');
    expect(dataRow).toContain('sell_tax_');
  });

  // ── contract_risk_checks.csv — CONTRACT_UNKNOWN ──────────────────────────────

  it('CONTRACT_UNKNOWN — contract_risk_checks.csv is created when both providers fail', async () => {
    // Both already return null (default)
    await service.checkToken('ethereum', '0xunknown', 'UNK', 'Unknown Token', 'run-unk-1');

    const csvPath = path.join(tempDir, 'raw', 'contract_risk_checks.csv');
    expect(fs.existsSync(csvPath)).toBe(true);
  });

  it('CONTRACT_UNKNOWN — CSV row contains UNKNOWN decision and goplus_queried=false', async () => {
    await service.checkToken('ethereum', '0xunknown', 'UNK', 'Unknown Token', 'run-unk-2');

    const csvPath = path.join(tempDir, 'raw', 'contract_risk_checks.csv');
    const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('CONTRACT_UNKNOWN');
    expect(lines[1]).toContain('false'); // goplusQueried and honeypotQueried both false
  });

  // ── Parallel provider calls ───────────────────────────────────────────────────

  it('both GoPlus and Honeypot.is are called in parallel', async () => {
    goplusMock.checkToken.mockResolvedValue(SAFE_DATA);
    honeypotMock.checkToken.mockResolvedValue({ honeypot: false });

    await service.checkToken('ethereum', '0xtoken', 'TK', 'Token', 'run-parallel-1');

    expect(goplusMock.checkToken).toHaveBeenCalledTimes(1);
    expect(honeypotMock.checkToken).toHaveBeenCalledTimes(1);
  });

  it('GoPlus fails, Honeypot.is returns clean → CONTRACT_UNKNOWN (cannot confirm SAFE without GoPlus signals)', async () => {
    goplusMock.checkToken.mockResolvedValue(null);
    honeypotMock.checkToken.mockResolvedValue({ honeypot: false, canSell: undefined });

    const result = await service.checkToken('ethereum', '0xtoken', 'TK', 'Token', 'run-parallel-2');

    // Honeypot.is "clean" is insufficient — mint/blacklist/proxy/etc. are unknown
    expect(result.decision).toBe('CONTRACT_UNKNOWN');
    expect(result.honeypotQueried).toBe(true);
    expect(result.goplusQueried).toBe(false);
  });

  it('GoPlus parse failure with empty critical fields -> CONTRACT_UNKNOWN, not SAFE', async () => {
    goplusMock.checkToken.mockResolvedValue({ providerStatus: 'GOPLUS_PARSE_FAILED' });
    honeypotMock.checkToken.mockResolvedValue({ honeypot: false, canSell: undefined });

    const result = await service.checkToken('base', '0xpartial', 'PART', 'Partial Token', 'run-goplus-partial');

    expect(result.decision).toBe('CONTRACT_UNKNOWN');
    expect(result.goplusQueried).toBe(true);
    expect(result.honeypotQueried).toBe(true);
    expect(result.providerStatus).toBe('GOPLUS_PARSE_FAILED');
    expect(redisMock.setex).not.toHaveBeenCalled();
  });

  it('GoPlus partial clean payload with all critical fields -> CONTRACT_SAFE with partial status', async () => {
    goplusMock.checkToken.mockResolvedValue({
      providerStatus: 'GOPLUS_PARTIAL',
      honeypot: false,
      mintRisk: false,
      blacklistRisk: false,
      proxyRisk: false,
    });
    honeypotMock.checkToken.mockResolvedValue({ honeypot: false, canSell: undefined });

    const result = await service.checkToken('base', '0xpartial2', 'PART2', 'Partial Token 2', 'run-goplus-partial2');

    expect(result.decision).toBe('CONTRACT_SAFE');
    expect(result.providerStatus).toBe('GOPLUS_PARTIAL');
    expect(redisMock.setex).toHaveBeenCalled();
  });

  it('GoPlus partial payload missing a critical field stays CONTRACT_UNKNOWN', async () => {
    goplusMock.checkToken.mockResolvedValue({
      providerStatus: 'GOPLUS_PARTIAL',
      honeypot: false,
      mintRisk: false,
      blacklistRisk: false,
      // proxyRisk missing -> not enough to pass the contract gate.
    });
    honeypotMock.checkToken.mockResolvedValue({ honeypot: false });

    const result = await service.checkToken('base', '0xpartialmissing', 'PM', 'Partial Missing', 'run-goplus-partial-missing');

    expect(result.decision).toBe('CONTRACT_UNKNOWN');
    expect(result.providerStatus).toBe('GOPLUS_PARTIAL');
    expect(redisMock.setex).not.toHaveBeenCalled();
  });

  it('GoPlus trade-only partial without critical fields stays UNKNOWN, not SAFE', async () => {
    goplusMock.checkToken.mockResolvedValue({
      providerStatus: 'GOPLUS_TRADE_ONLY_PARTIAL',
      buyTax: 0,
      sellTax: 0,
      deployerAddress: '0xdeployer',
    });
    honeypotMock.checkToken.mockResolvedValue({ honeypot: false, canSell: undefined });

    const result = await service.checkToken('base', '0xtradepartial', 'TP', 'Trade Partial', 'run-goplus-trade-partial');

    expect(result.decision).toBe('CONTRACT_UNKNOWN');
    expect(result.providerStatus).toBe('GOPLUS_TRADE_ONLY_PARTIAL');
    expect(result.merged.providerStatus).toBe('GOPLUS_TRADE_ONLY_PARTIAL');
    expect(redisMock.setex).not.toHaveBeenCalled();

    const csvPath = path.join(tempDir, 'raw', 'contract_risk_checks.csv');
    const dataRow = fs.readFileSync(csvPath, 'utf8').trim().split('\n')[1];
    expect(dataRow).toContain('GOPLUS_TRADE_ONLY_PARTIAL');
    expect(dataRow).not.toContain('GOPLUS_PARSE_FAILED');
  });

  it('GoPlus trade-only partial with positive tax can reject while preserving GOPLUS_PARTIAL status', async () => {
    goplusMock.checkToken.mockResolvedValue({
      providerStatus: 'GOPLUS_PARTIAL',
      sellTax: 24.3,
    });
    honeypotMock.checkToken.mockResolvedValue({ honeypot: false, canSell: undefined });

    const result = await service.checkToken('ethereum', '0xtaxpartial', 'TAXP', 'Tax Partial', 'run-goplus-tax-partial');

    expect(result.decision).toBe('CONTRACT_REJECT');
    expect(result.providerStatus).toBe('GOPLUS_PARTIAL');
    expect(result.rejectReasons).toContain('sell_tax_24.3pct');
  });

  it('GoPlus fails, Honeypot.is finds honeypot → CONTRACT_REJECT (valid even without GoPlus)', async () => {
    goplusMock.checkToken.mockResolvedValue(null);
    honeypotMock.checkToken.mockResolvedValue({ honeypot: true, canSell: false });

    const result = await service.checkToken('ethereum', '0xhp', 'HP', 'Honeypot', 'run-parallel-hp');

    expect(result.decision).toBe('CONTRACT_REJECT');
    expect(result.rejectReasons).toContain('honeypot_detected');
    expect(result.goplusQueried).toBe(false);
    expect(result.honeypotQueried).toBe(true);
  });

  it('both providers fail → CONTRACT_UNKNOWN', async () => {
    // Both already null by default
    const result = await service.checkToken('ethereum', '0xtoken', 'TK', 'Token', 'run-parallel-3');

    expect(result.decision).toBe('CONTRACT_UNKNOWN');
    expect(result.goplusQueried).toBe(false);
    expect(result.honeypotQueried).toBe(false);
  });

  // ── Redis cache ───────────────────────────────────────────────────────────────

  it('cache hit — providers are NOT called when Redis returns cached JSON', async () => {
    const cachedResult = {
      decision: 'CONTRACT_SAFE',
      rejectReasons: [],
      goplusQueried: true,
      honeypotQueried: false,
      merged: { honeypot: false },
    };
    redisMock.get.mockResolvedValue(JSON.stringify(cachedResult));

    const result = await service.checkToken('ethereum', '0xcached', 'C', 'Cached', 'run-cache-1');

    expect(result.decision).toBe('CONTRACT_SAFE');
    expect(goplusMock.checkToken).not.toHaveBeenCalled();
    expect(honeypotMock.checkToken).not.toHaveBeenCalled();
  });

  it('cache miss — result is stored in Redis after providers are called', async () => {
    goplusMock.checkToken.mockResolvedValue(SAFE_DATA);

    await service.checkToken('ethereum', '0xnewtoken', 'N', 'New', 'run-cache-2');

    expect(redisMock.setex).toHaveBeenCalledWith(
      expect.stringContaining('0xnewtoken'),
      expect.any(Number),
      expect.any(String),
    );
  });

  it('cache key is chain-scoped with current version prefix: risk:v4:chain:address', async () => {
    goplusMock.checkToken.mockResolvedValue(SAFE_DATA);

    await service.checkToken('base', '0xtokenb', 'B', 'Base Token', 'run-cache-3');

    expect(redisMock.get).toHaveBeenCalledWith(
      expect.stringMatching(/^risk:v4:base:/),
    );
  });

  it('CONTRACT_UNKNOWN — NOT cached in Redis (transient outage must not lock out re-checks)', async () => {
    // both providers already return null by default → both fail → UNKNOWN
    const result = await service.checkToken('ethereum', '0xunk', 'U', 'Unk', 'run-unk-nocache');

    expect(result.decision).toBe('CONTRACT_UNKNOWN');
    expect(redisMock.setex).not.toHaveBeenCalled();
  });

  it('Honeypot-only UNKNOWN — NOT cached in Redis', async () => {
    goplusMock.checkToken.mockResolvedValue(null);
    honeypotMock.checkToken.mockResolvedValue({ honeypot: false });

    const result = await service.checkToken('ethereum', '0xhpunk', 'H', 'HP Unk', 'run-hpunk-nocache');

    expect(result.decision).toBe('CONTRACT_UNKNOWN');
    expect(redisMock.setex).not.toHaveBeenCalled();
  });

  it('Honeypot-only REJECT — IS cached in Redis', async () => {
    goplusMock.checkToken.mockResolvedValue(null);
    honeypotMock.checkToken.mockResolvedValue({ honeypot: true, canSell: false });

    const result = await service.checkToken('ethereum', '0xhprej', 'H', 'HP Rej', 'run-hprej-cache');

    expect(result.decision).toBe('CONTRACT_REJECT');
    expect(redisMock.setex).toHaveBeenCalledTimes(1);
  });

  it('Redis error during get is swallowed — providers are still called', async () => {
    redisMock.get.mockRejectedValue(new Error('Redis connection refused'));
    goplusMock.checkToken.mockResolvedValue(SAFE_DATA);

    const result = await service.checkToken('ethereum', '0xerr', 'E', 'Err Token', 'run-cache-4');

    expect(result).toBeDefined();
    expect(goplusMock.checkToken).toHaveBeenCalledTimes(1);
  });

  // ── Multi-row appending ───────────────────────────────────────────────────────

  it('multiple checks append rows — header written exactly once', async () => {
    goplusMock.checkToken
      .mockResolvedValueOnce(SAFE_DATA)
      .mockResolvedValueOnce(HONEYPOT_DATA)
      .mockResolvedValueOnce(null);
    honeypotMock.checkToken
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await service.checkToken('ethereum', '0xtoken1', 'TK1', 'Token 1', 'run-multi');
    await service.checkToken('ethereum', '0xtoken2', 'TK2', 'Token 2', 'run-multi');
    await service.checkToken('ethereum', '0xtoken3', 'TK3', 'Token 3', 'run-multi');

    const csvPath = path.join(tempDir, 'raw', 'contract_risk_checks.csv');
    const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(4); // header + 3 data rows

    expect(lines[0].startsWith('ts,')).toBe(true);
    expect(lines[1].startsWith('ts,')).toBe(false);
    expect(lines[2].startsWith('ts,')).toBe(false);
    expect(lines[3].startsWith('ts,')).toBe(false);

    expect(lines[1]).toContain('CONTRACT_SAFE');
    expect(lines[2]).toContain('CONTRACT_REJECT');
    expect(lines[3]).toContain('CONTRACT_UNKNOWN');
  });
});
