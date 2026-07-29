import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { FileLoggerModule } from '../file-logger/file-logger.module';
import { MaintenanceModule } from './maintenance.module';

/** Minimal context for one-shot maintenance scripts. No collectors are started. */
@Module({
  imports: [ConfigModule, DatabaseModule, FileLoggerModule, MaintenanceModule],
})
export class MaintenanceAppModule {}
