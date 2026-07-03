/**
 * Shadow gem-tracker — FORWARD TRACKER.  `npm run gem:shadow`
 * Snapshots each gem_candidate's forward state at due horizons (T+15m/1h/6h/24h/72h).
 * No entry, no trade — observation only.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { ShadowTrackerService } from '../src/gem/shadow-tracker.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  const r = await app.get(ShadowTrackerService).track();
  console.log(`\nShadow tracker: ${r.candidates} candidate(s); ${r.captured} horizon(s) captured, ${r.missed} marked missed.`);
  process.exit(0);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
