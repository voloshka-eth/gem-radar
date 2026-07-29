import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import BN from 'bn.js';
import { Connection, PublicKey, type FetchFn } from '@solana/web3.js';
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

export interface SolanaQuoteSizeMatrix {
  quoteSlot: number;
  observedAt: Date;
  quotes: SolanaRoundTripQuote[];
  depthConfidence: 'REAL_EXECUTABLE_ATOMIC' | 'ROUTE_AGGREGATOR_NON_ATOMIC';
}

export type SolanaRpcPriority = 'P0' | 'P1' | 'P2' | 'P3';

interface QueuedRpcOperation {
  priority: SolanaRpcPriority;
  sequence: number;
  operation: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export function createSolanaRpcFailoverFetch(
  urls: readonly string[],
  primaryTimeoutMs: number,
  fallbackTimeoutMs: number,
  baseFetch: FetchFn = ((input: unknown, init?: unknown) =>
    globalThis.fetch(input as any, init as any)) as FetchFn,
): FetchFn {
  const endpoints = [...new Set(urls.map((url) => url.trim()).filter((url) => /^https?:\/\//i.test(url)))];
  if (!endpoints.length) throw new Error('Solana RPC failover requires at least one HTTP endpoint');

  return (async (_input: unknown, init?: any) => {
    let lastError: unknown = new Error('All Solana RPC endpoints failed');

    for (let index = 0; index < endpoints.length; index++) {
      const controller = new AbortController();
      const upstreamSignal: AbortSignal | undefined = init?.signal;
      const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
      if (upstreamSignal?.aborted) abortFromUpstream();
      else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });

      const timeoutMs = index === 0 ? primaryTimeoutMs : fallbackTimeoutMs;
      const timer = setTimeout(() => controller.abort(new Error('RPC endpoint deadline exceeded')), timeoutMs);
      try {
        const response: any = await baseFetch(endpoints[index] as any, {
          ...init,
          signal: controller.signal,
        });
        if (!isRetryableRpcResponse(response)) return response;
        lastError = new Error(`Solana RPC endpoint returned retryable HTTP ${response.status}`);
      } catch (error) {
        if (upstreamSignal?.aborted) throw error;
        lastError = error;
      } finally {
        clearTimeout(timer);
        upstreamSignal?.removeEventListener('abort', abortFromUpstream);
      }
    }

    throw lastError;
  }) as FetchFn;
}

function isRetryableRpcResponse(response: { ok?: boolean; status?: number }): boolean {
  const status = Number(response.status ?? 0);
  return status === 408 || status === 425 || status === 429 || status >= 500;
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
  private readonly rpcQueue: QueuedRpcOperation[] = [];
  private rpcQueueRunning = false;
  private rpcSequence = 0;
  private nextRpcAt = 0;

  constructor(private readonly config: ConfigService) {
    const rpcUrl = this.config.get<string>('solanaLaunch.rpcUrl')!;
    const rpcUrls = this.config.get<string[]>('solanaLaunch.rpcUrls') ?? [rpcUrl];
    const wsEndpoint = this.config.get<string>('solanaLaunch.wsUrl') || undefined;
    const primaryTimeoutMs = this.config.get<number>('solanaLaunch.rpcPrimaryTimeoutMs') ?? 8_000;
    const fallbackTimeoutMs = this.config.get<number>('solanaLaunch.rpcFallbackTimeoutMs') ?? 12_000;
    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      wsEndpoint,
      fetch: createSolanaRpcFailoverFetch(rpcUrls, primaryTimeoutMs, fallbackTimeoutMs),
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
    priority: SolanaRpcPriority = 'P1',
  ): Promise<SolanaRoundTripQuote | null> {
    // A single entry quote still needs a real capacity probe. Returning depth
    // from the $20 leg alone made every otherwise-valid entry look depthless.
    const sizes = entryUsd === 100 ? [100] : [entryUsd, 100];
    const matrix = await this.quoteSizeMatrix(venue, poolAddress, mintAddress, quoteMintHint, sizes, priority);
    return matrix?.quotes.find((quote) => quote.entryUsd === entryUsd) ?? null;
  }

  async quoteSizeMatrix(
    venue: SolanaVenue,
    poolAddress: string,
    mintAddress: string,
    quoteMintHint: string,
    sizesUsd: readonly number[],
    priority: SolanaRpcPriority = 'P1',
  ): Promise<SolanaQuoteSizeMatrix | null> {
    const sizes = [...new Set(sizesUsd)].filter((size) => Number.isFinite(size) && size > 0).sort((left, right) => left - right);
    if (!sizes.length) return null;
    const quoteSlot = await this.cached('slot', 250, () => this.runRpc(
      () => this.connection.getSlot('confirmed'),
      priority,
    ));
    const adapter = await this.adapterFor(venue, poolAddress, mintAddress, quoteMintHint, quoteSlot, priority);
    if (!adapter) return null;
    const baselineUsd = Math.min(0.05, sizes[0] / 100);
    const baseline = await adapter.buy(baselineUsd);
    if (!baseline) return null;
    const baselineTokens = rawToNumber(baseline.outputRaw, adapter.tokenDecimals);
    if (!(baselineTokens > 0)) return null;
    const spotPriceUsd = spotPriceFromProbe(baselineUsd, baselineTokens);
    const gasUsd = this.config.get<number>('solanaLaunch.gasUsd') ?? 0.01;
    const totalSupplyRaw = await this.tokenSupply(new PublicKey(mintAddress), priority)
      .then((result) => result.value.amount)
      .catch(() => null);
    const fdvUsd = totalSupplyRaw == null
      ? null
      : rawToNumber(totalSupplyRaw, adapter.tokenDecimals) * spotPriceUsd;
    const entries = await Promise.all(sizes.map((size) => adapter.buy(size)));
    const sells = await Promise.all(entries.map((entry) => entry ? adapter.sell(entry.outputRaw) : null));
    const quoteRows = sizes.flatMap((entryUsd, index) => {
      const entry = entries[index];
      const sell = sells[index];
      if (!entry || !sell || sell.outputUsd == null) return [];
      const entryTokens = rawToNumber(entry.outputRaw, adapter.tokenDecimals);
      if (!(entryTokens > 0)) return [];
      const buySlippagePct = executionPriceImpact(baselineUsd, baselineTokens, entryUsd, entryTokens);
      const sellSlippagePct = clampSlip(1 - sell.outputUsd / (entryTokens * spotPriceUsd));
      const sellUsd = Math.max(0, sell.outputUsd - gasUsd);
      return [{
        venue, poolAddress, mintAddress, quoteMint: adapter.quoteMint,
        tokenDecimals: adapter.tokenDecimals, quoteDecimals: adapter.quoteDecimals,
        executable: true, buySlippagePct, sellSlippagePct, roundTripMultiple: sellUsd / entryUsd,
        executableDepthUsd: 0,
        quoteSlot, quoteModel: adapter.model, spotPriceUsd, fdvUsd, entryTokensRaw: entry.outputRaw,
        entryTokens, entryUsd, sellUsd, gasUsd,
        raw: { baseline, baselineUsd, entry, sell, matrixSizes: sizes },
      } satisfies SolanaRoundTripQuote];
    });
    if (quoteRows.length !== sizes.length) return null;
    // Depth is executable in both directions. A cheap buy followed by an
    // expensive sell is not usable capacity for a paper position.
    const executableDepthUsd = measuredExecutableDepth(quoteRows);
    return {
      quoteSlot,
      observedAt: new Date(),
      quotes: quoteRows.map((quote) => ({ ...quote, executableDepthUsd })),
      depthConfidence: adapter.model === 'RAYDIUM_ROUTE_API'
        ? 'ROUTE_AGGREGATOR_NON_ATOMIC'
        : 'REAL_EXECUTABLE_ATOMIC',
    };
  }

  async sellQuote(position: {
    venue: SolanaVenue;
    poolAddress: string;
    mintAddress: string;
    quoteMint: string;
    tokensRaw: string;
  }, priority: SolanaRpcPriority = 'P0'): Promise<{
    netUsd: number;
    grossUsd: number;
    slippagePct: number;
    quoteSlot: number;
    raw: unknown;
  } | null> {
    const quoteSlot = await this.cached('slot', 250, () => this.runRpc(
      () => this.connection.getSlot('confirmed'),
      priority,
    ));
    const adapter = await this.adapterFor(
      position.venue, position.poolAddress, position.mintAddress, position.quoteMint, quoteSlot, priority,
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

  async runRpc<T>(operation: () => Promise<T>, priority: SolanaRpcPriority = 'P1'): Promise<T> {
    if (!this.isPublicRpc()) return operation();
    return new Promise<T>((resolve, reject) => {
      this.rpcQueue.push({
        priority,
        sequence: this.rpcSequence++,
        operation,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.rpcQueue.sort((left, right) =>
        rpcPriorityRank(left.priority) - rpcPriorityRank(right.priority) ||
        left.sequence - right.sequence);
      void this.drainRpcQueue();
    });
  }

  private async drainRpcQueue(): Promise<void> {
    if (this.rpcQueueRunning) return;
    this.rpcQueueRunning = true;
    try {
      while (this.rpcQueue.length) {
        const next = this.rpcQueue.shift()!;
        const waitMs = Math.max(0, this.nextRpcAt - Date.now());
        if (waitMs > 0) await delay(waitMs);
        try {
          next.resolve(await next.operation());
        } catch (error) {
          next.reject(error);
        } finally {
          this.nextRpcAt = Date.now() + this.rpcIntervalMs();
        }
      }
    } finally {
      this.rpcQueueRunning = false;
      if (this.rpcQueue.length) void this.drainRpcQueue();
    }
  }

  private async adapterFor(
    venue: SolanaVenue,
    poolAddress: string,
    mintAddress: string,
    quoteMintHint: string,
    slot: number,
    priority: SolanaRpcPriority,
  ): Promise<{
    model: string;
    quoteMint: string;
    tokenDecimals: number;
    quoteDecimals: number;
    buy: (usd: number) => Promise<ProtocolQuote | null>;
    sell: (tokensRaw: string) => Promise<ProtocolQuote | null>;
  } | null> {
    if (venue === 'PUMP_BONDING_CURVE') return this.pumpAdapter(mintAddress, priority);
    if (venue === 'PUMPSWAP') return this.pumpSwapAdapter(poolAddress, priority);
    if (venue === 'RAYDIUM_LAUNCHLAB') return this.raydiumLaunchAdapter(poolAddress, slot, priority);
    if (venue === 'METEORA_DBC') return this.meteoraAdapter(poolAddress, priority);
    return this.routeAdapter(mintAddress, quoteMintHint, priority);
  }

  private async pumpAdapter(mintAddress: string, priority: SolanaRpcPriority) {
    const mint = new PublicKey(mintAddress);
    const global = await this.cached('pump:global', 60_000, () => this.runRpc(() => this.pump.fetchGlobal(), priority));
    const feeConfig = await this.cached(
      'pump:fee-config',
      60_000,
      () => this.runRpc(() => this.pump.fetchFeeConfig(), priority).catch(() => null),
    );
    const bondingCurve = await this.cached(
      `pump:curve:${mintAddress}`,
      500,
      () => this.runRpc(() => this.pump.fetchBondingCurve(mint), priority),
    );
    const supply = await this.tokenSupply(mint, priority);
    if (bondingCurve.complete) return null;
    const quoteMint = bondingCurve.quoteMint.equals(PublicKey.default) ? WSOL_MINT : bondingCurve.quoteMint.toBase58();
    const tokenDecimals = supply.value.decimals;
    const quoteDecimals = await this.decimals(quoteMint, priority);
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

  private async pumpSwapAdapter(poolAddress: string, priority: SolanaRpcPriority) {
    const state = await this.cached(
      `pumpswap:${poolAddress}`,
      500,
      () => this.runRpc(
        () => this.pumpSwap.swapSolanaState(new PublicKey(poolAddress), PAPER_OWNER),
        priority,
      ),
    );
    const quoteMint = state.pool.quoteMint.toBase58();
    const tokenDecimals = state.baseMintAccount.decimals;
    const quoteDecimals = await this.decimals(quoteMint, priority);
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

  private async raydiumLaunchAdapter(poolAddress: string, slot: number, priority: SolanaRpcPriority) {
    const raydium = await this.raydium(priority);
    const poolInfo: any = await this.cached(
      `raydium-launch:${poolAddress}`,
      500,
      () => this.runRpc(
        () => raydium.launchpad.getRpcPoolInfo({ poolId: new PublicKey(poolAddress) }),
        priority,
      ),
    );
    if (Number(poolInfo.status) !== 0) return null;
    const platformAccount = await this.cached(
      `raydium-platform:${poolInfo.platformId.toBase58()}`,
      60_000,
      () => this.runRpc(() => this.connection.getAccountInfo(poolInfo.platformId, 'confirmed'), priority),
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

  private async meteoraAdapter(poolAddress: string, priority: SolanaRpcPriority) {
    const sdk: any = await import('@meteora-ag/dynamic-bonding-curve-sdk');
    const client = sdk.DynamicBondingCurveClient.create(this.connection, 'confirmed');
    const pool: any = await this.cached(
      `meteora-pool:${poolAddress}`,
      500,
      () => this.runRpc(() => client.state.getPool(poolAddress), priority),
    );
    if (!pool) return null;
    const configKey = new PublicKey(pool.config).toBase58();
    const config: any = await this.cached(
      `meteora-config:${configKey}`,
      60_000,
      () => this.runRpc(() => client.state.getPoolConfig(pool.config), priority),
    );
    if (!config) return null;
    const quoteMint = new PublicKey(config.quoteMint).toBase58();
    const tokenDecimals = Number(config.tokenDecimal ?? config.tokenBaseDecimal ?? 6);
    const quoteDecimals = await this.decimals(quoteMint, priority);
    const currentPoint = await this.cached(
      `meteora-point:${String(config.activationType)}`,
      500,
      () => this.runRpc(() => sdk.getCurrentPoint(this.connection, config.activationType), priority),
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

  private async routeAdapter(
    mintAddress: string,
    _quoteMintHint: string,
    priority: SolanaRpcPriority,
  ) {
    const tokenDecimals = await this.decimals(mintAddress, priority);
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

  private async decimals(mint: string, priority: SolanaRpcPriority): Promise<number> {
    const cached = this.mintDecimals.get(mint);
    if (cached != null) return cached;
    const decimals = mint === USDC_MINT
      ? 6
      : (await this.tokenSupply(new PublicKey(mint), priority)).value.decimals;
    this.mintDecimals.set(mint, decimals);
    return decimals;
  }

  private raydium(priority: SolanaRpcPriority): Promise<Raydium> {
    this.raydiumPromise ??= this.runRpc(() => Raydium.load({
      connection: this.connection,
      owner: PAPER_OWNER,
      disableFeatureCheck: true,
      disableLoadToken: true,
      blockhashCommitment: 'confirmed',
    }), priority);
    return this.raydiumPromise;
  }

  private tokenSupply(mint: PublicKey, priority: SolanaRpcPriority) {
    return this.cached(
      `supply:${mint.toBase58()}`,
      2_000,
      () => this.runRpc(() => this.connection.getTokenSupply(mint, 'confirmed'), priority),
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

export function measuredExecutableDepth(
  quotes: readonly Pick<SolanaRoundTripQuote, 'entryUsd' | 'buySlippagePct' | 'sellSlippagePct'>[],
  maxImpactPct = 0.05,
): number {
  return Math.max(0, ...quotes
    .filter((quote) => Math.max(
      quote.buySlippagePct ?? Infinity,
      quote.sellSlippagePct ?? Infinity,
    ) <= maxImpactPct)
    .map((quote) => quote.entryUsd));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rpcPriorityRank(priority: SolanaRpcPriority): number {
  return ({ P0: 0, P1: 1, P2: 2, P3: 3 } as const)[priority];
}
