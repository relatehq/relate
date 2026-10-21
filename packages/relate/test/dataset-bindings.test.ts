import { expect, it } from 'vitest';
import { z } from 'zod';
import { bind, defineSource } from 'relate';
import { createAnalyticalGraph } from '../../../tests/support/analytical-graph.js';
import {
  createAnalyticalConnector,
  analyticalGraphSchema,
} from '../../../tests/support/analytical-connector.js';

it('binds declared columns to a resource without inspecting or executing it', () => {
  const { Events } = createAnalyticalGraph();
  const connector = createAnalyticalConnector(analyticalGraphSchema());
  const columns = { customerId: 'customer_id' };
  const binding = bind(Events, connector.table('event rows'), { columns });

  columns.customerId = 'changed';
  expect(binding.dataset).toBe(Events);
  expect(binding.connection).toBe(connector.connection);
  expect(binding.connectionId).toBe('analytics');
  expect(binding.resourceId).toBe('event rows');
  expect(binding.columns).toEqual({
    customerId: 'customer_id',
    amount: 'amount',
    secret: 'secret',
  });
  expect(connector.resources.get(binding.resource)!.columns).toBe(
    binding.columns,
  );
  expect(connector.described).toEqual([]);
  expect(Object.isFrozen(binding)).toBe(true);
  expect(Object.isFrozen(binding.columns)).toBe(true);
});

it.each([
  { columns: { unknown: 'physical' } },
  { columns: { amount: '' } },
  { columns: { amount: '  ' } },
  { columns: { amount: 'bad\0column' } },
  { columns: { amount: undefined } },
  { columns: { amount: 1 } },
  { columns: [] },
  { columns: null },
  { providerAccountId: 'account' },
  { authorization: 'shared-service' },
])('rejects invalid erased dataset mapping %#', (options) => {
  const { Events } = createAnalyticalGraph();
  const connector = createAnalyticalConnector(analyticalGraphSchema());

  expect(() =>
    bind(Events, connector.table('events'), options as never),
  ).toThrow();
  expect(connector.resources.size).toBe(0);
});

it('passes physical identifier text unchanged to the connector and allows partial mappings', () => {
  const { Events } = createAnalyticalGraph();
  const connector = createAnalyticalConnector(analyticalGraphSchema());
  const binding = bind(Events, connector.table('events'), {
    columns: { amount: 'odd " column; DROP TABLE events --' },
  });

  expect(binding.columns.amount).toBe('odd " column; DROP TABLE events --');
  expect(bind(Events, connector.table('events')).columns.customerId).toBe(
    'customerId',
  );
});

it('requires the selected capability and preserves source connection identity', () => {
  const { Events } = createAnalyticalGraph();
  const connector = createAnalyticalConnector(analyticalGraphSchema());
  const source = defineSource({
    id: 'customers',
    idField: 'id',
    schema: z.object({ id: z.string() }),
  });
  const keyed = {
    connection: connector.connection,
    resourceId: 'customers',
    bindSource: () => ({
      identity: 'application' as const,
      async fetch() {
        return { state: 'deleted' as const };
      },
    }),
  };

  expect(() => bind(Events, keyed as never)).toThrow('analytical resource');
  expect(() => bind(source, connector.table('events') as never)).toThrow(
    'keyed resource',
  );
  expect(bind(source, keyed).connection).toBe(connector.connection);
});
