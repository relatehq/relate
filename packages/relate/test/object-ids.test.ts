import { expect, it } from 'vitest';
import { z } from 'zod';
import { referenceInput } from 'relate';
import { createInvoiceGraph } from '../../../tests/support/invoice-graph.js';

const { Customer } = createInvoiceGraph();

it('parses and serializes references as unchanged strings without wrappers', () => {
  const schema = z.object({ customer: referenceInput(Customer) });
  const value = schema.parse({ customer: ' customer-id ' });

  expect(value.customer).toBe(' customer-id ');
  expect(JSON.stringify(value)).toBe('{"customer":" customer-id "}');
  expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
  expect(z.toJSONSchema(schema).properties?.customer).toMatchObject({
    type: 'string',
  });
});

it.each([
  '',
  '  ',
  '\n\t',
  null,
  undefined,
  123,
  { id: 'customer' },
  ['customer'],
])('rejects invalid reference input %j', (value) => {
  expect(referenceInput(Customer).safeParse(value).success).toBe(false);
});
