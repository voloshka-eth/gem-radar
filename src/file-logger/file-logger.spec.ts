import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FileLoggerService, escapeCsvField, formatLogTimestamp } from './file-logger.service';
import { CSV_SCHEMA_VERSION, NewPoolRow, RejectedTokenRow } from './csv-schemas';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildConfigService(logDir: string): Partial<ConfigService> {
  return {
    get: jest.fn((key: string) => {
      if (key === 'app.logDir') return logDir;
      return undefined;
    }) as ConfigService['get'],
  };
}

function buildNewPoolRow(overrides: Partial<NewPoolRow> = {}): NewPoolRow {
  return {
    ts: '2024-01-15T10:30:00.000Z',
    run_id: 'run-abc-123',
    schema_version: CSV_SCHEMA_VERSION,
    chain: 'ethereum',
    token_address: '0xdeadbeef',
    token_symbol: 'GEM',
    token_name: 'Gem Token',
    pool_address: '0xpool1',
    dex: 'uniswap_v3',
    quote_asset: 'WETH',
    price_usd: '0.001',
    liquidity_usd: '50000',
    fdv_usd: '1000000',
    vol_5m: '500',
    vol_1h: '3000',
    vol_6h: '15000',
    vol_24h: '45000',
    buys_1h: '40',
    sells_1h: '20',
    pool_created_at: '2024-01-15T09:00:00.000Z',
    source: 'geckoterminal',
    risk_decision: 'CONTRACT_SAFE',
    ...overrides,
  };
}

function buildRejectedTokenRow(overrides: Partial<RejectedTokenRow> = {}): RejectedTokenRow {
  return {
    ts: '2024-01-15T10:30:00.000Z',
    run_id: 'run-abc-123',
    schema_version: CSV_SCHEMA_VERSION,
    chain: 'ethereum',
    token_address: '0xdeadbeef',
    token_symbol: 'SCAM',
    token_name: 'Scam Token',
    pool_address: '0xpool2',
    dex: 'uniswap_v3',
    quote_asset: 'WETH',
    price_usd: '0.0001',
    liquidity_usd: '2000',
    fdv_usd: '500000',
    vol_5m: '100',
    vol_1h: '500',
    vol_6h: '2000',
    vol_24h: '6000',
    buys_1h: '5',
    sells_1h: '3',
    tx_count_1h: '8',
    pool_created_at: '2024-01-15T09:00:00.000Z',
    pool_age_minutes: '90',
    stage: 'stage0',
    reason: 'liquidity_too_low',
    source: 'geckoterminal',
    liquidity_trust_level: 'REPORTED_ONLY',
    onchain_verified: 'false',
    ...overrides,
  };
}

function readLines(fullPath: string): string[] {
  return fs.readFileSync(fullPath, 'utf8').trim().split('\n');
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('FileLoggerService', () => {
  let service: FileLoggerService;
  let tempDir: string;
  let module: TestingModule;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gem-radar-test-'));

    module = await Test.createTestingModule({
      providers: [
        FileLoggerService,
        { provide: ConfigService, useValue: buildConfigService(tempDir) },
      ],
    }).compile();

    service = module.get<FileLoggerService>(FileLoggerService);
    service.onModuleInit(); // create log subdirectories
  });

  afterEach(async () => {
    await module.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ── CSV header correctness ────────────────────────────────────────────────

  it('writes CSV header on first write when file does not exist', () => {
    service.logNewPool(buildNewPoolRow());

    const csvPath = path.join(tempDir, 'raw', 'new_pools.csv');
    expect(fs.existsSync(csvPath)).toBe(true);

    const lines = readLines(csvPath);
    expect(lines).toHaveLength(2); // header + 1 data row
    expect(lines[0]).toBe(
      'ts,run_id,schema_version,chain,token_address,token_symbol,token_name,' +
      'pool_address,dex,quote_asset,price_usd,liquidity_usd,fdv_usd,' +
      'vol_5m,vol_1h,vol_6h,vol_24h,buys_1h,sells_1h,pool_created_at,source,risk_decision',
    );
  });

  it('does NOT duplicate the header on second write', () => {
    const row = buildNewPoolRow();
    service.logNewPool(row);
    service.logNewPool({ ...row, pool_address: '0xpool2', token_address: '0xtoken2' });

    const lines = readLines(path.join(tempDir, 'raw', 'new_pools.csv'));
    expect(lines).toHaveLength(3); // header + 2 data rows

    // Only the first line is a header — data rows must NOT start with 'ts'
    expect(lines[0].startsWith('ts,')).toBe(true);
    expect(lines[1].startsWith('ts,')).toBe(false);
    expect(lines[2].startsWith('ts,')).toBe(false);
  });

  it('header is NOT rewritten after a service restart (file already exists)', () => {
    // Simulate first run
    service.logNewPool(buildNewPoolRow());

    // Simulate restart: create a new service instance pointing at the same dir
    const service2 = new FileLoggerService(buildConfigService(tempDir) as ConfigService);
    service2.onModuleInit();
    service2.logNewPool(buildNewPoolRow({ pool_address: '0xpool3' }));

    const lines = readLines(path.join(tempDir, 'raw', 'new_pools.csv'));
    // Still exactly 1 header + 2 data rows, no second header injected
    expect(lines).toHaveLength(3);
    expect(lines[0].startsWith('ts,')).toBe(true);
    expect(lines[1].startsWith('ts,')).toBe(false);
    expect(lines[2].startsWith('ts,')).toBe(false);
  });

  it('does not reread a growing CSV after its header was validated', () => {
    const csvPath = path.join(tempDir, 'raw', 'new_pools.csv');
    fs.writeFileSync(csvPath, `ts,run_id,schema_version,chain,token_address,token_symbol,token_name,pool_address,dex,quote_asset,price_usd,liquidity_usd,fdv_usd,vol_5m,vol_1h,vol_6h,vol_24h,buys_1h,sells_1h,pool_created_at,source,risk_decision\n${'x'.repeat(1024 * 1024)}\n`);
    const readSpy = jest.spyOn(fs, 'readFileSync');

    service.logNewPool(buildNewPoolRow({ token_address: '0xone' }));
    service.logNewPool(buildNewPoolRow({ token_address: '0xtwo' }));

    expect(readSpy).not.toHaveBeenCalledWith(csvPath, 'utf8');
    readSpy.mockRestore();
  });

  // ── Timestamp format ─────────────────────────────────────────────────────

  it('renders UTC timestamps in Warsaw time with an explicit offset', () => {
    expect(formatLogTimestamp('2026-08-04T14:39:01.362Z')).toBe('2026-08-04T16:39:01.362+02:00');
    expect(formatLogTimestamp('2026-01-04T14:39:01.362Z')).toBe('2026-01-04T15:39:01.362+01:00');
  });

  it('writes timestamp columns in Warsaw time', () => {
    const ts = '2024-06-17T12:00:00.000Z';
    service.logNewPool(buildNewPoolRow({ ts }));

    const lines = readLines(path.join(tempDir, 'raw', 'new_pools.csv'));
    // First field of first data row is the timestamp
    expect(lines[1].startsWith('2024-06-17T14:00:00.000+02:00,')).toBe(true);
  });

  // ── schema_version in every row ──────────────────────────────────────────

  it('embeds schema_version in every data row', () => {
    service.logNewPool(buildNewPoolRow());
    const lines = readLines(path.join(tempDir, 'raw', 'new_pools.csv'));
    expect(lines[1]).toContain(CSV_SCHEMA_VERSION);
  });

  // ── Rejected token row contains full candidate metrics ────────────────────

  it('rejected token CSV contains all required candidate fields', () => {
    const row = buildRejectedTokenRow({
      liquidity_usd: '2000',
      fdv_usd: '500000',
      reason: 'liquidity_too_low',
      pool_age_minutes: '90',
      vol_1h: '500',
      buys_1h: '5',
      sells_1h: '3',
      tx_count_1h: '8',
      liquidity_trust_level: 'REPORTED_ONLY',
      onchain_verified: 'false',
    });
    service.logRejectedToken(row);

    const lines = readLines(path.join(tempDir, 'decisions', 'rejected_tokens.csv'));
    const dataRow = lines[1];

    expect(dataRow).toContain('2000');
    expect(dataRow).toContain('500000');
    expect(dataRow).toContain('liquidity_too_low');
    expect(dataRow).toContain('90');
    expect(dataRow).toContain('REPORTED_ONLY');
    expect(dataRow).toContain('false');
  });

  it('rejected token header contains pool_age_minutes and liquidity_trust_level columns', () => {
    service.logRejectedToken(buildRejectedTokenRow());
    const lines = readLines(path.join(tempDir, 'decisions', 'rejected_tokens.csv'));
    expect(lines[0]).toContain('pool_age_minutes');
    expect(lines[0]).toContain('liquidity_trust_level');
    expect(lines[0]).toContain('onchain_verified');
  });

  // ── CSV escaping ─────────────────────────────────────────────────────────

  it('escapeCsvField wraps value containing comma in double-quotes', () => {
    expect(escapeCsvField('hello, world')).toBe('"hello, world"');
  });

  it('escapeCsvField escapes embedded double-quotes per RFC 4180', () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('escapeCsvField leaves plain strings unmodified', () => {
    expect(escapeCsvField('plain')).toBe('plain');
    expect(escapeCsvField(42)).toBe('42');
  });

  it('escapeCsvField coerces null and undefined to empty string', () => {
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
  });

  // ── JSONL log ────────────────────────────────────────────────────────────

  it('logRawPayload appends valid JSON lines to source_payloads.jsonl', () => {
    service.logRawPayload({ run_id: 'r1', source: 'geckoterminal', pool_count: 10 });
    service.logRawPayload({ run_id: 'r1', source: 'dexscreener', pool_count: 5 });

    const fullPath = path.join(tempDir, 'raw', 'source_payloads.jsonl');
    const lines = fs.readFileSync(fullPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ run_id: 'r1', source: 'geckoterminal' });
    expect(JSON.parse(lines[1])).toMatchObject({ source: 'dexscreener', pool_count: 5 });
  });

  it('rotates a previous-day raw payload log into gzip before appending today', () => {
    const fullPath = path.join(tempDir, 'raw', 'source_payloads.jsonl');
    fs.writeFileSync(fullPath, '{"old":true}\n');
    const yesterday = new Date(Date.now() - 86_400_000);
    fs.utimesSync(fullPath, yesterday, yesterday);

    service.logRawPayload({ run_id: 'today', source: 'dexscreener' });

    const archiveRoot = path.join(tempDir, 'archive', 'raw-logs');
    const archiveDay = fs.readdirSync(archiveRoot)[0];
    const archives = fs.readdirSync(path.join(archiveRoot, archiveDay));
    expect(archives).toContain('source_payloads.jsonl.gz');
    expect(fs.readFileSync(fullPath, 'utf8')).toContain('today');
  });

  it('archives the active raw session on an explicit maintenance request', () => {
    const fullPath = path.join(tempDir, 'raw', 'source_payloads.jsonl');
    fs.writeFileSync(fullPath, '{"current":true}\n');

    expect(service.archiveActiveRawLogs()).toBe(1);
    expect(fs.existsSync(fullPath)).toBe(false);
  });
});
