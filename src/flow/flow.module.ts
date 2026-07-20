import { Module } from '@nestjs/common';
import { DeployerModule } from '../deployer/deployer.module';
import { OnchainModule } from '../onchain/onchain.module';
import { PaperModule } from '../paper/paper.module';
import { RiskEngineModule } from '../risk-engine/risk-engine.module';
import { EvmFlowService } from './evm-flow.service';

@Module({
  imports: [OnchainModule, RiskEngineModule, PaperModule, DeployerModule],
  providers: [EvmFlowService],
  exports: [EvmFlowService],
})
export class FlowModule {}

