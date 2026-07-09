/**
 * Research benchmark dashboard. `npm run benchmark`
 *
 * Runs the three local reality checks that answer:
 * - does the scored paper strategy beat enter-all?
 * - which t0 features separate bad vs good closed positions?
 * - does the survivor funnel have a forward-return tail worth studying?
 */
import 'reflect-metadata';
process.env.COLLECTOR_AUTOSTART = 'false';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { EdgeService } from '../src/edge/edge.service';
import { PostmortemService } from '../src/postmortem/postmortem.service';
import { GemReportService } from '../src/gem/gem-report.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const edge = await app.get(EdgeService).run();
    const postmortem = await app.get(PostmortemService).run();
    const gem = await app.get(GemReportService).run();

    console.log([
      '',
      '############################',
      '# GEM RADAR BENCHMARK SUITE',
      '############################',
      '',
      edge,
      '',
      postmortem,
      '',
      gem,
    ].join('\n'));
  } finally {
    await app.close();
  }
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
