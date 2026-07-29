import {
  alchemyHttpUrl,
  alchemyWsUrl,
  extractAlchemyApiKey,
  extractInfuraApiKey,
  flattenResolved,
  infuraHttpUrl,
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
      extractInfuraApiKey('https://solana-mainnet.infura.io/v3/infura-secret-key-123456'),
    ).toBe('infura-secret-key-123456');
  });

  it('defaults Alchemy→robinhood+ethereum and Infura→solana', () => {
    const resolved = flattenResolved(resolveRpcEndpoints({
      alchemyApiKey: 'test-key-abcdefghijklmnopqrst',
      infuraApiKey: 'infura-secret-key-1234567890',
    }));

    expect(resolved.alchemyChains).toEqual(['robinhood', 'ethereum']);
    expect(resolved.infuraChains).toEqual(['solana']);

    // Robinhood: free → Alchemy
    expect(resolved.robinhoodRpcUrls).toEqual([
      'https://rpc.mainnet.chain.robinhood.com',
      alchemyHttpUrl('robinhood-mainnet', 'test-key-abcdefghijklmnopqrst'),
    ]);
    expect(resolved.robinhoodRpcWsUrl).toBe(
      alchemyWsUrl('robinhood-mainnet', 'test-key-abcdefghijklmnopqrst'),
    );

    // Ethereum: free → Alchemy
    expect(resolved.ethereumRpcUrls[0]).toBe('https://eth.drpc.org');
    expect(resolved.ethereumRpcUrls).toContain(
      alchemyHttpUrl('eth-mainnet', 'test-key-abcdefghijklmnopqrst'),
    );

    // Base stays free-only by default
    expect(resolved.baseRpcUrls.every((url) => !url.includes('alchemy.com'))).toBe(true);
    expect(resolved.baseRpcUrls.every((url) => !url.includes('infura.io'))).toBe(true);

    // Solana HTTP: free first, then Infura after the primary deadline.
    expect(resolved.solanaRpcUrls).toEqual([
      'https://api.mainnet-beta.solana.com',
      infuraHttpUrl('solana-mainnet', 'infura-secret-key-1234567890'),
    ]);
    expect(resolved.solanaRpcUrl).toBe('https://api.mainnet-beta.solana.com');
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

  it('exposes primary/fallback timeouts for free-first failover', () => {
    const resolved = flattenResolved(resolveRpcEndpoints({
      rpcPrimaryTimeoutMs: '9000',
      rpcFallbackTimeoutMs: '15000',
    }));
    expect(resolved.primaryTimeoutMs).toBe(9000);
    expect(resolved.fallbackTimeoutMs).toBe(15000);
  });

  it('treats blank explicit endpoints as unset', () => {
    const resolved = flattenResolved(resolveRpcEndpoints({
      infuraApiKey: 'infura-secret-key-1234567890',
      solanaRpcUrl: '   ',
      solanaRpcWsUrl: '',
    }));

    expect(resolved.solanaRpcUrls[0]).toBe('https://api.mainnet-beta.solana.com');
    expect(resolved.solanaRpcUrls[1]).toContain('solana-mainnet.infura.io');
    expect(resolved.solanaRpcWsUrl).toBeUndefined();
  });

  it('uses a Solana WebSocket endpoint only when it was explicitly configured', () => {
    const resolved = flattenResolved(resolveRpcEndpoints({
      infuraApiKey: 'infura-secret-key-1234567890',
      solanaRpcWsUrl: 'wss://solana.example.test/ws',
    }));

    expect(resolved.solanaRpcWsUrl).toBe('wss://solana.example.test/ws');
  });
});
