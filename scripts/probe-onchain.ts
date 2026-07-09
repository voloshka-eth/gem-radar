/**
 * Probe a single pool on-chain: tries V2 (getReserves) then V3 (slot0/liquidity/fee),
 * then fetches the quote-asset price from DefiLlama.
 * For V3 pools, also runs a QuoterV2 slippage probe (proves the on-chain quote path works).
 * Prints raw results OR the exact RPC error so you can tell if the failure is
 * connectivity, wrong ABI, or rate-limiting.
 *
 * Usage:
 *   npm run probe:onchain -- <chain> <poolAddress> [quoteAssetAddress]
 *
 * Examples:
 *   npm run probe:onchain -- base 0xd0b53d9277642d899df5c87a3966a349a798f224
 *   npm run probe:onchain -- ethereum 0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2
 *
 * Known V3 pools for testing:
 *   Ethereum ETH/USDC 0.3%: npm run probe:onchain -- ethereum 0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
 *   Base     WETH/USDC 0.05%: npm run probe:onchain -- base 0xd0b53d9277642d899df5c87a3966a349a798f224 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913
 */
import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { createPublicClient, defineChain, http } from 'viem';
import { mainnet, base } from 'viem/chains';
import axios from 'axios';

dotenv.config();

const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
});

// ─── Args ────────────────────────────────────────────────────────────────────

const [, , chainArg, poolAddrArg, quoteAddrArg] = process.argv;

if (!chainArg || !poolAddrArg) {
  console.error('Usage: npm run probe:onchain -- <chain> <poolAddress> [quoteAssetAddress]');
  console.error('  chain: ethereum | base | robinhood');
  process.exit(1);
}

if (chainArg !== 'ethereum' && chainArg !== 'base' && chainArg !== 'robinhood') {
  console.error(`Unknown chain "${chainArg}". Use "ethereum", "base", or "robinhood".`);
  process.exit(1);
}

const chain       = chainArg as 'ethereum' | 'base' | 'robinhood';
const poolAddress = poolAddrArg.toLowerCase() as `0x${string}`;
const quoteAddr   = quoteAddrArg?.toLowerCase() as `0x${string}` | undefined;

// ─── viem client ─────────────────────────────────────────────────────────────

const ethRpc  = process.env.ETHEREUM_RPC_URL ?? 'https://ethereum.publicnode.com';
const baseRpc = process.env.BASE_RPC_URL     ?? 'https://base.publicnode.com';
const robinhoodRpc = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const rpcUrl  = chain === 'ethereum' ? ethRpc : chain === 'base' ? baseRpc : robinhoodRpc;
const viemChain = chain === 'ethereum' ? mainnet : chain === 'base' ? base : robinhood;

const client = createPublicClient({
  chain: viemChain,
  transport: http(rpcUrl),
});

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const TOKEN_ABI = [
  { name: 'token0', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'token1', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

const GET_RESERVES_ABI = [{
  name: 'getReserves', type: 'function', stateMutability: 'view', inputs: [],
  outputs: [{ name: 'reserve0', type: 'uint112' }, { name: 'reserve1', type: 'uint112' }, { name: 'blockTimestampLast', type: 'uint32' }],
}] as const;

const STABLE_ABI = [{ name: 'stable', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] }] as const;
const FEE_ABI   = [{ name: 'fee', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] }] as const;

const SLOT0_ABI = [{
  name: 'slot0', type: 'function', stateMutability: 'view', inputs: [],
  outputs: [
    { name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' },
    { name: 'observationIndex', type: 'uint16' }, { name: 'observationCardinality', type: 'uint16' },
    { name: 'observationCardinalityNext', type: 'uint16' }, { name: 'feeProtocol', type: 'uint8' },
    { name: 'unlocked', type: 'bool' },
  ],
}] as const;

const LIQUIDITY_ABI = [{ name: 'liquidity', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] }] as const;

const BALANCE_OF_ABI = [{
  name: 'balanceOf', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }],
}] as const;

const DECIMALS_ABI = [{ name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }] as const;

// QuoterV2 quoteExactInputSingle — Uniswap V3 periphery
const QUOTER_V2_ABI = [{
  name: 'quoteExactInputSingle',
  type: 'function',
  stateMutability: 'nonpayable',
  inputs: [{
    name: 'params', type: 'tuple',
    components: [
      { name: 'tokenIn',           type: 'address' },
      { name: 'tokenOut',          type: 'address' },
      { name: 'amountIn',          type: 'uint256' },
      { name: 'fee',               type: 'uint24'  },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ],
  }],
  outputs: [
    { name: 'amountOut',               type: 'uint256' },
    { name: 'sqrtPriceX96After',       type: 'uint160' },
    { name: 'initializedTicksCrossed', type: 'uint32'  },
    { name: 'gasEstimate',             type: 'uint256' },
  ],
}] as const;

// Verified against official Uniswap deployment docs
const QUOTER_V2_ADDR: Record<string, string> = {
  ethereum: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  base:     '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  robinhood: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function tryRead<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function sep(title: string) { console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length - 4))}`); }
function row(label: string, value: unknown) { console.log(`   ${label.padEnd(30)} ${value}`); }
function err(label: string, msg: string) { console.log(`   ${label.padEnd(30)} ✗  ${msg.slice(0, 120)}`); }

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═'.repeat(64));
  console.log(`  probe:onchain  chain=${chain}  RPC=${rpcUrl.slice(0, 50)}`);
  console.log(`  pool=${poolAddress}`);
  if (quoteAddr) console.log(`  quote=${quoteAddr}`);
  console.log('═'.repeat(64));

  // ── Token identity ───────────────────────────────────────────────────────
  sep('Token identity');
  const t0 = await tryRead(() => client.readContract({ address: poolAddress, abi: TOKEN_ABI, functionName: 'token0' }));
  const t1 = await tryRead(() => client.readContract({ address: poolAddress, abi: TOKEN_ABI, functionName: 'token1' }));
  if (t0.ok) row('token0', t0.value); else err('token0', t0.error);
  if (t1.ok) row('token1', t1.value); else err('token1', t1.error);

  // ── V2 probe ─────────────────────────────────────────────────────────────
  sep('V2 probe (getReserves)');
  const res = await tryRead(() => client.readContract({ address: poolAddress, abi: GET_RESERVES_ABI, functionName: 'getReserves' }));
  if (res.ok) {
    row('reserve0', res.value[0].toString());
    row('reserve1', res.value[1].toString());
    row('blockTimestampLast', res.value[2].toString());

    const stable = await tryRead(() => client.readContract({ address: poolAddress, abi: STABLE_ABI, functionName: 'stable' }));
    if (stable.ok) row('stable()', stable.value + ' → ' + (stable.value ? 'UNSUPPORTED_AERODROME_STABLE' : 'V2 (volatile)'));
    else           row('stable()', '(not present — standard Uniswap V2)');

    const fee = await tryRead(() => client.readContract({ address: poolAddress, abi: FEE_ABI, functionName: 'fee' }));
    if (fee.ok) row('fee()', fee.value + ' bps'); else row('fee()', '(not present — hardcode 30 bps)');

    console.log('\n  ✓  V2 interface detected');
  } else {
    err('getReserves()', res.error);
    console.log('  ✗  Not V2');
  }

  // ── V3 probe ─────────────────────────────────────────────────────────────
  sep('V3 probe (slot0 + liquidity + fee)');
  const s0  = await tryRead(() => client.readContract({ address: poolAddress, abi: SLOT0_ABI, functionName: 'slot0' }));
  const liq = await tryRead(() => client.readContract({ address: poolAddress, abi: LIQUIDITY_ABI, functionName: 'liquidity' }));
  const fee3 = await tryRead(() => client.readContract({ address: poolAddress, abi: FEE_ABI, functionName: 'fee' }));
  if (s0.ok) {
    row('sqrtPriceX96', s0.value[0].toString());
    row('tick', s0.value[1].toString());
    row('unlocked', s0.value[6].toString());
  } else {
    err('slot0()', s0.error);
  }
  if (liq.ok) row('liquidity()', liq.value.toString()); else err('liquidity()', liq.error);
  if (fee3.ok) row('fee()', fee3.value + ' (e.g. 3000=0.3%, 500=0.05%)'); else err('fee()', fee3.error);

  if (s0.ok && liq.ok) {
    console.log('\n  ✓  V3 interface detected');
  } else if (!res.ok) {
    console.log('\n  ✗  Not V2 and not V3 — likely UNSUPPORTED or wrong address');
  }

  // ── Quote-asset balance (V3 TVL) ─────────────────────────────────────────
  if (quoteAddr) {
    sep(`balanceOf pool for quote asset (${quoteAddr})`);
    const bal = await tryRead(() => client.readContract({
      address: quoteAddr as `0x${string}`,
      abi: BALANCE_OF_ABI,
      functionName: 'balanceOf',
      args: [poolAddress],
    }));
    if (bal.ok) row('quoteBalance (raw)', bal.value.toString());
    else        err('balanceOf(pool)', bal.error);
  }

  // ── QuoterV2 slippage probe (V3 only) ────────────────────────────────────
  // Only runs when: V3 detected, quoteAddr provided, fee known, token0/token1 known.
  const isV3 = s0.ok && liq.ok;
  const quoterAddr = QUOTER_V2_ADDR[chain];
  if (isV3 && quoteAddr && fee3.ok && t0.ok && t1.ok && quoterAddr) {
    sep('QuoterV2 slippage probe (V3)');
    row('quoter', quoterAddr);

    const feeTier = Number(fee3.value);
    const gemAddr = (t0.value as string).toLowerCase() === quoteAddr.toLowerCase()
      ? (t1.value as string)
      : (t0.value as string);
    row('gem (tokenIn)', gemAddr);
    row('quote (tokenOut)', quoteAddr);
    row('fee tier', feeTier + ' (' + (feeTier / 10000).toFixed(4) + '%)');

    // Read gem decimals for correct amountIn scaling
    const decResult = await tryRead(() => client.readContract({
      address: gemAddr as `0x${string}`,
      abi: DECIMALS_ABI,
      functionName: 'decimals',
    }));
    const gemDec = decResult.ok ? Number(decResult.value) : 18;
    row('gem decimals', gemDec);

    // Probe $100 worth: amountIn = 1 * 10^gemDec (spot: 1 gem)
    // We don't have the USD price here, so probe 1 whole gem.
    const amountIn = BigInt(10 ** Math.min(gemDec, 18)); // 1 gem in raw units
    row('amountIn (1 gem raw)', amountIn.toString());

    const quoteResult = await tryRead(() => client.readContract({
      address: quoterAddr as `0x${string}`,
      abi: QUOTER_V2_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{
        tokenIn:           gemAddr as `0x${string}`,
        tokenOut:          quoteAddr as `0x${string}`,
        amountIn,
        fee:               feeTier,
        sqrtPriceLimitX96: 0n,
      }],
    }));

    if (quoteResult.ok) {
      const [amountOut, sqrtPriceX96After, ticksCrossed, gasEst] = quoteResult.value as readonly [bigint, bigint, number, bigint];
      row('amountOut (raw)', amountOut.toString());
      row('sqrtPriceX96After', sqrtPriceX96After.toString());
      row('ticksCrossed', ticksCrossed.toString());
      row('gasEstimate', gasEst.toString());
      console.log('\n  ✓  QuoterV2 call succeeded — V3 liquidity path is functional');
    } else {
      err('quoteExactInputSingle', quoteResult.error);
      console.log('\n  ✗  QuoterV2 call failed — see error above');
    }
  } else if (isV3 && !quoteAddr) {
    console.log('\n  ℹ  Skipping QuoterV2 probe (no quoteAssetAddress provided)');
    console.log('     Pass quote asset address as 3rd arg to enable QuoterV2 probe.');
  }

  // ── DefiLlama price ───────────────────────────────────────────────────────
  const defiLlamaChain = chain;
  const priceTargets: string[] = [];
  if (quoteAddr) priceTargets.push(`${defiLlamaChain}:${quoteAddr}`);
  if (t0.ok)    priceTargets.push(`${defiLlamaChain}:${(t0.value as string).toLowerCase()}`);
  if (t1.ok)    priceTargets.push(`${defiLlamaChain}:${(t1.value as string).toLowerCase()}`);

  const uniqueTargets = [...new Set(priceTargets)].slice(0, 3);
  if (uniqueTargets.length > 0) {
    sep('DefiLlama price');
    for (const coinId of uniqueTargets) {
      try {
        const r = await axios.get<{ coins: Record<string, { price?: number; symbol?: string }> }>(
          `https://coins.llama.fi/prices/current/${encodeURIComponent(coinId)}`,
          { timeout: 6_000 },
        );
        const entry = r.data?.coins?.[coinId];
        if (entry?.price) {
          row(coinId.slice(0, 50), `$${entry.price}  (${entry.symbol ?? ''})`);
        } else {
          err(coinId.slice(0, 50), `no price in response: ${JSON.stringify(r.data?.coins ?? {}).slice(0, 100)}`);
        }
      } catch (e) {
        err(coinId.slice(0, 50), (e as Error).message);
      }
    }
  }

  console.log('\n' + '═'.repeat(64));
  console.log('Done.');
}

main().catch((e) => { console.error('\nFatal:', e); process.exit(1); });
