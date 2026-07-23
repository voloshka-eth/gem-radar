import type { CollectorResult } from '../collector/collector.types';
import type { FlowSnapshot, FlowTrade, FlowWatchType } from './flow.types';

export type RobinhoodExperimentArmCode =
  | 'A_IMMEDIATE_20'
  | 'B_PROBE_4_ADD_16'
  | 'C_CONFIRM_20'
  | 'D_PROBE_2_ADD_18'
  | 'E_PROBE_10_ADD_10';

export type RobinhoodExecutionScenarioCode = 'LATENCY_0S' | 'LATENCY_1S' | 'PRIMARY_2S' | 'STRESS_5S';

export interface RobinhoodArmDefinition {
  code: RobinhoodExperimentArmCode;
  immediateUsd: number;
  addUsd: number;
  confirmatory: boolean;
  exploratory: boolean;
}

export interface RobinhoodExecutionScenario {
  code: RobinhoodExecutionScenarioCode;
  latencyMs: number;
  gasMultiplier: number;
  primary: boolean;
  stress: boolean;
}

export interface RobinhoodFlowV3Config {
  version: string;
  confirmationStartMs: number;
  confirmationEndMs: number;
  rollingWindowMs: number;
  maxLaunchMultiple: number;
  minLatestNewBuyers: number;
  minNewBuyerAcceleration: number;
  minNetBuyPressure: number;
  minPressureGrowth: number;
  minOrganicBuyShare: number;
  minEarlyBuyerRetention: number;
  minDepthRetention: number;
  minDistinctBlocks: number;
  minExecutableDepthUsd: number;
  maxEntrySlippagePct: number;
  minZeroMoveRoundTrip: number;
  hardStopMultiple: number;
  flowReversalBuySellRatio: number;
  flowReversalDrawdown: number;
  horizonMs: number;
}

export interface RobinhoodFlowV3Snapshot {
  eligible: boolean;
  reasons: string[];
  elapsedMs: number;
  launchMultiple: number;
  latestNewBuyers: number;
  previousNewBuyers: number;
  newBuyerAcceleration: number;
  latestNetBuyUsd: number;
  previousNetBuyUsd: number;
  netBuyPressure: number;
  previousNetBuyPressure: number;
  pressureGrowth: number;
  totalBuyUsd: number;
  organicBuyUsd: number;
  organicBuyShare: number;
  earlyBuyers: number;
  retainedEarlyBuyers: number;
  earlyBuyerRetention: number;
  executableDepthUsd: number;
  depthRetention: number;
  distinctBlocks: number;
  creatorSellUsd: number;
}

export interface RobinhoodExperimentTick {
  watchId: string;
  candidate: CollectorResult;
  watchType: FlowWatchType;
  liquidityModel: 'V2' | 'V3' | 'V4';
  trades: readonly FlowTrade[];
  discoveredAtMs: number;
  latestBlock: bigint;
  observedAtMs: number;
  gemDecimals: number;
  creatorAddress: string | null;
  creatorAttributable: boolean;
  launchPriceUsd: number | null;
  dataHealthy: boolean;
  pipelineHealthy: boolean;
  dataHealth: Record<string, unknown>;
  v2ShadowDecision: { triggered: boolean; reasons: string[]; snapshot: FlowSnapshot } | null;
}
