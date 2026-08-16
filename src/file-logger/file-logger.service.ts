import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import {
  CsvHeader,
  NewPoolRow, NEW_POOL_HEADERS,
  RejectedTokenRow, REJECTED_TOKEN_HEADERS,
  ScoringHistoryRow, SCORING_HISTORY_HEADERS,
  WatchlistTokenRow, WATCHLIST_TOKEN_HEADERS,
  PaperEntryRow, PAPER_ENTRY_HEADERS,
  TakeCohortDecisionRow, TAKE_COHORT_DECISION_HEADERS,
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
  /** Existing files need header validation once per process, not once per row. */
  private readonly validatedHeaders = new Set<string>();
  private readonly rawLogDays = new Map<string, string>();
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
    this.rotateRawLogIfNeeded('raw/trajectory_snapshots.csv');
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

  logTakeCohortDecision(row: TakeCohortDecisionRow): void {
    this.writeCsvRow('decisions/take_cohort_decisions.csv', TAKE_COHORT_DECISION_HEADERS, row);
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
    const relativePath = 'raw/source_payloads.jsonl';
    this.rotateRawLogIfNeeded(relativePath);
    const fullPath = path.join(this.logDir, relativePath);
    const row = { ...payload };
    if (typeof row.ts === 'string') row.ts = formatLogTimestamp(row.ts);
    fs.appendFileSync(fullPath, JSON.stringify(row) + '\n', 'utf8');
  }

  /** Called by maintenance to compact the current raw session without touching paper CSVs. */
  archiveActiveRawLogs(): number {
    return Number(this.rotateRawLogIfNeeded('raw/source_payloads.jsonl', true)) +
      Number(this.rotateRawLogIfNeeded('raw/trajectory_snapshots.csv', true));
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
    const expected = headers.map((h) => escapeCsvField(h.title)).join(',');
    const headerKey = `${fullPath}\u0000${expected}\u0000${leadingComment ?? ''}`;

    let output = '';
    if (isNewFile) {
      if (leadingComment) output += leadingComment + '\n';
      output += expected + '\n';
      this.validatedHeaders.add(headerKey);
    } else if (!this.validatedHeaders.has(headerKey)) {
      this.upgradeHeaderIfAppendOnly(fullPath, expected, leadingComment);
      this.validatedHeaders.add(headerKey);
    }
    output += headers.map((h) => escapeCsvField(
      isTimestampColumn(h.id) ? formatLogTimestamp(rowObj[h.id]) : rowObj[h.id],
    )).join(',') + '\n';

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
    expected: string,
    leadingComment?: string,
  ): void {
    let prefix: string;
    try {
      const descriptor = fs.openSync(fullPath, 'r');
      try {
        const bytes = Buffer.alloc(64 * 1024);
        const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
        prefix = bytes.toString('utf8', 0, length);
      } finally {
        fs.closeSync(descriptor);
      }
    } catch {
      return;
    }

    const lines = prefix.split(/\r?\n/);
    const headerIndex = leadingComment ? lines.findIndex((line) => !line.startsWith('#')) : 0;
    if (headerIndex < 0 || lines[headerIndex] === expected) return;

    const existing = lines[headerIndex].split(',');
    const next = expected.split(',');
    const isAppendOnly =
      existing.length < next.length &&
      existing.every((value, index) => value === next[index]);
    if (!isAppendOnly) return;

    // Schema upgrades are rare; only that path needs one full-file rewrite.
    try {
      const raw = fs.readFileSync(fullPath, 'utf8');
      const fullLines = raw.split(/\r?\n/);
      fullLines[headerIndex] = expected;
      fs.writeFileSync(fullPath, fullLines.join('\n'), 'utf8');
    } catch (error) {
      this.logger.warn(`CSV header upgrade skipped for ${path.basename(fullPath)}: ${(error as Error).message}`);
    }
  }

  /** Rotate only high-volume raw logs; decision and paper CSVs remain stable. */
  private rotateRawLogIfNeeded(relativePath: string, force = false): boolean {
    const today = new Date().toISOString().slice(0, 10);
    if (!force && this.rawLogDays.get(relativePath) === today) return false;
    const fullPath = path.join(this.logDir, relativePath);
    let rotated = false;
    try {
      if (fs.existsSync(fullPath)) {
        const modifiedDay = fs.statSync(fullPath).mtime.toISOString().slice(0, 10);
        if ((force || modifiedDay !== today) && fs.statSync(fullPath).size > 0) {
          const archiveDirectory = path.join(this.logDir, 'archive', 'raw-logs', modifiedDay);
          fs.mkdirSync(archiveDirectory, { recursive: true });
          const baseArchivePath = path.join(archiveDirectory, `${path.basename(fullPath)}.gz`);
          const archivePath = fs.existsSync(baseArchivePath)
            ? path.join(archiveDirectory, `${path.basename(fullPath)}.${Date.now()}.gz`)
            : baseArchivePath;
          const compressed = zlib.gzipSync(fs.readFileSync(fullPath), { level: zlib.constants.Z_BEST_COMPRESSION });
          fs.writeFileSync(`${archivePath}.tmp`, compressed);
          fs.renameSync(`${archivePath}.tmp`, archivePath);
          fs.unlinkSync(fullPath);
          for (const key of this.validatedHeaders) {
            if (key.startsWith(`${fullPath}\u0000`)) this.validatedHeaders.delete(key);
          }
          this.logger.log(`Rotated raw log ${path.basename(fullPath)} -> ${path.basename(archivePath)}`);
          rotated = true;
        }
      }
    } catch (error) {
      this.logger.warn(`Raw log rotation skipped for ${path.basename(fullPath)}: ${(error as Error).message}`);
    }
    this.rawLogDays.set(relativePath, today);
    return rotated;
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

const WARSAW_TIME_ZONE = 'Europe/Warsaw';

/**
 * File logs are read by a person first, so render UTC ISO timestamps in the
 * configured research timezone while retaining an explicit UTC offset.
 */
export function formatLogTimestamp(value: unknown): unknown {
  if (typeof value !== 'string' || !value.endsWith('Z')) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: WARSAW_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  const offset = (part('timeZoneName') ?? 'GMT').replace('GMT', '') || '+00:00';
  const millis = String(date.getUTCMilliseconds()).padStart(3, '0');

  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}.${millis}${offset}`;
}

function isTimestampColumn(id: string): boolean {
  return id === 'ts' || id.endsWith('_at');
}
