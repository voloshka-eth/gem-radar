export interface RobinhoodAccountingLeg {
  legType: string;
  status: string;
  notionalUsd?: number | string | null;
  gasUsd?: number | string | null;
  netUsd?: number | string | null;
}

export interface RobinhoodAccountingArm {
  committedUsd?: number | string | null;
  realizedValueUsd?: number | string | null;
  tokensBought?: number | string | null;
  remainingTokens?: number | string | null;
  legs?: readonly RobinhoodAccountingLeg[];
}

export interface RobinhoodArmReconciliation {
  entryAndFailedCostsUsd: number;
  exitProceedsUsd: number;
  costDeltaUsd: number;
  proceedsDeltaUsd: number;
  residualTokens: number;
  valid: boolean;
}

const BUY_LEGS = new Set(['IMMEDIATE_BUY', 'PROBE_BUY', 'CONFIRM_ADD']);
const SELL_LEGS = new Set([
  'LADDER_SELL',
  'HARD_STOP_SELL',
  'FLOW_REVERSAL_SELL',
  'CREATOR_EXIT_SELL',
  'HARD_RISK_SELL',
  'CONFIRMATION_EXPIRY_SELL',
  'TIME_SELL',
]);

export function reconcileRobinhoodArm(
  arm: RobinhoodAccountingArm,
  toleranceUsd = 0.01,
): RobinhoodArmReconciliation {
  const legs = arm.legs ?? [];
  const entryCosts = legs
    .filter((leg) => BUY_LEGS.has(leg.legType) && leg.status === 'FILLED')
    .reduce((total, leg) => total + numeric(leg.notionalUsd), 0);
  const failedGas = legs
    .filter((leg) => leg.status === 'FAILED')
    .reduce((total, leg) => total + numeric(leg.gasUsd), 0);
  const exitProceedsUsd = legs
    .filter((leg) => SELL_LEGS.has(leg.legType) && leg.status === 'FILLED')
    .reduce((total, leg) => total + numeric(leg.netUsd), 0);
  const entryAndFailedCostsUsd = entryCosts + failedGas;
  const costDeltaUsd = Math.abs(entryAndFailedCostsUsd - numeric(arm.committedUsd));
  const proceedsDeltaUsd = Math.abs(exitProceedsUsd - numeric(arm.realizedValueUsd));
  const residualTokens = Math.max(0, numeric(arm.remainingTokens));
  const residualTolerance = Math.max(1e-9, numeric(arm.tokensBought) * 1e-9);
  return {
    entryAndFailedCostsUsd,
    exitProceedsUsd,
    costDeltaUsd,
    proceedsDeltaUsd,
    residualTokens,
    valid: costDeltaUsd <= toleranceUsd &&
      proceedsDeltaUsd <= toleranceUsd &&
      residualTokens <= residualTolerance,
  };
}

function numeric(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
