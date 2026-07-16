import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { SniperAppModule } from './sniper/sniper-app.module';

// This command is intentionally isolated from the main legacy radar runtime.
process.env.STRATEGY_MODE = 'launch_sniper_paper';
process.env.LAUNCH_SNIPER_ENABLED = 'true';
process.env.LAUNCH_SNIPER_MODE = 'paper';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(SniperAppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });
  const logger = new Logger('SniperBootstrap');
  const config = app.get(ConfigService);
  logger.log(
    `Headless launch sniper: strategy=${config.get<string>('app.strategyMode')} ` +
    `enabled=${config.get<boolean>('launchSniper.enabled')} ` +
    `mode=${config.get<string>('launchSniper.mode')}`,
  );

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, async () => {
      logger.log(`Received ${signal}, shutting down gracefully`);
      await app.close();
      process.exit(0);
    });
  }
}

void bootstrap();
