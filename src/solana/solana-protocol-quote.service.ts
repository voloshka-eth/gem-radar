import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import BN from 'bn.js';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  Curve,
  LAUNCHPAD_PROGRAM,
  PlatformConfig,
  Raydium,
} from '@raydium-io/raydium-sdk-v2';
import {
  OnlinePumpSdk,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
} from '@pump-fun/pump-sdk';
import {
  OnlinePumpAmmSdk,
  buyQuoteInput,
  sellBaseInput,
} from '@pump-fun/pump-swap-sdk';
import { SolanaExecutionSnapshot, SolanaVenue } from './solana-flow-v2';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const PAPER_OWNER = new PublicKey('11111111111111111111111111111111');

interface RouteQuoteData {
  inputAmount: string;
  outputAmount: string;
  priceImpactPct?: number | string;
  routePlan?: unknown[];
}

interface ProtocolQuote {
  inputRaw: string;
  outputRaw: string;
  inputUsd: number;
  outputUsd?: number;
}

export interface SolanaRoundTripQuote extends SolanaExecutionSnapshot {
  venue: SolanaVenue;
  poolAddress: string;
  mintAddress: string;
  quoteMint: string;
  tokenDecimals: number;
  quoteDecimals: number;
  spotPriceUsd: number;
  fdvUsd: number | null;
  entryTokensRaw: string;
  entryTokens: number;
  entryUsd: number;
  sellUsd: number;
  gasUsd: number;
  raw: Record<string, unknown>;
}

@Injectable()
export class SolanaProtocolQuoteService {
  readonly connection: Connection;
  private readonly http: AxiosInstance;
  private readonly pump: OnlinePumpSdk;
  private readonly pumpSwap: OnlinePumpAmmSdk;
  private raydiumPromise: Promise<Raydium> | null = null;
  private readonly mintDecimals = new Map<string, number>();
  private readonly stateCache = new Map<string, { expiresAt: number; value: Promise<any> }>();
  private rpcTail: Promise<void> = Promise.resolve();
  private nextRpcAt = 0;

  constructor(private readonly config: ConfigService) {
    const rpcUrl = this.config.get<string>('solanaLaunch.rpcUrl')!;
    const wsEndpoint = this.config.get<string>('solanaLaunch.wsUrl') || undefined;
    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      wsEndpoint,
      disableRetryOnRateLimit: true,
    });
    this.http = axios.create({
      timeout: this.config.get<number>('solanaLaunch.requestTimeoutMs') ?? 10_000,
      validateStatus: () => true,
    });
    this.pump = new OnlinePumpSdk(this.connection);
    this.pumpSwap = new OnlinePumpAmmSdk(this.connection);
  }

  async quoteRoundTrip(
    venue: SolanaVenue,
    poolAddress: string,
    mintAddress: string,
    quoteMintHint: string,
    entryUsd = 20,
  ): Promise<SolanaRoundTripQuote | null> {
    const quoteSlot = await this.cached('slot', 250, () => this.runRpc(() => this.connection.getSlot('confirmed')));
    const adapter = await this.adapterFor(venue, poolAddress, mintAddress, quoteMintHint, quoteSlot);
    if (!adapter) return null;
    const baselineUsd = Math.min(0.05, entryUsd / 100);
    const [baseline, entry, depth] = await Promise.all([
      adapter.buy(baselineUsd), adapter.buy(entryUsd), adapter.buy(100),
    ]);
    if (!baseline || !entry || !depth) return null;
    const entryTokens = rawToNumber(entry.outputRaw, adapter.tokenDecimals);
    const baselineTokens = rawToNumber(baseline.outputRaw, adapter.tokenDecimals);
    if (!(entryTokens > 0) || !(baselineTokens > 0)) return null;
    const sell = await adapter.sell(entry.outputRaw);
    if (!sell || !(sell.outputUsd != null)) return null;

    const spotPriceUsd = spotPriceFromProbe(baselineUsd, baselineTokens);
    const buySlippagePct = executionPriceImpact(baselineUsd, baselineTokens, entryUsd, entryTokens);
    const sellGrossAtSpot = entryTokens * spotPriceUsd;
    const sellSlippagePct = clampSlip(1 - sell.outputUsd / sellGrossAtSpot);
    const depthTokens = rawToNumber(depth.outputRaw, adapter.tokenDecimals);
    const depthSlip = executionPriceImpact(baselineUsd, baselineTokens, 100, depthTokens);
    const gasUsd = this.config.get<number>('solanaLaunch.gasUsd') ?? 0.01;
    const sellUsd = Math.max(0, sell.outputUsd - gasUsd);
    const totalSupplyRaw = await this.tokenSupply(new PublicKey(mintAddress))
      .then((result) => result.value.amount)
      .catch(() => null);
    const fdvUsd = totalSupplyRaw == null
      ? null
      : rawToNumber(totalSupplyRaw, adapter.tokenDecimals) * spotPriceUsd;
    return {
      venue,
      poolAddress,
      mintAddress,
      quoteMint: adapter.quoteMint,
      tokenDecimals: adapter.tokenDecimals,
      quoteDecimals: adapter.quoteDecimals,
      executable: true,
      buySlippagePct,
      sellSlippagePct,
      roundTripMultiple: sellUsd / entryUsd,
      executableDepthUsd: depthSlip <= 0.10 ? 100 : 0,
      quoteSlot,
      quoteModel: adapter.model,
      spotPriceUsd,
      fdvUsd,
      entryTokensRaw: entry.outputRaw,
      entryTokens,
      entryUsd,
      sellUsd,
      gasUsd,
      raw: {
        baseline, baselineUsd, entry, depth, sell, depthSlippagePct: depthSlip,
      },
    };
  }

  async sellQuote(position: {
    venue: SolanaVenue;
    poolAddress: string;
    mintAddress: string;
    quoteMint: string;
    tokensRaw: string;
  }): Promise<{ netUsd: number; grossUsd: number; slippagePct: number; quoteSlot: number; raw: unknown } | null> {
    const quoteSlot = await this.cached('slot', 250, () => this.runRpc(() => this.connection.getSlot('confirmed')));
    const adapter = await this.adapterFor(
      position.venue, position.poolAddress, position.mintAddress, position.quoteMint, quoteSlot,
    );
    if (!adapter) return null;
    const sell = await adapter.sell(position.tokensRaw);
    if (!sell?.outputUsd) return null;
    const tokens = rawToNumber(position.tokensRaw, adapter.tokenDecimals);
    const baselineUsd = 0.05;
    const baseline = await adapter.buy(baselineUsd);
    if (!baseline) return null;
    const spotPrice = spotPriceFromProbe(
      baselineUsd,
      rawToNumber(baseline.outputRaw, adapter.tokenDecimals),
    );
    const grossAtSpot = tokens * spotPrice;
    const grossUsd = sell.outputUsd;
    return {
      grossUsd,
      netUsd: Math.max(0, grossUsd - (this.config.get<number>('solanaLaunch.gasUsd') ?? 0.01)),
      slippagePct: clampSlip(1 - grossUsd / grossAtSpot),
      quoteSlot,
      raw: sell,
    };
  }

  async quoteRawToUsd(quoteMint: string, raw: string): Promise<number | null> {
    if (quoteMint === USDC_MINT) return rawToNumber(raw, 6);
    const route = await this.routeQuote(quoteMint, USDC_MINT, raw);
    return route ? rawToNumber(route.outputAmount, 6) : null;
  }

  async runRpc<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.isPublicRpc()) return operation();
    const task = this.rpcTail.then(async () => {
      const waitMs = Math.max(0, this.nextRpcAt - Date.now());
      if (waitMs > 0) await delay(waitMs);
      try {
        return await operation();
      } finally {
        this.nextRpcAt = Date.now() + this.rpcIntervalMs();
      }
    });
    this.rpcTail = task.then(() => undefined, () => undefined);
    return task;
  }

  private async adapterFor(
    venue: SolanaVenue,
    poolAddress: string,
    mintAddress: string,
    quoteMintHint: string,
    slot: number,
  ): Promise<{
    model: string;
    quoteMint: string;
    tokenDecimals: number;
    quoteDecimals: number;
    buy: (usd: number) => Promise<ProtocolQuote | null>;
    sell: (tokensRaw: string) => Promise<ProtocolQuote | null>;
  } | null> {
    if (venue === 'PUMP_BONDING_CURVE') return this.pumpAdapter(mintAddress);
    if (venue === 'PUMPSWAP') return this.pumpSwapAdapter(poolAddress);
    if (venue === 'RAYDIUM_LAUNCHLAB') return this.raydiumLaunchAdapter(poolAddress, slot);
    if (venue === 'METEORA_DBC') return this.meteoraAdapter(poolAddress);
    return this.routeAdapter(mintAddress, quoteMintHint);
  }

  private async pumpAdapter(mintAddress: string) {
    const mint = new PublicKey(mintAddress);
    const global = await this.cached('pump:global', 60_000, () => this.runRpc(() => this.pump.fetchGlobal()));
    const feeConfig = await this.cached(
      'pump:fee-config',
      60_000,
      () => this.runRpc(() => this.pump.fetchFeeConfig()).catch(() => null),
    );
    const bondingCurve = await this.cached(
      `pump:curve:${mintAddress}`,
      500,
      () => this.runRpc(() => this.pump.fetchBondingCurve(mint)),
    );
    const supply = await this.tokenSupply(mint);
    if (bondingCurve.complete) return null;
    const quoteMint = bondingCurve.quoteMint.equals(PublicKey.default) ? WSOL_MINT : bondingCurve.quoteMint.toBase58();
    const tokenDecimals = supply.value.decimals;
    const quoteDecimals = await this.decimals(quoteMint);
    const mintSupply = new BN(supply.value.amount);
    return {
      model: 'PUMP_BONDING_CURVE_SDK', quoteMint, tokenDecimals, quoteDecimals,
      buy: async (usd: number) => {
        const quoteRaw = await this.usdToQuoteRaw(usd, quoteMint);
        if (!quoteRaw) return null;
        const output = getBuyTokenAmountFromSolAmount({
          global, feeConfig, mintSupply, bondingCurve, amount: new BN(quoteRaw), quoteMint: new PublicKey(quoteMint),
        });
        return { inputRaw: quoteRaw, outputRaw: output.toString(), inputUsd: usd };
      },
      sell: async (tokensRaw: string) => {
        const output = getSellSolAmountFromTokenAmount({
          global, feeConfig, mintSupply, bondingCurve, amount: new BN(tokensRaw),
        });
        const outputUsd = await this.quoteRawToUsd(quoteMint, output.toString());
        return { inputRaw: tokensRaw, outputRaw: output.toString(), inputUsd: 0, outputUsd: outputUsd ?? undefined };
      },
    };
  }

  private async pumpSwapAdapter(poolAddress: string) {
    const state = await this.cached(
      `pumpswap:${poolAddress}`,
      500,
      () => this.runRpc(() => this.pumpSwap.swapSolanaState(new PublicKey(poolAddress), PAPER_OWNER)),
    );
    const quoteMint = state.pool.quoteMint.toBase58();
    const tokenDecimals = state.baseMintAccount.decimals;
    const quoteDecimals = await this.decimals(quoteMint);
    return {
      model: 'PUMPSWAP_SDK', quoteMint, tokenDecimals, quoteDecimals,
      buy: async (usd: number) => {
        const quoteRaw = await this.usdToQuoteRaw(usd, quoteMint);
        if (!quoteRaw) return null;
        const result = buyQuoteInput({
          quote: new BN(quoteRaw), slippage: 0, baseReserve: state.poolBaseAmount,
          quoteReserve: state.poolQuoteAmount, virtualQuoteReserves: state.pool.virtualQuoteReserves,
          globalConfig: state.globalConfig, baseMintAccount: state.baseMintAccount,
          baseMint: state.baseMint, coinCreator: state.pool.coinCreator, creator: state.pool.creator,
          feeConfig: state.feeConfig,
        });
        return { inputRaw: quoteRaw, outputRaw: result.base.toString(), inputUsd: usd };
      },
      sell: async (tokensRaw: string) => {
        const result = sellBaseInput({
          base: new BN(tokensRaw), slippage: 0, baseReserve: state.poolBaseAmount,
          quoteReserve: state.poolQuoteAmount, virtualQuoteReserves: state.pool.virtualQuoteReserves,
          globalConfig: state.globalConfig, baseMintAccount: state.baseMintAccount,
          baseMint: state.baseMint, coinCreator: state.pool.coinCreator, creator: state.pool.creator,
          feeConfig: state.feeConfig,
        });
        const outputUsd = await this.quoteRawToUsd(quoteMint, result.uiQuote.toString());
        return { inputRaw: tokensRaw, outputRaw: result.uiQuote.toString(), inputUsd: 0, outputUsd: outputUsd ?? undefined };
      },
    };
  }

  private async raydiumLaunchAdapter(poolAddress: string, slot: number) {
    const raydium = await this.raydium();
    const poolInfo: any = await this.cached(
      `raydium-launch:${poolAddress}`,
      500,
      () => this.runRpc(() => raydium.launchpad.getRpcPoolInfo({ poolId: new PublicKey(poolAddress) })),
    );
    if (Number(poolInfo.status) !== 0) return null;
    const platformAccount = await this.cached(
      `raydium-platform:${poolInfo.platformId.toBase58()}`,
      60_000,
      () => this.runRpc(() => this.connection.getAccountInfo(poolInfo.platformId, 'confirmed')),
    );
    const platformInfo: any = platformAccount ? PlatformConfig.decode(platformAccount.data) : null;
    const quoteMint = poolInfo.mintB.toBase58();
    const tokenDecimals = Number(poolInfo.mintDecimalsA);
    const quoteDecimals = Number(poolInfo.mintDecimalsB);
    const curveArgs = {
      poolInfo,
      protocolFeeRate: poolInfo.configInfo.tradeFeeRate,
      platformFeeRate: platformInfo?.feeRate ?? new BN(0),
      curveType: Number(poolInfo.configInfo.curveType),
      shareFeeRate: new BN(0),
      creatorFeeRate: platformInfo?.creatorFeeRate ?? new BN(0),
      transferFeeConfigA: undefined,
      slot,
    };
    return {
      model: 'RAYDIUM_LAUNCHLAB_SDK', quoteMint, tokenDecimals, quoteDecimals,
      buy: async (usd: number) => {
        const quoteRaw = await this.usdToQuoteRaw(usd, quoteMint);
        if (!quoteRaw) return null;
        const result = Curve.buyExactIn({ ...curveArgs, amountB: new BN(quoteRaw) });
        return { inputRaw: quoteRaw, outputRaw: result.amountA.amount.toString(), inputUsd: usd };
      },
      sell: async (tokensRaw: string) => {
        const result = Curve.sellExactIn({ ...curveArgs, amountA: new BN(tokensRaw) });
        const outputUsd = await this.quoteRawToUsd(quoteMint, result.amountB.toString());
        return { inputRaw: tokensRaw, outputRaw: result.amountB.toString(), inputUsd: 0, outputUsd: outputUsd ?? undefined };
      },
    };
  }

  private async meteoraAdapter(poolAddress: string) {
    const sdk: any = await import('@meteora-ag/dynamic-bonding-curve-sdk');
    const client = sdk.DynamicBondingCurveClient.create(this.connection, 'confirmed');
    const pool: any = await this.cached(
      `meteora-pool:${poolAddress}`,
      500,
      () => this.runRpc(() => client.state.getPool(poolAddress)),
    );
    if (!pool) return null;
    const configKey = new PublicKey(pool.config).toBase58();
    const config: any = await this.cached(
      `meteora-config:${configKey}`,
      60_000,
      () => this.runRpc(() => client.state.getPoolConfig(pool.config)),
    );
    if (!config) return null;
    const quoteMint = new PublicKey(config.quoteMint).toBase58();
    const tokenDecimals = Number(config.tokenDecimal ?? config.tokenBaseDecimal ?? 6);
    const quoteDecimals = await this.decimals(quoteMint);
    const currentPoint = await this.cached(
      `meteora-point:${String(config.activationType)}`,
      500,
      () => this.runRpc(() => sdk.getCurrentPoint(this.connection, config.activationType)),
    );
    return {
      model: 'METEORA_DBC_SDK', quoteMint, tokenDecimals, quoteDecimals,
      buy: async (usd: number) => {
        const quoteRaw = await this.usdToQuoteRaw(usd, quoteMint);
        if (!quoteRaw) return null;
        const result: any = sdk.swapQuoteExactIn(pool, config, false, new BN(quoteRaw), 0, false, currentPoint, false);
        return { inputRaw: quoteRaw, outputRaw: result.outputAmount.toString(), inputUsd: usd };
      },
      sell: async (tokensRaw: string) => {
        const result: any = sdk.swapQuoteExactIn(pool, config, true, new BN(tokensRaw), 0, false, currentPoint, false);
        const outputUsd = await this.quoteRawToUsd(quoteMint, result.outputAmount.toString());
        return { inputRaw: tokensRaw, outputRaw: result.outputAmount.toString(), inputUsd: 0, outputUsd: outputUsd ?? undefined };
      },
    };
  }

  private async routeAdapter(mintAddress: string, _quoteMintHint: string) {
    const tokenDecimals = await this.decimals(mintAddress);
    return {
      model: 'RAYDIUM_ROUTE_API', quoteMint: USDC_MINT, tokenDecimals, quoteDecimals: 6,
      buy: async (usd: number) => {
        const route = await this.routeQuote(USDC_MINT, mintAddress, String(Math.round(usd * 1_000_000)));
        return route ? { inputRaw: route.inputAmount, outputRaw: route.outputAmount, inputUsd: usd } : null;
      },
      sell: async (tokensRaw: string) => {
        const route = await this.routeQuote(mintAddress, USDC_MINT, tokensRaw);
        return route ? {
          inputRaw: route.inputAmount, outputRaw: route.outputAmount, inputUsd: 0,
          outputUsd: rawToNumber(route.outputAmount, 6),
        } : null;
      },
    };
  }

  private async usdToQuoteRaw(usd: number, quoteMint: string): Promise<string | null> {
    if (quoteMint === USDC_MINT) return String(Math.round(usd * 1_000_000));
    const route = await this.routeQuote(USDC_MINT, quoteMint, String(Math.round(usd * 1_000_000)));
    return route?.outputAmount ?? null;
  }

  private async routeQuote(inputMint: string, outputMint: string, amount: string): Promise<RouteQuoteData | null> {
    const baseUrl = this.config.get<string>('solanaLaunch.tradeApiUrl')!;
    const response = await this.http.get(`${baseUrl}/compute/swap-base-in`, {
      params: { inputMint, outputMint, amount, slippageBps: 0, txVersion: 'V0' },
    });
    const data = response.data?.data as RouteQuoteData | undefined;
    return response.status >= 200 && response.status < 300 && response.data?.success === true && data ? data : null;
  }

  private async decimals(mint: string): Promise<number> {
    const cached = this.mintDecimals.get(mint);
    if (cached != null) return cached;
    const decimals = mint === USDC_MINT ? 6 : (await this.tokenSupply(new PublicKey(mint))).value.decimals;
    this.mintDecimals.set(mint, decimals);
    return decimals;
  }

  private raydium(): Promise<Raydium> {
    this.raydiumPromise ??= this.runRpc(() => Raydium.load({
      connection: this.connection,
      owner: PAPER_OWNER,
      disableFeatureCheck: true,
      disableLoadToken: true,
      blockhashCommitment: 'confirmed',
    }));
    return this.raydiumPromise;
  }

  private tokenSupply(mint: PublicKey) {
    return this.cached(
      `supply:${mint.toBase58()}`,
      2_000,
      () => this.runRpc(() => this.connection.getTokenSupply(mint, 'confirmed')),
    );
  }

  private cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const existing = this.stateCache.get(key);
    if (existing && existing.expiresAt > Date.now()) return existing.value as Promise<T>;
    const value = load().catch((error) => {
      if (this.stateCache.get(key)?.value === value) this.stateCache.delete(key);
      throw error;
    });
    this.stateCache.set(key, { expiresAt: Date.now() + ttlMs, value });
    return value;
  }

  private isPublicRpc(): boolean {
    return /api\.mainnet-beta\.solana\.com/i.test(this.config.get<string>('solanaLaunch.rpcUrl') ?? '');
  }

  private rpcIntervalMs(): number {
    return Math.max(0, this.config.get<number>('solanaLaunch.rpcMinRequestIntervalMs') ?? 250);
  }
}

function rawToNumber(raw: string, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  const value = BigInt(raw);
  return Number(value / scale) + Number(value % scale) / Number(scale);
}

function clampSlip(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, value);
}

export function spotPriceFromProbe(probeUsd: number, tokens: number): number {
  return probeUsd > 0 && tokens > 0 ? probeUsd / tokens : 0;
}

export function executionPriceImpact(
  probeUsd: number,
  probeTokens: number,
  orderUsd: number,
  orderTokens: number,
): number {
  const marginalTokensPerUsd = probeUsd > 0 ? probeTokens / probeUsd : 0;
  const executionTokensPerUsd = orderUsd > 0 ? orderTokens / orderUsd : 0;
  return marginalTokensPerUsd > 0
    ? clampSlip(1 - executionTokensPerUsd / marginalTokensPerUsd)
    : 1;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
