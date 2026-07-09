import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import {
  CsvHeader,
  NewPoolRow, NEW_POOL_HEADERS,
  RejectedTokenRow, REJECTED_TOKEN_HEADERS,
  ScoringHistoryRow, SCORING_HISTORY_HEADERS,
  WatchlistTokenRow, WATCHLIST_TOKEN_HEADERS,
  PaperEntryRow, PAPER_ENTRY_HEADERS,
  ResearchPaperEntryRow, RESEARCH_PAPER_ENTRY_HEADERS,
  PaperExitRow, PAPER_EXIT_HEADERS,
  ContractRiskRow, CONTRACT_RISK_HEADERS,
  ContractRejectedTokenRow, CONTRACT_REJECTED_TOKEN_HEADERS,
  QuarantineTokenRow, QUARANTINE_TOKEN_HEADERS,
  TrajectorySnapshotRow, TRAJECTORY_SNAPSHOT_HEADERS,
  ResearchCandidateRow, RESEARCH_CANDIDATE_HEADERS, RESEARCH_CANDIDATE_CAVEAT,
  SpeculativeCandidateRow, SPECULATIVE_CANDIDATE_HEADERS, SPECULATIVE_CANDIDATE_CAVEAT,
  PoolSnapshotRow, POOL_SNAPSHOT_HEADERS,
  PoolLiquiditySnapshotRow, POOL_LIQUIDITY_SNAPSHOT_HEADERS,
  CandidateRow, CANDIDATE_HEADERS, CANDIDATE_CAVEAT,
  PositionTickRow, POSITION_TICK_HEADERS,
  GemShadowTickRow, GEM_SHADOW_TICK_HEADERS,
} from './csv-schemas';

@Injectable()
export class FileLoggerService implements OnModuleInit {
  private readonly logger = new Logger(FileLoggerService.name);
  logDir: string; // package-visible for tests

  constructor(private readonly config: ConfigService) {
    this.logDir = this.config.get<string>('app.logDir') ?? './logs';
  }

  onModuleInit(): void {
    this.ensureDirectories();
    this.logger.log(`File logger initialised — log dir: ${path.resolve(this.logDir)}`);
  }

  // ─── CSV log methods ─────────────────────────────────────────────────────────

  logNewPool(row: NewPoolRow): void {
    this.writeCsvRow('raw/new_pools.csv', NEW_POOL_HEADERS, row);
  }

  logRejectedToken(row: RejectedTokenRow): void {
    this.writeCsvRow('decisions/rejected_tokens.csv', REJECTED_TOKEN_HEADERS, row);
  }

  logTrajectorySnapshot(row: TrajectorySnapshotRow): void {
    this.writeCsvRow('raw/trajectory_snapshots.csv', TRAJECTORY_SNAPSHOT_HEADERS, row);
  }

  logScoringHistory(row: ScoringHistoryRow): void {
    this.writeCsvRow('decisions/scoring_history.csv', SCORING_HISTORY_HEADERS, row);
  }

  logWatchlistToken(row: WatchlistTokenRow): void {
    this.writeCsvRow('decisions/watchlist_tokens.csv', WATCHLIST_TOKEN_HEADERS, row);
  }

  logPaperEntry(row: PaperEntryRow): void {
    this.writeCsvRow('decisions/paper_entries.csv', PAPER_ENTRY_HEADERS, row);
  }

  logResearchPaperEntry(row: ResearchPaperEntryRow): void {
    this.writeCsvRow('decisions/research_paper_entries.csv', RESEARCH_PAPER_ENTRY_HEADERS, row);
  }

  logPositionTick(row: PositionTickRow): void {
    this.writeCsvRow('decisions/position_ticks.csv', POSITION_TICK_HEADERS, row);
  }

  logGemShadowTick(row: GemShadowTickRow): void {
    this.writeCsvRow('decisions/gem_shadow_ticks.csv', GEM_SHADOW_TICK_HEADERS, row);
  }

  logPaperExit(row: PaperExitRow): void {
    this.writeCsvRow('decisions/paper_exits.csv', PAPER_EXIT_HEADERS, row);
  }

  logContractRisk(row: ContractRiskRow): void {
    this.writeCsvRow('raw/contract_risk_checks.csv', CONTRACT_RISK_HEADERS, row);
  }

  logContractRejected(row: ContractRejectedTokenRow): void {
    this.writeCsvRow('decisions/contract_rejected_tokens.csv', CONTRACT_REJECTED_TOKEN_HEADERS, row);
  }

  logQuarantineToken(row: QuarantineTokenRow): void {
    this.writeCsvRow('decisions/quarantine_tokens.csv', QUARANTINE_TOKEN_HEADERS, row);
  }

  logResearchCandidate(row: ResearchCandidateRow): void {
    this.writeCsvRow(
      'decisions/research_candidates.csv',
      RESEARCH_CANDIDATE_HEADERS,
      row,
      RESEARCH_CANDIDATE_CAVEAT,
    );
  }

  logSpeculativeCandidate(row: SpeculativeCandidateRow): void {
    this.writeCsvRow(
      'decisions/speculative_candidates.csv',
      SPECULATIVE_CANDIDATE_HEADERS,
      row,
      SPECULATIVE_CANDIDATE_CAVEAT,
    );
  }

  logPoolSnapshot(row: PoolSnapshotRow): void {
    this.writeCsvRow('raw/pool_snapshots.csv', POOL_SNAPSHOT_HEADERS, row);
  }

  logLiquiditySnapshot(row: PoolLiquiditySnapshotRow): void {
    this.writeCsvRow('raw/pool_liquidity_snapshots.csv', POOL_LIQUIDITY_SNAPSHOT_HEADERS, row);
  }

  // Survivor watchlist. On a new file the caveat comment is written FIRST, then the
  // column header, then the row — so the "not a buy signal" warning leads the file.
  logCandidate(row: CandidateRow): void {
    this.writeCsvRow('decisions/candidates.csv', CANDIDATE_HEADERS, row, CANDIDATE_CAVEAT);
  }

  // ─── JSONL raw payload log ───────────────────────────────────────────────────
  // Writes one JSON object per line so the file is grep-able without a parser.
  // Raw API payloads are stored in DB (RawCollectorPayload table).
  // This file stores per-cycle summaries only (no bulk API dump here).
  logRawPayload(payload: Record<string, unknown>): void {
    const fullPath = path.join(this.logDir, 'raw', 'source_payloads.jsonl');
    fs.appendFileSync(fullPath, JSON.stringify(payload) + '\n', 'utf8');
  }

  // ─── TXT report write (overwrite) ───────────────────────────────────────────
  // Overwrites the file so that restarting the process within the same calendar
  // day does not produce duplicate report blocks in the same file.

  writeReport(filename: string, content: string): void {
    const fullPath = path.join(this.logDir, 'reports', filename);
    fs.writeFileSync(fullPath, content + '\n', 'utf8');
  }

  appendReport(filename: string, content: string): void {
    const fullPath = path.join(this.logDir, 'reports', filename);
    fs.appendFileSync(fullPath, content + '\n', 'utf8');
  }

  // ─── Core CSV writer ─────────────────────────────────────────────────────────
  // Checks file existence BEFORE the write so header + first data row are written
  // in a single appendFileSync call — making them atomic from the OS perspective.
  // The `csv-writer` library's append:true behaviour depends on instantiation-time
  // state; this implementation checks existence at every write, which is the
  // only reliable approach for a long-running process.

  private writeCsvRow(
    relativePath: string,
    headers: CsvHeader[],
    row: unknown,
    leadingComment?: string,
  ): void {
    const fullPath = path.join(this.logDir, relativePath);
    const isNewFile = !fs.existsSync(fullPath);
    const rowObj = row as Record<string, unknown>;

    let output = '';
    if (isNewFile) {
      if (leadingComment) output += leadingComment + '\n';
      output += headers.map((h) => escapeCsvField(h.title)).join(',') + '\n';
    } else {
      this.upgradeHeaderIfAppendOnly(fullPath, headers, leadingComment);
    }
    output += headers.map((h) => escapeCsvField(rowObj[h.id])).join(',') + '\n';

    try {
      fs.appendFileSync(fullPath, output, 'utf8');
    } catch (err) {
      this.logger.error(`CSV write failed for ${relativePath}: ${(err as Error).message}`);
    }
  }

  private ensureDirectories(): void {
    for (const subdir of ['raw', 'decisions', 'reports']) {
      fs.mkdirSync(path.join(this.logDir, subdir), { recursive: true });
    }
  }

  private upgradeHeaderIfAppendOnly(
    fullPath: string,
    headers: CsvHeader[],
    leadingComment?: string,
  ): void {
    let raw: string;
    try {
      raw = fs.readFileSync(fullPath, 'utf8');
    } catch {
      return;
    }

    const expected = headers.map((h) => escapeCsvField(h.title)).join(',');
    const lines = raw.split(/\r?\n/);
    const headerIndex = leadingComment ? lines.findIndex((line) => !line.startsWith('#')) : 0;
    if (headerIndex < 0 || lines[headerIndex] === expected) return;

    const existing = lines[headerIndex].split(',');
    const next = expected.split(',');
    const isAppendOnly =
      existing.length < next.length &&
      existing.every((value, index) => value === next[index]);
    if (!isAppendOnly) return;

    lines[headerIndex] = expected;
    fs.writeFileSync(fullPath, lines.join('\n'), 'utf8');
  }
}

// RFC 4180 — fields containing commas, double-quotes, or line breaks must be
// wrapped in double-quotes, and any double-quote within must be escaped as "".
export function escapeCsvField(value: unknown): string {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
