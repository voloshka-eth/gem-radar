/**
 * Probe the deployment block and age of a token contract via binary search
 * over eth_getCode — no explorer API key required.
 * Proves the token-age gate works by showing when known-old tokens would be rejected.
 *
 * Usage:
 *   npm run probe:age -- <chain> <tokenAddress>
 *   npm run probe:age               (defaults: ethereum + mUSD 0xaca92e438df0b2401ff60da7e4337b687a2435da)
 *
 * Examples:
 *   npm run probe:age -- ethereum 0xaca92e438df0b2401ff60da7e4337b687a2435da  (mUSD — deployed 2020)
 *   npm run probe:age -- base 0x4200000000000000000000000000000000000006        (WETH on Base — very old)
 */
import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { createPublicClient, http } from 'viem';
import { mainnet, base } from 'viem/chains';

dotenv.config();

// ─── Args / defaults ──────────────────────────────────────────────────────────

const DEFAULT_CHAIN   = 'ethereum' as const;
const DEFAULT_ADDRESS = '0xaca92e438df0b2401ff60da7e4337b687a2435da'; // mUSD — deployed 2020

const [, , chainArg, addrArg] = process.argv;
const chain        = ((chainArg as string | undefined) ?? DEFAULT_CHAIN) as 'ethereum' | 'base';
const tokenAddress = (addrArg ?? DEFAULT_ADDRESS).toLowerCase() as `0x${string}`;
const TOKEN_MAX_AGE_DAYS = parseInt(process.env.TOKEN_MAX_AGE_DAYS ?? '7', 10);

if (chain !== 'ethereum' && chain !== 'base') {
  console.error(`Unknown chain "${chain}". Use "ethereum" or "base".`);
  process.exit(1);
}

// ─── RPC client ───────────────────────────────────────────────────────────────

const ethRpc  = process.env.ETHEREUM_RPC_URL ?? 'https://ethereum.publicnode.com';
const baseRpc = process.env.BASE_RPC_URL     ?? 'https://base.publicnode.com';
const rpcUrl  = chain === 'ethereum' ? ethRpc : baseRpc;

const client = createPublicClient({
  chain: chain === 'ethereum' ? mainnet : base,
  transport: http(rpcUrl),
});

// ─── binary search ────────────────────────────────────────────────────────────

async function findDeployBlock(addr: `0x${string}`, currentBlock: bigint): Promise<bigint | null> {
  // Confirm the contract exists at the current tip first.
  const codeNow = await client.getCode({ address: addr });
  if (!codeNow) {
    console.log(`✗  No bytecode at current block — not a contract address on ${chain}.`);
    return null;
  }

  console.log(`   Searching deploy block in range [0, ${currentBlock}] (~${Math.ceil(Math.log2(Number(currentBlock)))} iterations)`);

  let lo = 0n;
  let hi = currentBlock;
  let iter = 0;

  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    iter++;
    process.stdout.write(`\r   iter ${iter.toString().padStart(2)}  lo=${lo}  hi=${hi}  mid=${mid}  `);

    const code = await client.getCode({ address: addr, blockNumber: mid });
    if (!code) {
      lo = mid + 1n;
    } else {
      hi = mid;
    }
  }
  process.stdout.write('\n');
  return lo;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═'.repeat(64));
  console.log(`  probe:age  chain=${chain}  method=getCode-binary-search`);
  console.log(`  token=${tokenAddress}`);
  console.log(`  TOKEN_MAX_AGE_DAYS=${TOKEN_MAX_AGE_DAYS}`);
  console.log(`  rpc=${rpcUrl}`);
  console.log('═'.repeat(64));

  // ── Step 1: current block ────────────────────────────────────────────────────
  console.log('\n── Step 1: current block ────────────────────────────────────');
  let currentBlock: bigint;
  try {
    currentBlock = await client.getBlockNumber();
    console.log(`   currentBlock:    ${currentBlock}`);
  } catch (err) {
    console.log(`✗  getBlockNumber failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // ── Step 2: binary search ────────────────────────────────────────────────────
  console.log('\n── Step 2: binary search for deploy block ───────────────────');
  let deployBlock: bigint | null;
  try {
    deployBlock = await findDeployBlock(tokenAddress, currentBlock);
    if (deployBlock === null) process.exit(1);
    console.log(`   deployBlock:     ${deployBlock}`);
  } catch (err) {
    console.log(`✗  Binary search failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // ── Step 3: block timestamp ──────────────────────────────────────────────────
  console.log('\n── Step 3: deploy block timestamp ───────────────────────────');
  let deployedAtMs: number;
  try {
    const block = await client.getBlock({ blockNumber: deployBlock });
    deployedAtMs = Number(block.timestamp) * 1_000;
    console.log(`   blockTimestamp:  ${block.timestamp} (unix)`);
    console.log(`   deployedAt:      ${new Date(deployedAtMs).toISOString()}`);
  } catch (err) {
    console.log(`✗  getBlock(${deployBlock}) failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // ── Result ────────────────────────────────────────────────────────────────────
  const ageDays = (Date.now() - deployedAtMs) / 86_400_000;
  const tooOld  = ageDays > TOKEN_MAX_AGE_DAYS;

  console.log('\n── Result ───────────────────────────────────────────────────');
  console.log(`   Token age:       ${ageDays.toFixed(2)} days`);
  console.log(`   TOKEN_MAX_AGE:   ${TOKEN_MAX_AGE_DAYS} days`);
  console.log(`   Gate verdict:    ${
    tooOld
      ? `✗  TOKEN_TOO_OLD  (would be REJECTED before risk engine)`
      : `✓  PASS  (within max age)`
  }`);
  console.log('═'.repeat(64));
}

main().catch((e) => { console.error('\nFatal:', e); process.exit(1); });
