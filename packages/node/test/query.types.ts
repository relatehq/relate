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

const optionalFullQuery: import('relate').QueryOptions<
  typeof Invoice,
  'status',
  'full'
> = { select: ['status'] };
const optionalPage = await objects.Invoice.query(optionalFullQuery);

// @ts-expect-error optional evidence does not guarantee a field map
optionalPage.data[0]!.meta.fields.status;
const fullPage = await objects.Invoice.query({
  select: ['status'],
  evidence: 'full',
});

fullPage.data[0]!.meta.fields.status;
// @ts-expect-error full evidence still respects selection
fullPage.data[0]!.meta.fields.total;
const genericPage = await objects.Invoice.query<'status', 'full'>();

// @ts-expect-error explicit type arguments alone cannot request full
genericPage.data[0]!.meta.fields.status;

implementAction(graph, Run, async ({ objects }) => {
  const optional = await objects.Invoice.get(invoice, {
    select: ['status'],
  } as import('relate').ReadOptions<'status', 'full'>);

  if (optional.status === 'ok') {
    // @ts-expect-error optional evidence includes compact inside actions too
    optional.meta.fields.status;
  }

  const page = await objects.Invoice.query(optionalFullQuery);

  // @ts-expect-error optional evidence includes compact inside action queries
  page.data[0]!.meta.fields.status;
  const full = await objects.Invoice.get(invoice, {
    select: ['status'],
    evidence: 'full',
  });

  if (full.status === 'ok') full.meta.fields.status;

  const detailed = await objects.Invoice.query({
    select: ['status'],
    evidence: 'full',
  });

  detailed.data[0]!.meta.fields.status;
  const omitted = await objects.Invoice.get<'status', 'full'>(invoice);

  if (omitted.status === 'ok') {
    // @ts-expect-error explicit generics with omitted options still include compact
    omitted.meta.fields.status;
  }

  const omittedPage = await objects.Invoice.query<'status', 'full'>();

  // @ts-expect-error explicit generics with omitted options still include compact
  omittedPage.data[0]!.meta.fields.status;

  return { count: 0 };
});
