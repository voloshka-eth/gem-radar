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
          'api.moralisAuthBackoffMs': 60_000,
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
    expect(service.getLastFetchSummary()).toEqual({
      enabled: true,
      requestedChains: 1,
      returned: 1,
      errors: 0,
    });
  });

  it('accepts wrapped trending response shapes', async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        result: [
          { chain: 'base', address: '0xBBB0000000000000000000000000000000000002' },
        ],
      },
    });

    await expect(service.getTrendingTokenAddresses(['base'])).resolves.toEqual([
      { chain: 'base', tokenAddress: '0xbbb0000000000000000000000000000000000002' },
    ]);
  });

  it('accepts nested token response shapes and dedupes addresses', async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        data: {
          tokens: [
            {
              token: {
                chain_id: '0x2105',
                token_address: '0xBBB0000000000000000000000000000000000002',
              },
            },
            {
              token: {
                chain_id: 'base',
                address: '0xbbb0000000000000000000000000000000000002',
              },
            },
          ],
        },
      },
    });

    await expect(service.getTrendingTokenAddresses(['base'])).resolves.toEqual([
      { chain: 'base', tokenAddress: '0xbbb0000000000000000000000000000000000002' },
    ]);
  });

  it('stores HTTP status and message when Moralis fails', async () => {
    mockGet.mockRejectedValueOnce({
      isAxiosError: true,
      message: 'Request failed with status code 401',
      response: { status: 401 },
    });

    await expect(service.getTrendingTokenAddresses(['ethereum'])).resolves.toEqual([]);
    expect(service.getLastFetchSummary()).toMatchObject({
      enabled: true,
      requestedChains: 1,
      returned: 0,
      errors: 1,
      lastStatus: '401',
      lastError: 'Request failed with status code 401',
    });
  });

  it('opens an auth backoff after 401 and skips later HTTP requests', async () => {
    mockGet.mockRejectedValueOnce({
      isAxiosError: true,
      message: 'Request failed with status code 401',
      response: { status: 401 },
    });

    await expect(service.getTrendingTokenAddresses(['ethereum', 'base'])).resolves.toEqual([]);
    await expect(service.getTrendingTokenAddresses(['ethereum', 'base'])).resolves.toEqual([]);

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(service.getLastFetchSummary()).toMatchObject({
      lastStatus: 'AUTH_BACKOFF',
      requestedChains: 0,
      authBackoffRemainingMs: expect.any(Number),
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
    expect(service.getLastFetchSummary()).toEqual({
      enabled: false,
      requestedChains: 0,
      returned: 0,
      errors: 0,
    });
  });
});
