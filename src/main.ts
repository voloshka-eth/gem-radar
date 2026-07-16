import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });

  const port = process.env.PORT ?? 3847;
  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`Gem Radar running on port ${port}`);
  const config = app.get(ConfigService);
  logger.log(
    `Runtime config: strategy=${config.get<string>('app.strategyMode') ?? 'unknown'} ` +
    `chains=${(config.get<string[]>('chain.enabledChains') ?? []).join(',')} ` +
    `unknownResearch=${config.get<boolean>('collector.promoteCleanUnknownEnabled') ?? false} ` +
    `mintShadow=${config.get<boolean>('collector.contractRiskShadowEnabled') ?? false} ` +
    `evalIntervalMs=${config.get<number>('paper.evalIntervalMs') ?? 300000} ` +
    `youngEvalMs=${config.get<number>('paper.evalYoungIntervalMs') ?? 60000}`,
  );

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, async () => {
      logger.log(`Received ${signal}, shutting down gracefully`);
      await app.close();
      process.exit(0);
    });
  }
}

bootstrap();
