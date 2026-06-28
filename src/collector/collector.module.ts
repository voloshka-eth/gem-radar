import { Module } from '@nestjs/common';
import { GeckoTerminalService } from './geckoterminal/geckoterminal.service';
import { DexScreenerService } from './dexscreener/dexscreener.service';
import { CollectorService } from './collector.service';
import { RiskEngineModule } from '../risk-engine/risk-engine.module';
import { OnchainModule } from '../onchain/onchain.module';
import { ScoringModule } from '../scoring/scoring.module';
import { PaperModule } from '../paper/paper.module';

@Module({
  imports: [RiskEngineModule, OnchainModule, ScoringModule, PaperModule],
  providers: [GeckoTerminalService, DexScreenerService, CollectorService],
  exports: [CollectorService],
})
export class CollectorModule {}
