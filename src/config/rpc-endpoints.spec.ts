import {
  alchemyHttpUrl,
  alchemyWsUrl,
  extractAlchemyApiKey,
  extractInfuraApiKey,
  flattenResolved,
  resolveRpcEndpoints,
} from './rpc-endpoints';

describe('rpc-endpoints Alchemy/Infura split', () => {
  it('extracts Alchemy and Infura keys from bare values or pasted URLs', () => {
    expect(extractAlchemyApiKey('AbCdEfGhIjKlMnOpQrStUvWxYz012345')).toBe(
      'AbCdEfGhIjKlMnOpQrStUvWxYz012345',
    );
    expect(
      extractAlchemyApiKey('https://robinhood-mainnet.g.alchemy.com/v2/my-secret-key'),
    ).toBe('my-secret-key');
    expect(
      extractInfuraApiKey('https://mainnet.infura.io/v3/infura-secret-key-123456'),
    ).toBe('infura-secret-key-123456');
  });

  it('defaults Alchemy to Robinhood and Ethereum while Infura remains opt-in', () => {
    const resolved = flattenResolved(resolveRpcEndpoints({
      alchemyApiKey: 'test-key-abcdefghijklmnopqrst',
      infuraApiKey: 'infura-secret-key-1234567890',
    }));

    expect(resolved.alchemyChains).toEqual(['robinhood', 'ethereum']);
    expect(resolved.infuraChains).toEqual([]);
    expect(resolved.robinhoodRpcUrls).toEqual([
      'https://rpc.mainnet.chain.robinhood.com',
      alchemyHttpUrl('robinhood-mainnet', 'test-key-abcdefghijklmnopqrst'),
    ]);
    expect(resolved.robinhoodRpcWsUrl).toBe(
      alchemyWsUrl('robinhood-mainnet', 'test-key-abcdefghijklmnopqrst'),
    );
    expect(resolved.ethereumRpcUrls[0]).toBe('https://eth.drpc.org');
    expect(resolved.ethereumRpcUrls).toContain(
      alchemyHttpUrl('eth-mainnet', 'test-key-abcdefghijklmnopqrst'),
    );
    expect(resolved.baseRpcUrls.every((url) => !url.includes('alchemy.com'))).toBe(true);
    expect(resolved.baseRpcUrls.every((url) => !url.includes('infura.io'))).toBe(true);
  });

  it('does not attach Infura to Robinhood by default', () => {
    const resolved = flattenResolved(resolveRpcEndpoints({
      alchemyApiKey: 'test-key-abcdefghijklmnopqrst',
      infuraApiKey: 'infura-secret-key-1234567890',
    }));
    expect(resolved.robinhoodRpcUrls.some((url) => url.includes('infura.io'))).toBe(false);
  });

  it('honours RPC_PRIORITY=paid_first for Robinhood Alchemy', () => {
    const resolved = flattenResolved(resolveRpcEndpoints({
      alchemyApiKey: 'test-key-abcdefghijklmnopqrst',
      rpcPriority: 'paid_first',
    }));
    expect(resolved.robinhoodRpcUrl).toBe(
      alchemyHttpUrl('robinhood-mainnet', 'test-key-abcdefghijklmnopqrst'),
    );
  });

  it('exposes primary and fallback timeouts for free-first failover', () => {
    const resolved = flattenResolved(resolveRpcEndpoints({
      rpcPrimaryTimeoutMs: '9000',
      rpcFallbackTimeoutMs: '15000',
    }));
    expect(resolved.primaryTimeoutMs).toBe(9000);
    expect(resolved.fallbackTimeoutMs).toBe(15000);
  });

  it('treats blank explicit EVM endpoints as unset', () => {
    const resolved = flattenResolved(resolveRpcEndpoints({
      infuraApiKey: 'infura-secret-key-1234567890',
      ethereumRpcUrl: '   ',
      ethereumRpcWsUrl: '',
    }));

    expect(resolved.ethereumRpcUrl).toBe('https://eth.drpc.org');
    expect(resolved.ethereumRpcWsUrl).toBeUndefined();
  });
});
