import { createRuntime } from '@relate/node';
import { implementAction, referenceInput } from 'relate';
import type { QueryResult, ObjectRecord } from 'relate';
import { createQueryModel } from '../../../tests/support/query-model.js';

const { graph, Customer, Invoice, Run } = createQueryModel();
const app = createRuntime({ graph, connections: [] });
const customer = referenceInput(Customer).parse('customer');
const invoice = referenceInput(Invoice).parse('invoice');
const objects = app.as({ id: 'ana', roles: [], claims: {} }).objects;
const selected = objects.Invoice.query({
  where: { customer, status: 'Overdue', total: null, paid: false },
  select: ['status'],
});
const typed: QueryResult<ObjectRecord<typeof Invoice, 'status'>> = selected;
const page = await selected;
const status: string | undefined = page.data[0]?.data.status;

// @ts-expect-error filter fields are not automatically selected
page.data[0]?.data.total;
// @ts-expect-error wrong reference type
objects.Invoice.query({ where: { customer: invoice } });
// @ts-expect-error IDs are branded
objects.Invoice.query({ where: { id: 'raw-id' } });
// @ts-expect-error wrong scalar type
objects.Invoice.query({ where: { total: '10' } });
// @ts-expect-error unknown property
objects.Invoice.query({ where: { typo: 'x' } });
// @ts-expect-error no operators in equality-only queries
objects.Invoice.query({ where: { total: { gt: 10 } } });
// @ts-expect-error unknown selection
objects.Invoice.query({ select: ['typo'] });
// @ts-expect-error filters do not broaden selection
objects.Invoice.query({ where: { customer }, select: ['typo'] });

for await (const row of objects.Invoice.query({ select: ['paid'] })) {
  const paid: boolean | undefined = row.data.paid;

  // @ts-expect-error iterator preserves selection
  row.data.status;
  void paid;
}

implementAction(graph, Run, async ({ objects }) => {
  const review = await objects.Review.create({ note: 'hello' });
  const result = await objects.Review.query({
    where: { id: review.id },
    select: ['note'],
  });

  // @ts-expect-error action queries validate values too
  objects.Review.query({ where: { note: 1 } });
  // @ts-expect-error selection preserved inside actions
  result.data[0]?.data.id;

  return { count: result.data.length };
});
void [typed, status];
