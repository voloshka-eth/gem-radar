import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { FileLoggerService } from '../file-logger/file-logger.service';
import {
  computePostmortem, renderPostmortem, ClosedFeatureRow, POSTMORTEM_T0_FEATURES,
} from './postmortem';

/** M5 — Post-mortem over CLOSED paper positions (on demand). */
@Injectable()
export class PostmortemService {
  private readonly logger = new Logger(PostmortemService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly fileLogger: FileLoggerService,
  ) {}

  async run(): Promise<string> {
    const minPerGroup = this.config.get<number>('paper.minPerGroupPostmortem') ?? 30;

    const closed = await this.prisma.paperPosition.findMany({
      where: { status: 'CLOSED' },
      select: {
        outcomeClass: true, entryFeatures: true,
        lastSellersToBuyersRatio: true, lastSellSimOk: true,
      },
    });

    const rows: ClosedFeatureRow[] = closed.map((c) => {
      const f = (c.entryFeatures ?? {}) as Record<string, number | null>;
      const features: Record<string, number | null> = {};
      for (const key of POSTMORTEM_T0_FEATURES) features[key] = f[key] ?? null;
      // Post-t0 rug signals from the LAST eval tick before close.
      features.sellersToBuyersRatioLast =
        c.lastSellersToBuyersRatio != null ? Number(c.lastSellersToBuyersRatio) : null;
      features.sellSimOkLast = c.lastSellSimOk == null ? null : c.lastSellSimOk ? 1 : 0;
      return { outcomeClass: c.outcomeClass ?? 'UNKNOWN', features };
    });

    const result = computePostmortem(rows, minPerGroup);
    const dateLabel = new Date().toISOString().slice(0, 10);
    const report = renderPostmortem(result, dateLabel);
    this.fileLogger.writeReport(`postmortem_${dateLabel}.txt`, report);
    this.logger.log(
      `Post-mortem written → reports/postmortem_${dateLabel}.txt  ` +
      `(bad=${result.nBad} good=${result.nGood}${result.underpowered ? ' — UNDERPOWERED' : ''})`,
    );
    return report;
  }
}
