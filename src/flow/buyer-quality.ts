import type { FlowTrade } from './flow.types';

export type BuyerClass =
  | 'INDEPENDENT' | 'CREATOR' | 'CREATOR_FUNDED' | 'INSIDER'
  | 'BUNDLED' | 'SYBIL' | 'WASH' | 'BOT_SUSPECTED' | 'UNKNOWN';

export interface BuyerQualitySnapshot {
  featureSchemaVersion: 'buyer_quality_shadow_v1';
  measuredAtMs: number;
  classificationCoverage: number;
  windows: Record<string, BuyerQualityWindow>;
  retention: Record<string, BuyerRetentionWindow>;
  firstMajorSell: FirstMajorSellAbsorption | null;
}

export interface BuyerQualityWindow {
  organicFlowRatio: number | null;
  knownOrganicFlowRatio: number | null;
  independentBuyerCount: number | null;
  independentBuyerAcceleration: number | null;
  unknownFlowShare: number;
  creatorFundedFlowShare: number;
  bundledFlowShare: number;
  topIndependentBuyerShare: number | null;
  classVolumeUsd: Record<BuyerClass, number>;
}

export interface BuyerRetentionWindow {
  measuredAtMs: number;
  buyerRetentionRate: number | null;
  capitalRetentionRate: number | null;
  repeatBuyRate: number | null;
  fullExitRate: number | null;
  partialExitRate: number | null;
  medianRetainedPositionRatio: number | null;
  tokenAmountCoverage: number;
}

export interface FirstMajorSellAbsorption {
  sellOccurredAtMs: number;
  majorSellUsd: number;
  absorptionRatio15s: number | null;
  absorptionRatio30s: number | null;
  absorptionRatio60s: number | null;
  independentBuyersAfter15s: number | null;
  independentBuyersAfter30s: number | null;
  independentBuyersAfter60s: number | null;
}

const CLASSES: BuyerClass[] = [
  'INDEPENDENT', 'CREATOR', 'CREATOR_FUNDED', 'INSIDER', 'BUNDLED', 'SYBIL', 'WASH', 'BOT_SUSPECTED', 'UNKNOWN',
];
type ClassifiedTrade = { trade: FlowTrade; classification: BuyerClass };

/**
 * Conservative shadow metrics. Only identities backed by a future wallet
 * graph may become INDEPENDENT. Until then UNKNOWN is missing information,
 * not evidence of non-organic flow.
 */
export function computeBuyerQualityShadow(
  trades: readonly FlowTrade[],
  nowMs: number,
  executableDepthUsd: number,
  creatorAddress: string | null,
  t0Ms = Math.min(...trades.map((trade) => trade.occurredAtMs), nowMs),
): BuyerQualitySnapshot {
  const normalizedCreator = creatorAddress?.toLowerCase() ?? null;
  const classified = trades
    .filter((trade) => trade.occurredAtMs <= nowMs)
    .map((trade) => ({ trade, classification: classify(trade, normalizedCreator) }));
  const windows = Object.fromEntries([15_000, 30_000, 60_000, 120_000, 300_000].map((windowMs) => [
    `${windowMs / 1000}s`,
    summarizeWindow(classified.filter(({ trade }) => trade.occurredAtMs > nowMs - windowMs), nowMs, windowMs),
  ]));
  const retention = Object.fromEntries([30_000, 60_000].map((cohortMs) => [
    `cohort_0_${cohortMs / 1000}s`, retentionAt(classified, nowMs, t0Ms, cohortMs),
  ]));
  const buyRows = classified.filter(({ trade }) => trade.kind === 'BUY');
  const knownRows = buyRows.filter(({ classification }) => classification !== 'UNKNOWN');
  return {
    featureSchemaVersion: 'buyer_quality_shadow_v1', measuredAtMs: nowMs,
    classificationCoverage: buyRows.length ? knownRows.length / buyRows.length : 0,
    windows, retention,
    firstMajorSell: firstMajorSell(classified, nowMs, executableDepthUsd),
  };
}

function classify(trade: FlowTrade, creator: string | null): BuyerClass {
  return creator != null && trade.trader.toLowerCase() === creator ? 'CREATOR' : 'UNKNOWN';
}

function summarizeWindow(rows: readonly ClassifiedTrade[], nowMs: number, windowMs: number): BuyerQualityWindow {
  const classVolumeUsd = Object.fromEntries(CLASSES.map((classification) => [classification, 0])) as Record<BuyerClass, number>;
  const walletVolumes = new Map<string, number>();
  for (const { trade, classification } of rows) {
    if (trade.kind !== 'BUY') continue;
    classVolumeUsd[classification] += trade.quoteAmountUsd;
    if (classification === 'INDEPENDENT') {
      const wallet = trade.trader.toLowerCase();
      walletVolumes.set(wallet, (walletVolumes.get(wallet) ?? 0) + trade.quoteAmountUsd);
    }
  }
  const totalBuy = CLASSES.reduce((sum, classification) => sum + classVolumeUsd[classification], 0);
  const knownOrganic = classVolumeUsd.INDEPENDENT;
  const independent = [...walletVolumes.values()];
  const previousStart = nowMs - windowMs;
  const previousEnd = nowMs - Math.floor(windowMs / 2);
  const currentStart = previousEnd;
  const previousCount = new Set(rows.filter(({ trade, classification }) =>
    classification === 'INDEPENDENT' && trade.kind === 'BUY' && trade.occurredAtMs >= previousStart && trade.occurredAtMs < previousEnd,
  ).map(({ trade }) => trade.trader.toLowerCase())).size;
  const currentCount = new Set(rows.filter(({ trade, classification }) =>
    classification === 'INDEPENDENT' && trade.kind === 'BUY' && trade.occurredAtMs >= currentStart && trade.occurredAtMs <= nowMs,
  ).map(({ trade }) => trade.trader.toLowerCase())).size;
  const hasClassifiedOrganic = knownOrganic > 0;
  return {
    organicFlowRatio: hasClassifiedOrganic && totalBuy > 0 ? knownOrganic / totalBuy : null,
    knownOrganicFlowRatio: hasClassifiedOrganic && totalBuy > 0 ? knownOrganic / totalBuy : null,
    independentBuyerCount: hasClassifiedOrganic ? independent.length : null,
    independentBuyerAcceleration: previousCount > 0 ? currentCount / previousCount : null,
    unknownFlowShare: totalBuy > 0 ? classVolumeUsd.UNKNOWN / totalBuy : 1,
    creatorFundedFlowShare: totalBuy > 0 ? classVolumeUsd.CREATOR_FUNDED / totalBuy : 0,
    bundledFlowShare: totalBuy > 0 ? (classVolumeUsd.BUNDLED + classVolumeUsd.SYBIL) / totalBuy : 0,
    topIndependentBuyerShare: knownOrganic > 0 ? Math.max(...independent) / knownOrganic : null,
    classVolumeUsd,
  };
}

function retentionAt(rows: readonly ClassifiedTrade[], nowMs: number, t0Ms: number, cohortMs: number): BuyerRetentionWindow {
  const cohort = rows.filter(({ trade, classification }) => classification === 'INDEPENDENT' && trade.kind === 'BUY'
    && trade.occurredAtMs >= t0Ms && trade.occurredAtMs <= t0Ms + cohortMs && trade.tokenAmount != null);
  const tokenAmountCoverage = rows.filter(({ trade, classification }) => classification === 'INDEPENDENT' && trade.kind === 'BUY'
    && trade.occurredAtMs >= t0Ms && trade.occurredAtMs <= t0Ms + cohortMs).length;
  if (!cohort.length) return emptyRetention(nowMs, tokenAmountCoverage ? cohort.length / tokenAmountCoverage : 0);
  const wallets = new Set(cohort.map(({ trade }) => trade.trader.toLowerCase()));
  const positions = new Map<string, { bought: number; sold: number; repeatBuys: number }>();
  for (const { trade, classification } of rows) {
    const wallet = trade.trader.toLowerCase();
    if (classification !== 'INDEPENDENT' || !wallets.has(wallet) || trade.tokenAmount == null || trade.occurredAtMs > nowMs) continue;
    const position = positions.get(wallet) ?? { bought: 0, sold: 0, repeatBuys: 0 };
    if (trade.kind === 'BUY') { position.bought += trade.tokenAmount; position.repeatBuys++; }
    else position.sold += trade.tokenAmount;
    positions.set(wallet, position);
  }
  const values = [...positions.values()].filter((position) => position.bought > 0);
  if (!values.length) return emptyRetention(nowMs, 0);
  const ratios = values.map((position) => Math.max(0, 1 - position.sold / position.bought));
  return {
    measuredAtMs: nowMs, tokenAmountCoverage: cohort.length / tokenAmountCoverage,
    buyerRetentionRate: ratios.filter((ratio) => ratio > 0).length / ratios.length,
    capitalRetentionRate: ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length,
    repeatBuyRate: values.filter((position) => position.repeatBuys > 1).length / values.length,
    fullExitRate: ratios.filter((ratio) => ratio === 0).length / ratios.length,
    partialExitRate: ratios.filter((ratio) => ratio > 0 && ratio < 1).length / ratios.length,
    medianRetainedPositionRatio: quantile(ratios, 0.5),
  };
}

function emptyRetention(measuredAtMs: number, tokenAmountCoverage: number): BuyerRetentionWindow {
  return { measuredAtMs, tokenAmountCoverage, buyerRetentionRate: null, capitalRetentionRate: null, repeatBuyRate: null,
    fullExitRate: null, partialExitRate: null, medianRetainedPositionRatio: null };
}

function firstMajorSell(rows: readonly ClassifiedTrade[], nowMs: number, depthUsd: number): FirstMajorSellAbsorption | null {
  // With no independently classified buyers, absorption is unknown rather
  // than zero. This prevents absent wallet labels becoming an anti-alpha cue.
  if (!rows.some(({ classification }) => classification === 'INDEPENDENT')) return null;
  const first = rows.find(({ trade }) => {
    if (trade.kind !== 'SELL') return false;
    const priorIndependentBuys = rows.filter(({ trade: prior, classification }) => classification === 'INDEPENDENT' && prior.kind === 'BUY'
      && prior.occurredAtMs >= trade.occurredAtMs - 60_000 && prior.occurredAtMs < trade.occurredAtMs)
      .reduce((sum, { trade: prior }) => sum + prior.quoteAmountUsd, 0);
    return trade.quoteAmountUsd >= Math.max(0.05 * Math.max(depthUsd, 0), 0.25 * priorIndependentBuys);
  });
  if (!first) return null;
  const result = (windowMs: number) => {
    const buys = rows.filter(({ trade, classification }) => classification === 'INDEPENDENT' && trade.kind === 'BUY'
      && trade.occurredAtMs > first.trade.occurredAtMs && trade.occurredAtMs <= Math.min(nowMs, first.trade.occurredAtMs + windowMs));
    const volume = buys.reduce((sum, { trade }) => sum + trade.quoteAmountUsd, 0);
    return { ratio: first.trade.quoteAmountUsd > 0 ? volume / first.trade.quoteAmountUsd : null,
      buyers: new Set(buys.map(({ trade }) => trade.trader.toLowerCase())).size };
  };
  const at15 = result(15_000); const at30 = result(30_000); const at60 = result(60_000);
  return { sellOccurredAtMs: first.trade.occurredAtMs, majorSellUsd: first.trade.quoteAmountUsd,
    absorptionRatio15s: at15.ratio, absorptionRatio30s: at30.ratio, absorptionRatio60s: at60.ratio,
    independentBuyersAfter15s: at15.buyers, independentBuyersAfter30s: at30.buyers, independentBuyersAfter60s: at60.buyers };
}

function quantile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * q)];
}
