import { Module } from '@nestjs/common';
import { OnchainModule } from '../onchain/onchain.module';
import { RiskEngineModule } from '../risk-engine/risk-engine.module';
import { GeckoTerminalService } from '../collector/geckoterminal/geckoterminal.service';
import { PaperService } from './paper.service';
import { EvalService } from './eval.service';
import { PostmortemService } from '../postmortem/postmortem.service';
import { EdgeService } from '../edge/edge.service';

// PrismaService + FileLoggerService + ConfigService are global. EvalService additionally
// needs on-chain re-reads (OnchainModule), best-effort risk re-checks (RiskEngineModule),
// and current pool trade stats. GeckoTerminalService is stateless (ConfigService only), so
// it is provided directly here to avoid a circular dependency with CollectorModule.
@Module({
  imports: [OnchainModule, RiskEngineModule],
  providers: [PaperService, EvalService, PostmortemService, EdgeService, GeckoTerminalService],
  exports: [PaperService, EvalService, PostmortemService, EdgeService],
})
export class PaperModule {}
