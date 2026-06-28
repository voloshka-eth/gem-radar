export interface HoneypotSimulationResult {
  buyTax: number;      // percentage 0–100, e.g. 5 = 5 %
  sellTax: number;
  transferTax: number;
  buyGas?: string;     // gas estimate for buy simulation (non-zero if buy succeeded)
  sellGas?: string;    // gas estimate for sell simulation; "0" means sell simulation failed
}

export interface HoneypotResult {
  isHoneypot: boolean;
  honeypotReason?: string | null;
}

export interface HoneypotApiResponse {
  token?: {
    name?: string;
    symbol?: string;
    decimals?: number;
    address?: string;
  };
  simulationResult?: HoneypotSimulationResult;
  honeypotResult?: HoneypotResult;
  isHoneypot?: boolean;
}
