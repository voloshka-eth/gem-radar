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

  it('exports paper entries and exits as CSV alongside the raw journal', () => {
    const config = {
      get: <T>(key: string): T | undefined => key === 'app.logDir' ? logDir as T : undefined,
    } as ConfigService;
    const journal = new SniperJournalService(config);
    journal.onModuleInit();

    journal.append({
      ts: '2026-07-19T00:00:00.000Z', strategyVersion: 'test', type: 'ENTER', chain: 'bsc',
      launchpad: 'four_meme', token: '0x111', symbol: 'TEST', creator: '0x222',
      positionSizeQuote: 0.02, entryMarketPrice: 1, entryEffectivePrice: 1.03, tokensBought: 0.019,
      features: { buys: 3, uniqueBuyers: 3, buyQuote: 0.2, buySellRatio: 2.5, priceMomentum: 1.1 },
    });
    journal.append({
      ts: '2026-07-19T00:01:00.000Z', strategyVersion: 'test', type: 'CREATOR_EXIT', chain: 'bsc',
      launchpad: 'four_meme', token: '0x111', symbol: 'TEST', priceQuotePerToken: 0.5,
      netMultiple: 0.4, fraction: 1, quoteValue: 0.008, remainingFraction: 0,
      realizedMultiple: 0.4, note: 'creator sold after entry', exitSignal: 'creator_sold',
    });

    const entryCsv = fs.readFileSync(path.join(logDir, 'sniper', 'paper_entries.csv'), 'utf8');
    const exitCsv = fs.readFileSync(path.join(logDir, 'sniper', 'paper_exits.csv'), 'utf8');
    expect(entryCsv).toContain('size_bnb');
    expect(entryCsv).toContain('0x111');
    expect(exitCsv).toContain('CREATOR_EXIT');
    expect(exitCsv).toContain(',RUG,test');
    journal.onModuleDestroy();
  });
});
