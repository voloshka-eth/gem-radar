import { planLogPoll } from './four-meme-source.service';

describe('planLogPoll', () => {
  it('processes at most one provider-sized chunk per poll', () => {
    expect(planLogPoll(null, 1_000n, 300, 25)).toEqual({
      fromBlock: 701n,
      toBlock: 725n,
      skippedRange: undefined,
    });
  });

  it('skips a stale cursor instead of replaying useless launch history', () => {
    expect(planLogPoll('100', 1_000n, 300, 25)).toEqual({
      fromBlock: 701n,
      toBlock: 725n,
      skippedRange: { fromBlock: 101n, toBlock: 700n },
    });
  });

  it('continues from the checkpoint and returns null when caught up', () => {
    expect(planLogPoll('724', 1_000n, 300, 25)).toEqual({
      fromBlock: 725n,
      toBlock: 749n,
      skippedRange: undefined,
    });
    expect(planLogPoll('1000', 1_000n, 300, 25)).toBeNull();
  });
});
