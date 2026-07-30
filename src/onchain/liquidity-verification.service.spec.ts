import { LiquidityVerificationService } from './liquidity-verification.service';

describe('LiquidityVerificationService physicality guard', () => {
  let service: LiquidityVerificationService;

  beforeEach(() => {
    service = new LiquidityVerificationService({} as any, {} as any, {} as any, {} as any);
  });

  const quoterBackedRead = {
    spotPriceUsd: 0.00002,
    slip20: 0.01,
    entrySlip20: 0.009,
    exitSlip20: 0.01,
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

  it('treats excessive large-size impact as limited depth instead of a broken read', () => {
    const result = (service as any).buildResult(
      'V3',
      2_500,
      3_000,
      {
        ...quoterBackedRead,
        slip100: 0.08,
        slip500: 0.42,
        slip1000: 0.72,
        executableDepthUsd: 100,
      },
    );

    expect(result.liquidityVerified).toBe(true);
    expect(result.executableDepthUsd).toBe(100);
  });

  it('still rejects a pool when the $20 sell probe itself is physically unusable', () => {
    const result = (service as any).buildResult(
      'V3',
      10,
      3_000,
      {
        ...quoterBackedRead,
        exitSlip20: 0.70,
        slip20: 0.70,
        slip50: 0.80,
        slip100: 0.90,
        slip500: 0.99,
        slip1000: 1,
        executableDepthUsd: 0,
      },
    );

    expect(result.liquidityVerified).toBe(false);
    expect(result.error).toContain('slip on $20 probe');
  });

  it('accepts V4 only when its Quoter proves executable depth', () => {
    const result = (service as any).buildV4Result(quoterBackedRead);

    expect(result).toMatchObject({
      liquidityModel: 'V4',
      liquidityVerified: true,
      onchainTvlUsd: null,
      spotPriceUsd: quoterBackedRead.spotPriceUsd,
      executableDepthUsd: 1000,
    });
  });

  it('reads V4 gem decimals from the non-native currency', async () => {
    const gem = '0x1111111111111111111111111111111111111111';
    const native = '0x0000000000000000000000000000000000000000';
    const weth = '0x4200000000000000000000000000000000000006';
    const resolver = { resolveModel: jest.fn().mockResolvedValue({ model: 'V4' }) };
    const v4 = {
      readDecimals: jest.fn().mockResolvedValue(9),
      readLiquidity: jest.fn().mockResolvedValue(quoterBackedRead),
    };
    service = new LiquidityVerificationService(resolver as any, {} as any, {} as any, v4 as any);

    await service.verify({
      chain: 'base',
      poolAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      dex: 'Uniswap V4',
      token0Address: native,
      token1Address: gem,
      quoteAsset: 'WETH',
      quoteAssetAddress: weth,
      source: 'test',
      v4Metadata: {
        currency0: native,
        currency1: gem,
        fee: 3000,
        tickSpacing: 60,
        hooks: native,
        sqrtPriceX96: 2n ** 96n,
      },
    });

    expect(v4.readDecimals).toHaveBeenCalledWith('base', gem);
    expect(v4.readLiquidity).toHaveBeenCalledWith(expect.any(Object), 9);
  });
});
