import { ConfigService } from '@nestjs/config';
import {
  SolanaProtocolQuoteService,
  createSolanaRpcFailoverFetch,
  executionPriceImpact,
  measuredExecutableDepth,
  spotPriceFromProbe,
} from './solana-protocol-quote.service';

describe('SolanaProtocolQuoteService RPC coordination', () => {
  function service(intervalMs = 5): SolanaProtocolQuoteService {
    const config = {
      get: jest.fn((key: string) => ({
        'solanaLaunch.rpcUrl': 'https://api.mainnet-beta.solana.com',
        'solanaLaunch.rpcUrls': ['https://api.mainnet-beta.solana.com'],
        'solanaLaunch.wsUrl': 'wss://api.mainnet-beta.solana.com',
        'solanaLaunch.rpcMinRequestIntervalMs': intervalMs,
      } as Record<string, unknown>)[key]),
    } as unknown as ConfigService;
    return new SolanaProtocolQuoteService(config);
  }

  it('serializes public RPC operations', async () => {
    const quotes = service();
    let active = 0;
    let maximumActive = 0;
    const starts: number[] = [];
    const operation = async () => {
      starts.push(Date.now());
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
    };

    await Promise.all([quotes.runRpc(operation), quotes.runRpc(operation), quotes.runRpc(operation)]);

    expect(maximumActive).toBe(1);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(4);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(4);
  });

  it('deduplicates concurrent cached state reads', async () => {
    const quotes = service(0);
    const load = jest.fn().mockResolvedValue({ value: 1 });

    const [first, second] = await Promise.all([
      (quotes as any).cached('state', 1_000, load),
      (quotes as any).cached('state', 1_000, load),
    ]);

    expect(first).toEqual({ value: 1 });
    expect(second).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('lets P0 work jump ahead of queued discovery and backfill RPC work', async () => {
    const quotes = service(0);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = quotes.runRpc(async () => {
      order.push('running-p3');
      await firstGate;
    }, 'P3');
    await Promise.resolve();
    const queuedP3 = quotes.runRpc(async () => { order.push('queued-p3'); }, 'P3');
    const queuedP0 = quotes.runRpc(async () => { order.push('queued-p0'); }, 'P0');

    releaseFirst();
    await Promise.all([first, queuedP3, queuedP0]);

    expect(order).toEqual(['running-p3', 'queued-p0', 'queued-p3']);
  });

  it('derives marginal price and impact from the actual probe notional', () => {
    expect(spotPriceFromProbe(0.05, 25_000)).toBeCloseTo(0.000002, 12);
    expect(executionPriceImpact(0.05, 25_000, 20, 10_000_000)).toBeCloseTo(0, 12);
    expect(executionPriceImpact(0.05, 25_000, 20, 9_000_000)).toBeCloseTo(0.10, 12);
  });

  it('requires both buy and immediate-sell impact for executable depth', () => {
    expect(measuredExecutableDepth([
      { entryUsd: 20, buySlippagePct: 0.02, sellSlippagePct: 0.03 },
      { entryUsd: 50, buySlippagePct: 0.03, sellSlippagePct: 0.07 },
      { entryUsd: 100, buySlippagePct: 0.06, sellSlippagePct: 0.04 },
    ])).toBe(20);
  });

  it('falls back after the free RPC times out', async () => {
    jest.useFakeTimers();
    const fetch = jest.fn()
      .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const failover = createSolanaRpcFailoverFetch(
      ['https://free.example', 'https://paid.example'],
      50,
      100,
      fetch as any,
    );

    const request = failover('https://ignored.example' as any, {} as any);
    await jest.advanceTimersByTimeAsync(51);
    await expect(request).resolves.toMatchObject({ ok: true });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://free.example',
      'https://paid.example',
    ]);
    jest.useRealTimers();
  });

  it('falls back immediately on rate limiting', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const failover = createSolanaRpcFailoverFetch(
      ['https://free.example', 'https://paid.example'],
      8_000,
      12_000,
      fetch as any,
    );

    await expect(failover('https://ignored.example' as any, {} as any))
      .resolves.toMatchObject({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
