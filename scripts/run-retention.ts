import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MaintenanceAppModule } from '../src/maintenance/maintenance-app.module';
import { ResearchRetentionService } from '../src/maintenance/research-retention.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(MaintenanceAppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const result = await app.get(ResearchRetentionService).runNow();
    new Logger('RetentionScript').log(`Done: ${JSON.stringify(result)}`);
  } finally {
    await app.close();
  }
}

void main();
