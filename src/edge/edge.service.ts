import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { FileLoggerService } from '../file-logger/file-logger.service';
import { computeEdge, renderEdgeReport, ClosedPosition, EdgeParams } from './edge';

/** M5 — Edge report over CLOSED paper positions (on demand). */
@Injectable()
export class EdgeService {
  private readonly logger = new Logger(EdgeService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly fileLogger: FileLoggerService,
  ) {}

  async run(): Promise<string> {
    const params: EdgeParams = {
      minClosed:      this.config.get<number>('paper.minClosedForEdge') ?? 50,
      scoreThreshold: this.config.get<number>('paper.edgeScoreThreshold') ?? 70,
    };

    const closed = await this.prisma.paperPosition.findMany({
      where: { status: 'CLOSED' },
      select: { realizedMultiple: true, entryFeatures: true, status: true },
    });

    const primaryClosed = closed.filter((c) => {
      const f = (c.entryFeatures ?? {}) as { riskCohort?: string };
      return f.riskCohort !== 'ROBINHOOD_EXPERIMENTAL_NO_PROVIDER' &&
        f.riskCohort !== 'CONTRACT_MINTABLE_RESEARCH' &&
        f.riskCohort !== 'CONTRACT_UNKNOWN_RESEARCH';
    });
    const positions: ClosedPosition[] = primaryClosed.map((c) => {
      const f = (c.entryFeatures ?? {}) as { finalScore?: number; band?: string; fdvUsd?: number | null };
      return {
        realizedMultiple: c.realizedMultiple != null ? Number(c.realizedMultiple) : 0,
        finalScore: f.finalScore ?? null,
        band: f.band ?? null,
        fdvUsd: f.fdvUsd ?? null,
      };
    });

    const result = computeEdge(positions, params);
    const dateLabel = new Date().toISOString().slice(0, 10);
    const experimentalCount = closed.length - primaryClosed.length;
    const takeCohort = primaryClosed.filter((c) => {
      const f = (c.entryFeatures ?? {}) as { takeCohort?: string };
      return f.takeCohort === 'CONFIRMED';
    });
    const takeSummary = this.cohortSummary(takeCohort);
    const sourceSummary = this.sourceSummary(primaryClosed);
    const survivalSummary = this.survivalSummary(primaryClosed);
    const researchSummary = this.researchCohortSummary(closed.filter((c) => !primaryClosed.includes(c)));
    const report = renderEdgeReport(result, params, dateLabel) +
      `\n\nEXPERIMENTAL/RESEARCH COHORTS EXCLUDED FROM PRIMARY EDGE: ${experimentalCount} position(s).` +
      `\n\nBASE/ETH TAKE-COHORT VALIDATION (separate from baseline; paper only): ${takeSummary}` +
      `\n\nDISCOVERY-SOURCE OUTCOMES (forward comparison; paper only): ${sourceSummary}` +
      `\n\nRESEARCH COHORT OUTCOMES (excluded from primary edge): ${researchSummary}`;
    const reportWithSurvival = report +
      `\n\nT0 SURVIVAL OBSERVATION (not an entry gate): ${survivalSummary}`;
    this.fileLogger.writeReport(`edge_${dateLabel}.txt`, reportWithSurvival);
    this.logger.log(`Edge report written → reports/edge_${dateLabel}.txt  (verdict: ${result.verdict})`);
    return reportWithSurvival;
  }

  private cohortSummary(closed: Array<{ realizedMultiple: unknown }>): string {
    if (closed.length === 0) return 'no closed confirmed positions yet.';
    const multiples = closed.map((c) => Number(c.realizedMultiple ?? 0));
    const average = multiples.reduce((sum, value) => sum + value, 0) / multiples.length;
    const x2 = multiples.filter((value) => value >= 2).length;
    return `n=${closed.length}, avg realized multiple=${average.toFixed(3)}, x2-or-better=${x2}/${closed.length}.`;
  }

  private sourceSummary(closed: Array<{ realizedMultiple: unknown; entryFeatures: unknown }>): string {
    const groups = new Map<string, number[]>();
    for (const position of closed) {
      const features = (position.entryFeatures ?? {}) as { discoverySource?: string };
      const source = features.discoverySource || 'legacy_unknown';
      const values = groups.get(source) ?? [];
      values.push(Number(position.realizedMultiple ?? 0));
      groups.set(source, values);
    }
    if (groups.size === 0) return 'no closed primary positions.';
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([source, multiples]) => {
        const average = multiples.reduce((sum, value) => sum + value, 0) / multiples.length;
        const x2 = multiples.filter((value) => value >= 2).length;
        return `${source}: n=${multiples.length}, avg=${average.toFixed(3)}, x2+=${x2}/${multiples.length}`;
      })
      .join('; ');
  }

  private survivalSummary(positions: Array<{ entryFeatures: unknown }>): string {
    const groups = new Map<string, number>();
    for (const position of positions) {
      const status = (position.entryFeatures as { survival10mStatus?: string } | null)?.survival10mStatus;
      if (status) groups.set(status, (groups.get(status) ?? 0) + 1);
    }
    if (groups.size === 0) return 'no 10m observations yet.';
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(', ');
  }

  private researchCohortSummary(positions: Array<{ realizedMultiple: unknown; entryFeatures: unknown }>): string {
    const groups = new Map<string, number[]>();
    for (const position of positions) {
      const cohort = (position.entryFeatures as { riskCohort?: string } | null)?.riskCohort || 'legacy_unknown';
      const values = groups.get(cohort) ?? [];
      values.push(Number(position.realizedMultiple ?? 0));
      groups.set(cohort, values);
    }
    if (groups.size === 0) return 'none closed yet.';
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([cohort, values]) => {
      const average = values.reduce((sum, value) => sum + value, 0) / values.length;
      const x2 = values.filter((value) => value >= 2).length;
      return `${cohort}: n=${values.length}, avg=${average.toFixed(3)}, x2+=${x2}/${values.length}`;
    }).join('; ');
  }
}
