/**
 * LIVE smoke test for the risk engine.
 * Hits real GoPlus + Honeypot.is APIs — NO mocks.
 *
 * Usage:
 *   npm run smoke:risk
 *   npm run smoke:risk -- ethereum 0xTOKEN base 0xTOKEN2   (extra pairs)
 */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

// Direct imports from src/ — no NestJS app context needed.
// Decorators (@Injectable, @Inject) are metadata-only and safe to call directly.
import { GoPlusService } from '../src/risk-engine/providers/goplus.service';
import { HoneypotService } from '../src/risk-engine/providers/honeypot.service';
import { RiskEngineService } from '../src/risk-engine/risk-engine.service';
import { ContractRiskResult, NormalizedRiskData } from '../src/risk-engine/risk-engine.types';
import { SupportedChain } from '../src/collector/collector.types';

const localEnv: Record<string, string> = {};
try {
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match) localEnv[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch {
  // .env is optional for CI.
}

function env(name: string): string | undefined {
  return process.env[name] ?? localEnv[name];
}

// ─── Stubs (no-op — do not touch real logs/ or DB) ──────────────────────────

const configStub = {
  get: (key: string): unknown => {
    const m: Record<string, string | undefined> = {
      'api.goplusBaseUrl': env('GOPLUS_BASE_URL') ?? 'https://api.gopluslabs.io',
      'api.goplusApiKey': env('GOPLUS_API_KEY'),
      'api.goplusAppKey': env('GOPLUS_APP_KEY') ?? env('GOPLUS_API_KEY'),
      'api.goplusAppSecret': env('GOPLUS_APP_SECRET'),
      'api.goplusMinIntervalMs': env('GOPLUS_MIN_INTERVAL_MS') ?? '2000',
      'api.goplusMaxAttempts': env('GOPLUS_MAX_ATTEMPTS') ?? '2',
      'api.goplusRetryDelayMs': env('GOPLUS_RETRY_DELAY_MS') ?? '2500',
      'api.honeypotBaseUrl': env('HONEYPOT_BASE_URL') ?? 'https://api.honeypot.is',
    };
    return m[key];
  },
} as any; // eslint-disable-line @typescript-eslint/no-explicit-any

const fileLoggerStub = {
  logContractRisk: () => {},
} as any;

const redisStub = {
  get:    async (): Promise<null>   => null,   // always miss → real HTTP every time
  setex:  async (): Promise<'OK'>   => 'OK',
} as any;

// ─── Reference targets ────────────────────────────────────────────────────────

type Target = { chain: SupportedChain; address: string; label: string };

const REFERENCE: Target[] = [
  { chain: 'ethereum', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', label: 'WETH (Ethereum)' },
  { chain: 'ethereum', address: '0xA0b86991c6218b36c1D19D4a2e9Eb0cE3606eB48', label: 'USDC (Ethereum)' },
  { chain: 'base',     address: '0x4200000000000000000000000000000000000006', label: 'WETH (Base)' },
  { chain: 'base',     address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', label: 'USDC (Base)' },
];

const GOPLUS_CHAIN_ID: Partial<Record<SupportedChain, string>> = { ethereum: '1', base: '8453' };

// ─── CLI args parsing (pairs: chain address chain address …) ─────────────────

function parseCliTargets(): Target[] {
  const args = process.argv.slice(2);
  const out: Target[] = [];
  for (let i = 0; i + 1 < args.length; i += 2) {
    const chain = args[i] as SupportedChain;
    const address = args[i + 1];
    if (chain !== 'ethereum' && chain !== 'base') {
      console.warn(`⚠  Unknown chain "${chain}" — skipping ${address}`);
      continue;
    }
    out.push({ chain, address, label: `CLI (${chain})` });
  }
  return out;
}

// ─── Read up to 15 recent tokens from logs/raw/new_pools.csv ─────────────────

function readNewPoolsTargets(limit = 15): Target[] {
  const csvPath = path.join(process.cwd(), 'logs', 'raw', 'new_pools.csv');
  if (!fs.existsSync(csvPath)) {
    console.log('\nℹ  logs/raw/new_pools.csv not found — no live-pool targets to add.\n');
    return [];
  }
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',');
  const ci = (name: string) => headers.indexOf(name);
  const chainI  = ci('chain');
  const addrI   = ci('token_address');
  const symI    = ci('token_symbol');

  if (chainI === -1 || addrI === -1) {
    console.warn('⚠  new_pools.csv missing chain/token_address column — skipping.');
    return [];
  }

  const seen = new Set<string>();
  const out: Target[] = [];
  for (const line of lines.slice(1).slice(-limit)) {
    const cols = line.split(',');
    const chain   = cols[chainI]  as SupportedChain;
    const address = cols[addrI];
    const symbol  = symI !== -1 ? cols[symI] : '';
    const key = `${chain}:${address}`;
    if (seen.has(key)) continue;
    if (chain !== 'ethereum' && chain !== 'base') continue;
    if (!address?.startsWith('0x')) continue;
    seen.add(key);
    out.push({ chain, address, label: `new_pools ${symbol || address.slice(0, 10)}` });
  }
  console.log(`ℹ  Loaded ${out.length} unique token(s) from new_pools.csv\n`);
  return out;
}

// ─── Per-token print ──────────────────────────────────────────────────────────

const ICON: Record<string, string> = {
  CONTRACT_SAFE:    '✓',
  CONTRACT_REJECT:  '✗',
  CONTRACT_UNKNOWN: '?',
};

function printResult(t: Target, r: ContractRiskResult): void {
  const icon = ICON[r.decision] ?? '?';
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`${icon}  ${t.label}`);
  console.log(`   chain           ${t.chain}`);
  console.log(`   address         ${t.address}`);
  console.log(`   decision        ${r.decision}`);
  console.log(`   rejectReasons   ${r.rejectReasons.length ? r.rejectReasons.join(', ') : '(none)'}`);
  console.log(`   goplusQueried   ${r.goplusQueried}`);
  console.log(`   honeypotQueried ${r.honeypotQueried}`);

  const m: NormalizedRiskData = r.merged;
  const fields = Object.entries(m).filter(([, v]) => v !== undefined);
  if (fields.length) {
    console.log('   merged:');
    for (const [k, v] of fields) {
      console.log(`     ${k.padEnd(26)} ${v}`);
    }
  } else {
    console.log('   merged:          (empty — no provider data)');
  }
}

// ─── Raw lp_holders dump ──────────────────────────────────────────────────────

async function tryDumpLpHolders(t: Target): Promise<boolean> {
  const chainId = GOPLUS_CHAIN_ID[t.chain];
  if (!chainId) return false;
  try {
    const { data } = await axios.get(
      `https://api.gopluslabs.io/api/v1/token_security/${chainId}`,
      { params: { contract_addresses: t.address.toLowerCase() }, timeout: 15_000 },
    );
    const result = data?.result?.[t.address.toLowerCase()];
    const holders: any[] | undefined = result?.lp_holders; // eslint-disable-line

    if (!holders || holders.length === 0) return false;

    console.log(`\n${'─'.repeat(72)}`);
    console.log(`LP HOLDERS DUMP  ${t.label} (${t.chain}:${t.address})`);
    console.log(`${holders.length} holder(s) returned by GoPlus lp_holders:`);
    for (const h of holders) {
      console.log('  ' + JSON.stringify(h));
    }

    // Unit detection
    const first = parseFloat(holders[0].percent ?? '0');
    if (first > 1.0) {
      console.log(`\n  ⚠  UNIT: percent="${holders[0].percent}" > 1.0`);
      console.log('     → GoPlus sends PERCENTAGE (0–100), not decimal fraction.');
      console.log('     → LP_LOCK_THRESHOLD=0.5 is WRONG — should be 50. Fix required.');
    } else {
      console.log(`\n  ✓  UNIT: percent="${holders[0].percent}" ≤ 1.0`);
      console.log('     → GoPlus sends DECIMAL FRACTION (0–1).');
      console.log('     → LP_LOCK_THRESHOLD=0.5 (=50%) is CORRECT.');
    }
    return true;
  } catch (err) {
    console.log(`  [lp_holders fetch failed: ${(err as Error).message}]`);
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═'.repeat(72));
  console.log('GEM RADAR — LIVE RISK ENGINE SMOKE TEST');
  console.log('Real GoPlus + Honeypot.is | No mocks | Anon tier (2 s throttle)');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log('═'.repeat(72));

  const goplusService    = new GoPlusService(configStub);
  const honeypotService  = new HoneypotService(configStub);
  const riskEngine       = new RiskEngineService(goplusService, honeypotService, fileLoggerStub, redisStub);

  const cliTargets = parseCliTargets();
  const csvTargets = readNewPoolsTargets(15);
  const allTargets: Target[] = [...REFERENCE, ...cliTargets, ...csvTargets];

  console.log(`Targets: ${REFERENCE.length} reference + ${cliTargets.length} CLI + ${csvTargets.length} new_pools = ${allTargets.length} total`);
  console.log('(GoPlus throttle=2 s — expect ~4 s per token minimum)\n');

  const succeeded: Array<{ target: Target; result: ContractRiskResult }> = [];

  for (const target of allTargets) {
    try {
      const result = await riskEngine.checkToken(
        target.chain, target.address, undefined, undefined, 'smoke',
      );
      printResult(target, result);
      if (result.goplusQueried) succeeded.push({ target, result });
    } catch (err) {
      console.log(`\n✗ ERROR  ${target.label} ${target.chain}:${target.address}`);
      console.log(`  ${(err as Error).message}`);
    }
  }

  // ── LP holders dump ────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(72)}`);
  console.log('LP HOLDERS RAW DUMP (percent unit verification)');
  console.log('Looking for first token with non-empty lp_holders…');

  let lpFound = false;
  for (const { target } of succeeded) {
    if (lpFound) break;
    await sleep(2_000); // respect anon rate limit for extra calls
    lpFound = await tryDumpLpHolders(target);
  }

  if (!lpFound) {
    console.log('\n  No token in this run returned non-empty lp_holders.');
    console.log('  Normal for blue-chip/stablecoin tokens (mostly V3/V4 pools).');
    console.log('  Add a known Uni V2 / Sushi token as CLI arg to verify percent units:');
    console.log('    npm run smoke:risk -- ethereum 0x<V2_TOKEN_ADDRESS>');
  }

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`Done: ${new Date().toISOString()}`);
  const decisions = succeeded.map((s) => s.result.decision);
  const safe    = decisions.filter((d) => d === 'CONTRACT_SAFE').length;
  const reject  = decisions.filter((d) => d === 'CONTRACT_REJECT').length;
  const unknown = allTargets.length - succeeded.length +
                  decisions.filter((d) => d === 'CONTRACT_UNKNOWN').length;
  console.log(`Results: ${safe} SAFE  ${reject} REJECT  ${unknown} UNKNOWN/ERROR  (of ${allTargets.length} total)`);
}

main().catch((err) => {
  console.error('\nFatal:', err);
  process.exit(1);
});
