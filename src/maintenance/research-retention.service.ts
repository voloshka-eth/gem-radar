import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { FileLoggerService } from '../file-logger/file-logger.service';

type AnyRow = Record<string, any>;
type ArchiveTable = 'evm_swap_observations' | 'solana_swap_observations' | 'raw_collector_payloads' |
  'evm_pool_watches' | 'solana_launch_watches';

export type RetentionSummary = {
  archivedRows: number;
  deletedRows: number;
  deletedArchives: number;
  rotatedLogFiles: number;
  vacuumAttempted: boolean;
};

@Injectable()
export class ResearchRetentionService {
  private readonly logger = new Logger(ResearchRetentionService.name);
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly files: FileLoggerService,
  ) {}

  @Cron('17 3 * * *')
  async scheduledRetention(): Promise<void> {
    if (!(this.config.get<boolean>('maintenance.retentionEnabled') ?? true)) return;
    await this.runNow();
  }

  async runNow(): Promise<RetentionSummary> {
    if (this.running) {
      this.logger.warn('Research retention skipped: previous run still active');
      return { archivedRows: 0, deletedRows: 0, deletedArchives: 0, rotatedLogFiles: 0, vacuumAttempted: false };
    }
    this.running = true;
    try {
      const now = new Date();
      const hotRawDays = this.config.get<number>('maintenance.hotRawDays') ?? 7;
      const archiveDays = this.config.get<number>('maintenance.archiveDays') ?? 90;
      const batchSize = this.config.get<number>('maintenance.batchSize') ?? 500;
      const archiveDir = this.config.get<string>('maintenance.archiveDir') ?? './logs/archive';
      const cutoff = new Date(now.getTime() - hotRawDays * 86_400_000);
      const summary: RetentionSummary = {
        archivedRows: 0, deletedRows: 0, deletedArchives: 0,
        rotatedLogFiles: this.files.archiveActiveRawLogs(), vacuumAttempted: false,
      };

      // Raw observations are removable only after their watch can no longer
      // drive an active signal or open arm. Signals/legs themselves stay forever.
      await this.archiveAndDelete('evm_swap_observations', 'evmSwapObservation', {
        ts: { lt: cutoff },
        watch: {
          outcomeDueAt: { lt: now },
          signals: { none: { paperPosition: { is: { status: 'OPEN' } } } },
          robinhoodExperiments: {
            none: { arms: { some: { status: { in: ['PENDING_ENTRY', 'WAITING_CONFIRMATION', 'OPEN'] } } } },
          },
        },
      }, 'ts', batchSize, archiveDir, summary);
      await this.archiveAndDelete('solana_swap_observations', 'solanaSwapObservation', {
        ts: { lt: cutoff },
        watch: {
          latestEventAt: { lt: cutoff },
          signals: {
            none: {
              OR: [
                { status: { in: ['ACTIVE', 'CONFIRMED'] } },
                { arms: { some: { status: 'OPEN' } } },
              ],
            },
          },
        },
      }, 'ts', batchSize, archiveDir, summary);
      await this.archiveAndDelete('raw_collector_payloads', 'rawCollectorPayload', {
        ts: { lt: cutoff },
      }, 'ts', batchSize, archiveDir, summary);

      // These rows have no strategy signal, execution leg, or remaining raw
      // observations. Keeping them adds no reproducibility value.
      await this.archiveAndDelete('evm_pool_watches', 'evmPoolWatch', {
        createdAt: { lt: cutoff },
        outcomeDueAt: { lt: now },
        status: { not: 'WATCHING' },
        signals: { none: {} },
        swaps: { none: {} },
        backfills: { none: {} },
        robinhoodExperiments: { none: {} },
      }, 'createdAt', batchSize, archiveDir, summary);
      await this.archiveAndDelete('solana_launch_watches', 'solanaLaunchWatch', {
        createdAt: { lt: cutoff },
        latestEventAt: { lt: cutoff },
        status: { not: 'WATCHING' },
        signals: { none: {} },
        observations: { none: {} },
        poolEras: { none: {} },
      }, 'createdAt', batchSize, archiveDir, summary);

      summary.deletedArchives = this.pruneExpiredArchives(archiveDir, archiveDays, now);
      if (summary.deletedRows > 0) {
        summary.vacuumAttempted = true;
        await this.prisma.$executeRawUnsafe('VACUUM (ANALYZE)').catch((error) => {
          this.logger.warn(`Research retention VACUUM failed: ${(error as Error).message}`);
        });
      }
      this.logger.log(
        `Research retention complete: archived=${summary.archivedRows} deleted=${summary.deletedRows} ` +
        `expiredArchives=${summary.deletedArchives} rotatedLogs=${summary.rotatedLogFiles} vacuum=${summary.vacuumAttempted}`,
      );
      return summary;
    } finally {
      this.running = false;
    }
  }

  private async archiveAndDelete(
    table: ArchiveTable,
    delegateName: string,
    where: AnyRow,
    timestampField: 'ts' | 'createdAt',
    batchSize: number,
    archiveDir: string,
    summary: RetentionSummary,
  ): Promise<void> {
    const delegate = (this.prisma as any)[delegateName];
    if (!delegate?.findMany || !delegate?.deleteMany) return;

    while (true) {
      const rows = await delegate.findMany({
        where,
        orderBy: [{ [timestampField]: 'asc' }, { id: 'asc' }],
        take: batchSize,
      }) as AnyRow[];
      if (rows.length === 0) return;

      const archive = this.writeArchive(table, rows, timestampField, archiveDir);
      await delegate.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
      summary.archivedRows += archive.rowCount;
      summary.deletedRows += rows.length;
      if (rows.length < batchSize) return;
    }
  }

  private writeArchive(
    table: ArchiveTable,
    rows: readonly AnyRow[],
    timestampField: 'ts' | 'createdAt',
    archiveDir: string,
  ): { rowCount: number } {
    const first = rows[0];
    const last = rows[rows.length - 1];
    const day = new Date(first[timestampField]).toISOString().slice(0, 10);
    const directory = path.resolve(archiveDir, table, day);
    const archivePath = path.join(directory, `${first.id}_${last.id}.jsonl.gz`);
    const manifestPath = `${archivePath}.manifest.json`;
    const jsonl = rows.map((row) => JSON.stringify(row, jsonReplacer)).join('\n') + '\n';
    const compressed = zlib.gzipSync(Buffer.from(jsonl, 'utf8'), { level: zlib.constants.Z_BEST_COMPRESSION });
    const sha256 = crypto.createHash('sha256').update(compressed).digest('hex');

    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(archivePath) || fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { sha256?: string; rowCount?: number };
      const existingHash = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
      if (manifest.sha256 !== sha256 || existingHash !== sha256 || manifest.rowCount !== rows.length) {
        throw new Error(`Archive collision for ${table} ${first.id}-${last.id}`);
      }
      return { rowCount: rows.length };
    }

    writeAtomic(archivePath, compressed);
    writeAtomic(manifestPath, Buffer.from(JSON.stringify({
      schemaVersion: 1,
      table,
      rowCount: rows.length,
      timestampField,
      from: new Date(first[timestampField]).toISOString(),
      to: new Date(last[timestampField]).toISOString(),
      firstId: first.id,
      lastId: last.id,
      sha256,
      createdAt: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8'));
    return { rowCount: rows.length };
  }

  private pruneExpiredArchives(archiveDir: string, archiveDays: number, now: Date): number {
    const root = path.resolve(archiveDir);
    if (!fs.existsSync(root)) return 0;
    const cutoffDay = new Date(now.getTime() - archiveDays * 86_400_000).toISOString().slice(0, 10);
    let deleted = 0;
    for (const table of fs.readdirSync(root, { withFileTypes: true })) {
      if (!table.isDirectory()) continue;
      const tableDir = path.join(root, table.name);
      for (const day of fs.readdirSync(tableDir, { withFileTypes: true })) {
        if (!day.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(day.name) || day.name >= cutoffDay) continue;
        const dayDir = path.join(tableDir, day.name);
        for (const file of fs.readdirSync(dayDir)) {
          fs.unlinkSync(path.join(dayDir, file));
          deleted++;
        }
        fs.rmdirSync(dayDir);
      }
    }
    return deleted;
  }
}

function writeAtomic(target: string, content: Buffer): void {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, target);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}
