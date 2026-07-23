import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { FileLoggerModule } from '../file-logger/file-logger.module';
import { SolanaModule } from './solana.module';

@Module({
  imports: [ConfigModule, DatabaseModule, FileLoggerModule, SolanaModule],
})
export class SolanaAppModule {}
