import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SolanaAppModule } from './solana/solana-app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(SolanaAppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });
  const logger = new Logger('SolanaBootstrap');
  logger.log('Headless Solana multi-launch paper collector running; no wallet and no real transactions');

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, async () => {
      logger.log(`Received ${signal}, shutting down gracefully`);
      await app.close();
      process.exit(0);
    });
  }
}

void bootstrap();
