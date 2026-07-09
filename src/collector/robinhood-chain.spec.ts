import { ConfigService } from '@nestjs/config';
import { QUOTE_ASSET_MAP } from './collector.types';
import { BirdeyeService } from './birdeye/birdeye.service';
import { DS_CHAIN_MAP } from './dexscreener/dexscreener.types';
import { GT_NETWORK } from './geckoterminal/geckoterminal.types';
import { MoralisService } from './moralis/moralis.service';
import {
  DEFILLAMA_CHAIN,
  QUOTE_ASSET_DECIMALS,
  QUOTER_V2_CONFIG_KEY,
  V4_CONFIG_KEYS,
} from '../onchain/onchain.constants';

describe('Robinhood Chain integration', () => {
  it('maps discovery, pricing and Uniswap config consistently', () => {
    expect(DS_CHAIN_MAP.robinhood).toBe('robinhood');
    expect(GT_NETWORK.robinhood).toBe('robinhood');
    expect(DEFILLAMA_CHAIN.robinhood).toBe('robinhood');
    expect(QUOTE_ASSET_MAP.robinhood).toEqual({
      '0x0bd7d308f8e1639fab988df18a8011f41eacad73': 'WETH',
      '0x5fc5360d0400ad4f2af552add042d716f1d168': 'USDG',
    });
    expect(QUOTE_ASSET_DECIMALS.USDG).toBe(6);
    expect(QUOTER_V2_CONFIG_KEY.robinhood).toBe('onchain.quoterV2Robinhood');
    expect(V4_CONFIG_KEYS.robinhood).toEqual({
      poolManager: 'onchain.v4PoolManagerRobinhood',
      quoter: 'onchain.v4QuoterRobinhood',
      stateView: 'onchain.v4StateViewRobinhood',
    });
  });

  it('does not send Robinhood to Moralis when that source has no chain mapping', async () => {
    const service = new MoralisService({
      get: (key: string) => {
        if (key === 'api.moralisApiKey') return 'test-key';
        if (key === 'api.moralisTrendingLimit') return 10;
        return undefined;
      },
    } as unknown as ConfigService);
    const get = jest.fn();
    (service as any).http = { get };

    await expect(service.getTrendingTokenAddresses(['robinhood'])).resolves.toEqual([]);
    expect(get).not.toHaveBeenCalled();
    expect(service.getLastFetchSummary().requestedChains).toBe(0);
  });

  it('does not send Robinhood to Birdeye when that source has no chain mapping', async () => {
    const service = new BirdeyeService({
      get: (key: string) => {
        if (key === 'api.birdeyeApiKey') return 'test-key';
        if (key === 'api.birdeyeTokenListLimit') return 10;
        return undefined;
      },
    } as unknown as ConfigService);
    const get = jest.fn();
    (service as any).http = { get };

    await expect(service.getVolumeTokenAddresses(['robinhood'])).resolves.toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });
});
