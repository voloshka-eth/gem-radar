export interface AdaptiveBatchFailure<T> {
  values: readonly T[];
  error: Error;
}

export interface AdaptiveBatchResult<T, R> {
  results: R[];
  failures: Array<AdaptiveBatchFailure<T>>;
  maxSuccessfulBatch: number;
}

/**
 * Reads values in provider-sized batches and recursively splits rejected arrays.
 * Single-value failures are returned to the caller so their cursors remain behind.
 */
export async function adaptiveBatchRead<T, R>(
  values: readonly T[],
  initialBatchSize: number,
  reader: (batch: readonly T[]) => Promise<readonly R[]>,
  shouldSplit: (error: Error, batch: readonly T[]) => boolean = () => true,
): Promise<AdaptiveBatchResult<T, R>> {
  const size = Math.max(1, Math.floor(initialBatchSize));
  const results: R[] = [];
  const failures: Array<AdaptiveBatchFailure<T>> = [];
  let maxSuccessfulBatch = 0;

  const read = async (batch: readonly T[]): Promise<void> => {
    if (!batch.length) return;
    try {
      results.push(...await reader(batch));
      maxSuccessfulBatch = Math.max(maxSuccessfulBatch, batch.length);
    } catch (cause) {
      const error = toError(cause);
      if (batch.length === 1) {
        failures.push({ values: batch, error });
        return;
      }
      if (!shouldSplit(error, batch)) {
        failures.push({ values: batch, error });
        return;
      }
      const middle = Math.ceil(batch.length / 2);
      await read(batch.slice(0, middle));
      await read(batch.slice(middle));
    }
  };

  for (let index = 0; index < values.length; index += size) {
    await read(values.slice(index, index + size));
  }
  return { results, failures, maxSuccessfulBatch };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
