import { Inject, Injectable } from '@nestjs/common';
import type { PublicClient } from 'viem';
import type { SupportedChain } from '../collector/collector.types';
import { VIEM_CLIENTS } from './onchain.constants';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const EIP1967_SLOTS = [
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', // implementation
  '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103', // admin
  '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50', // beacon
] as const;

const OWNER_ABI = [{
  name: 'owner',
  type: 'function',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ type: 'address' }],
}] as const;

const DANGEROUS_SELECTORS: ReadonlyArray<{ selector: string; reason: string }> = [
  { selector: '40c10f19', reason: 'mint_selector_detected' },       // mint(address,uint256)
  { selector: 'a0712d68', reason: 'mint_selector_detected' },       // mint(uint256)
  { selector: '8456cb59', reason: 'pause_selector_detected' },      // pause()
  { selector: '3659cfe6', reason: 'upgrade_selector_detected' },    // upgradeTo(address)
  { selector: '4f1ef286', reason: 'upgrade_selector_detected' },    // upgradeToAndCall(address,bytes)
  { selector: 'c3cda520', reason: 'blacklist_selector_detected' },  // blacklist(address)
  { selector: 'b6a3c5f2', reason: 'blacklist_selector_detected' },  // setBlacklist(address,bool)
  { selector: '57de26a4', reason: 'tax_setter_selector_detected' }, // setTaxFeePercent(uint256)
  { selector: '7a9e5e4b', reason: 'tax_setter_selector_detected' }, // setSellTax(uint256)
  { selector: '22cc93d1', reason: 'tax_setter_selector_detected' }, // setBuyTax(uint256)
];

export interface RobinhoodExperimentalSafetyResult {
  passed: boolean;
  reasons: string[];
  ownerAddress: string | null;
  proxyDetected: boolean;
  dangerousSelectors: string[];
}

/**
 * Conservative static checks for the temporary Robinhood experimental cohort.
 * This does not prove a token is sellable or tax-free; it only rejects contracts
 * with visible upgrade, ownership, mint, pause, blacklist, or tax-setter risk.
 */
@Injectable()
export class RobinhoodExperimentalSafetyService {
  constructor(
    @Inject(VIEM_CLIENTS) private readonly clients: Map<SupportedChain, PublicClient>,
  ) {}

  async inspect(tokenAddress: string): Promise<RobinhoodExperimentalSafetyResult> {
    const client = this.clients.get('robinhood');
    if (!client) return this.failed('no_robinhood_rpc_client');

    const address = tokenAddress as `0x${string}`;
    try {
      const [code, implementation, admin, beacon, owner] = await Promise.all([
        client.getCode({ address }),
        this.readStorage(client, address, EIP1967_SLOTS[0]),
        this.readStorage(client, address, EIP1967_SLOTS[1]),
        this.readStorage(client, address, EIP1967_SLOTS[2]),
        this.readOwner(client, address),
      ]);
      if (!code || code === '0x') return this.failed('no_contract_bytecode');

      const proxyDetected = [implementation, admin, beacon].some(this.slotHasAddress);
      const lowerCode = code.toLowerCase();
      const dangerousSelectors = DANGEROUS_SELECTORS
        .filter(({ selector }) => lowerCode.includes(selector))
        .map(({ reason }) => reason);
      const reasons: string[] = [];
      if (proxyDetected) reasons.push('eip1967_proxy_detected');
      if (owner && owner !== ZERO_ADDRESS) reasons.push('owner_not_renounced');
      reasons.push(...dangerousSelectors);

      return {
        passed: reasons.length === 0,
        reasons,
        ownerAddress: owner,
        proxyDetected,
        dangerousSelectors,
      };
    } catch {
      return this.failed('static_safety_read_failed');
    }
  }

  private async readStorage(
    client: PublicClient,
    address: `0x${string}`,
    slot: `0x${string}`,
  ): Promise<string | null> {
    const value = await (client as any).getStorageAt({ address, slot });
    return typeof value === 'string' ? value.toLowerCase() : null;
  }

  private async readOwner(client: PublicClient, address: `0x${string}`): Promise<string | null> {
    try {
      const owner = await client.readContract({ address, abi: OWNER_ABI, functionName: 'owner' });
      return typeof owner === 'string' ? owner.toLowerCase() : null;
    } catch {
      // A reverting owner() is treated as no detectable OpenZeppelin-style owner.
      return null;
    }
  }

  private slotHasAddress(value: string | null): boolean {
    if (!value || !/^0x[0-9a-f]{64}$/.test(value)) return false;
    return value.slice(-40) !== ZERO_ADDRESS.slice(2);
  }

  private failed(reason: string): RobinhoodExperimentalSafetyResult {
    return { passed: false, reasons: [reason], ownerAddress: null, proxyDetected: false, dangerousSelectors: [] };
  }
}
