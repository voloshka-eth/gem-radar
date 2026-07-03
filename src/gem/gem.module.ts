import { Module } from '@nestjs/common';
import { OnchainModule } from '../onchain/onchain.module';
import { RiskEngineModule } from '../risk-engine/risk-engine.module';
import { GeckoTerminalService } from '../collector/geckoterminal/geckoterminal.service';
import { LpLockService } from './lp-lock.service';
import { GemScreenService } from './gem-screen.service';
import { ShadowTrackerService } from './shadow-tracker.service';
import { GemReportService } from './gem-report.service';

// Shadow gem-tracker (OBSERVATION ONLY). OnchainModule provides LiquidityVerificationService
// + VIEM_CLIENTS (for LP-lock reads); RiskEngineModule provides the sell-sim re-check.
// GeckoTerminalService is stateless (ConfigService only) → provided directly.
@Module({
  imports: [OnchainModule, RiskEngineModule],
  providers: [LpLockService, GemScreenService, ShadowTrackerService, GemReportService, GeckoTerminalService],
  exports: [GemScreenService, ShadowTrackerService, GemReportService],
})
export class GemModule {}
