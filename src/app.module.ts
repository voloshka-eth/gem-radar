import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { QueueModule } from './queue/queue.module';
import { FileLoggerModule } from './file-logger/file-logger.module';
import { CollectorModule } from './collector/collector.module';
import { ReportModule } from './report/report.module';
import { PaperModule } from './paper/paper.module';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    ScheduleModule.forRoot(),
    QueueModule,
    FileLoggerModule,
    CollectorModule,
    ReportModule,
    PaperModule,
  ],
})
export class AppModule {}
