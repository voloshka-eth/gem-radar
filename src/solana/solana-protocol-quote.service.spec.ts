import { ConfigService } from '@nestjs/config';
import {
  SolanaProtocolQuoteService,
  executionPriceImpact,
  spotPriceFromProbe,
} from './solana-protocol-quote.service';

describe('SolanaProtocolQuoteService RPC coordination', () => {
  function service(intervalMs = 5): SolanaProtocolQuoteService {
    const config = {
      get: jest.fn((key: string) => ({
        'solanaLaunch.rpcUrl': 'https://api.mainnet-beta.solana.com',
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

  it('derives marginal price and impact from the actual probe notional', () => {
    expect(spotPriceFromProbe(0.05, 25_000)).toBeCloseTo(0.000002, 12);
    expect(executionPriceImpact(0.05, 25_000, 20, 10_000_000)).toBeCloseTo(0, 12);
    expect(executionPriceImpact(0.05, 25_000, 20, 9_000_000)).toBeCloseTo(0.10, 12);
  });
});
