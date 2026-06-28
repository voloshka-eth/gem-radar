import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });

  const port = process.env.PORT ?? 3847;
  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`Gem Radar running on port ${port}`);

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, async () => {
      logger.log(`Received ${signal}, shutting down gracefully`);
      await app.close();
      process.exit(0);
    });
  }
}

bootstrap();
