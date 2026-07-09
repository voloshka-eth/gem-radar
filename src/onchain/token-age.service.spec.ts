import { TokenAgeService } from './token-age.service';

describe('TokenAgeService', () => {
  it('does not issue unsupported historical code requests on Robinhood by default', async () => {
    const redis = { get: jest.fn().mockResolvedValue(null), setex: jest.fn() };
    const client = { getBlockNumber: jest.fn() };
    const config = { get: jest.fn().mockReturnValue(false) };
    const service = new TokenAgeService(
      config as any,
      redis as any,
      new Map([['robinhood', client]]) as any,
    );

    await expect(
      service.getTokenAgeDays('robinhood', '0x1111111111111111111111111111111111111111'),
    ).resolves.toBeNull();
    expect(client.getBlockNumber).not.toHaveBeenCalled();
  });
});
