import { ParsedInstruction, ParsedTransactionWithMeta, PartiallyDecodedInstruction, PublicKey } from '@solana/web3.js';
import * as bs58 from 'bs58';
import { createHash } from 'crypto';
import {
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  pumpIdl,
} from '@pump-fun/pump-sdk';
import { pumpAmmJson } from '@pump-fun/pump-swap-sdk';
import { AmmIdl, PROGRAM_ID as METEORA_DAMM_V1_PROGRAM_ID } from '@meteora-ag/dynamic-amm-sdk';
import { CP_AMM_PROGRAM_ID, CpAmmIdl } from '@meteora-ag/cp-amm-sdk';
import {
  CREATE_CPMM_POOL_PROGRAM,
  LAUNCHPAD_PROGRAM,
  anchorDataBuf,
} from '@raydium-io/raydium-sdk-v2';
import { SolanaTradeDirection, SolanaVenue } from './solana-flow-v2';

export interface SolanaProgramDescriptor {
  venue: SolanaVenue;
  programId: string;
  launchProgram: boolean;
}

export interface SolanaLaunchEvent {
  kind: 'LAUNCH' | 'MIGRATION';
  venue: SolanaVenue;
  programId: string;
  signature: string;
  instructionIndex: number;
  slot: number;
  blockTimeMs: number;
  instructionName: string;
  mintAddress: string;
  poolAddress: string;
  quoteMint: string;
  creatorAddress: string | null;
  rawAccounts: string[];
}

export interface SolanaDecodedTrade {
  venue: SolanaVenue;
  programId: string;
  signature: string;
  instructionIndex: number;
  slot: number;
  blockTimeMs: number;
  instructionName: string;
  mintAddress: string;
  poolAddress: string;
  quoteMint: string;
  wallet: string;
  direction: SolanaTradeDirection;
  baseAmountRaw: string | null;
  quoteAmountRaw: string | null;
  rawAccounts: string[];
}

export interface DecodedSolanaTransaction {
  launches: SolanaLaunchEvent[];
  trades: SolanaDecodedTrade[];
}

interface InstructionDefinition {
  name: string;
  discriminator: string;
  accountNames: string[];
}

interface NormalizedInstruction {
  programId: string;
  accounts: string[];
  data: Buffer;
  index: number;
}

interface BalanceDelta {
  owner: string | null;
  mint: string;
  raw: bigint;
}

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);
const METEORA_DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
const METEORA_DAMM_V1_PROGRAM = String(METEORA_DAMM_V1_PROGRAM_ID);
const METEORA_DAMM_V2_PROGRAM = String(CP_AMM_PROGRAM_ID);

const DESCRIPTORS: readonly SolanaProgramDescriptor[] = Object.freeze([
  { venue: 'RAYDIUM_LAUNCHLAB', programId: LAUNCHPAD_PROGRAM.toBase58(), launchProgram: true },
  { venue: 'PUMP_BONDING_CURVE', programId: PUMP_PROGRAM_ID.toBase58(), launchProgram: true },
  { venue: 'PUMPSWAP', programId: PUMP_AMM_PROGRAM_ID.toBase58(), launchProgram: false },
  { venue: 'METEORA_DBC', programId: METEORA_DBC_PROGRAM, launchProgram: true },
  { venue: 'METEORA_DAMM_V1', programId: METEORA_DAMM_V1_PROGRAM, launchProgram: false },
  { venue: 'METEORA_DAMM_V2', programId: METEORA_DAMM_V2_PROGRAM, launchProgram: false },
  { venue: 'RAYDIUM_CPMM', programId: CREATE_CPMM_POOL_PROGRAM.toBase58(), launchProgram: false },
]);

const RAYDIUM_DEFINITIONS: InstructionDefinition[] = [
  raydiumDefinition('initialize', ['payer', 'creator', 'configId', 'platformId', 'auth', 'poolId', 'mintA', 'mintB', 'vaultA', 'vaultB', 'metadataId']),
  raydiumDefinition('initializeV2', ['payer', 'creator', 'configId', 'platformId', 'auth', 'poolId', 'mintA', 'mintB', 'vaultA', 'vaultB', 'metadataId']),
  raydiumDefinition('initializeWithToken2022', ['payer', 'creator', 'configId', 'platformId', 'auth', 'poolId', 'mintA', 'mintB', 'vaultA', 'vaultB']),
  raydiumDefinition('buyExactIn', ['owner', 'auth', 'configId', 'platformId', 'poolId', 'userTokenAccountA', 'userTokenAccountB', 'vaultA', 'vaultB', 'mintA', 'mintB']),
  raydiumDefinition('buyExactOut', ['owner', 'auth', 'configId', 'platformId', 'poolId', 'userTokenAccountA', 'userTokenAccountB', 'vaultA', 'vaultB', 'mintA', 'mintB']),
  raydiumDefinition('sellExactIn', ['owner', 'auth', 'configId', 'platformId', 'poolId', 'userTokenAccountA', 'userTokenAccountB', 'vaultA', 'vaultB', 'mintA', 'mintB']),
  raydiumDefinition('sellExactOut', ['owner', 'auth', 'configId', 'platformId', 'poolId', 'userTokenAccountA', 'userTokenAccountB', 'vaultA', 'vaultB', 'mintA', 'mintB']),
];

const RAYDIUM_CPMM_DEFINITIONS: InstructionDefinition[] = [
  definition('initialize', 'afaf6d1f0d989bed', [
    'creator', 'configId', 'authority', 'poolId', 'mintA', 'mintB', 'lpMint', 'userVaultA', 'userVaultB',
    'userLpAccount', 'vaultA', 'vaultB', 'createPoolFeeAccount', 'observationId',
  ]),
  definition('swapBaseInput', '8fbe5adac41e33de', [
    'payer', 'authority', 'configId', 'poolId', 'userInputAccount', 'userOutputAccount', 'inputVault',
    'outputVault', 'inputTokenProgram', 'outputTokenProgram', 'inputMint', 'outputMint', 'observationId',
  ]),
  definition('swapBaseOutput', '37d96256a34ab4ad', [
    'payer', 'authority', 'configId', 'poolId', 'userInputAccount', 'userOutputAccount', 'inputVault',
    'outputVault', 'inputTokenProgram', 'outputTokenProgram', 'inputMint', 'outputMint', 'observationId',
  ]),
];

const METEORA_DEFINITIONS: InstructionDefinition[] = [
  definition('initialize_virtual_pool_with_spl_token', '8c55d7b06636684f', [
    'config', 'poolAuthority', 'creator', 'baseMint', 'quoteMint', 'pool', 'baseVault', 'quoteVault',
  ]),
  definition('initialize_virtual_pool_with_token2022', 'a976334e916edc9b', [
    'config', 'poolAuthority', 'creator', 'baseMint', 'quoteMint', 'pool', 'baseVault', 'quoteVault',
  ]),
  definition('initialize_virtual_pool_with_token2022_transfer_hook', 'b60de9b12a918702', [
    'config', 'poolAuthority', 'creator', 'baseMint', 'quoteMint', 'pool', 'baseVault', 'quoteVault',
  ]),
  definition('swap', 'f8c69e91e17587c8', [
    'poolAuthority', 'config', 'pool', 'inputTokenAccount', 'outputTokenAccount', 'baseVault', 'quoteVault',
    'baseMint', 'quoteMint', 'payer',
  ]),
  definition('swap2', '414b3f4ceb5b5b88', [
    'poolAuthority', 'config', 'pool', 'inputTokenAccount', 'outputTokenAccount', 'baseVault', 'quoteVault',
    'baseMint', 'quoteMint', 'payer',
  ]),
  definition('swap2_with_transfer_hook', 'b75d992818e6c297', [
    'poolAuthority', 'config', 'pool', 'inputTokenAccount', 'outputTokenAccount', 'baseVault', 'quoteVault',
    'baseMint', 'quoteMint', 'payer',
  ]),
  definition('migrate_meteora_damm', '1b013016b43f76d9', [
    'virtualPool', 'migrationMetadata', 'config', 'poolAuthority', 'pool', 'dammConfig', 'lpMint',
    'tokenAMint', 'tokenBMint',
  ]),
  definition('migration_damm_v2', '9ca9e66735e45040', [
    'virtualPool', 'migrationMetadata', 'config', 'poolAuthority', 'pool', 'firstPositionNftMint',
    'firstPositionNftAccount', 'firstPosition', 'secondPositionNftMint', 'secondPositionNftAccount',
    'secondPosition', 'dammPoolAuthority', 'ammProgram', 'baseMint', 'quoteMint',
  ]),
];

const DEFINITIONS = new Map<string, Map<string, InstructionDefinition>>([
  [PUMP_PROGRAM_ID.toBase58(), definitionsFromIdl(pumpIdl)],
  [PUMP_AMM_PROGRAM_ID.toBase58(), definitionsFromIdl(pumpAmmJson)],
  [METEORA_DBC_PROGRAM, new Map(METEORA_DEFINITIONS.map((item) => [item.discriminator, item]))],
  [METEORA_DAMM_V1_PROGRAM, definitionsFromIdl(AmmIdl)],
  [METEORA_DAMM_V2_PROGRAM, definitionsFromIdl(CpAmmIdl)],
  [LAUNCHPAD_PROGRAM.toBase58(), new Map(RAYDIUM_DEFINITIONS.map((definition) => [definition.discriminator, definition]))],
  [CREATE_CPMM_POOL_PROGRAM.toBase58(), new Map(RAYDIUM_CPMM_DEFINITIONS.map((definition) => [definition.discriminator, definition]))],
]);

export function solanaProgramDescriptors(): readonly SolanaProgramDescriptor[] {
  return DESCRIPTORS;
}

export function isPotentialLaunchLog(venue: SolanaVenue, logs: readonly string[]): boolean {
  const text = logs.join('\n');
  if (venue === 'PUMP_BONDING_CURVE') {
    return /Instruction:\s*(Create(?:V2)?|Migrate(?:V2)?)/i.test(text);
  }
  if (venue === 'METEORA_DBC') {
    return /Instruction:\s*(InitializeVirtualPool|MigrateMeteoraDamm|MigrationDammV2)/i.test(text);
  }
  if (venue === 'RAYDIUM_LAUNCHLAB') {
    return /Instruction:\s*(Initialize(?:V2|WithToken2022)?|Migrate)/i.test(text);
  }
  return false;
}

export function decodeSolanaVenueTransaction(
  transaction: ParsedTransactionWithMeta,
  signature: string,
): DecodedSolanaTransaction {
  const blockTimeMs = (transaction.blockTime ?? Math.floor(Date.now() / 1000)) * 1000;
  const instructions = normalizeInstructions(transaction);
  const deltas = tokenBalanceDeltas(transaction);
  const launches: SolanaLaunchEvent[] = [];
  const trades: SolanaDecodedTrade[] = [];

  for (const instruction of instructions) {
    const definitions = DEFINITIONS.get(instruction.programId);
    const definition = definitions?.get(instruction.data.subarray(0, 8).toString('hex'));
    if (!definition) continue;
    const descriptor = DESCRIPTORS.find((item) => item.programId === instruction.programId);
    if (!descriptor) continue;
    const named = namedAccounts(definition, instruction.accounts);

    const launch = launchFromInstruction(descriptor.venue, definition.name, named);
    if (launch) {
      launches.push({
        kind: launch.kind,
        venue: launch.venue,
        programId: instruction.programId,
        signature,
        instructionIndex: instruction.index,
        slot: transaction.slot,
        blockTimeMs,
        instructionName: definition.name,
        mintAddress: launch.mint,
        poolAddress: launch.pool,
        quoteMint: launch.quoteMint,
        creatorAddress: launch.creator,
        rawAccounts: instruction.accounts,
      });
    }

    const wallet = account(named, 'user', 'owner', 'payer') ?? firstSigner(transaction);
    const inferredPair = inferPairFromDeltas(deltas, wallet);
    const explicitMints = resolveExplicitPair(named);
    const mint = explicitMints?.mint ?? inferredPair?.mint ?? account(named, 'mint');
    const pool = account(named, 'bondingCurve', 'pool', 'poolId');
    if (!mint || !pool) continue;
    const quoteMint = explicitMints?.quoteMint ?? inferredPair?.quoteMint ?? account(named, 'quoteMint') ?? WSOL_MINT;
    const baseDelta = deltaFor(deltas, wallet, mint);
    const quoteDelta = deltaFor(deltas, wallet, quoteMint);
    const direction = instructionDirection(definition.name) ??
      (normalizeName(definition.name).startsWith('swap') && baseDelta !== 0n
        ? baseDelta > 0n ? 'BUY' : 'SELL'
        : null);
    if (!direction) continue;
    trades.push({
      venue: descriptor.venue,
      programId: instruction.programId,
      signature,
      instructionIndex: instruction.index,
      slot: transaction.slot,
      blockTimeMs,
      instructionName: definition.name,
      mintAddress: mint,
      poolAddress: pool,
      quoteMint,
      wallet,
      direction,
      baseAmountRaw: baseDelta !== 0n ? abs(baseDelta).toString() : null,
      quoteAmountRaw: quoteDelta !== 0n ? abs(quoteDelta).toString() : nativeQuoteDelta(transaction, wallet),
      rawAccounts: instruction.accounts,
    });
  }
  return { launches, trades };
}

function launchFromInstruction(
  venue: SolanaVenue,
  name: string,
  accounts: Map<string, string>,
): { kind: 'LAUNCH' | 'MIGRATION'; venue: SolanaVenue; mint: string; pool: string; quoteMint: string; creator: string | null } | null {
  const normalized = normalizeName(name);
  if (venue === 'PUMP_BONDING_CURVE' && ['create', 'create_v2'].includes(normalized)) {
    return {
      kind: 'LAUNCH', venue, mint: account(accounts, 'mint', 'baseMint')!,
      pool: account(accounts, 'bondingCurve')!, quoteMint: account(accounts, 'quoteMint') ?? WSOL_MINT,
      creator: account(accounts, 'user', 'creator'),
    };
  }
  if (venue === 'PUMP_BONDING_CURVE' && ['migrate', 'migrate_v2'].includes(normalized)) {
    return {
      kind: 'MIGRATION', venue: 'PUMPSWAP', mint: account(accounts, 'mint', 'baseMint')!,
      pool: account(accounts, 'pool')!, quoteMint: account(accounts, 'quoteMint', 'wsolMint') ?? WSOL_MINT,
      creator: account(accounts, 'user'),
    };
  }
  if (venue === 'PUMPSWAP' && normalized === 'create_pool') {
    return {
      kind: 'LAUNCH', venue, mint: account(accounts, 'baseMint')!, pool: account(accounts, 'pool')!,
      quoteMint: account(accounts, 'quoteMint') ?? WSOL_MINT, creator: account(accounts, 'creator'),
    };
  }
  if (venue === 'METEORA_DBC' && normalized.startsWith('initialize_virtual_pool')) {
    return {
      kind: 'LAUNCH', venue, mint: account(accounts, 'baseMint')!, pool: account(accounts, 'pool')!,
      quoteMint: account(accounts, 'quoteMint') ?? WSOL_MINT, creator: account(accounts, 'creator'),
    };
  }
  if (venue === 'METEORA_DBC' && (normalized === 'migrate_meteora_damm' || normalized === 'migration_damm_v2')) {
    return {
      kind: 'MIGRATION', venue: normalized === 'migration_damm_v2' ? 'METEORA_DAMM_V2' : 'METEORA_DAMM_V1',
      mint: account(accounts, 'baseMint', 'tokenAMint')!, pool: account(accounts, 'pool')!,
      quoteMint: account(accounts, 'quoteMint', 'tokenBMint') ?? WSOL_MINT, creator: account(accounts, 'payer'),
    };
  }
  if (venue === 'RAYDIUM_LAUNCHLAB' && ['initialize', 'initialize_v2', 'initialize_with_token2022'].includes(normalized)) {
    return {
      kind: 'LAUNCH', venue, mint: account(accounts, 'mintA')!, pool: account(accounts, 'poolId')!,
      quoteMint: account(accounts, 'mintB') ?? WSOL_MINT, creator: account(accounts, 'creator'),
    };
  }
  if (venue === 'RAYDIUM_CPMM' && normalized === 'initialize') {
    return {
      kind: 'MIGRATION', venue, mint: account(accounts, 'mintA')!, pool: account(accounts, 'poolId')!,
      quoteMint: account(accounts, 'mintB') ?? WSOL_MINT, creator: account(accounts, 'creator'),
    };
  }
  if (venue === 'METEORA_DAMM_V1' && normalized.startsWith('initialize')) {
    return {
      kind: 'LAUNCH', venue, mint: account(accounts, 'tokenAMint')!, pool: account(accounts, 'pool')!,
      quoteMint: account(accounts, 'tokenBMint') ?? WSOL_MINT, creator: account(accounts, 'payer', 'admin'),
    };
  }
  if (venue === 'METEORA_DAMM_V2' && normalized.startsWith('initialize_') && normalized.includes('pool')) {
    return {
      kind: 'LAUNCH', venue, mint: account(accounts, 'token_a_mint')!, pool: account(accounts, 'pool')!,
      quoteMint: account(accounts, 'token_b_mint') ?? WSOL_MINT, creator: account(accounts, 'creator', 'payer'),
    };
  }
  return null;
}

function instructionDirection(name: string): SolanaTradeDirection | null {
  const normalized = normalizeName(name);
  if (normalized === 'buy' || normalized.startsWith('buy_') || normalized.startsWith('buyExact')) return 'BUY';
  if (normalized === 'sell' || normalized.startsWith('sell_') || normalized.startsWith('sellExact')) return 'SELL';
  if (normalized === 'swap' || normalized.startsWith('swap')) return null;
  return null;
}

function normalizeInstructions(transaction: ParsedTransactionWithMeta): NormalizedInstruction[] {
  const keys = transaction.transaction.message.accountKeys.map((entry) => entry.pubkey.toBase58());
  const output: NormalizedInstruction[] = [];
  let index = 0;
  for (const instruction of transaction.transaction.message.instructions) {
    const normalized = normalizeInstruction(instruction, keys, index++);
    if (normalized) output.push(normalized);
  }
  for (const group of transaction.meta?.innerInstructions ?? []) {
    for (const instruction of group.instructions) {
      if ('programIdIndex' in instruction) {
        const compiled = instruction as any;
        output.push({
          programId: keys[Number(compiled.programIdIndex)],
          accounts: (compiled.accounts as number[]).map((accountIndex: number) => keys[accountIndex]),
          data: decodeBase58(String(compiled.data)),
          index: index++,
        });
      } else {
        const normalized = normalizeInstruction(instruction as ParsedInstruction | PartiallyDecodedInstruction, keys, index++);
        if (normalized) output.push(normalized);
      }
    }
  }
  return output;
}

function normalizeInstruction(
  instruction: ParsedInstruction | PartiallyDecodedInstruction,
  _keys: string[],
  index: number,
): NormalizedInstruction | null {
  if (!('data' in instruction) || !('accounts' in instruction)) return null;
  return {
    programId: instruction.programId.toBase58(),
    accounts: instruction.accounts.map((key) => key.toBase58()),
    data: decodeBase58(instruction.data),
    index,
  };
}

function tokenBalanceDeltas(transaction: ParsedTransactionWithMeta): BalanceDelta[] {
  const before = new Map<number, { owner: string | null; mint: string; raw: bigint }>();
  for (const balance of transaction.meta?.preTokenBalances ?? []) {
    before.set(balance.accountIndex, {
      owner: balance.owner ?? null,
      mint: balance.mint,
      raw: BigInt(balance.uiTokenAmount.amount),
    });
  }
  const indexes = new Set([
    ...before.keys(),
    ...(transaction.meta?.postTokenBalances ?? []).map((balance) => balance.accountIndex),
  ]);
  const after = new Map((transaction.meta?.postTokenBalances ?? []).map((balance) => [balance.accountIndex, balance]));
  return [...indexes].map((accountIndex) => {
    const pre = before.get(accountIndex);
    const post = after.get(accountIndex);
    return {
      owner: post?.owner ?? pre?.owner ?? null,
      mint: post?.mint ?? pre?.mint ?? '',
      raw: BigInt(post?.uiTokenAmount.amount ?? '0') - (pre?.raw ?? 0n),
    };
  });
}

function deltaFor(deltas: readonly BalanceDelta[], owner: string, mint: string): bigint {
  return deltas
    .filter((delta) => delta.owner === owner && delta.mint === mint)
    .reduce((total, delta) => total + delta.raw, 0n);
}

function nativeQuoteDelta(transaction: ParsedTransactionWithMeta, wallet: string): string | null {
  const index = transaction.transaction.message.accountKeys.findIndex((entry) => entry.pubkey.toBase58() === wallet);
  if (index < 0 || !transaction.meta) return null;
  const raw = BigInt(transaction.meta.postBalances[index] ?? 0) - BigInt(transaction.meta.preBalances[index] ?? 0);
  return raw !== 0n ? abs(raw).toString() : null;
}

function firstSigner(transaction: ParsedTransactionWithMeta): string {
  return transaction.transaction.message.accountKeys.find((entry) => entry.signer)?.pubkey.toBase58() ?? '';
}

function definitionsFromIdl(idl: any): Map<string, InstructionDefinition> {
  return new Map((idl.instructions ?? []).map((instruction: any) => {
    const discriminator = instruction.discriminator?.length
      ? Buffer.from(instruction.discriminator).toString('hex')
      : createHash('sha256').update(`global:${normalizeName(instruction.name)}`).digest().subarray(0, 8).toString('hex');
    const definition: InstructionDefinition = {
      name: instruction.name,
      discriminator,
      accountNames: (instruction.accounts ?? []).map((item: any) => item.name),
    };
    return [definition.discriminator, definition];
  }));
}

function resolveExplicitPair(accounts: Map<string, string>): { mint: string; quoteMint: string } | null {
  const first = account(accounts, 'baseMint', 'mintA', 'tokenAMint', 'token_a_mint', 'inputMint');
  const second = account(accounts, 'quoteMint', 'mintB', 'tokenBMint', 'token_b_mint', 'outputMint');
  if (!first || !second) return null;
  if (QUOTE_MINTS.has(first) && !QUOTE_MINTS.has(second)) return { mint: second, quoteMint: first };
  return { mint: first, quoteMint: second };
}

function inferPairFromDeltas(deltas: readonly BalanceDelta[], wallet: string): { mint: string; quoteMint: string } | null {
  const walletDeltas = deltas.filter((delta) => delta.owner === wallet && delta.raw !== 0n);
  const quote = walletDeltas.find((delta) => QUOTE_MINTS.has(delta.mint));
  const base = walletDeltas.find((delta) => !QUOTE_MINTS.has(delta.mint));
  return quote && base ? { mint: base.mint, quoteMint: quote.mint } : null;
}

function raydiumDefinition(name: keyof typeof anchorDataBuf, accountNames: string[]): InstructionDefinition {
  return { name, discriminator: Buffer.from(anchorDataBuf[name]).toString('hex'), accountNames };
}

function definition(name: string, discriminator: string, accountNames: string[]): InstructionDefinition {
  return { name, discriminator, accountNames };
}

function namedAccounts(definition: InstructionDefinition, values: string[]): Map<string, string> {
  const entries: Array<[string, string]> = [];
  definition.accountNames.forEach((name, index) => {
    if (values[index]) entries.push([name, values[index]]);
  });
  return new Map(entries);
}

function account(values: Map<string, string>, ...names: string[]): string | null {
  for (const name of names) {
    const direct = values.get(name);
    if (direct) return direct;
    const normalized = [...values.entries()].find(([key]) => normalizeName(key) === normalizeName(name));
    if (normalized?.[1]) return normalized[1];
  }
  return null;
}

function normalizeName(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function decodeBase58(value: string): Buffer {
  try {
    return Buffer.from(bs58.decode(value));
  } catch {
    return Buffer.alloc(0);
  }
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}
