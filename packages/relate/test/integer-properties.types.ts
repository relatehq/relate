import { expectTypeOf } from 'vitest';
import { z } from 'zod';
import { defineObject, native, nativeMembership, objectId } from 'relate';
import type { NativeValues, ObjectData, QueryOptions } from 'relate';

const Balance = defineObject({
  id: 'balance',
  membership: nativeMembership(),
  properties: {
    id: objectId({ id: 'balance.id' }),
    total: native(z.int64(), { id: 'balance.total' }),
    optional: native(z.int64().optional().nullable(), {
      id: 'balance.optional',
    }),
    count: native(z.int32(), { id: 'balance.count' }),
  },
});

type Data = ObjectData<typeof Balance>;

expectTypeOf<Data['total']>().toEqualTypeOf<string | undefined>();
expectTypeOf<Data['optional']>().toEqualTypeOf<string | null | undefined>();
expectTypeOf<Data['count']>().toEqualTypeOf<number | undefined>();
const values: NativeValues<typeof Balance> = {
  total: '9007199254740993',
  count: 1,
  optional: null,
};

void values;
const query: QueryOptions<typeof Balance> = {
  where: {
    total: { gt: '9007199254740992', in: ['9007199254740993'] },
    count: { lte: 2 },
  },
};

void query;
const wrong: QueryOptions<typeof Balance> = {
  where: {
    // @ts-expect-error JSON int64 operands are strings, never bigint or number.
    total: { gt: 9007199254740993n },
  },
};

void wrong;
