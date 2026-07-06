/**
 * Persistently block a deployer wallet from future collector entries.
 *
 * Usage:
 *   npm run deployers:block -- base 0xabc... "repeat rug deployer"
 */
import 'reflect-metadata';
process.env.COLLECTOR_AUTOSTART = 'false';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { SupportedChain } from '../src/collector/collector.types';
import { DeployerReputationService } from '../src/deployer/deployer-reputation.service';

const SUPPORTED = new Set(['ethereum', 'base']);

async function main(): Promise<void> {
  const [chainArg, addressArg, ...reasonParts] = process.argv.slice(2);
  const chain = chainArg as SupportedChain;
  const address = addressArg?.toLowerCase();
  const reason = reasonParts.join(' ').trim() || 'manual_block';

  if (!SUPPORTED.has(chain)) {
    throw new Error('Usage: npm run deployers:block -- <ethereum|base> <0xaddress> [reason]');
  }
  if (!address || !/^0x[a-f0-9]{40}$/.test(address)) {
    throw new Error(`Invalid deployer address: ${addressArg ?? '<missing>'}`);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  const deployers = app.get(DeployerReputationService);
  const hit = await deployers.addBlocklistEntry(chain, address, reason, 'manual');
  await app.close();

  console.log(`Blocked deployer: ${hit.chain}:${hit.address} (${hit.reason})`);
  console.log('Stored in logs/state/deployer_blocklist.jsonl');
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
