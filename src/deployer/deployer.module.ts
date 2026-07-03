import { Module } from '@nestjs/common';
import { DeployerReputationService } from './deployer-reputation.service';

@Module({
  providers: [DeployerReputationService],
  exports: [DeployerReputationService],
})
export class DeployerModule {}
