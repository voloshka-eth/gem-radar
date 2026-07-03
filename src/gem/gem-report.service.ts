import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { FileLoggerService } from '../file-logger/file-logger.service';
import { computeGemReport, renderGemReport, deriveSummaries, RawGemCandidate } from './gem-report';

const num = (d: unknown): number | null => (d == null ? null : Number(d));
const horizonLabel = (min: number): string => (min < 60 ? `${min}m` : `${min / 60}h`);

@Injectable()
export class GemReportService {
  private readonly logger = new Logger(GemReportService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly fileLogger: FileLoggerService,
  ) {}

  async run(): Promise<string> {
    const horizonsMin = this.config.get<number[]>('gem.horizonsMin') ?? [15, 60, 180, 360, 1440, 4320];
    const horizonOrder = horizonsMin.map(horizonLabel);
    const minSampleWarn = this.config.get<number>('gem.minSampleWarn') ?? 30;
    const snipeBaseline = this.config.get<string>('gem.snipeBaselineHorizon') ?? '3h';
    const snipeBaselineMin = horizonsMin.find((m) => horizonLabel(m) === snipeBaseline) ?? 180;

    const candidates = await this.prisma.gemCandidate.findMany({ include: { ticks: true } });

    // Raw captured ticks per candidate — re-baselining is done in the pure layer.
    const raw: RawGemCandidate[] = candidates.map((c) => ({
      tokenAddress: c.tokenAddress,
      symbol: c.symbol ?? '?',
      entryFdvUsd: num(c.entryFdvUsd),
      ticks: c.ticks
        .filter((t) => t.status === 'captured')
        .map((t) => ({ horizon: t.horizon, elapsedMin: t.elapsedMin, fdvUsd: num(t.fdvUsd), rug: t.rugFlag })),
    }));

    // View 1 — baseline t0 (every survivor, returns from discovery).
    const t0 = computeGemReport(deriveSummaries(raw, 't0'), horizonOrder, minSampleWarn);

    // View 2 — snipe baseline (only candidates ALIVE at the baseline horizon; returns from there).
    const snipeSummaries = deriveSummaries(raw, snipeBaseline);
    const fwdOrder = horizonOrder.filter((_, i) => horizonsMin[i] > snipeBaselineMin);
    const snipe = computeGemReport(snipeSummaries, fwdOrder, minSampleWarn);
    const eligibleNote =
      `Snipe-at-${snipeBaseline} cohort: ${snipeSummaries.length} of ${raw.length} candidates were ` +
      `captured ALIVE at ${snipeBaseline} (only these are "enterable"). Returns measured FROM ${snipeBaseline}.`;

    const dateLabel = new Date().toISOString().slice(0, 10);
    const report =
      renderGemReport(t0, dateLabel) +
      '\n\n' +
      renderGemReport(snipe, dateLabel, {
        heading: `SNIPE HYPOTHESIS · baseline = ${snipeBaseline} (entered only if survived ${snipeBaseline})`,
        baselineNote: eligibleNote,
      });

    this.fileLogger.writeReport(`gem_outcomes_${dateLabel}.txt`, report);
    this.logger.log(`Gem outcome report → reports/gem_outcomes_${dateLabel}.txt (t0=${t0.totalCandidates}, snipe@${snipeBaseline}=${snipe.totalCandidates})`);
    return report;
  }
}
