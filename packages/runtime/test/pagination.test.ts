import { expect, it, vi } from 'vitest';
import { createQuery } from '@relate/runtime';
import { ReadError } from '@relate/protocol';
import type { Page } from '@relate/protocol';

async function collect<T>(query: AsyncIterable<T>): Promise<T[]> {
  const records: T[] = [];

  for await (const record of query) records.push(record);

  return records;
}

it('is lazy and shares one first-page request across awaits and iteration', async () => {
  const record = {
    id: 'invoice-1',
    data: { status: 'open' },
    meta: {
      completeness: 'partial',
      fields: { total: { status: 'unavailable' } },
    },
  };
  const page = { data: [record], meta: { exhausted: true } } as const;
  const read = vi.fn(async () => page);
  const query = createQuery(read);

  expect(read).not.toHaveBeenCalled();

  const iterator = query[Symbol.asyncIterator]();

  expect(read).not.toHaveBeenCalled();
  const [first, repeated, item] = await Promise.all([
    query,
    query,
    iterator.next(),
  ]);

  expect(first).toBe(page);
  expect(repeated).toBe(page);
  expect(item.value).toBe(record);
  expect(await iterator.next()).toEqual({ done: true, value: undefined });
  expect(read).toHaveBeenCalledExactlyOnceWith(undefined);
});

it('awaits one page, but iterates across empty and populated non-final pages', async () => {
  const requests: (string | undefined)[] = [];
  const pages: Record<string, Page<string>> = {
    start: {
      data: ['a'],
      meta: { exhausted: false, continuationCursor: 'empty' },
    },
    empty: { data: [], meta: { exhausted: false, continuationCursor: 'last' } },
    last: { data: ['b', 'c'], meta: { exhausted: true } },
  };
  const query = createQuery(async (cursor) => {
    requests.push(cursor);

    return pages[cursor ?? 'start']!;
  });

  expect((await query).data).toEqual(['a']);
  expect(requests).toEqual([undefined]);
  expect(await collect(query)).toEqual(['a', 'b', 'c']);
  expect(requests).toEqual([undefined, 'empty', 'last']);
});

it('resumes at the supplied cursor and permits an empty final page', async () => {
  const read = vi.fn(async (): Promise<Page<string>> => ({
    data: [],
    meta: { exhausted: true },
  }));

  expect(await collect(createQuery(read, { cursor: 'resume' }))).toEqual([]);
  expect(read).toHaveBeenCalledExactlyOnceWith('resume');
});

it.each(['break', 'throw'] as const)(
  'does not prefetch after a caller %s',
  async (stop) => {
    const read = vi.fn(async (): Promise<Page<string>> => ({
      data: ['a', 'b'],
      meta: { exhausted: false, continuationCursor: 'later' },
    }));
    const failure = new Error('Business limit');
    const run = async () => {
      for await (const record of createQuery(read)) {
        expect(record).toBe('a');

        if (stop === 'throw') throw failure;

        break;
      }
    };

    if (stop === 'throw') await expect(run()).rejects.toBe(failure);
    else await run();

    expect(read).toHaveBeenCalledTimes(1);
  },
);

it('propagates later-page failure instead of returning partial success', async () => {
  const failure = new ReadError('unavailable');
  const read = vi.fn(
    async (cursor: string | undefined): Promise<Page<string>> => {
      if (cursor) throw failure;

      return {
        data: ['a'],
        meta: { exhausted: false, continuationCursor: 'next' },
      };
    },
  );
  const iterator = createQuery(read)[Symbol.asyncIterator]();

  expect(await iterator.next()).toEqual({ done: false, value: 'a' });
  await expect(iterator.next()).rejects.toBe(failure);
  expect(read).toHaveBeenCalledTimes(2);
});

it('caches first-page failure without retrying when switching consumption style', async () => {
  const failure = new ReadError('incomplete');
  const read = vi.fn(async (): Promise<Page<string>> => {
    throw failure;
  });
  const query = createQuery(read);

  await expect(Promise.resolve(query)).rejects.toBe(failure);
  await expect(collect(query)).rejects.toBe(failure);
  expect(read).toHaveBeenCalledTimes(1);
});

it.each([
  null,
  {},
  { data: null, meta: { exhausted: true } },
  { data: [], meta: null },
  { data: [], meta: {} },
  { data: [], meta: { exhausted: 'true' } },
  { data: [], meta: { exhausted: false } },
  { data: [], meta: { exhausted: false, continuationCursor: null } },
  { data: [], meta: { exhausted: false, continuationCursor: '' } },
  { data: [], meta: { exhausted: false, continuationCursor: 1 } },
  { data: [], meta: { exhausted: true, continuationCursor: 'extra' } },
  { data: [], meta: { exhausted: true, continuationCursor: null } },
  { data: [], meta: { exhausted: true, continuationCursor: undefined } },
])(
  'rejects malformed pages in both consumption styles: %j',
  async (malformed) => {
    const query = createQuery(async () => malformed as unknown as Page<string>);

    await expect(Promise.resolve(query)).rejects.toMatchObject({
      name: 'ReadError',
      code: 'incomplete',
    });
    await expect(collect(query)).rejects.toMatchObject({
      name: 'ReadError',
      code: 'incomplete',
    });
  },
);

it('rejects a non-advancing explicit page without exposing its data or cursor', async () => {
  const query = createQuery(
    async () => ({
      data: ['not-exposed'],
      meta: { exhausted: false, continuationCursor: 'private-cursor' },
    }),
    { cursor: 'private-cursor' },
  );

  await expect(Promise.resolve(query)).rejects.toThrow('incomplete');
  await expect(collect(query)).rejects.toMatchObject({ message: 'incomplete' });
});

it('detects longer cursor cycles before yielding records from the offending page', async () => {
  const read = vi.fn(
    async (cursor: string | undefined): Promise<Page<string>> => ({
      data: [cursor ?? 'first'],
      meta: {
        exhausted: false,
        continuationCursor: cursor === 'a' ? 'b' : 'a',
      },
    }),
  );
  const iterator = createQuery(read)[Symbol.asyncIterator]();

  expect((await iterator.next()).value).toBe('first');
  expect((await iterator.next()).value).toBe('a');
  await expect(iterator.next()).rejects.toMatchObject({ code: 'incomplete' });
  expect(read.mock.calls).toEqual([[undefined], ['a'], ['b']]);
});

it('includes the initial resume cursor in cycle detection', async () => {
  const query = createQuery(
    async (cursor): Promise<Page<string>> => ({
      data: [],
      meta: {
        exhausted: false,
        continuationCursor: cursor === 'resume' ? 'b' : 'resume',
      },
    }),
    { cursor: 'resume' },
  );

  await expect(collect(query)).rejects.toMatchObject({ code: 'incomplete' });
});

it('isolates iterator state while sharing the first page', async () => {
  const read = vi.fn(
    async (cursor: string | undefined): Promise<Page<string>> =>
      cursor
        ? { data: ['b'], meta: { exhausted: true } }
        : {
            data: ['a'],
            meta: { exhausted: false, continuationCursor: 'next' },
          },
  );
  const query = createQuery(read);
  const [a, b] = await Promise.all([collect(query), collect(query)]);

  expect(a).toEqual(['a', 'b']);
  expect(b).toEqual(a);
  expect(read.mock.calls).toEqual([[undefined], ['next'], ['next']]);
});

it.each(['', null, 42])(
  'rejects invalid initial cursor %j before fetching',
  (cursor) => {
    const read = vi.fn();

    expect(() => createQuery(read, { cursor: cursor as string })).toThrow(
      'invalid-request',
    );
    expect(read).not.toHaveBeenCalled();
  },
);

it.each([1_000, 1_001])(
  'keeps the action bound distinct from page size: %i records',
  async (count) => {
    let requests = 0;
    const query = createQuery(async (cursor): Promise<Page<number>> => {
      requests++;
      const offset = Number(cursor ?? 0);
      const end = Math.min(offset + 100, count);

      return {
        data: Array.from({ length: end - offset }, (_, i) => offset + i),
        meta:
          end === count
            ? { exhausted: true }
            : { exhausted: false, continuationCursor: String(end) },
      };
    });
    const process = async () => {
      let tasks = 0;

      for await (const invoice of query) {
        if (tasks >= 1_000) throw new Error('Too many invoices');

        expect(invoice).toBe(tasks);
        tasks++;
      }

      return tasks;
    };

    if (count === 1_000) await expect(process()).resolves.toBe(1_000);
    else await expect(process()).rejects.toThrow('Too many invoices');

    expect(requests).toBe(Math.ceil(count / 100));
  },
);
