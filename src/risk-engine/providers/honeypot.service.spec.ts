import { HoneypotService } from './honeypot.service';
import { ConfigService } from '@nestjs/config';
import * as safeFixture from '../fixtures/honeypot-safe.fixture.json';
import * as honeypotFixture from '../fixtures/honeypot-honeypot.fixture.json';

const TOKEN_ADDR = '0xaaa0000000000000000000000000000000000001';

describe('HoneypotService', () => {
  let service: HoneypotService;
  let mockGet: jest.Mock;

  beforeEach(() => {
    service = new HoneypotService({
      get: (k: string) =>
        k === 'api.honeypotBaseUrl' ? 'https://api.honeypot.is' : undefined,
    } as unknown as ConfigService);

    mockGet = jest.fn();
    (service as any).http = { get: mockGet };
  });

  it('safe token — honeypot=false, canSell=undefined', async () => {
    mockGet.mockResolvedValueOnce({ data: safeFixture });
    const result = await service.checkToken('ethereum', TOKEN_ADDR);

    expect(result).not.toBeNull();
    expect(result!.honeypot).toBe(false);
    expect(result!.canSell).toBeUndefined();
  });

  it('safe token — non-zero tax values are surfaced (buy=1%, sell=1%)', async () => {
    mockGet.mockResolvedValueOnce({ data: safeFixture });
    const result = await service.checkToken('ethereum', TOKEN_ADDR);

    expect(result!.buyTax).toBeCloseTo(1.0, 5);
    expect(result!.sellTax).toBeCloseTo(1.0, 5);
  });

  it('honeypot token — honeypot=true and canSell=false', async () => {
    mockGet.mockResolvedValueOnce({ data: honeypotFixture });
    const result = await service.checkToken('ethereum', TOKEN_ADDR);

    expect(result!.honeypot).toBe(true);
    expect(result!.canSell).toBe(false);
  });

  it('honeypot token — zero taxes do not surface as buyTax/sellTax', async () => {
    mockGet.mockResolvedValueOnce({ data: honeypotFixture });
    const result = await service.checkToken('ethereum', TOKEN_ADDR);

    expect(result!.buyTax).toBeUndefined();
    expect(result!.sellTax).toBeUndefined();
  });

  it('HTTP error → returns null (non-fatal, supplementary source)', async () => {
    mockGet.mockRejectedValueOnce(new Error('ECONNRESET'));
    const result = await service.checkToken('ethereum', TOKEN_ADDR);
    expect(result).toBeNull();
  });

  it('unsupported chain → returns null without HTTP call', async () => {
    const result = await service.checkToken('solana' as any, TOKEN_ADDR);
    expect(result).toBeNull();
    expect(mockGet).not.toHaveBeenCalled();
  });
});
