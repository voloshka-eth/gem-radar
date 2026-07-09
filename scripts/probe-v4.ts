import 'reflect-metadata';
import * as dotenv from 'dotenv';
import axios from 'axios';
import { createPublicClient, defineChain, http, type PublicClient } from 'viem';
import { mainnet, base } from 'viem/chains';
import type { ConfigService } from '@nestjs/config';
import type { CandidatePool, SupportedChain } from '../src/collector/collector.types';
import { V4LiquidityService } from '../src/onchain/v4-liquidity.service';

dotenv.config();

const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
});

const [, , chainArg, poolIdArg, quoteAddressArg, decimalsArg] = process.argv;
if (!chainArg || !poolIdArg || !quoteAddressArg) {
  throw new Error('Usage: npm run probe:v4 -- <ethereum|base|robinhood> <poolId> <quoteAddress> [gemDecimals]');
}
if (chainArg !== 'ethereum' && chainArg !== 'base' && chainArg !== 'robinhood') {
  throw new Error(`Unsupported chain: ${chainArg}`);
}

const chain = chainArg as SupportedChain;
const poolId = poolIdArg.toLowerCase();
const quoteAddress = quoteAddressArg.toLowerCase();
const gemDecimals = Number(decimalsArg ?? 18);
const rpcUrl = {
  ethereum: process.env.ETHEREUM_RPC_URL ?? 'https://eth.drpc.org',
  base: process.env.BASE_RPC_URL ?? 'https://base.drpc.org',
  robinhood: process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com',
}[chain];
const viemChain = chain === 'ethereum' ? mainnet : chain === 'base' ? base : robinhood;
const client = createPublicClient({ chain: viemChain, transport: http(rpcUrl) }) as unknown as PublicClient;

const addresses: Record<string, string> = {
  'onchain.v4PoolManagerEthereum': '0x000000000004444c5dc75cB358380D2e3dE08A90',
  'onchain.v4QuoterEthereum': '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203',
  'onchain.v4StateViewEthereum': '0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
  'onchain.v4PoolManagerBase': '0x498581ff718922c3f8e6a244956af099b2652b2b',
  'onchain.v4QuoterBase': '0x0d5e0f971ed27fbff6c2837bf31316121532048d',
  'onchain.v4StateViewBase': '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71',
  'onchain.v4PoolManagerRobinhood': '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  'onchain.v4QuoterRobinhood': '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  'onchain.v4StateViewRobinhood': '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
};
const config = { get: (key: string) => addresses[key] } as ConfigService;
const priceService = {
  getUsdPrice: async (targetChain: SupportedChain, address: string): Promise<number | null> => {
    const coinId = `${targetChain}:${address}`;
    const response = await axios.get<{ coins: Record<string, { price?: number }> }>(
      `https://coins.llama.fi/prices/current/${encodeURIComponent(coinId)}`,
      { timeout: 10_000 },
    );
    return response.data.coins[coinId]?.price ?? null;
  },
};
const service = new V4LiquidityService(
  config,
  new Map([[chain, client]]),
  priceService as any,
);
const pool: CandidatePool = {
  chain,
  poolAddress: poolId,
  dex: 'Uniswap V4',
  token0Address: quoteAddress,
  token1Address: '0x0000000000000000000000000000000000000000',
  quoteAsset: 'WETH',
  quoteAssetAddress: quoteAddress,
  source: 'probe',
};

service.readLiquidity(pool, gemDecimals)
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
