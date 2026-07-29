import { adaptiveBatchRead } from './rpc-batching';

describe('adaptiveBatchRead', () => {
  it('splits provider-rejected address arrays down to supported batches', async () => {
    const calls: number[] = [];
    const result = await adaptiveBatchRead([1, 2, 3, 4, 5], 4, async (batch) => {
      calls.push(batch.length);
      if (batch.length > 1) throw new Error('blocked address array');
      return batch.map((value) => value * 10);
    });

    expect(result.results.sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50]);
    expect(result.failures).toHaveLength(0);
    expect(result.maxSuccessfulBatch).toBe(1);
    expect(calls).toContain(4);
  });

  it('isolates a single failed value without discarding successful values', async () => {
    const result = await adaptiveBatchRead(['ok-a', 'bad', 'ok-b'], 3, async (batch) => {
      if (batch.includes('bad')) throw new Error('single pool rejected');
      return [...batch];
    });

    expect(result.results.sort()).toEqual(['ok-a', 'ok-b']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].values).toEqual(['bad']);
  });

  it('does not amplify a transient provider failure into one request per value', async () => {
    const reader = jest.fn().mockRejectedValue(new Error('429 Too Many Requests'));
    const result = await adaptiveBatchRead(
      Array.from({ length: 32 }, (_, index) => index),
      32,
      reader,
      (error) => !error.message.includes('429'),
    );

    expect(reader).toHaveBeenCalledTimes(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].values).toHaveLength(32);
  });
});
