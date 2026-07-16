import {
  PaperAction,
  PaperSniperConfig,
  SniperPaperPosition,
} from './sniper.types';

export class PaperSniperEngine {
  constructor(private readonly config: PaperSniperConfig) {
    assertPositiveFinite(config.positionSizeQuote, 'positionSizeQuote');
    assertFraction(config.protocolFeePct, 'protocolFeePct');
    assertFraction(config.entrySlippagePct, 'entrySlippagePct');
    assertFraction(config.exitSlippagePct, 'exitSlippagePct');
    assertPositiveFinite(config.stopMultiple, 'stopMultiple');
    assertPositiveFinite(config.timeExitMs, 'timeExitMs');
    assertPositiveFinite(config.momentumWindowMs, 'momentumWindowMs');
    assertPositiveFinite(config.momentumConfirmations, 'momentumConfirmations');
    const ladderFraction = config.ladder.reduce((sum, rung) => sum + rung.sellFraction, 0);
    if (ladderFraction > 1 + 1e-9) throw new Error('ladder sell fractions cannot exceed 1');
    for (const rung of config.ladder) {
      assertPositiveFinite(rung.multiple, 'ladder multiple');
      assertFraction(rung.sellFraction, 'ladder sellFraction', true);
    }
  }

  open(
    input: Pick<SniperPaperPosition, 'token' | 'creator' | 'symbol'>,
    marketPrice: number,
    nowMs: number,
  ): { position: SniperPaperPosition; action: PaperAction } {
    assertPositiveFinite(marketPrice, 'marketPrice');
    const spendAfterFee = this.config.positionSizeQuote * (1 - this.config.protocolFeePct);
    const tokensBought = spendAfterFee / (marketPrice * (1 + this.config.entrySlippagePct));
    const entryEffectivePrice = this.config.positionSizeQuote / tokensBought;
    const position: SniperPaperPosition = {
      ...input,
      openedAtMs: nowMs,
      entryMarketPrice: marketPrice,
      entryEffectivePrice,
      positionSizeQuote: this.config.positionSizeQuote,
      tokensBought,
      remainingFraction: 1,
      realizedQuote: 0,
      executedRungs: [],
      maxNetMultiple: 1,
      weakWindowCount: 0,
      lastMomentumBucket: null,
      status: 'OPEN',
      closeReason: null,
    };
    return {
      position,
      action: this.action(position, 'ENTER', nowMs, marketPrice, 1, 0, 'paper-only entry'),
    };
  }

  evaluate(
    position: SniperPaperPosition,
    marketPrice: number,
    nowMs: number,
    recentFlowRatio: number,
    tradeStopped = false,
  ): PaperAction[] {
    if (position.status !== 'OPEN') return [];
    assertPositiveFinite(marketPrice, 'marketPrice');
    const actions: PaperAction[] = [];
    const netMultiple = this.netMultiple(position, marketPrice);
    position.maxNetMultiple = Math.max(position.maxNetMultiple, netMultiple);

    if (tradeStopped) {
      actions.push(this.close(position, 'TRADE_STOP_EXIT', nowMs, marketPrice, 0, 'launchpad stopped trading'));
      return actions;
    }

    for (const rung of [...this.config.ladder].sort((a, b) => a.multiple - b.multiple)) {
      if (
        netMultiple >= rung.multiple &&
        !position.executedRungs.includes(rung.multiple) &&
        position.remainingFraction > 0
      ) {
        const fraction = Math.min(rung.sellFraction, position.remainingFraction);
        actions.push(this.sell(position, 'LADDER_EXIT', nowMs, marketPrice, fraction, `ladder ${rung.multiple}x`));
        position.executedRungs.push(rung.multiple);
      }
    }
    if (position.remainingFraction <= 1e-9) {
      position.status = 'CLOSED';
      position.closeReason = 'ladder_complete';
      return actions;
    }

    if (netMultiple <= this.config.stopMultiple) {
      actions.push(this.close(position, 'STOP_EXIT', nowMs, marketPrice, netMultiple, 'executable stop'));
      return actions;
    }

    const momentumBucket = Math.floor(nowMs / this.config.momentumWindowMs);
    if (position.lastMomentumBucket !== momentumBucket) {
      const weak = recentFlowRatio < this.config.momentumExitRatio && marketPrice < position.entryMarketPrice;
      position.weakWindowCount = weak ? position.weakWindowCount + 1 : 0;
      position.lastMomentumBucket = momentumBucket;
    }
    if (position.weakWindowCount >= this.config.momentumConfirmations) {
      actions.push(this.close(position, 'MOMENTUM_EXIT', nowMs, marketPrice, netMultiple, 'confirmed sell-flow reversal'));
      return actions;
    }

    if (nowMs - position.openedAtMs >= this.config.timeExitMs) {
      actions.push(this.close(position, 'TIME_EXIT', nowMs, marketPrice, netMultiple, 'maximum holding time reached'));
    }
    return actions;
  }

  private close(
    position: SniperPaperPosition,
    type: Exclude<PaperAction['type'], 'ENTER' | 'LADDER_EXIT'>,
    nowMs: number,
    marketPrice: number,
    netMultiple: number,
    note: string,
  ): PaperAction {
    const action = type === 'TRADE_STOP_EXIT'
      ? this.sellAtValue(position, type, nowMs, marketPrice, position.remainingFraction, 0, note)
      : this.sell(position, type, nowMs, marketPrice, position.remainingFraction, note);
    position.status = 'CLOSED';
    position.closeReason = type;
    action.netMultiple = netMultiple;
    return action;
  }

  private sell(
    position: SniperPaperPosition,
    type: Exclude<PaperAction['type'], 'ENTER'>,
    nowMs: number,
    marketPrice: number,
    fraction: number,
    note: string,
  ): PaperAction {
    const tokens = position.tokensBought * fraction;
    const quoteValue = tokens * marketPrice *
      (1 - this.config.protocolFeePct) *
      (1 - this.config.exitSlippagePct);
    return this.sellAtValue(position, type, nowMs, marketPrice, fraction, quoteValue, note);
  }

  private sellAtValue(
    position: SniperPaperPosition,
    type: Exclude<PaperAction['type'], 'ENTER'>,
    nowMs: number,
    marketPrice: number,
    fraction: number,
    quoteValue: number,
    note: string,
  ): PaperAction {
    position.realizedQuote += quoteValue;
    position.remainingFraction = Math.max(0, position.remainingFraction - fraction);
    return this.action(
      position,
      type,
      nowMs,
      marketPrice,
      this.netMultiple(position, marketPrice),
      fraction,
      note,
      quoteValue,
    );
  }

  private action(
    position: SniperPaperPosition,
    type: PaperAction['type'],
    nowMs: number,
    marketPrice: number,
    netMultiple: number,
    fraction: number,
    note: string,
    quoteValue = 0,
  ): PaperAction {
    return {
      type,
      occurredAtMs: nowMs,
      token: position.token,
      symbol: position.symbol,
      priceQuotePerToken: marketPrice,
      netMultiple,
      fraction,
      quoteValue,
      remainingFraction: position.remainingFraction,
      realizedMultiple: position.realizedQuote / position.positionSizeQuote,
      note,
    };
  }

  private netMultiple(position: SniperPaperPosition, marketPrice: number): number {
    const netExitPrice = marketPrice *
      (1 - this.config.protocolFeePct) *
      (1 - this.config.exitSlippagePct);
    return netExitPrice / position.entryEffectivePrice;
  }
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive and finite`);
}

function assertFraction(value: number, name: string, allowOne = false): void {
  const upperBoundOk = allowOne ? value <= 1 : value < 1;
  if (!Number.isFinite(value) || value < 0 || !upperBoundOk) {
    throw new Error(`${name} must be between 0 and ${allowOne ? '1' : 'less than 1'}`);
  }
}
