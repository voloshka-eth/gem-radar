import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { ResearchRetentionService } from './research-retention.service';

function config(archiveDir: string): any {
  return {
    get: jest.fn((key: string) => ({
      'maintenance.hotRawDays': 7,
      'maintenance.archiveDays': 90,
      'maintenance.batchSize': 10,
      'maintenance.archiveDir': archiveDir,
    })[key]),
  } as Partial<ConfigService>;
}

function emptyDelegate() {
  return { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn() };
}

describe('ResearchRetentionService', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gem-retention-'));
  });

  afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it('archives raw payloads before deleting their exact IDs', async () => {
    const rawCollectorPayload = {
      findMany: jest.fn()
        .mockResolvedValueOnce([{ id: 'payload-1', ts: new Date(Date.now() - 8 * 86_400_000), payload: { x: 1 } }])
        .mockResolvedValueOnce([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const prisma: any = {
      evmSwapObservation: emptyDelegate(),
      solanaSwapObservation: emptyDelegate(),
      rawCollectorPayload,
      evmPoolWatch: emptyDelegate(),
      solanaLaunchWatch: emptyDelegate(),
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    };
    const service = new ResearchRetentionService(config(tempDir) as ConfigService, prisma, { archiveActiveRawLogs: jest.fn(() => 0) } as any);

    await service.runNow();

    expect(rawCollectorPayload.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['payload-1'] } } });
    const day = new Date(Date.now() - 8 * 86_400_000).toISOString().slice(0, 10);
    const archives = fs.readdirSync(path.join(tempDir, 'raw_collector_payloads', day));
    expect(archives.some((name) => name.endsWith('.jsonl.gz'))).toBe(true);
    expect(archives.some((name) => name.endsWith('.manifest.json'))).toBe(true);
  });

  it('does not delete data if archive creation fails', async () => {
    const blockedPath = path.join(tempDir, 'blocked');
    fs.writeFileSync(blockedPath, 'not a directory');
    const rawCollectorPayload = {
      findMany: jest.fn().mockResolvedValue([{ id: 'payload-1', ts: new Date(), payload: {} }]),
      deleteMany: jest.fn(),
    };
    const prisma: any = {
      evmSwapObservation: emptyDelegate(),
      solanaSwapObservation: emptyDelegate(),
      rawCollectorPayload,
      evmPoolWatch: emptyDelegate(),
      solanaLaunchWatch: emptyDelegate(),
      $executeRawUnsafe: jest.fn(),
    };
    const service = new ResearchRetentionService(config(blockedPath) as ConfigService, prisma, { archiveActiveRawLogs: jest.fn(() => 0) } as any);

    await expect(service.runNow()).rejects.toThrow();
    expect(rawCollectorPayload.deleteMany).not.toHaveBeenCalled();
  });

  it('queries EVM observations with unresolved/open-position safety guards', async () => {
    const evmSwapObservation = emptyDelegate();
    const prisma: any = {
      evmSwapObservation,
      solanaSwapObservation: emptyDelegate(),
      rawCollectorPayload: emptyDelegate(),
      evmPoolWatch: emptyDelegate(),
      solanaLaunchWatch: emptyDelegate(),
      $executeRawUnsafe: jest.fn(),
    };
    const service = new ResearchRetentionService(config(tempDir) as ConfigService, prisma, { archiveActiveRawLogs: jest.fn(() => 0) } as any);

    await service.runNow();

    const where = evmSwapObservation.findMany.mock.calls[0][0].where;
    expect(where.watch.outcomeDueAt.lt).toBeInstanceOf(Date);
    expect(where.watch.signals.none.paperPosition.is.status).toBe('OPEN');
    expect(where.watch.robinhoodExperiments.none.arms.some.status.in).toContain('OPEN');
  });
});
