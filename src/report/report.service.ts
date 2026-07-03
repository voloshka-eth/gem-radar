import * as fs from 'fs';
import * as path from 'path';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { FileLoggerService } from '../file-logger/file-logger.service';
import { UNIMPLEMENTED_COMPONENT_KEYS } from '../scoring/score';

interface Stage0Stats {
  totalEvents: number;
  uniqueTokens: number;
  reasons: Record<string, number>;
}

interface SurvivorRow {
  chain: string;
  symbol: string;
  tvlUsd: string;
  slip1000: string;
}
interface CandidateStats {
  totalRows: number;
  survivors: SurvivorRow[]; // distinct by chain:token_address, latest row kept
}

@Injectable()
export class ReportService implements OnModuleDestroy {
  private readonly logger = new Logger(ReportService.name);
  private shutdownReportDone = false; // guard against multiple onModuleDestroy calls

  constructor(
    private readonly prisma: PrismaService,
    private readonly fileLogger: FileLoggerService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.shutdownReportDone) return;
    this.shutdownReportDone = true;
    try {
      await this.generateReport('shutdown');
    } catch (err) {
      this.logger.error(`Shutdown report failed: ${(err as Error).message}`);
    }
  }

  @Cron('5 0 * * *')
  async scheduledReport(): Promise<void> {
    try {
      await this.generateReport('scheduled');
    } catch (err) {
      this.logger.error(`Scheduled report failed: ${(err as Error).message}`);
    }
  }

  // Called by `npm run report:now`
  async generateNow(): Promise<void> {
    await this.generateReport('shutdown');
  }

  private async generateReport(trigger: 'scheduled' | 'shutdown'): Promise<void> {
    const now = new Date();
    let windowStart: Date;
    let windowEnd: Date;
    let dateLabel: string;

    if (trigger === 'scheduled') {
      windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
      windowEnd   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      dateLabel   = windowStart.toISOString().slice(0, 10);
    } else {
      windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      windowEnd   = now;
      dateLabel   = now.toISOString().slice(0, 10);
    }

    const where = { ts: { gte: windowStart, lt: windowEnd } };

    // ── DB queries ─────────────────────────────────────────────────────────────

    const [cycleGroups, allChecks, uniqueDiscovered, liqSnapshots, scoringRows] = await Promise.all([
      // Distinct run_ids = cycles that ran in window
      this.prisma.contractRiskCheck.groupBy({
        by: ['runId'],
        where: { ...where, runId: { not: null } },
      }),
      // All check rows — we dedup in memory (one row per unique chain:tokenAddress)
      this.prisma.contractRiskCheck.findMany({
        where,
        select: {
          chain: true,
          tokenAddress: true,
          decision: true,
          ts: true,
          goplusQueried: true,
          honeypotQueried: true,
          rejectReasons: true,
          buyTax: true,
          sellTax: true,
          canMint: true,
        },
        orderBy: { ts: 'desc' }, // newest first → first-seen per key = latest decision
      }),
      this.prisma.token.count({
        where: { firstSeenAt: { gte: windowStart, lt: windowEnd } },
      }),
      // Liquidity verification stats — only snapshots where we ran the verifier
      this.prisma.poolSnapshot.findMany({
        where: { ...where, liquidityModel: { not: null } },
        select: {
          liquidityModel:       true,
          liquidityVerified:    true,
          reportedVsOnchainPct: true,
        },
      }),
      // M4 scoring rows in window
      this.prisma.scoringHistory.findMany({
        where,
        select: {
          chain: true, tokenAddress: true, finalScore: true, band: true,
          scoreConfidence: true, liquidityModel: true, ts: true,
        },
        orderBy: { ts: 'desc' },
      }),
    ]);

    // Dedup: keep latest decision per (chain, tokenAddress)
    const latestByToken = new Map<string, typeof allChecks[0]>();
    for (const check of allChecks) {
      const key = `${check.chain}:${check.tokenAddress}`;
      if (!latestByToken.has(key)) latestByToken.set(key, check);
    }
    const dedupedChecks = [...latestByToken.values()];

    const cyclesRun  = cycleGroups.length;
    const totalGate  = dedupedChecks.length;

    const decisionMap: Record<string, number> = {};
    let goplusCount  = 0;
    let honeypotCount = 0;
    const reasonHistogram: Record<string, number> = {};

    for (const check of dedupedChecks) {
      decisionMap[check.decision] = (decisionMap[check.decision] ?? 0) + 1;
      if (check.goplusQueried)   goplusCount++;
      if (check.honeypotQueried) honeypotCount++;
      if (check.decision === 'CONTRACT_REJECT') {
        const reasons = check.rejectReasons as string[] | null;
        if (reasons) {
          for (const r of reasons) {
            reasonHistogram[r] = (reasonHistogram[r] ?? 0) + 1;
          }
        }
      }
    }

    const safeCount    = decisionMap['CONTRACT_SAFE'] ?? 0;
    const rejectCount  = decisionMap['CONTRACT_REJECT'] ?? 0;
    const unknownCount = decisionMap['CONTRACT_UNKNOWN'] ?? 0;
    const gateAlerts = buildContractGateAlerts(
      dedupedChecks,
      safeCount,
      totalGate,
    );

    // ── Liquidity verification stats ───────────────────────────────────────────
    const liqModelHistogram: Record<string, number> = {};
    let liqVerifiedTrue  = 0;
    let liqVerifiedFalse = 0;
    let liqInflated      = 0; // reportedVsOnchainPct > 0.50 (reported > 50% above onchain)

    for (const snap of liqSnapshots) {
      const model = snap.liquidityModel ?? 'UNKNOWN';
      liqModelHistogram[model] = (liqModelHistogram[model] ?? 0) + 1;
      if (snap.liquidityVerified === true)  liqVerifiedTrue++;
      if (snap.liquidityVerified === false) liqVerifiedFalse++;
      // reportedVsOnchainPct is a Prisma Decimal — convert to number for comparison
      const pct = snap.reportedVsOnchainPct != null ? Number(snap.reportedVsOnchainPct) : null;
      if (pct !== null && pct > 0.50) liqInflated++;
    }

    const totalLiq = liqSnapshots.length;

    // ── Stage 0 CSV ────────────────────────────────────────────────────────────
    const stage0 = this.parseStage0Csv(
      path.join(this.fileLogger.logDir, 'decisions', 'rejected_tokens.csv'),
      windowStart,
      windowEnd,
    );

    // ── Survivor watchlist CSV ───────────────────────────────────────────────────
    const candidates = this.parseCandidatesCsv(
      path.join(this.fileLogger.logDir, 'decisions', 'candidates.csv'),
      windowStart,
      windowEnd,
    );

    // ── Formatting helpers ─────────────────────────────────────────────────────
    const pct = (n: number, total: number): string =>
      total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '–';
    const pad = (s: string | number, w: number) => String(s).padStart(w);

    // ── Report lines ───────────────────────────────────────────────────────────
    const lines: string[] = [
      '═══════════════════════════════════════════════════════════',
      '  GEM RADAR — Daily Collection Report',
      `  Date:      ${dateLabel}`,
      `  Window:    ${windowStart.toISOString()} → ${windowEnd.toISOString()}`,
      `  Generated: ${now.toISOString()}  (trigger: ${trigger})`,
      '═══════════════════════════════════════════════════════════',
      '',
    ];

    if (gateAlerts.length > 0) {
      lines.push(
        '!!! CONTRACT GATE DATA QUALITY ALERT !!!',
        ...gateAlerts.map((a) => `  ${a}`),
        '',
      );
    }

    // ── Stage 0 ────────────────────────────────────────────────────────────────
    lines.push('STAGE 0 FILTER');
    if (stage0 === null) {
      lines.push('  (no Stage 0 data in window — rejected_tokens.csv missing or empty)');
    } else {
      lines.push(
        `  Total rejection events:  ${stage0.totalEvents}`,
        `  Unique tokens rejected:  ${stage0.uniqueTokens}`,
        '',
        '  Reason histogram:',
      );
      const sortedS0 = Object.entries(stage0.reasons).sort((a, b) => b[1] - a[1]);
      for (const [reason, count] of sortedS0) {
        lines.push(`    ${reason.padEnd(30)} ${pad(count, 4)}   (${pct(count, stage0.totalEvents)})`);
      }
    }

    // ── Contract gate ──────────────────────────────────────────────────────────
    lines.push(
      '',
      'CONTRACT GATE  (unique tokens, latest decision per token)',
      `  Tokens evaluated:    ${totalGate}`,
      `  CONTRACT_SAFE:       ${pad(safeCount, 4)}   (${pct(safeCount, totalGate)})`,
      `  CONTRACT_REJECT:     ${pad(rejectCount, 4)}   (${pct(rejectCount, totalGate)})`,
      `  CONTRACT_UNKNOWN:    ${pad(unknownCount, 4)}   (${pct(unknownCount, totalGate)})`,
      `  Unique discovered:   ${uniqueDiscovered}`,
    );

    // ── Reject reason histogram ────────────────────────────────────────────────
    lines.push('', 'CONTRACT REJECT REASON HISTOGRAM');
    const sortedReasons = Object.entries(reasonHistogram).sort((a, b) => b[1] - a[1]);
    if (sortedReasons.length === 0) {
      lines.push('  (no rejects in window)');
    } else {
      for (const [reason, count] of sortedReasons) {
        lines.push(`  ${reason.padEnd(35)} ${pad(count, 4)}   (${pct(count, rejectCount)})`);
      }
    }

    // ── Liquidity verification (M3A) ───────────────────────────────────────────
    lines.push('', 'LIQUIDITY VERIFICATION  (pools reaching CONTRACT_SAFE in window)');
    if (totalLiq === 0) {
      lines.push('  (no liquidity snapshots in window — DB push pending or M3A not yet active)');
    } else {
      lines.push(
        `  Pools with liquidity check: ${totalLiq}`,
        `  liquidity_verified true:    ${pad(liqVerifiedTrue, 4)}   (${pct(liqVerifiedTrue, totalLiq)})`,
        `  liquidity_verified false:   ${pad(liqVerifiedFalse, 4)}   (${pct(liqVerifiedFalse, totalLiq)})`,
        `  Inflated (reported > onchain+50%): ${liqInflated}`,
        '',
        '  Model histogram:',
      );
      const sortedModels = Object.entries(liqModelHistogram).sort((a, b) => b[1] - a[1]);
      for (const [model, count] of sortedModels) {
        lines.push(`    ${model.padEnd(34)} ${pad(count, 4)}   (${pct(count, totalLiq)})`);
      }
    }

    // ── Survivor watchlist (CANDIDATES) ────────────────────────────────────────
    lines.push('', 'CANDIDATES  (survivor watchlist)');
    lines.push(
      '  Survivors = passed scam/liquidity filters only. ' +
      'NOT scored, NOT backtested, NOT a buy signal. Research queue, not recommendations.',
    );
    if (candidates === null || candidates.survivors.length === 0) {
      lines.push('  Distinct survivor tokens: 0   (none passed CONTRACT_SAFE + age + liquidity_verified in window)');
    } else {
      lines.push(
        `  Distinct survivor tokens: ${candidates.survivors.length}   (from ${candidates.totalRows} verified rows)`,
        '',
        `    ${'chain'.padEnd(9)}${'symbol'.padEnd(14)}${'onchain_tvl_usd'.padStart(16)}${'slip_1000'.padStart(12)}`,
      );
      for (const s of candidates.survivors) {
        const tvl  = s.tvlUsd  !== '' ? `$${Number(s.tvlUsd).toFixed(0)}` : '?';
        const slip = s.slip1000 !== '' ? `${(Number(s.slip1000) * 100).toFixed(2)}%` : '?';
        lines.push(`    ${s.chain.padEnd(9)}${(s.symbol || '?').padEnd(14)}${tvl.padStart(16)}${slip.padStart(12)}`);
      }
    }

    // ── Scoring (M4) ────────────────────────────────────────────────────────────
    // Dedup to the best (highest finalScore) row per distinct token in the window.
    const bestByToken = new Map<string, typeof scoringRows[0]>();
    for (const s of scoringRows) {
      const key = `${s.chain}:${s.tokenAddress}`;
      const prev = bestByToken.get(key);
      if (!prev || Number(s.finalScore) > Number(prev.finalScore)) bestByToken.set(key, s);
    }
    const distinctScored = [...bestByToken.values()];

    const blindList = UNIMPLEMENTED_COMPONENT_KEYS.join(', ');
    lines.push('', 'SCORING  (M4 — ranking hypothesis)');
    lines.push(
      '  Scores are an UNVALIDATED ranking hypothesis. Not edge, not backtested, not a buy signal. ' +
      'M5 will test whether higher bands outperform.',
      `  Confidence <1.0 means the score is blind to: ${blindList}. Treat low-confidence scores as weak.`,
    );
    if (distinctScored.length === 0) {
      lines.push('  Distinct tokens scored: 0   (no verified survivors scored in window)');
    } else {
      const bandHist: Record<string, number> = {};
      let sumScore = 0;
      let sumConf = 0;
      for (const s of distinctScored) {
        bandHist[s.band] = (bandHist[s.band] ?? 0) + 1;
        sumScore += Number(s.finalScore);
        sumConf  += Number(s.scoreConfidence);
      }
      const n = distinctScored.length;
      lines.push(
        `  Distinct tokens scored: ${n}`,
        `  Mean finalScore:        ${(sumScore / n).toFixed(1)}`,
        `  Mean confidence:        ${(sumConf / n).toFixed(2)}`,
        '',
        '  Band histogram (UNVALIDATED bands):',
      );
      // Stable band order, best → worst.
      for (const band of ['high_band', 'candidate', 'watchlist', 'reject_band']) {
        const c = bandHist[band] ?? 0;
        if (c > 0) lines.push(`    ${band.padEnd(14)} ${pad(c, 4)}   (${pct(c, n)})`);
      }
      lines.push('', '  Top survivors by score:');
      lines.push(`    ${'chain'.padEnd(9)}${'token'.padEnd(14)}${'model'.padEnd(7)}${'score'.padStart(7)}${'band'.padStart(13)}${'conf'.padStart(7)}`);
      const top = [...distinctScored].sort((a, b) => Number(b.finalScore) - Number(a.finalScore)).slice(0, 10);
      for (const s of top) {
        const tok = `${s.tokenAddress.slice(0, 10)}…`;
        lines.push(
          `    ${s.chain.padEnd(9)}${tok.padEnd(14)}${(s.liquidityModel || '?').padEnd(7)}` +
          `${Number(s.finalScore).toFixed(1).padStart(7)}${s.band.padStart(13)}${Number(s.scoreConfidence).toFixed(2).padStart(7)}`,
        );
      }
    }

    // ── Funnel ────────────────────────────────────────────────────────────────
    const s0Unique  = stage0?.uniqueTokens ?? 0;
    const poolsSeen = s0Unique + totalGate;
    lines.push(
      '',
      'COLLECTION FUNNEL  (unique tokens)',
      `  Pools seen total:        ${pad(poolsSeen, 4)}`,
      `  → Stage 0 rejected:      ${pad(s0Unique, 4)}   (${pct(s0Unique, poolsSeen)})`,
      `  → Reached contract gate: ${pad(totalGate, 4)}   (${pct(totalGate, poolsSeen)})`,
      `     → CONTRACT_SAFE:      ${pad(safeCount, 4)}   (${pct(safeCount, totalGate)} of gate)`,
      `     → CONTRACT_REJECT:    ${pad(rejectCount, 4)}   (${pct(rejectCount, totalGate)} of gate)`,
      `     → CONTRACT_UNKNOWN:   ${pad(unknownCount, 4)}   (${pct(unknownCount, totalGate)} of gate)`,
    );

    // ── Data availability ─────────────────────────────────────────────────────
    lines.push(
      '',
      'DATA AVAILABILITY',
      `  Cycles run:          ${cyclesRun}`,
      `  GoPlus queried:      ${goplusCount}/${totalGate} (${pct(goplusCount, totalGate)})`,
      `  Honeypot.is queried: ${honeypotCount}/${totalGate} (${pct(honeypotCount, totalGate)})`,
      '',
      'FILES',
      '  Stage 0 detail:        logs/decisions/rejected_tokens.csv',
      '  Trajectory data:       logs/raw/pool_snapshots.csv',
      '  Discovery log:         logs/raw/new_pools.csv',
      '  Liquidity snapshots:   logs/raw/pool_liquidity_snapshots.csv',
      '  Survivor watchlist:    logs/decisions/candidates.csv',
      '  Scoring history:       logs/decisions/scoring_history.csv',
      '',
    );

    const filename = `daily_report_${dateLabel}.txt`;
    this.fileLogger.writeReport(filename, lines.join('\n'));
    this.logger.log(`Report written → reports/${filename}  (trigger: ${trigger})`);
  }

  // ── Stage 0 CSV parser ──────────────────────────────────────────────────────
  private parseStage0Csv(
    filePath: string,
    windowStart: Date,
    windowEnd: Date,
  ): Stage0Stats | null {
    if (!fs.existsSync(filePath)) return null;

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }

    const rows = raw.split('\n');
    if (rows.length < 2) return null;

    let totalEvents = 0;
    const uniqueTokens = new Set<string>();
    const reasons: Record<string, number> = {};

    for (let i = 1; i < rows.length; i++) {
      const line = rows[i].trim();
      if (!line) continue;

      const fields = parseCsvLine(line);
      if (fields.length < 24) continue;

      const tsStr     = fields[0];
      const tokenAddr = fields[4];
      const reason    = fields[23];

      if (!tsStr || !tokenAddr || !reason) continue;

      const ts = new Date(tsStr);
      if (isNaN(ts.getTime())) continue;
      if (ts < windowStart || ts >= windowEnd) continue;

      totalEvents++;
      uniqueTokens.add(`${fields[3]}:${tokenAddr}`);
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }

    if (totalEvents === 0) return null;
    return { totalEvents, uniqueTokens: uniqueTokens.size, reasons };
  }

  // ── Survivor watchlist CSV parser ────────────────────────────────────────────
  // Skips the leading caveat comment (`#…`) and the column header, filters by the
  // report window, and dedups to the latest row per chain:token_address.
  // Columns: ts(0) run_id(1) chain(2) token_address(3) symbol(4) name(5)
  //          model(6) onchain_tvl_usd(7) reported_vs_onchain_pct(8)
  //          slip_100(9) slip_1000(10) fdv_usd(11) age_days(12)
  private parseCandidatesCsv(
    filePath: string,
    windowStart: Date,
    windowEnd: Date,
  ): CandidateStats | null {
    if (!fs.existsSync(filePath)) return null;

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }

    const rows = raw.split('\n');
    let totalRows = 0;
    const latestByToken = new Map<string, { ts: number; row: SurvivorRow }>();

    for (const rawLine of rows) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;     // skip blanks + caveat comment
      if (line.startsWith('ts,')) continue;            // skip header

      const f = parseCsvLine(line);
      if (f.length < 11) continue;

      const ts = new Date(f[0]);
      if (isNaN(ts.getTime())) continue;
      if (ts < windowStart || ts >= windowEnd) continue;

      totalRows++;
      const key = `${f[2]}:${f[3]}`;
      const prev = latestByToken.get(key);
      if (!prev || ts.getTime() >= prev.ts) {
        latestByToken.set(key, {
          ts: ts.getTime(),
          row: { chain: f[2], symbol: f[4], tvlUsd: f[7], slip1000: f[10] },
        });
      }
    }

    if (totalRows === 0) return null;
    return { totalRows, survivors: [...latestByToken.values()].map((v) => v.row) };
  }
}

// Minimal RFC-4180-compliant CSV line parser (handles double-quote escaping).
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"')       { inQuotes = true; }
      else if (ch === ',')  { fields.push(current); current = ''; }
      else                  { current += ch; }
    }
  }
  fields.push(current);
  return fields;
}

function buildContractGateAlerts(
  checks: Array<{
    goplusQueried: boolean;
    buyTax: unknown;
    sellTax: unknown;
    canMint: unknown;
  }>,
  safeCount: number,
  totalGate: number,
): string[] {
  const alerts: string[] = [];
  if (totalGate === 0) return alerts;

  const safeRate = safeCount / totalGate;
  if (totalGate >= 20 && safeRate > 0.9) {
    alerts.push(`SAFE RATE ${(safeRate * 100).toFixed(1)}% > 90% over ${totalGate} gate tokens.`);
  }

  const queried = checks.filter((c) => c.goplusQueried);
  if (queried.length < 20) return alerts;

  const taxFilled = queried.filter((c) => c.buyTax != null || c.sellTax != null).length;
  const mintFilled = queried.filter((c) => c.canMint != null).length;
  const taxRate = taxFilled / queried.length;
  const mintRate = mintFilled / queried.length;

  if (taxRate < 0.4) {
    alerts.push(`GoPlus tax fill rate ${(taxRate * 100).toFixed(1)}% < 40% (${taxFilled}/${queried.length}).`);
  }
  if (mintRate < 0.4) {
    alerts.push(`GoPlus can_mint fill rate ${(mintRate * 100).toFixed(1)}% < 40% (${mintFilled}/${queried.length}).`);
  }
  return alerts;
}
