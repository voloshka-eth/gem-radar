/**
 * M5 — Edge report over CLOSED paper positions.  `npm run edge`
 * Headline expectancy is NET of all modeled costs. "No edge" is a valid outcome.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { EdgeService } from '../src/edge/edge.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const report = await app.get(EdgeService).run();
  console.log('\n' + report);
  process.exit(0);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
