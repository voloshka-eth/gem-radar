import { LiquidityVerificationService } from './liquidity-verification.service';

describe('LiquidityVerificationService physicality guard', () => {
  let service: LiquidityVerificationService;

  beforeEach(() => {
    service = new LiquidityVerificationService({} as any, {} as any, {} as any);
  });

  const quoterBackedRead = {
    spotPriceUsd: 0.00002,
    slip50: 0.0125,
    slip100: 0.015,
    slip500: 0.0345,
    slip1000: 0.0578,
    executableDepthUsd: 1000,
  };

  it('keeps the V2 reported-vs-onchain hard guard', () => {
    const result = (service as any).buildResult(
      'V2',
      0.0178,
      19_427,
      quoterBackedRead,
    );

    expect(result.liquidityVerified).toBe(false);
    expect(result.error).toContain('implausible_read');
    expect(result.spotPriceUsd).toBeNull();
  });

  it('does not false-reject V3 when Quoter proves executable depth', () => {
    const result = (service as any).buildResult(
      'V3',
      0.0178,
      19_427,
      quoterBackedRead,
    );

    expect(result.liquidityVerified).toBe(true);
    expect(result.liquidityModel).toBe('V3');
    expect(result.executableDepthUsd).toBe(1000);
    expect(result.spotPriceUsd).toBe(quoterBackedRead.spotPriceUsd);
    expect(result.error).toBeUndefined();
  });
});
