import 'reflect-metadata';
process.env.COLLECTOR_AUTOSTART = 'false';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { CollectorService } from '../src/collector/collector.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const collector = app.get(CollectorService);
    await collector.runCollectionCycle();
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
