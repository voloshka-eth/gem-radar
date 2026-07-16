import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SniperJournalService } from './sniper-journal.service';

describe('SniperJournalService process lock', () => {
  let logDir: string;

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gem-radar-sniper-'));
  });

  afterEach(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('prevents two watcher processes from owning the same state', () => {
    const config = {
      get: <T>(key: string): T | undefined => key === 'app.logDir' ? logDir as T : undefined,
    } as ConfigService;
    const first = new SniperJournalService(config);
    const second = new SniperJournalService(config);

    first.onModuleInit();
    expect(() => second.onModuleInit()).toThrow('Another launch sniper is already running');
    first.onModuleDestroy();
    expect(() => second.onModuleInit()).not.toThrow();
    second.onModuleDestroy();
  });
});
