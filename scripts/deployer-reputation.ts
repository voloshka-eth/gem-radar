/**
 * Backfill/refresh deployer reputation from observed outcomes.
 *
 * Sources:
 * - paper_positions.outcome_class in RUG / UNSELLABLE / LIQ_PULL
 * - gem_shadow_ticks.rug_flag=true via gem_candidates.deployer_address
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DeployerReputationService } from '../src/deployer/deployer-reputation.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const service = app.get(DeployerReputationService);
  const result = await service.refreshAll();

  console.log(
    `Deployer reputation refreshed: deployers=${result.deployersUpdated} ` +
    `deployments=${result.deploymentsTracked} rug_like=${result.rugLikeTokens}`,
  );
  await app.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
