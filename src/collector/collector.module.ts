import { Module } from '@nestjs/common';
import { GeckoTerminalService } from './geckoterminal/geckoterminal.service';
import { DexScreenerService } from './dexscreener/dexscreener.service';
import { MoralisService } from './moralis/moralis.service';
import { BirdeyeService } from './birdeye/birdeye.service';
import { CollectorService } from './collector.service';
import { RiskEngineModule } from '../risk-engine/risk-engine.module';
import { OnchainModule } from '../onchain/onchain.module';
import { ScoringModule } from '../scoring/scoring.module';
import { PaperModule } from '../paper/paper.module';
import { DeployerModule } from '../deployer/deployer.module';

@Module({
  imports: [RiskEngineModule, OnchainModule, ScoringModule, PaperModule, DeployerModule],
  providers: [GeckoTerminalService, DexScreenerService, MoralisService, BirdeyeService, CollectorService],
  exports: [CollectorService],
})
export class CollectorModule {}
