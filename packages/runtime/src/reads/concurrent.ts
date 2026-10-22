/** Bounded independent reads, joined before surfacing failure or cancellation. */
export async function mapReads<T, R>(
  items: readonly T[],
  read: (item: T) => Promise<R>,
  signal: AbortSignal | undefined,
  concurrency = 8,
): Promise<R[]> {
  const output: R[] = [];

  for (let offset = 0; offset < items.length; offset += concurrency) {
    signal?.throwIfAborted();
    const results = await Promise.allSettled(
      items.slice(offset, offset + concurrency).map(read),
    );
    const failed = results.find((result) => result.status === 'rejected');

    if (failed?.status === 'rejected') throw failed.reason;

    signal?.throwIfAborted();

    for (const result of results)
      if (result.status === 'fulfilled') output.push(result.value);
  }

  return output;
}
