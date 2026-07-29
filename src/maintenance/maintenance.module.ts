import { Module } from '@nestjs/common';
import { ResearchRetentionService } from './research-retention.service';

@Module({
  providers: [ResearchRetentionService],
  exports: [ResearchRetentionService],
})
export class MaintenanceModule {}
