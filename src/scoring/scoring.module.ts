import { Module } from '@nestjs/common';
import { ScoringService } from './scoring.service';

// ConfigModule is @Global, so ScoringService can inject ConfigService directly.
@Module({
  providers: [ScoringService],
  exports: [ScoringService],
})
export class ScoringModule {}
