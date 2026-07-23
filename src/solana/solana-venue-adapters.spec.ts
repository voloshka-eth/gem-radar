import { Keypair, PublicKey } from '@solana/web3.js';
import * as bs58 from 'bs58';
import { PUMP_PROGRAM_ID, pumpIdl } from '@pump-fun/pump-sdk';
import { CP_AMM_PROGRAM_ID, CpAmmIdl } from '@meteora-ag/cp-amm-sdk';
import { CREATE_CPMM_POOL_PROGRAM } from '@raydium-io/raydium-sdk-v2';
import { decodeSolanaVenueTransaction, isPotentialLaunchLog } from './solana-venue-adapters';

describe('Solana venue instruction decoder', () => {
  it('decodes a Pump create instruction with durable attribution fields', () => {
    const definition: any = pumpIdl.instructions.find((instruction: any) => instruction.name === 'create');
    const accounts = definition.accounts.map(() => Keypair.generate().publicKey);
    const transaction = parsedTransaction(
      PUMP_PROGRAM_ID,
      accounts,
      Buffer.from(definition.discriminator),
    );
    const result = decodeSolanaVenueTransaction(transaction as any, 'create-signature');
    expect(result.launches).toHaveLength(1);
    expect(result.launches[0]).toMatchObject({
      venue: 'PUMP_BONDING_CURVE',
      instructionName: 'create',
      mintAddress: accounts[0].toBase58(),
      poolAddress: accounts[2].toBase58(),
      creatorAddress: accounts[7].toBase58(),
    });
  });

  it('decodes Pump buy direction and token delta for the signer', () => {
    const definition: any = pumpIdl.instructions.find((instruction: any) => instruction.name === 'buy');
    const accounts = definition.accounts.map(() => Keypair.generate().publicKey);
    const user = accounts[6];
    const mint = accounts[2];
    const transaction: any = parsedTransaction(PUMP_PROGRAM_ID, accounts, Buffer.from(definition.discriminator));
    transaction.transaction.message.accountKeys = [
      { pubkey: user, signer: true, writable: true },
      { pubkey: mint, signer: false, writable: false },
      { pubkey: PUMP_PROGRAM_ID, signer: false, writable: false },
    ];
    transaction.meta.preTokenBalances = [{ accountIndex: 1, mint: mint.toBase58(), owner: user.toBase58(), uiTokenAmount: { amount: '0' } }];
    transaction.meta.postTokenBalances = [{ accountIndex: 1, mint: mint.toBase58(), owner: user.toBase58(), uiTokenAmount: { amount: '12345' } }];
    transaction.meta.preBalances = [1_000_000_000, 0, 0];
    transaction.meta.postBalances = [900_000_000, 0, 0];
    const result = decodeSolanaVenueTransaction(transaction, 'buy-signature');
    expect(result.trades[0]).toMatchObject({
      venue: 'PUMP_BONDING_CURVE', direction: 'BUY', wallet: user.toBase58(), baseAmountRaw: '12345',
    });
  });

  it('decodes Meteora DAMM v2 swaps from the official IDL', () => {
    const definition: any = CpAmmIdl.instructions.find((instruction: any) => instruction.name === 'swap');
    const accounts = definition.accounts.map(() => Keypair.generate().publicKey);
    const named = new Map<string, PublicKey>(
      definition.accounts.map((item: any, index: number) => [item.name, accounts[index]]),
    );
    const user = named.get('payer')!;
    const mint = named.get('token_a_mint')!;
    const quoteMint = named.get('token_b_mint')!;
    const transaction: any = parsedTransaction(CP_AMM_PROGRAM_ID, accounts, Buffer.from(definition.discriminator));
    addBalanceDeltas(transaction, user, mint, quoteMint, '12345', '-1000000');

    const result = decodeSolanaVenueTransaction(transaction, 'damm-v2-swap');
    expect(result.trades[0]).toMatchObject({
      venue: 'METEORA_DAMM_V2', direction: 'BUY', wallet: user.toBase58(),
      mintAddress: mint.toBase58(), quoteMint: quoteMint.toBase58(), baseAmountRaw: '12345',
    });
  });

  it('decodes Raydium CPMM migration and swap instructions', () => {
    const launchAccounts = Array.from({ length: 14 }, () => Keypair.generate().publicKey);
    const launch = parsedTransaction(
      CREATE_CPMM_POOL_PROGRAM,
      launchAccounts,
      Buffer.from('afaf6d1f0d989bed', 'hex'),
    );
    const launchResult = decodeSolanaVenueTransaction(launch as any, 'cpmm-create');
    expect(launchResult.launches[0]).toMatchObject({
      kind: 'MIGRATION', venue: 'RAYDIUM_CPMM',
      poolAddress: launchAccounts[3].toBase58(), mintAddress: launchAccounts[4].toBase58(),
    });

    const swapAccounts = Array.from({ length: 13 }, () => Keypair.generate().publicKey);
    const user = swapAccounts[0];
    swapAccounts[10] = new PublicKey('So11111111111111111111111111111111111111112');
    const quoteMint = swapAccounts[10];
    const mint = swapAccounts[11];
    const swap: any = parsedTransaction(
      CREATE_CPMM_POOL_PROGRAM,
      swapAccounts,
      Buffer.from('8fbe5adac41e33de', 'hex'),
    );
    addBalanceDeltas(swap, user, mint, quoteMint, '5000', '-1000000');
    const swapResult = decodeSolanaVenueTransaction(swap, 'cpmm-swap');
    expect(swapResult.trades[0]).toMatchObject({
      venue: 'RAYDIUM_CPMM', direction: 'BUY', poolAddress: swapAccounts[3].toBase58(),
      mintAddress: mint.toBase58(), quoteMint: quoteMint.toBase58(),
    });
  });

  it('filters global program logs before spending an HTTP transaction request', () => {
    expect(isPotentialLaunchLog('PUMP_BONDING_CURVE', ['Program log: Instruction: Buy'])).toBe(false);
    expect(isPotentialLaunchLog('PUMP_BONDING_CURVE', ['Program log: Instruction: CreateV2'])).toBe(true);
    expect(isPotentialLaunchLog('METEORA_DBC', ['Program log: Instruction: MigrateMeteoraDamm'])).toBe(true);
    expect(isPotentialLaunchLog('RAYDIUM_LAUNCHLAB', ['Program log: Instruction: SellExactIn'])).toBe(false);
  });
});

function addBalanceDeltas(
  transaction: any,
  user: PublicKey,
  mint: PublicKey,
  quoteMint: PublicKey,
  baseDelta: string,
  quoteDelta: string,
): void {
  transaction.transaction.message.accountKeys = [
    { pubkey: user, signer: true, writable: true },
    { pubkey: mint, signer: false, writable: false },
    { pubkey: quoteMint, signer: false, writable: false },
  ];
  transaction.meta.preTokenBalances = [
    { accountIndex: 1, mint: mint.toBase58(), owner: user.toBase58(), uiTokenAmount: { amount: '0' } },
    { accountIndex: 2, mint: quoteMint.toBase58(), owner: user.toBase58(), uiTokenAmount: { amount: '1000000' } },
  ];
  transaction.meta.postTokenBalances = [
    { accountIndex: 1, mint: mint.toBase58(), owner: user.toBase58(), uiTokenAmount: { amount: baseDelta } },
    {
      accountIndex: 2,
      mint: quoteMint.toBase58(),
      owner: user.toBase58(),
      uiTokenAmount: { amount: String(BigInt('1000000') + BigInt(quoteDelta)) },
    },
  ];
}

function parsedTransaction(programId: PublicKey, accounts: PublicKey[], discriminator: Buffer) {
  const payer = accounts[0];
  return {
    slot: 123,
    blockTime: 1_700_000_000,
    transaction: {
      signatures: ['signature'],
      message: {
        accountKeys: [
          { pubkey: payer, signer: true, writable: true },
          { pubkey: programId, signer: false, writable: false },
        ],
        instructions: [{ programId, accounts, data: bs58.encode(discriminator) }],
      },
    },
    meta: {
      err: null, fee: 5_000, innerInstructions: [], logMessages: [],
      preBalances: [1_000_000_000, 0], postBalances: [999_995_000, 0],
      preTokenBalances: [], postTokenBalances: [], rewards: [], loadedAddresses: { writable: [], readonly: [] },
    },
  };
}
