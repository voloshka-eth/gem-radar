import { RobinhoodExperimentalSafetyService } from './robinhood-experimental-safety.service';

const ZERO_SLOT = `0x${'0'.repeat(64)}`;
const PROXY_SLOT = `0x${'0'.repeat(24)}1111111111111111111111111111111111111111`;
const TOKEN = '0x1111111111111111111111111111111111111111';

describe('RobinhoodExperimentalSafetyService', () => {
  const client = {
    getCode: jest.fn(),
    getStorageAt: jest.fn(),
    readContract: jest.fn(),
  };
  let service: RobinhoodExperimentalSafetyService;

  beforeEach(() => {
    jest.resetAllMocks();
    client.getCode.mockResolvedValue('0x60006000');
    client.getStorageAt.mockResolvedValue(ZERO_SLOT);
    client.readContract.mockRejectedValue(new Error('owner() unavailable'));
    service = new RobinhoodExperimentalSafetyService(new Map([['robinhood', client]]) as any);
  });

  it('passes a non-proxy contract with no detectable owner or dangerous selector', async () => {
    await expect(service.inspect(TOKEN)).resolves.toEqual({
      passed: true,
      reasons: [],
      ownerAddress: null,
      proxyDetected: false,
      dangerousSelectors: [],
    });
  });

  it('rejects a contract with a non-renounced owner', async () => {
    client.readContract.mockResolvedValue('0x2222222222222222222222222222222222222222');

    await expect(service.inspect(TOKEN)).resolves.toMatchObject({
      passed: false,
      reasons: ['owner_not_renounced'],
      ownerAddress: '0x2222222222222222222222222222222222222222',
    });
  });

  it('rejects an EIP-1967 proxy', async () => {
    client.getStorageAt.mockResolvedValueOnce(PROXY_SLOT);

    await expect(service.inspect(TOKEN)).resolves.toMatchObject({
      passed: false,
      reasons: ['eip1967_proxy_detected'],
      proxyDetected: true,
    });
  });

  it('rejects bytecode containing a mint selector', async () => {
    client.getCode.mockResolvedValue('0x600040c10f196000');

    await expect(service.inspect(TOKEN)).resolves.toMatchObject({
      passed: false,
      reasons: ['mint_selector_detected'],
      dangerousSelectors: ['mint_selector_detected'],
    });
  });
});
