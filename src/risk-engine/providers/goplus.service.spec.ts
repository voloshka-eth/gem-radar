import { GoPlusService } from './goplus.service';
import { ConfigService } from '@nestjs/config';
import * as safeFixture from '../fixtures/goplus-safe.fixture.json';
import * as honeypotFixture from '../fixtures/goplus-honeypot.fixture.json';
import * as highSellTaxFixture from '../fixtures/goplus-high-sell-tax.fixture.json';
import * as blacklistFixture from '../fixtures/goplus-blacklist.fixture.json';
import * as mintFixture from '../fixtures/goplus-mint.fixture.json';
import * as malformedFixture from '../fixtures/goplus-malformed.fixture.json';
import * as hiddenOwnerFixture from '../fixtures/goplus-hidden-owner.fixture.json';
import * as slippageModFixture from '../fixtures/goplus-slippage-modifiable.fixture.json';
import * as tradingCooldownFixture from '../fixtures/goplus-trading-cooldown.fixture.json';
import * as selfdestructFixture from '../fixtures/goplus-selfdestruct.fixture.json';
import * as cannotSellAllFixture from '../fixtures/goplus-cannot-sell-all.fixture.json';
import * as ambiguousOwnerFixture from '../fixtures/goplus-ambiguous-owner.fixture.json';

const TOKEN_ADDR = '0xaaa0000000000000000000000000000000000001';

function buildGoPlusResponse(token: Record<string, unknown>) {
  return { code: 1, message: 'ok', result: { [TOKEN_ADDR]: token } };
}

describe('GoPlusService', () => {
  let service: GoPlusService;
  let mockGet: jest.Mock;
  let mockPost: jest.Mock;

  beforeEach(() => {
    service = new GoPlusService({
      get: (k: string) => {
        if (k === 'api.goplusBaseUrl') return 'https://api.gopluslabs.io';
        return undefined;
      },
    } as unknown as ConfigService);
    (service as any).minIntervalMs = 0;
    (service as any).retryDelayMs = 0;

    mockGet = jest.fn();
    mockPost = jest.fn();
    (service as any).http = { get: mockGet, post: mockPost };
  });

  // ── Safe token ──────────────────────────────────────────────────────────────

  it('safe token — returns CONTRACT_SAFE-compatible data (no risk flags)', async () => {
    mockGet.mockResolvedValueOnce({ data: safeFixture });
    const result = await service.checkToken('ethereum', TOKEN_ADDR);

    expect(result).not.toBeNull();
    expect(result!.honeypot).toBe(false);
    expect(result!.verified).toBe(true);
    expect(result!.mintRisk).toBe(false);
    expect(result!.blacklistRisk).toBe(false);
    expect(result!.pauseRisk).toBe(false);
    expect(result!.proxyRisk).toBe(false);
  });

  it('safe token — buy_tax and sell_tax are converted to percentage (1 %)', async () => {
    mockGet.mockResolvedValueOnce({ data: safeFixture });
    const result = await service.checkToken('ethereum', TOKEN_ADDR);

    expect(result!.buyTax).toBeCloseTo(1.0, 5);
    expect(result!.sellTax).toBeCloseTo(1.0, 5);
  });

  it('safe token — owner renounced (zero address)', async () => {
    mockGet.mockResolvedValueOnce({ data: safeFixture });
    const result = await service.checkToken('ethereum', TOKEN_ADDR);
    expect(result!.ownerRenounced).toBe(true);
  });

  it('safe token — LP locked (is_locked=1)', async () => {
    mockGet.mockResolvedValueOnce({ data: safeFixture });
    const result = await service.checkToken('ethereum', TOKEN_ADDR);
    expect(result!.lpLockedOrBurned).toBe(true);
  });

  // ── Honeypot ─────────────────────────────────────────────────────────────────

  it('honeypot token — honeypot=true and canSell=false', async () => {
    mockGet.mockResolvedValueOnce({ data: honeypotFixture });
    const result = await service.checkToken('ethereum', TOKEN_ADDR);

    expect(result!.honeypot).toBe(true);
    expect(result!.canSell).toBe(false);
  });

  it('honeypot token — verified=false (not open source)', async () => {
    mockGet.mockResolvedValueOnce({ data: honeypotFixture });
    const result = await service.checkToken('ethereum', TOKEN_ADDR);
    expect(result!.verified).toBe(false);
  });

  // ── High sell tax ─────────────────────────────────────────────────────────────

  it('high sell_tax=0.15 → normalized to 15 %', async () => {
    mockGet.mockResolvedValueOnce({ data: highSellTaxFixture });
    const result = await service.checkToken('ethereum', TOKEN_ADDR);

    expect(result!.sellTax).toBeCloseTo(15.0, 5);
    expect(result!.buyTax).toBeCloseTo(2.0, 5);
  });

  // ── Blacklist ─────────────────────────────────────────────────────────────────

  it('blacklist token — blacklistRisk=true', async () => {
    mockGet.mockResolvedValueOnce({ data: blacklistFixture });
    const result = await service.checkToken('ethereum', TOKEN_ADDR);
    expect(result!.blacklistRisk).toBe(true);
  });

  it('blacklist token — owner not renounced', async () => {
    mockGet.mockResolvedValueOnce({ data: blacklistFixture });
    const result = await service.checkToken('ethereum', TOKEN_ADDR);
    expect(result!.ownerRenounced).toBe(false);
  });

  // ── Mint ──────────────────────────────────────────────────────────────────────

  it('mintable token — mintRisk=true', async () => {
    mockGet.mockResolvedValueOnce({ data: mintFixture });
    const result = await service.checkToken('ethereum', TOKEN_ADDR);
    expect(result!.mintRisk).toBe(true);
  });

  // ── Error handling ────────────────────────────────────────────────────────────

  it('malformed response (code=0, no result) → returns null', async () => {
    mockGet.mockResolvedValueOnce({ data: malformedFixture });
    const result = await service.checkToken('ethereum', TOKEN_ADDR);
    expect(result).toBeNull();
  });

  it('empty success payload without critical risk fields -> GOPLUS_PARSE_FAILED', async () => {
    const emptyPayload = { data: buildGoPlusResponse({ token_name: 'Partial Only' }) };
    mockGet.mockResolvedValueOnce(emptyPayload).mockResolvedValueOnce(emptyPayload);

    const result = await service.checkToken('ethereum', TOKEN_ADDR);

    expect(result).not.toBeNull();
    expect(result!.providerStatus).toBe('GOPLUS_PARSE_FAILED');
    expect(result!.mintRisk).toBeUndefined();
    expect(result!.blacklistRisk).toBeUndefined();
    expect(result!.proxyRisk).toBeUndefined();
    expect(result!.honeypot).toBeUndefined();
  });

  it('trade-only GoPlus payload without security fields -> GOPLUS_TRADE_ONLY_PARTIAL', async () => {
    mockGet.mockResolvedValueOnce({
      data: buildGoPlusResponse({
        token_name: 'Trade Only',
        buy_tax: '0',
        sell_tax: '0',
        cannot_buy: '0',
        cannot_sell_all: '0',
        is_in_dex: '1',
        holder_count: '42',
        creator_address: '0xC0FFEE0000000000000000000000000000000000',
      }),
    });

    const result = await service.checkToken('base', TOKEN_ADDR);

    expect(result).not.toBeNull();
    expect(result!.providerStatus).toBe('GOPLUS_TRADE_ONLY_PARTIAL');
    expect(result!.buyTax).toBe(0);
    expect(result!.sellTax).toBe(0);
    expect(result!.deployerAddress).toBe('0xc0ffee0000000000000000000000000000000000');
    expect(result!.mintRisk).toBeUndefined();
  });

  it('rate-limit response is retried before returning data', async () => {
    mockGet
      .mockResolvedValueOnce({ data: { code: 4029, message: 'too many requests' } })
      .mockResolvedValueOnce({ data: safeFixture });

    const result = await service.checkToken('ethereum', TOKEN_ADDR);

    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(result).not.toBeNull();
    expect(result!.providerStatus).toBe('OK');
    expect(result!.mintRisk).toBe(false);
  });

  it('opens a short circuit breaker after repeated GoPlus server errors', async () => {
    mockGet.mockResolvedValue({ data: { code: 5000, message: 'server error' } });

    const first = await service.checkToken('ethereum', TOKEN_ADDR);
    const second = await service.checkToken('ethereum', TOKEN_ADDR);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('missing tax fields with critical booleans present -> GOPLUS_PARTIAL', async () => {
    mockGet.mockResolvedValueOnce({
      data: buildGoPlusResponse({
        is_open_source: '1',
        is_honeypot: '0',
        is_mintable: '0',
        is_blacklisted: '0',
        is_proxy: '0',
        can_take_back_ownership: '0',
        transfer_pausable: '0',
      }),
    });

    const result = await service.checkToken('ethereum', TOKEN_ADDR);

    expect(result).not.toBeNull();
    expect(result!.providerStatus).toBe('GOPLUS_PARTIAL');
    expect(result!.mintRisk).toBe(false);
  });

  it('HTTP error → returns null', async () => {
    mockGet.mockRejectedValueOnce(new Error('Network timeout'));
    const result = await service.checkToken('ethereum', TOKEN_ADDR);
    expect(result).toBeNull();
  });

  it('unsupported chain → returns null without making HTTP request', async () => {
    const result = await service.checkToken('solana' as any, TOKEN_ADDR);
    expect(result).toBeNull();
    expect(mockGet).not.toHaveBeenCalled();
  });

  // ── New flags — hidden_owner / slippage_modifiable / trading_cooldown / selfdestruct ──

  it('hidden_owner=1 → hiddenOwnerRisk=true', async () => {
    mockGet.mockResolvedValueOnce({ data: hiddenOwnerFixture });
    const result = await service.checkToken('ethereum', TOKEN_ADDR);
    expect(result!.hiddenOwnerRisk).toBe(true);
  });

  it('slippage_modifiable=1 → feeModifiableRisk=true', async () => {
    mockGet.mockResolvedValueOnce({ data: slippageModFixture });
    const result = await service.checkToken('ethereum', TOKEN_ADDR);
    expect(result!.feeModifiableRisk).toBe(true);
  });

  it('trading_cooldown=1 → tradingCooldownRisk=true', async () => {
    mockGet.mockResolvedValueOnce({ data: tradingCooldownFixture });
    const result = await service.checkToken('ethereum', TOKEN_ADDR);
    expect(result!.tradingCooldownRisk).toBe(true);
  });

  it('selfdestruct=1 → selfdestructRisk=true', async () => {
    mockGet.mockResolvedValueOnce({ data: selfdestructFixture });
    const result = await service.checkToken('ethereum', TOKEN_ADDR);
    expect(result!.selfdestructRisk).toBe(true);
  });

  it('cannot_sell_all=1 → canSell=false even without is_honeypot', async () => {
    mockGet.mockResolvedValueOnce({ data: cannotSellAllFixture });
    const result = await service.checkToken('ethereum', TOKEN_ADDR);
    expect(result!.canSell).toBe(false);
    expect(result!.honeypot).toBe(false);
  });

  // ── ownerRenounced — empty string is ambiguous ────────────────────────────────

  it('owner_address="" → ownerRenounced=undefined (not treated as renounced)', async () => {
    mockGet.mockResolvedValueOnce({ data: ambiguousOwnerFixture });
    const result = await service.checkToken('ethereum', TOKEN_ADDR);
    expect(result!.ownerRenounced).toBeUndefined();
  });

  // ── LP lock — weighted % threshold ───────────────────────────────────────────

  it('LP holder with is_locked=1 at 60% → lpLockedOrBurned=true (≥50% threshold)', async () => {
    mockGet.mockResolvedValueOnce({
      data: buildGoPlusResponse({
        is_open_source: '1', is_honeypot: '0', buy_tax: '0.00', sell_tax: '0.00',
        can_take_back_ownership: '0', is_mintable: '0', is_blacklisted: '0',
        transfer_pausable: '0', is_proxy: '0',
        owner_address: '0x0000000000000000000000000000000000000000',
        lp_holders: [{ address: '0xlocker', percent: '0.6000', is_locked: 1, is_contract: 1 }],
      }),
    });
    const result = await service.checkToken('ethereum', TOKEN_ADDR);
    expect(result!.lpLockedOrBurned).toBe(true);
  });

  it('LP holder with is_locked=1 at 40% → lpLockedOrBurned=false (<50% threshold)', async () => {
    mockGet.mockResolvedValueOnce({
      data: buildGoPlusResponse({
        is_open_source: '1', is_honeypot: '0', buy_tax: '0.00', sell_tax: '0.00',
        can_take_back_ownership: '0', is_mintable: '0', is_blacklisted: '0',
        transfer_pausable: '0', is_proxy: '0',
        owner_address: '0x0000000000000000000000000000000000000000',
        lp_holders: [{ address: '0xlocker', percent: '0.4000', is_locked: 1, is_contract: 1 }],
      }),
    });
    const result = await service.checkToken('ethereum', TOKEN_ADDR);
    expect(result!.lpLockedOrBurned).toBe(false);
  });

  it('LP holder with is_contract=1 only (no lock tag, not dead) is NOT counted as locked', async () => {
    mockGet.mockResolvedValueOnce({
      data: buildGoPlusResponse({
        is_open_source: '1', is_honeypot: '0', buy_tax: '0.00', sell_tax: '0.00',
        can_take_back_ownership: '0', is_mintable: '0', is_blacklisted: '0',
        transfer_pausable: '0', is_proxy: '0',
        owner_address: '0x0000000000000000000000000000000000000000',
        lp_holders: [{ address: '0xrandom_contract', percent: '0.9000', is_locked: 0, is_contract: 1 }],
      }),
    });
    const result = await service.checkToken('ethereum', TOKEN_ADDR);
    expect(result!.lpLockedOrBurned).toBe(false);
  });

  // ── Auth header ──────────────────────────────────────────────────────────────

  it('does not send Authorization header when app credentials are missing', async () => {
    mockGet.mockResolvedValueOnce({ data: safeFixture });
    await service.checkToken('ethereum', TOKEN_ADDR);

    const callOptions = mockGet.mock.calls[0][1];
    expect(callOptions).not.toHaveProperty('headers');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('uses cached GoPlus access token when app credentials are configured', async () => {
    service = new GoPlusService({
      get: (k: string) => {
        if (k === 'api.goplusBaseUrl') return 'https://api.gopluslabs.io';
        if (k === 'api.goplusAppKey') return 'app-key';
        if (k === 'api.goplusAppSecret') return 'app-secret';
        return undefined;
      },
    } as unknown as ConfigService);
    (service as any).minIntervalMs = 0;
    (service as any).retryDelayMs = 0;
    mockGet = jest.fn().mockResolvedValue({ data: safeFixture });
    mockPost = jest.fn().mockResolvedValue({
      data: {
        code: 1,
        message: 'ok',
        result: { access_token: 'access-token', expires_in: 60 },
      },
    });
    (service as any).http = { get: mockGet, post: mockPost };

    await service.checkToken('ethereum', TOKEN_ADDR);
    await service.checkToken('ethereum', TOKEN_ADDR);

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet.mock.calls[0][1].headers.Authorization).toBe('access-token');
    expect(mockGet.mock.calls[1][1].headers.Authorization).toBe('access-token');
  });

  it('falls back to anonymous tier if access-token request fails', async () => {
    service = new GoPlusService({
      get: (k: string) => {
        if (k === 'api.goplusBaseUrl') return 'https://api.gopluslabs.io';
        if (k === 'api.goplusAppKey') return 'app-key';
        if (k === 'api.goplusAppSecret') return 'app-secret';
        return undefined;
      },
    } as unknown as ConfigService);
    (service as any).minIntervalMs = 0;
    (service as any).retryDelayMs = 0;
    mockGet = jest.fn().mockResolvedValue({ data: safeFixture });
    mockPost = jest.fn().mockRejectedValue(new Error('auth unavailable'));
    (service as any).http = { get: mockGet, post: mockPost };

    const result = await service.checkToken('ethereum', TOKEN_ADDR);

    expect(result).not.toBeNull();
    expect(mockGet.mock.calls[0][1]).not.toHaveProperty('headers');
  });
});
