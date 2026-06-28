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
      select: { realizedMultiple: true, entryFeatures: true },
    });

    const positions: ClosedPosition[] = closed.map((c) => {
      const f = (c.entryFeatures ?? {}) as { finalScore?: number; band?: string };
      return {
        realizedMultiple: c.realizedMultiple != null ? Number(c.realizedMultiple) : 0,
        finalScore: f.finalScore ?? null,
        band: f.band ?? null,
      };
    });

    const result = computeEdge(positions, params);
    const dateLabel = new Date().toISOString().slice(0, 10);
    const report = renderEdgeReport(result, params, dateLabel);
    this.fileLogger.writeReport(`edge_${dateLabel}.txt`, report);
    this.logger.log(`Edge report written → reports/edge_${dateLabel}.txt  (verdict: ${result.verdict})`);
    return report;
  }
}
