import { PaperSniperEngine } from './paper-sniper-engine';
import { PaperSniperConfig, SniperAddress } from './sniper.types';

const config: PaperSniperConfig = {
  positionSizeQuote: 0.02,
  protocolFeePct: 0.01,
  entrySlippagePct: 0.02,
  exitSlippagePct: 0.03,
  stopMultiple: 0.8,
  timeExitMs: 3_600_000,
  momentumWindowMs: 30_000,
  momentumExitRatio: 0.7,
  momentumConfirmations: 2,
  ladder: [
    { multiple: 2, sellFraction: 0.8 },
    { multiple: 5, sellFraction: 0.15 },
    { multiple: 100, sellFraction: 0.05 },
  ],
};

describe('PaperSniperEngine', () => {
  const token = '0x1111111111111111111111111111111111111111' as SniperAddress;
  const creator = '0x2222222222222222222222222222222222222222' as SniperAddress;

  it('models entry fees and slippage pessimistically', () => {
    const engine = new PaperSniperEngine(config);
    const { position, action } = engine.open({ token, creator, symbol: 'TEST' }, 1, 0);

    expect(position.entryEffectivePrice).toBeGreaterThan(1);
    expect(position.tokensBought).toBeLessThan(config.positionSizeQuote);
    expect(action.type).toBe('ENTER');
  });

  it('rejects an over-allocated exit ladder', () => {
    expect(() => new PaperSniperEngine({
      ...config,
      ladder: [
        { multiple: 2, sellFraction: 0.8 },
        { multiple: 10, sellFraction: 0.3 },
      ],
    })).toThrow('ladder sell fractions cannot exceed 1');
  });

  it('sells 80% of the original position at executable 2x', () => {
    const engine = new PaperSniperEngine(config);
    const { position } = engine.open({ token, creator, symbol: 'TEST' }, 1, 0);
    const priceForTwoX = position.entryEffectivePrice * 2.1 /
      ((1 - config.protocolFeePct) * (1 - config.exitSlippagePct));

    const actions = engine.evaluate(position, priceForTwoX, 10_000, 3);

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('LADDER_EXIT');
    expect(actions[0].fraction).toBeCloseTo(0.8);
    expect(position.remainingFraction).toBeCloseTo(0.2);
  });

  it('closes the remainder at the executable stop', () => {
    const engine = new PaperSniperEngine(config);
    const { position } = engine.open({ token, creator, symbol: 'TEST' }, 1, 0);

    const actions = engine.evaluate(position, 0.5, 10_000, 0.5);

    expect(actions[0].type).toBe('STOP_EXIT');
    expect(position.status).toBe('CLOSED');
    expect(position.remainingFraction).toBe(0);
  });

  it('requires two distinct weak momentum windows before exiting', () => {
    const engine = new PaperSniperEngine(config);
    const { position } = engine.open({ token, creator, symbol: 'TEST' }, 1, 0);

    expect(engine.evaluate(position, 0.9, 31_000, 0.5)).toHaveLength(0);
    expect(engine.evaluate(position, 0.9, 40_000, 0.5)).toHaveLength(0);
    const actions = engine.evaluate(position, 0.9, 61_000, 0.5);

    expect(actions[0].type).toBe('MOMENTUM_EXIT');
  });

  it('takes the actual profit when a position never reaches the first ladder rung', () => {
    const engine = new PaperSniperEngine(config);
    const { position } = engine.open({ token, creator, symbol: 'TEST' }, 1, 0);
    const profitablePrice = position.entryEffectivePrice * 1.2 /
      ((1 - config.protocolFeePct) * (1 - config.exitSlippagePct));

    const actions = engine.evaluate(position, profitablePrice, config.timeExitMs + 1, 10);

    expect(actions[0].type).toBe('TIME_EXIT');
    expect(actions[0].realizedMultiple).toBeCloseTo(1.2);
    expect(position.status).toBe('CLOSED');
  });

  it('keeps the post-2x runner open past the time limit', () => {
    const engine = new PaperSniperEngine(config);
    const { position } = engine.open({ token, creator, symbol: 'TEST' }, 1, 0);
    const priceForTwoX = position.entryEffectivePrice * 2.1 /
      ((1 - config.protocolFeePct) * (1 - config.exitSlippagePct));
    engine.evaluate(position, priceForTwoX, 10_000, 10);

    const actions = engine.evaluate(position, priceForTwoX, config.timeExitMs + 1, 10);

    expect(actions).toHaveLength(0);
    expect(position.remainingFraction).toBeCloseTo(0.2);
    expect(position.status).toBe('OPEN');
  });

  it('values a trade-stop remainder at zero', () => {
    const engine = new PaperSniperEngine(config);
    const { position } = engine.open({ token, creator, symbol: 'TEST' }, 1, 0);

    const actions = engine.evaluate(position, 1.5, 10_000, 2, 'TRADE_STOP_EXIT');

    expect(actions[0].type).toBe('TRADE_STOP_EXIT');
    expect(actions[0].quoteValue).toBe(0);
    expect(position.status).toBe('CLOSED');
  });

  it('closes an open position when its creator sells', () => {
    const engine = new PaperSniperEngine(config);
    const { position } = engine.open({ token, creator, symbol: 'TEST' }, 1, 0);

    const actions = engine.evaluate(position, 1.2, 10_000, 2, 'CREATOR_EXIT');

    expect(actions[0].type).toBe('CREATOR_EXIT');
    expect(actions[0].note).toBe('creator sold after entry');
    expect(position.status).toBe('CLOSED');
  });
});
