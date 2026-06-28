/**
 * Deep V3 liquidity probe — mirrors the exact math used by V3LiquidityService
 * so you can verify a pool produces sane numbers before trusting CSV output.
 *
 * Prints: token identities, decimals, slot0, raw balances, spot price, TVL,
 * QuoterV2 quotes (QUOTE→GEM direction) for $50/$100/$500/$1000, and slippage.
 *
 * Usage:
 *   npm run probe:v3                        (default: Base WETH/USDC 0.05%)
 *   npm run probe:v3 -- base   <pool> <quoteAddr>
 *   npm run probe:v3 -- ethereum <pool> <quoteAddr>
 *
 * Example — Base WETH/USDC 0.05% (~$50M TVL, should show <0.1% slippage on $100):
 *   npm run probe:v3 -- base 0xd0b53d9277642d899df5c87a3966a349a798f224 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913
 */
import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { createPublicClient, http } from 'viem';
import { mainnet, base } from 'viem/chains';
import axios from 'axios';

dotenv.config();

// ─── Args / defaults ─────────────────────────────────────────────────────────

const DEFAULT_CHAIN      = 'base';
// Uniswap V3 WETH/USDC 0.05% on Base — large, liquid, good reference pool
const DEFAULT_POOL       = '0xd0b53d9277642d899df5c87a3966a349a798f224';
const DEFAULT_QUOTE_ADDR = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'; // USDC on Base

const [, , chainArg, poolArg, quoteArg] = process.argv;
const chain       = ((chainArg ?? DEFAULT_CHAIN) as 'ethereum' | 'base');
const poolAddress = (poolArg  ?? DEFAULT_POOL).toLowerCase()       as `0x${string}`;
const quoteAddr   = (quoteArg ?? DEFAULT_QUOTE_ADDR).toLowerCase() as `0x${string}`;

if (chain !== 'ethereum' && chain !== 'base') {
  console.error(`Unknown chain "${chain}". Use "ethereum" or "base".`);
  process.exit(1);
}

// ─── viem client ─────────────────────────────────────────────────────────────

const rpcUrl = chain === 'ethereum'
  ? (process.env.ETHEREUM_RPC_URL ?? 'https://eth.drpc.org')
  : (process.env.BASE_RPC_URL     ?? 'https://base.drpc.org');

const client = createPublicClient({
  chain: chain === 'ethereum' ? mainnet : base,
  transport: http(rpcUrl, { retryCount: 3, retryDelay: 200 }),
});

// QuoterV2 addresses (official Uniswap V3 periphery deployments)
const QUOTER_V2_ADDR: Record<string, string> = {
  ethereum: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  base:     '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
};
const TWO_POW_96 = 2n ** 96n;
const PROBE_SIZES_USD = [50, 100, 500, 1000] as const;

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const TOKEN_ABI = [
  { name: 'token0',   type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'token1',   type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

const ERC20_ABI = [
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8'  }] },
  { name: 'symbol',   type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const SLOT0_ABI = [{
  name: 'slot0', type: 'function', stateMutability: 'view', inputs: [],
  outputs: [
    { name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick',                     type: 'int24'  },
    { name: 'observationIndex', type: 'uint16' }, { name: 'observationCardinality', type: 'uint16' },
    { name: 'observationCardinalityNext', type: 'uint16' }, { name: 'feeProtocol', type: 'uint8'  },
    { name: 'unlocked', type: 'bool' },
  ],
}] as const;

const LIQUIDITY_ABI = [{ name: 'liquidity', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] }] as const;
const FEE_ABI       = [{ name: 'fee',       type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24'  }] }] as const;

const QUOTER_V2_ABI = [{
  name: 'quoteExactInputSingle', type: 'function', stateMutability: 'nonpayable',
  inputs: [{
    name: 'params', type: 'tuple',
    components: [
      { name: 'tokenIn',           type: 'address' }, { name: 'tokenOut', type: 'address' },
      { name: 'amountIn',          type: 'uint256' }, { name: 'fee',      type: 'uint24'  },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ],
  }],
  outputs: [
    { name: 'amountOut',               type: 'uint256' }, { name: 'sqrtPriceX96After', type: 'uint160' },
    { name: 'initializedTicksCrossed', type: 'uint32'  }, { name: 'gasEstimate',       type: 'uint256' },
  ],
}] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function tryRead<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try { return { ok: true, value: await fn() }; }
  catch (e) { return { ok: false, error: (e as Error).message.slice(0, 120) }; }
}

function sep(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 62 - title.length - 4))}`);
}
function row(label: string, value: unknown) { console.log(`   ${label.padEnd(32)} ${value}`); }
function bad(label: string, msg: string)    { console.log(`   ${label.padEnd(32)} ✗  ${msg}`); }

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═'.repeat(66));
  console.log(`  probe:v3  chain=${chain}  rpc=${rpcUrl}`);
  console.log(`  pool =${poolAddress}`);
  console.log(`  quote=${quoteAddr}`);
  console.log('═'.repeat(66));

  // ── Token identity ────────────────────────────────────────────────────────
  sep('Pool identity (token0 / token1 / fee)');
  const t0r  = await tryRead(() => client.readContract({ address: poolAddress, abi: TOKEN_ABI,    functionName: 'token0' }));
  const t1r  = await tryRead(() => client.readContract({ address: poolAddress, abi: TOKEN_ABI,    functionName: 'token1' }));
  const feer = await tryRead(() => client.readContract({ address: poolAddress, abi: FEE_ABI,      functionName: 'fee'    }));

  if (!t0r.ok || !t1r.ok) { bad('token0/token1', 'RPC failed — is this a V3 pool?'); process.exit(1); }

  const token0 = (t0r.value as string).toLowerCase() as `0x${string}`;
  const token1 = (t1r.value as string).toLowerCase() as `0x${string}`;
  const feeTier = feer.ok ? Number(feer.value) : null;
  row('token0', token0);
  row('token1', token1);
  row('fee', feeTier != null ? `${feeTier} (${(feeTier / 10000).toFixed(4)}%)` : '? (fee() failed)');

  // ── Decimals + symbols ────────────────────────────────────────────────────
  sep('ERC-20 metadata');
  const [dec0r, dec1r, sym0r, sym1r] = await Promise.all([
    tryRead(() => client.readContract({ address: token0, abi: ERC20_ABI, functionName: 'decimals' })),
    tryRead(() => client.readContract({ address: token1, abi: ERC20_ABI, functionName: 'decimals' })),
    tryRead(() => client.readContract({ address: token0, abi: ERC20_ABI, functionName: 'symbol'   })),
    tryRead(() => client.readContract({ address: token1, abi: ERC20_ABI, functionName: 'symbol'   })),
  ]);
  const dec0 = dec0r.ok ? Number(dec0r.value) : 18;
  const dec1 = dec1r.ok ? Number(dec1r.value) : 18;
  const sym0 = sym0r.ok ? String(sym0r.value) : '?';
  const sym1 = sym1r.ok ? String(sym1r.value) : '?';
  row('token0 symbol / decimals', `${sym0} / ${dec0}`);
  row('token1 symbol / decimals', `${sym1} / ${dec1}`);

  // Determine gem vs quote from the provided quoteAddr
  const gemIsToken0 = token0 !== quoteAddr;
  const gemAddr     = gemIsToken0 ? token0 : token1;
  const gemDec      = gemIsToken0 ? dec0   : dec1;
  const gemSym      = gemIsToken0 ? sym0   : sym1;
  const quoteDec    = gemIsToken0 ? dec1   : dec0;
  const quoteSym    = gemIsToken0 ? sym1   : sym0;
  row('gem  (non-quote)', `${gemAddr}  ${gemSym} (${gemDec} dec)`);
  row('quote',            `${quoteAddr}  ${quoteSym} (${quoteDec} dec)`);

  // ── Slot0 + liquidity ─────────────────────────────────────────────────────
  sep('V3 pool state (slot0 + liquidity)');
  const s0r  = await tryRead(() => client.readContract({ address: poolAddress, abi: SLOT0_ABI,    functionName: 'slot0'    }));
  const liqr = await tryRead(() => client.readContract({ address: poolAddress, abi: LIQUIDITY_ABI, functionName: 'liquidity' }));

  if (!s0r.ok)  { bad('slot0()', s0r.error); }
  if (!liqr.ok) { bad('liquidity()', liqr.error); }
  if (!s0r.ok || !liqr.ok) { process.exit(1); }

  const slot0 = s0r.value as readonly [bigint, number, number, number, number, number, boolean];
  const sqrtPriceX96 = slot0[0] as bigint;
  const tick         = Number(slot0[1]);
  const liquidity    = liqr.value as bigint;

  row('sqrtPriceX96', sqrtPriceX96.toString());
  row('tick',         tick.toString());
  row('unlocked',     String(slot0[6]));
  row('liquidity',    liquidity.toString());

  if (sqrtPriceX96 === 0n) { console.log('\n  ✗  sqrtPriceX96 = 0 — pool is uninitialized'); process.exit(1); }

  // ── Spot price from sqrtPriceX96 ─────────────────────────────────────────
  sep('Spot price computation');
  const sqrtRatio = Number(sqrtPriceX96) / Number(TWO_POW_96);
  const priceRaw  = sqrtRatio * sqrtRatio; // token1Raw per token0Raw
  row('sqrtRatio (sqrtPrice)', sqrtRatio.toFixed(12));
  row('priceRaw (token1/token0 raw)', priceRaw.toExponential(6));

  let spotPriceUsd: number;
  // Fetch quote price from DefiLlama
  const llamaChain = chain === 'ethereum' ? 'ethereum' : 'base';
  let quotePriceUsd = 0;
  try {
    const coinId = `${llamaChain}:${quoteAddr}`;
    const resp = await axios.get<{ coins: Record<string, { price?: number; symbol?: string }> }>(
      `https://coins.llama.fi/prices/current/${encodeURIComponent(coinId)}`,
      { timeout: 6000 },
    );
    quotePriceUsd = resp.data?.coins?.[coinId]?.price ?? 0;
    row(`quote price (${quoteSym})`, quotePriceUsd ? `$${quotePriceUsd}` : '? (no data from DefiLlama)');
  } catch (e) { bad('DefiLlama price', (e as Error).message); }

  if (gemIsToken0) {
    // token0=gem, token1=quote: priceRaw = quoteRaw/gemRaw
    // 1 gem (human) in quote (human) = priceRaw * 10^gemDec / 10^quoteDec
    const priceGemInQuote = priceRaw * (10 ** gemDec) / (10 ** quoteDec);
    spotPriceUsd = priceGemInQuote * quotePriceUsd;
    row('priceGemInQuote (human)', priceGemInQuote.toExponential(6));
  } else {
    // token0=quote, token1=gem: priceRaw = gemRaw/quoteRaw → invert
    const priceGemInQuote = (10 ** gemDec) / (priceRaw * (10 ** quoteDec));
    spotPriceUsd = priceGemInQuote * quotePriceUsd;
    row('priceGemInQuote (human, inverted)', priceGemInQuote.toExponential(6));
  }
  row(`gem spot price (${gemSym})`, spotPriceUsd ? `$${spotPriceUsd.toExponential(6)}` : '? (no quote price)');

  // ── Balances + TVL ────────────────────────────────────────────────────────
  sep(`Pool balances (balanceOf pool for each token)`);
  const [bal0r, bal1r] = await Promise.all([
    tryRead(() => client.readContract({ address: token0, abi: ERC20_ABI, functionName: 'balanceOf', args: [poolAddress] })),
    tryRead(() => client.readContract({ address: token1, abi: ERC20_ABI, functionName: 'balanceOf', args: [poolAddress] })),
  ]);

  const bal0raw = bal0r.ok ? (bal0r.value as bigint) : 0n;
  const bal1raw = bal1r.ok ? (bal1r.value as bigint) : 0n;
  const bal0hum = Number(bal0raw) / 10 ** dec0;
  const bal1hum = Number(bal1raw) / 10 ** dec1;

  if (bal0r.ok) row(`${sym0} balance (raw)`,   `${bal0raw}  →  ${bal0hum.toFixed(6)} ${sym0}`);
  else          bad(`${sym0} balanceOf failed`,  bal0r.error);
  if (bal1r.ok) row(`${sym1} balance (raw)`,   `${bal1raw}  →  ${bal1hum.toFixed(6)} ${sym1}`);
  else          bad(`${sym1} balanceOf failed`,  bal1r.error);

  const quoteBal    = gemIsToken0 ? bal1hum : bal0hum;
  const onchainTvl  = quotePriceUsd > 0 ? quoteBal * quotePriceUsd * 2 : 0;
  row('onchain TVL (quote balance × price × 2)', `$${onchainTvl.toFixed(2)}`);

  // ── QuoterV2 slippage probes (QUOTE→GEM direction) ────────────────────────
  sep('QuoterV2 slippage probes  (QUOTE → GEM direction)');
  const quoterAddr = QUOTER_V2_ADDR[chain];
  if (!quoterAddr) { bad('QuoterV2 address', `no address for chain "${chain}"`); process.exit(1); }
  if (feeTier === null) { bad('fee tier', 'could not read fee — skipping QuoterV2 probes'); }
  else if (!quotePriceUsd || spotPriceUsd <= 0) {
    bad('prices', 'quote price or spot price unavailable — skipping QuoterV2 probes');
  } else {
    console.log(`   direction: sell ${quoteSym} → receive ${gemSym}`);
    console.log(`   quoter:    ${quoterAddr}`);
    console.log(`   fee tier:  ${feeTier}\n`);
    console.log(`   ${'SIZE USD'.padEnd(12)} ${'AMOUNT_IN_RAW'.padEnd(22)} ${'GEM_OUT_RAW'.padEnd(22)} ${'OUT_USD'.padEnd(12)} SLIP`);
    console.log(`   ${'─'.repeat(80)}`);

    let allNull = true;
    for (const sizeUsd of PROBE_SIZES_USD) {
      const amountInFloat = (sizeUsd / quotePriceUsd) * (10 ** quoteDec);
      if (!isFinite(amountInFloat) || amountInFloat < 1) {
        console.log(`   $${String(sizeUsd).padEnd(11)} amountIn < 1 raw unit — skipped`);
        continue;
      }
      const amountInRaw = BigInt(Math.round(amountInFloat));

      const res = await tryRead(() => client.readContract({
        address: quoterAddr as `0x${string}`,
        abi: QUOTER_V2_ABI,
        functionName: 'quoteExactInputSingle',
        args: [{
          tokenIn:           quoteAddr,
          tokenOut:          gemAddr,
          amountIn:          amountInRaw,
          fee:               feeTier,
          sqrtPriceLimitX96: 0n,
        }],
      }));

      if (!res.ok) {
        console.log(`   $${String(sizeUsd).padEnd(11)} ${amountInRaw.toString().padEnd(22)} QuoterV2 REVERTED: ${res.error.slice(0, 60)}`);
        continue;
      }

      const [amountOut] = res.value as readonly [bigint, bigint, number, bigint];
      const actualOutUsd = (Number(amountOut) / 10 ** gemDec) * spotPriceUsd;
      const slip = 1 - actualOutUsd / sizeUsd;
      const slipStr = `${(slip * 100).toFixed(3)}%`;
      console.log(
        `   $${String(sizeUsd).padEnd(11)} ${amountInRaw.toString().padEnd(22)} ${amountOut.toString().padEnd(22)} $${actualOutUsd.toFixed(4).padEnd(11)} ${slipStr}`,
      );
      allNull = false;

      if (slip > 0.50) {
        console.log(`   ^ ⚠  >50% slippage on $${sizeUsd} — physicality guard would mark this implausible_read`);
      }
    }
    if (allNull) console.log('   (all probes failed — no QuoterV2 data)');
  }

  // ── Physicality verdict ────────────────────────────────────────────────────
  sep('Physicality verdict (mirrors guard in LiquidityVerificationService)');
  // Replicates the exact conditions from buildResult() in liquidity-verification.service.ts
  // using slip50 (the $50 probe).
  const slip50Value = (quotePriceUsd > 0 && spotPriceUsd > 0 && feeTier !== null)
    ? await (async () => {
        const amtIn = (50 / quotePriceUsd) * (10 ** quoteDec);
        if (!isFinite(amtIn) || amtIn < 1) return null;
        const r = await tryRead(() => client.readContract({
          address: quoterAddr as `0x${string}`,
          abi: QUOTER_V2_ABI,
          functionName: 'quoteExactInputSingle',
          args: [{ tokenIn: quoteAddr, tokenOut: gemAddr, amountIn: BigInt(Math.round(amtIn)), fee: feeTier!, sqrtPriceLimitX96: 0n }],
        }));
        if (!r.ok) return null;
        const [out] = r.value as readonly [bigint, bigint, number, bigint];
        return 1 - (Number(out) / 10 ** gemDec) * spotPriceUsd / 50;
      })()
    : null;

  const condA = onchainTvl >= 0 && onchainTvl < onchainTvl * 0.01; // placeholder — computed below
  const REPORTED_USD = onchainTvl * 1.0; // we don't have reported here; use a stand-in
  const condA_real = onchainTvl < 1;  // onchain < $1 → insufficient
  const condB_real = slip50Value !== null && slip50Value > 0.50;

  if (condA_real || condB_real) {
    console.log(`\n  ✗  IMPLAUSIBLE_READ  — would be marked liquidityVerified=false`);
    if (condA_real) console.log(`     condA: onchain TVL ($${onchainTvl.toFixed(2)}) < $1`);
    if (condB_real) console.log(`     condB: slip50=${slip50Value != null ? (slip50Value * 100).toFixed(2) + '%' : '?'} > 50%`);
  } else {
    console.log(`\n  ✓  PLAUSIBLE READ  — would be marked liquidityVerified=true`);
    console.log(`     onchain TVL = $${onchainTvl.toFixed(2)}`);
    console.log(`     slip50 = ${slip50Value != null ? (slip50Value * 100).toFixed(3) + '%' : '?'}`);
  }
  console.log('\n' + '═'.repeat(66));
}

main().catch((e) => { console.error('\nFatal:', e); process.exit(1); });
