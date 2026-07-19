import { parseAbi } from 'viem';

// Minimal read-only ABI. The sniper has no transaction methods by design.
export const FOUR_MEME_READ_ABI = parseAbi([
  'event TokenCreate(address creator, address token, uint256 requestId, string name, string symbol, uint256 totalSupply, uint256 launchTime)',
  // TokenManager2 emits the full bonding-curve state. The previous four-field
  // V1-shaped signature produced a different topic hash and saw no trades.
  'event TokenPurchase(address token, address account, uint256 price, uint256 amount, uint256 cost, uint256 fee, uint256 offers, uint256 funds)',
  'event TokenSale(address token, address account, uint256 price, uint256 amount, uint256 cost, uint256 fee, uint256 offers, uint256 funds)',
  'event TradeStop(address token)',
]);

export const FOUR_MEME_TOKEN_MANAGER2 =
  '0x5c952063c7fc8610ffdb798152d69f0b9550762b' as const;
