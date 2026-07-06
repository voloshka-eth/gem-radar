/**
 * Triggers the report generator immediately (window = today UTC 00:00 → now).
 * Requires DB + Redis to be running.
 *
 * Usage:  npm run report:now
 */
import 'reflect-metadata';
process.env.COLLECTOR_AUTOSTART = 'false';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { ReportService } from '../src/report/report.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const report = app.get(ReportService);
  await report.generateNow();

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
