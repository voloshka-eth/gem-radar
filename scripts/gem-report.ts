/**
 * Shadow gem-tracker — OUTCOME DISTRIBUTION REPORT.  `npm run gem:report`
 * Forward-return distribution of the survivor cohort (does the funnel have an x10–x1000 tail?).
 */
import 'reflect-metadata';
process.env.COLLECTOR_AUTOSTART = 'false';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { GemReportService } from '../src/gem/gem-report.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const report = await app.get(GemReportService).run();
  console.log('\n' + report);
  process.exit(0);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
