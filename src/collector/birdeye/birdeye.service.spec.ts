import { ConfigService } from '@nestjs/config';
import { BirdeyeService } from './birdeye.service';

describe('BirdeyeService', () => {
  let service: BirdeyeService;
  let mockGet: jest.Mock;

  beforeEach(() => {
    service = new BirdeyeService({
      get: (k: string) => {
        const cfg: Record<string, unknown> = {
          'api.birdeyeBaseUrl': 'https://public-api.birdeye.so',
          'api.birdeyeApiKey': 'test-key',
          'api.birdeyeTokenListLimit': 10,
        };
        return cfg[k];
      },
    } as unknown as ConfigService);
    mockGet = jest.fn();
    (service as any).http = { get: mockGet };
  });

  it('extracts token addresses from nested tokenlist responses', async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        data: {
          tokens: [
            { address: '0xAAA0000000000000000000000000000000000001' },
            { token_address: '0xBBB0000000000000000000000000000000000002' },
            { tokenAddress: 'not-an-evm-address' },
          ],
        },
      },
    });

    await expect(service.getVolumeTokenAddresses(['base'])).resolves.toEqual([
      { chain: 'base', tokenAddress: '0xaaa0000000000000000000000000000000000001' },
      { chain: 'base', tokenAddress: '0xbbb0000000000000000000000000000000000002' },
    ]);
    expect(mockGet).toHaveBeenCalledWith('/defi/tokenlist', {
      headers: { 'x-chain': 'base' },
      params: {
        sort_by: 'v24hUSD',
        sort_type: 'desc',
        offset: 0,
        limit: 10,
        min_liquidity: 1000,
      },
    });
  });

  it('is disabled when no API key is configured', async () => {
    service = new BirdeyeService({
      get: (k: string) => (k === 'api.birdeyeApiKey' ? '' : undefined),
    } as unknown as ConfigService);
    mockGet = jest.fn();
    (service as any).http = { get: mockGet };

    await expect(service.getVolumeTokenAddresses(['ethereum'])).resolves.toEqual([]);
    expect(mockGet).not.toHaveBeenCalled();
  });
});
