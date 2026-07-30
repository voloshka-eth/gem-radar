import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServer } from 'node:net';
import { AppModule } from './app.module';

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port);
  });
}

async function bootstrap(): Promise<void> {
  const port = Number(process.env.PORT ?? 3847);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: ${process.env.PORT}`);
  }
  if (!(await isPortAvailable(port))) {
    console.error(
      `[Gem Radar] Port ${port} is already in use. The main collector is likely already running; ` +
      'close that process before starting another one.',
    );
    process.exitCode = 1;
    return;
  }

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });

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
