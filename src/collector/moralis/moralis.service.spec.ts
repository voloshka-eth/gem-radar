import { ConfigService } from '@nestjs/config';
import { MoralisService } from './moralis.service';

describe('MoralisService', () => {
  let service: MoralisService;
  let mockGet: jest.Mock;

  beforeEach(() => {
    service = new MoralisService({
      get: (k: string) => {
        const cfg: Record<string, unknown> = {
          'api.moralisBaseUrl': 'https://deep-index.moralis.io/api/v2.2',
          'api.moralisApiKey': 'test-key',
          'api.moralisTrendingLimit': 10,
        };
        return cfg[k];
      },
    } as unknown as ConfigService);
    mockGet = jest.fn();
    (service as any).http = { get: mockGet };
  });

  it('maps trending token addresses for enabled EVM chains', async () => {
    mockGet.mockResolvedValueOnce({
      data: [
        { chainId: '0x1', tokenAddress: '0xAAA0000000000000000000000000000000000001' },
        { chainId: 'solana', tokenAddress: 'So11111111111111111111111111111111111111112' },
      ],
    });

    await expect(service.getTrendingTokenAddresses(['ethereum'])).resolves.toEqual([
      { chain: 'ethereum', tokenAddress: '0xaaa0000000000000000000000000000000000001' },
    ]);
    expect(mockGet).toHaveBeenCalledWith('/tokens/trending', {
      params: { chain: 'eth', limit: 10 },
    });
  });

  it('is disabled when no API key is configured', async () => {
    service = new MoralisService({
      get: (k: string) => (k === 'api.moralisApiKey' ? '' : undefined),
    } as unknown as ConfigService);
    mockGet = jest.fn();
    (service as any).http = { get: mockGet };

    await expect(service.getTrendingTokenAddresses(['ethereum'])).resolves.toEqual([]);
    expect(mockGet).not.toHaveBeenCalled();
  });
});
