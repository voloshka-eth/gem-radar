import { TokenMetadataService } from './token-metadata.service';

describe('TokenMetadataService', () => {
  it('returns standard metadata and degrades per field when a token is non-standard', async () => {
    const client = {
      readContract: jest.fn()
        .mockResolvedValueOnce('  GEM  ')
        .mockRejectedValueOnce(new Error('bytes32 symbol')),
    };
    const service = new TokenMetadataService(new Map([['base', client]]) as any);

    await expect(service.read('base', '0x1111111111111111111111111111111111111111')).resolves.toEqual({
      symbol: 'GEM', name: '',
    });
  });
});
