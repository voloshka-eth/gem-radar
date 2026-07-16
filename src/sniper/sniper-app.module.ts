import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { SniperModule } from './sniper.module';

@Module({
  imports: [ConfigModule, SniperModule],
})
export class SniperAppModule {}

