/**
 * Liquidity verification harness — runs REAL pools through the PRODUCTION
 * LiquidityVerificationService.verify() path and writes real rows to
 * logs/raw/pool_liquidity_snapshots.csv (same writer the collector uses).
 *
 * Why this exists: the organic new-pools feed is dominated by scam pools with
 * fabricated reported liquidity (correctly → verified=false). To produce live
 * evidence that the V3 path yields SANE verified=true rows, we push a handful of
 * well-known, genuinely-liquid public V3 pools through the exact same service.
 * Nothing here is mocked: real RPC reads, real DefiLlama prices, real guard.
 *
 * `reported_liquidity_usd` is fetched live from DexScreener (a real collector
 * source) — not hand-entered — so the divergence check is exercised honestly.
 *
 * Usage:  npm run verify:pools
 */
import 'reflect-metadata';
import axios from 'axios';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { LiquidityVerificationService } from '../src/onchain/liquidity-verification.service';
import { FileLoggerService } from '../src/file-logger/file-logger.service';
import { CSV_SCHEMA_VERSION } from '../src/file-logger/csv-schemas';
import type { CandidatePool, SupportedChain } from '../src/collector/collector.types';

interface PoolSpec {
  label: string;
  chain: SupportedChain;
  poolAddress: string;
  dex: string;
  token0Address: string;
  token1Address: string;
  quoteAsset: string;        // 'WETH' | 'USDC' | ...
  quoteAssetAddress: string;
  gemDecimals: number;
  note: string;
}

// Real, public Uniswap V3 pools. Addresses are lowercased to match pipeline convention.
const POOLS: PoolSpec[] = [
  {
    label: 'LIQUID — Base WETH/USDC 0.05%',
    chain: 'base',
    poolAddress: '0xd0b53d9277642d899df5c87a3966a349a798f224',
    dex: 'Uniswap V3 (Base)',
    token0Address: '0x4200000000000000000000000000000000000006', // WETH
    token1Address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
    quoteAsset: 'USDC',
    quoteAssetAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    gemDecimals: 18,
    note: 'deep blue-chip pool — expect verified=true, slip << 1%',
  },
  {
    label: 'LIQUID — Ethereum WETH/USDC 0.05%',
    chain: 'ethereum',
    poolAddress: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    dex: 'Uniswap V3',
    token0Address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    token1Address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
    quoteAsset: 'USDC',
    quoteAssetAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    gemDecimals: 18,
    note: 'deep blue-chip pool — expect verified=true, slip << 1%',
  },
  {
    label: 'LIQUID — Ethereum WETH/USDC 0.3%',
    chain: 'ethereum',
    poolAddress: '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8',
    dex: 'Uniswap V3',
    token0Address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    token1Address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
    quoteAsset: 'USDC',
    quoteAssetAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    gemDecimals: 18,
    note: 'deep blue-chip pool — expect verified=true, slip < 1%',
  },
  {
    label: 'THIN — Base FABLE5/WETH 1% (from live feed)',
    chain: 'base',
    poolAddress: '0xd965476f5481858a22a4536f2646d9ceaf22f709',
    dex: 'Uniswap V3 (Base)',
    token0Address: '0x0c39fc40cb1e899b55a3c58b564412b93e4c21f3', // FABLE5
    token1Address: '0x4200000000000000000000000000000000000006', // WETH
    quoteAsset: 'WETH',
    quoteAssetAddress: '0x4200000000000000000000000000000000000006',
    gemDecimals: 18,
    note: 'real quote balance ~$0.003 vs $33k reported — expect implausible_read',
  },
];

// Live reported liquidity from DexScreener (real collector source).
async function fetchReportedUsd(chain: string, pair: string): Promise<{ liq?: number; fdv?: number }> {
  try {
    const r = await axios.get<{ pairs?: Array<{ liquidity?: { usd?: number }; fdv?: number }> }>(
      `https://api.dexscreener.com/latest/dex/pairs/${chain}/${pair}`,
      { timeout: 8000 },
    );
    const p = r.data?.pairs?.[0];
    return { liq: p?.liquidity?.usd, fdv: p?.fdv };
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const verifier   = app.get(LiquidityVerificationService);
  const fileLogger = app.get(FileLoggerService);
  const runId = `verify-harness-${new Date().toISOString().slice(0, 19)}`;

  console.log('\n' + '═'.repeat(72));
  console.log('  verify:pools — real pools through production verify()');
  console.log('═'.repeat(72));

  for (const spec of POOLS) {
    const { liq: reportedUsd, fdv } = await fetchReportedUsd(spec.chain, spec.poolAddress);

    const pool: CandidatePool = {
      chain: spec.chain,
      poolAddress: spec.poolAddress.toLowerCase(),
      dex: spec.dex,
      token0Address: spec.token0Address.toLowerCase(),
      token1Address: spec.token1Address.toLowerCase(),
      quoteAsset: spec.quoteAsset,
      quoteAssetAddress: spec.quoteAssetAddress.toLowerCase(),
      liquidityUsd: reportedUsd,
      fdvUsd: fdv,
      source: 'verify-harness',
    };

    const liq = await verifier.verify(pool, spec.gemDecimals);

    fileLogger.logLiquiditySnapshot({
      ts:                      new Date().toISOString(),
      run_id:                  runId,
      schema_version:          CSV_SCHEMA_VERSION,
      chain:                   pool.chain,
      token_address:           spec.token0Address.toLowerCase(),
      pool_address:            pool.poolAddress,
      dex:                     pool.dex,
      liquidity_model:         liq.liquidityModel,
      liquidity_verified:      String(liq.liquidityVerified),
      reported_liquidity_usd:  reportedUsd?.toString() ?? '',
      onchain_tvl_usd:         liq.onchainTvlUsd?.toFixed(4) ?? '',
      reported_vs_onchain_pct: liq.reportedVsOnchainPct?.toFixed(6) ?? '',
      executable_depth_usd:    liq.executableDepthUsd?.toString() ?? '',
      slip_50:                 liq.slip50?.toFixed(6) ?? '',
      slip_100:                liq.slip100?.toFixed(6) ?? '',
      slip_500:                liq.slip500?.toFixed(6) ?? '',
      slip_1000:               liq.slip1000?.toFixed(6) ?? '',
      spot_price_usd:          liq.spotPriceUsd?.toFixed(12) ?? '',
      error:                   liq.error ?? '',
    });

    const slips = [liq.slip50, liq.slip100, liq.slip500, liq.slip1000]
      .map((s) => (s != null ? (s * 100).toFixed(3) + '%' : '–')).join(' / ');
    console.log(
      `\n${spec.label}\n` +
      `  ${spec.note}\n` +
      `  model=${liq.liquidityModel}  verified=${liq.liquidityVerified}` +
      `${liq.error ? `  error=${liq.error}` : ''}\n` +
      `  reported=$${reportedUsd?.toFixed(0) ?? '?'}  onchain_tvl=$${liq.onchainTvlUsd?.toFixed(2) ?? '?'}\n` +
      `  slip 50/100/500/1000 = ${slips}`,
    );
  }

  console.log('\n' + '═'.repeat(72));
  console.log('  Rows appended to logs/raw/pool_liquidity_snapshots.csv');
  console.log('═'.repeat(72) + '\n');

  await app.close();
  process.exit(0);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
