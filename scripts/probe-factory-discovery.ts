import 'reflect-metadata';

process.env.COLLECTOR_AUTOSTART = 'false';
process.env.PAPER_EVAL_AUTOSTART = 'false';
process.env.GEM_SHADOW_AUTOSTART = 'false';

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { FactoryPoolDiscoveryService } from '../src/onchain/factory-pool-discovery.service';
import { LiquidityVerificationService } from '../src/onchain/liquidity-verification.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const discovery = app.get(FactoryPoolDiscoveryService);
    const verifyLiquidity = process.argv.includes('--verify');
    const liquidityVerifier = verifyLiquidity ? app.get(LiquidityVerificationService) : null;
    for (const chain of ['ethereum', 'base'] as const) {
      const pools = await discovery.getPendingPools(chain);
      console.log(`${chain}: ${pools.length} factory pool(s) awaiting liquidity admission`);
      for (const pool of pools.slice(0, 10)) {
        console.log(`  ${pool.pool.dex} ${pool.token.tokenAddress} ${pool.pool.poolAddress} created=${pool.pool.poolCreatedAt?.toISOString() ?? '?'}`);
        if (liquidityVerifier) {
          const liq = await liquidityVerifier.verify(pool.pool, pool.token.decimals);
          console.log(
            `    verified=${liq.liquidityVerified} model=${liq.liquidityModel} ` +
            `depth=$${liq.executableDepthUsd ?? '?'} price=${liq.spotPriceUsd ?? '?'} ${liq.error ? `error=${liq.error}` : ''}`,
          );
        }
      }
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
