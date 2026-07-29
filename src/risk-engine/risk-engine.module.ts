import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RiskEngineService } from './risk-engine.service';
import { GoPlusService } from './providers/goplus.service';
import { HoneypotService } from './providers/honeypot.service';
import { BubblemapsService } from './providers/bubblemaps.service';
import { FreeHolderConcentrationService } from './providers/free-holder-concentration.service';
import { RISK_REDIS_CLIENT } from './risk-engine.constants';

@Module({
  providers: [
    RiskEngineService,
    GoPlusService,
    HoneypotService,
    BubblemapsService,
    FreeHolderConcentrationService,
    {
      provide: RISK_REDIS_CLIENT,
      useFactory: (config: ConfigService) =>
        new Redis({
          host: config.get<string>('redis.host') ?? 'localhost',
          port: config.get<number>('redis.port') ?? 6379,
          password: config.get<string>('redis.password'),
          // lazyConnect + enableOfflineQueue=false ensures tests don't hang
          // waiting for a real Redis connection.
          lazyConnect: true,
          enableOfflineQueue: false,
        }),
      inject: [ConfigService],
    },
  ],
  exports: [RiskEngineService, BubblemapsService, FreeHolderConcentrationService],
})
export class RiskEngineModule {}
