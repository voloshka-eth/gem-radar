import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { SniperJournalRecord } from './sniper.types';

@Injectable()
export class SniperJournalService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SniperJournalService.name);
  private readonly directory: string;
  private readonly journalPath: string;
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly entryHeaders = [
    'ts', 'chain', 'token_address', 'symbol', 'pool_address', 'liquidity_model',
    'first_seen_at', 'detection_delay_sec', 'opened_at', 'size_bnb', 'spot_price_bnb',
    'entry_price_effective_bnb', 'slippage_pct', 'protocol_fee_pct', 'tokens_bought',
    'entered', 'not_entered_reason', 'deployer_address', 'discovery_source', 'strategy_version',
  ];
  private readonly exitHeaders = [
    'ts', 'chain', 'token_address', 'symbol', 'pool_address', 'event_type', 'status',
    'price_bnb', 'multiple', 'fraction', 'tokens', 'net_bnb', 'slip_pct',
    'realized_multiple_total', 'note', 'deployer_address', 'outcome_class', 'strategy_version',
  ];
  private readonly watchHeaders = [
    'ts', 'strategy_version', 'event_type', 'token_address', 'symbol', 'creator_address',
    'reason', 'reasons', 'age_sec', 'buys', 'sells', 'unique_buyers', 'buy_quote_bnb',
    'sell_quote_bnb', 'buy_sell_ratio', 'price_momentum', 'creator_sold',
  ];
  private lockFd: number | null = null;

  constructor(config: ConfigService) {
    const logDir = config.get<string>('app.logDir') ?? './logs';
    this.directory = path.join(logDir, 'sniper');
    this.journalPath = path.join(this.directory, 'paper_journal.ndjson');
    this.statePath = path.join(this.directory, 'state.json');
    this.lockPath = path.join(this.directory, 'watcher.lock');
  }

  onModuleInit(): void {
    this.ensureProcessLock();
  }

  ensureProcessLock(): void {
    if (this.lockFd != null) return;
    fs.mkdirSync(this.directory, { recursive: true });
    this.ensureCsvExports();
    this.acquireProcessLock();
  }

  onModuleDestroy(): void {
    if (this.lockFd != null) {
      fs.closeSync(this.lockFd);
      this.lockFd = null;
    }
    try {
      if (fs.existsSync(this.lockPath) && fs.readFileSync(this.lockPath, 'utf8').trim() === String(process.pid)) {
        fs.unlinkSync(this.lockPath);
      }
    } catch (error) {
      this.logger.warn(`Sniper process lock cleanup failed: ${(error as Error).message}`);
    }
  }

  append(record: SniperJournalRecord): void {
    try {
      fs.appendFileSync(this.journalPath, `${JSON.stringify(record)}\n`, 'utf8');
      this.appendCsvExports(record);
    } catch (error) {
      this.logger.error(`Sniper journal write failed: ${(error as Error).message}`);
    }
  }

  readState<T>(): T | null {
    if (!fs.existsSync(this.statePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as T;
    } catch (error) {
      this.logger.error(`Sniper state restore failed: ${(error as Error).message}`);
      return null;
    }
  }

  writeState(state: unknown): void {
    const temporaryPath = `${this.statePath}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(temporaryPath, this.statePath);
    } catch (error) {
      this.logger.error(`Sniper state write failed: ${(error as Error).message}`);
      try {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      } catch {
        // Best effort cleanup only.
      }
    }
  }

  private acquireProcessLock(): void {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.lockFd = fs.openSync(this.lockPath, 'wx');
        fs.writeFileSync(this.lockFd, String(process.pid), 'utf8');
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existingPid = this.readLockPid();
        if (existingPid != null && isProcessAlive(existingPid)) {
          throw new Error(
            `Another launch sniper is already running (pid=${existingPid}). ` +
            'Stop it before starting a second watcher.',
          );
        }
        fs.unlinkSync(this.lockPath);
      }
    }
    throw new Error('Unable to acquire launch sniper process lock');
  }

  private ensureCsvExports(): void {
    const missing = new Set<string>();
    const schemas: Array<[string, string[]]> = [
      ['paper_entries.csv', this.entryHeaders],
      ['paper_exits.csv', this.exitHeaders],
      ['watch_events.csv', this.watchHeaders],
    ];
    for (const [filename, headers] of schemas) {
      const csvPath = path.join(this.directory, filename);
      if (!fs.existsSync(csvPath) || fs.readFileSync(csvPath, 'utf8').split(/\r?\n/, 1)[0] !== headers.join(',')) {
        missing.add(filename);
      }
    }
    if (missing.size === 0 || !fs.existsSync(this.journalPath)) return;

    try {
      for (const filename of missing) fs.writeFileSync(path.join(this.directory, filename), '', 'utf8');
      const records = fs.readFileSync(this.journalPath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as SniperJournalRecord];
          } catch {
            return [];
          }
        });
      for (const record of records) this.appendCsvExports(record, missing);
    } catch (error) {
      this.logger.warn(`Sniper CSV history export failed: ${(error as Error).message}`);
    }
  }

  private appendCsvExports(record: SniperJournalRecord, only?: Set<string>): void {
    const type = record.type;
    if (type === 'ENTER' && (!only || only.has('paper_entries.csv'))) {
      this.appendCsv('paper_entries.csv', this.entryHeaders, {
        ts: record.ts,
        chain: record.chain,
        token_address: record.token,
        symbol: record.symbol,
        pool_address: '',
        liquidity_model: 'four_meme_bonding_curve',
        first_seen_at: record.firstSeenAt,
        detection_delay_sec: record.detectionDelaySec,
        opened_at: isoTimestamp(record.occurredAtMs, record.ts),
        size_bnb: record.positionSizeQuote,
        spot_price_bnb: record.entryMarketPrice ?? record.priceQuotePerToken,
        entry_price_effective_bnb: record.entryEffectivePrice,
        slippage_pct: record.entrySlippagePct,
        protocol_fee_pct: record.protocolFeePct,
        tokens_bought: record.tokensBought,
        entered: 'true',
        not_entered_reason: '',
        deployer_address: record.creator,
        discovery_source: 'four_meme_token_manager2',
        strategy_version: record.strategyVersion,
      });
      return;
    }
    if (
      ['LADDER_EXIT', 'STOP_EXIT', 'MOMENTUM_EXIT', 'TIME_EXIT', 'TRADE_STOP_EXIT', 'CREATOR_EXIT'].includes(type) &&
      (!only || only.has('paper_exits.csv'))
    ) {
      this.appendCsv('paper_exits.csv', this.exitHeaders, {
        ts: record.ts,
        chain: record.chain,
        token_address: record.token,
        symbol: record.symbol,
        pool_address: '',
        event_type: type,
        status: exitStatus(type),
        price_bnb: record.priceQuotePerToken,
        multiple: record.netMultiple,
        fraction: record.fraction,
        tokens: '',
        net_bnb: record.quoteValue,
        slip_pct: record.exitSlippagePct,
        realized_multiple_total: record.realizedMultiple,
        note: record.note,
        deployer_address: record.creator,
        outcome_class: outcomeClass(record),
        strategy_version: record.strategyVersion,
      });
      return;
    }
    if (
      ['HOT_WATCH_STARTED', 'HOT_WATCH_REPLAYED_TRADES', 'ENTRY_REJECTED', 'SAFETY_DEFERRED', 'HOT_WATCH_EXPIRED'].includes(type) &&
      (!only || only.has('watch_events.csv'))
    ) {
      this.appendCsv('watch_events.csv', this.watchHeaders, {
        ts: record.ts,
        strategy_version: record.strategyVersion,
        event_type: type,
        token_address: record.token,
        symbol: record.symbol,
        creator_address: record.creator,
        reason: record.reason,
        reasons: Array.isArray(record.reasons) ? record.reasons.join(';') : '',
        age_sec: feature(record, 'ageSec'),
        buys: feature(record, 'buys'),
        sells: feature(record, 'sells'),
        unique_buyers: feature(record, 'uniqueBuyers'),
        buy_quote_bnb: feature(record, 'buyQuote'),
        sell_quote_bnb: feature(record, 'sellQuote'),
        buy_sell_ratio: feature(record, 'buySellRatio'),
        price_momentum: feature(record, 'priceMomentum'),
        creator_sold: feature(record, 'creatorSold'),
      });
    }
  }

  private appendCsv(filename: string, headers: string[], row: Record<string, unknown>): void {
    const csvPath = path.join(this.directory, filename);
    const prefix = !fs.existsSync(csvPath) || fs.statSync(csvPath).size === 0 ? `${headers.join(',')}\n` : '';
    const values = headers.map((header) => escapeCsv(row[header])).join(',');
    fs.appendFileSync(csvPath, `${prefix}${values}\n`, 'utf8');
  }

  private readLockPid(): number | null {
    try {
      const value = Number(fs.readFileSync(this.lockPath, 'utf8').trim());
      return Number.isInteger(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }
}

function feature(record: SniperJournalRecord, key: string): unknown {
  const features = record.features;
  if (!features || typeof features !== 'object') return '';
  return (features as Record<string, unknown>)[key] ?? '';
}

function escapeCsv(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function isoTimestamp(value: unknown, fallback: string): string {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

function exitStatus(type: string): string {
  return type === 'LADDER_EXIT' ? 'alive' : 'closed';
}

function outcomeClass(record: SniperJournalRecord): string {
  const realizedMultiple = Number(record.realizedMultiple);
  if (Number.isFinite(realizedMultiple) && realizedMultiple > 1) return 'PARTIAL_PROFIT';
  if (record.type === 'CREATOR_EXIT' || record.type === 'TRADE_STOP_EXIT') return 'RUG';
  if (record.type === 'LADDER_EXIT') return 'PARTIAL_PROFIT';
  return 'LOSS';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
