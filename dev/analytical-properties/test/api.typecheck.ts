import { z } from 'zod';
import { defineObject, nativeMembership, native, objectId } from 'relate';
import type { AnalyticalObjectApi } from '../api.js';
import type { Scalar } from '../contracts.js';

/** Checked by root tsc; deliberately not presented as execution or auth proof. */
export async function checkCallerInference() {
  const Customer = defineObject({
    id: 'customer',
    membership: nativeMembership(),
    properties: {
      id: objectId({ id: 'customer.id' }),
      name: native(z.string(), { id: 'customer.name' }),
    },
  });

  function check(api: AnalyticalObjectApi<typeof Customer>) {
    const result = api.get('customer_1', {
      select: ['name'],
      compute: { count: { sql: 'SELECT COUNT(*) FROM self.events' } },
    });

    void result.then((row) => {
      if (row.status !== 'ok') return;

      const value: Scalar | undefined = row.data.count;
      const name: string | undefined = row.data.name;

      void value;
      void name;
      // @ts-expect-error Unselected properties stay excluded.
      row.data.id;
      // @ts-expect-error SQL does not prove the value is a number.
      const numeric: number = row.data.count;

      void numeric;
    });
    api.query({
      select: ['name'],
      compute: { count: { sql: 'SELECT COUNT(*) FROM self.events' } },
      where: { name: { eq: 'Acme' }, count: { eq: '0' } },
      orderBy: [{ field: 'count', direction: 'asc' }],
    });
    api.get('customer_1', {
      select: ['id'],
      // @ts-expect-error Compute cannot shadow a declared property.
      compute: { name: { sql: 'SELECT COUNT(*) FROM self.events' } },
    });
    api.query({
      compute: { count: { sql: 'SELECT COUNT(*) FROM self.events' } },
      // @ts-expect-error An order field must be a declared computed alias.
      orderBy: [{ field: 'typo', direction: 'asc' }],
    });
    api.query({
      compute: { count: { sql: 'SELECT COUNT(*) FROM self.events' } },
      // @ts-expect-error An unknown filter cannot create an inferred compute alias.
      where: { typo: { eq: '0' } },
    });
    // @ts-expect-error Property filters keep their original types.
    api.query({ where: { name: { eq: 42 } } });
  }

  return check;
}
