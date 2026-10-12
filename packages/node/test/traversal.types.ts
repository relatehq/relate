import { createRuntime } from '@relate/node';
import { defineRelationship, reference, referenceInput } from 'relate';
import { createInvoiceGraph } from '../../../tests/support/invoice-graph.js';

const { graph, ana, Customer, Invoice, invoices } = createInvoiceGraph();

const relate = createRuntime({ graph, connections: [] });
const objects = relate.as(ana).objects;
const customerId = referenceInput(Customer).parse('customer');
const invoiceId = referenceInput(Invoice).parse('invoice');
const page = await objects.Customer.traverse.invoices(customerId, {
  select: ['status', 'totalMinor'],
  limit: 2,
});
const amount: number | undefined = page.data[0]?.data.totalMinor;
const cursor: string | undefined = page.meta.continuationCursor;

// @ts-expect-error names belong to the target type
objects.Customer.traverse.invoices(customerId, { select: ['portfolio'] });
// @ts-expect-error reverse selections belong to Customer
objects.Invoice.traverse.customer(invoiceId, { select: ['totalMinor'] });
// @ts-expect-error traversal name is not an invoice operation
objects.Invoice.traverse.invoices(invoiceId);
// @ts-expect-error to-one traversal does not paginate
objects.Invoice.traverse.customer(invoiceId, { limit: 1 });
// @ts-expect-error to-one traversal does not filter
objects.Invoice.traverse.customer(invoiceId, { where: { name: 'north' } });
const filtered = await objects.Customer.traverse.invoices(customerId, {
  where: {
    status: { in: ['open', 'paid'] },
    totalMinor: { gte: 0, lt: 10_000 },
    customer: customerId,
  },
  select: ['status'],
});
const filteredStatus: string | undefined = filtered.data[0]?.data.status;

// @ts-expect-error filter fields are not automatically selected
filtered.data[0]?.data.totalMinor;
// @ts-expect-error filters address the destination type
objects.Customer.traverse.invoices(customerId, { where: { portfolio: 'x' } });
// @ts-expect-error filter values keep the destination's scalar type
objects.Customer.traverse.invoices(customerId, { where: { totalMinor: '1' } });
objects.Customer.traverse.invoices(customerId, {
  // @ts-expect-error ordinary strings have no range operators
  where: { status: { gt: 'a' } },
});
objects.Customer.traverse.invoices(customerId, {
  // @ts-expect-error references keep their target brand
  where: { customer: invoiceId },
});
void filteredStatus;
// @ts-expect-error unknown traversal
objects.Customer.traverse.unknown(customerId);
// @ts-expect-error unselected properties are not exposed
page.data[0]?.data.customer;
const customer = await objects.Invoice.traverse.customer(invoiceId, {
  select: ['name'],
});

if (customer.status === 'ok') {
  const name: string | undefined = customer.data.name;

  // @ts-expect-error not selected
  customer.data.revenue;
  void name;
}

// prettier-ignore
// @ts-expect-error a scalar cannot serve as the relationship reference
defineRelationship({ id: 'invalid', forward: 'invoices', reverse: 'customer', via: Invoice.properties.status });

const unbound = reference(Customer, {
  id: 'unbound',
  from: invoices.fields.customer_id,
});

// prettier-ignore
// @ts-expect-error a reference must be bound by defineObject before use
defineRelationship({ id: 'invalid', forward: 'invoices', reverse: 'customer', via: unbound });
// prettier-ignore
// @ts-expect-error cardinality is inferred rather than authored
defineRelationship({ id: 'invalid', forward: { name: 'invoices', cardinality: 'one' }, reverse: 'customer', via: Invoice.properties.customer });
// prettier-ignore
// @ts-expect-error endpoints are inferred rather than authored
defineRelationship({ id: 'invalid', from: Invoice, forward: 'invoices', reverse: 'customer', via: Invoice.properties.customer });

const owner: typeof Invoice = Invoice.properties.customer.owner;
const target: typeof Customer = Invoice.properties.customer.target;

void [owner, target];
void [amount, cursor];

for await (const invoice of objects.Customer.traverse.invoices(customerId, {
  select: ['status'],
})) {
  const status: string | undefined = invoice.data.status;

  // @ts-expect-error iteration preserves selection
  invoice.data.totalMinor;
  void status;
}

const optionalFullTraversal: import('relate').PageOptions<'status', 'full'> = {
  select: ['status'],
};
const optionalPage = await objects.Customer.traverse.invoices(
  customerId,
  optionalFullTraversal,
);

// @ts-expect-error an optional full option can produce compact metadata
optionalPage.data[0]!.meta.fields.status;
const fullPage = await objects.Customer.traverse.invoices(customerId, {
  select: ['status'],
  evidence: 'full',
});

fullPage.data[0]!.meta.fields.status;
const optionalOwner = await objects.Invoice.traverse.customer(
  invoiceId,
  {} as import('relate').ReadOptions<'name', 'full'>,
);

if (optionalOwner.status === 'ok') {
  // @ts-expect-error optional full evidence does not guarantee full metadata
  optionalOwner.meta.fields.name;
}

const fullOwner = await objects.Invoice.traverse.customer(invoiceId, {
  select: ['name'],
  evidence: 'full',
});

if (fullOwner.status === 'ok') fullOwner.meta.fields.name;

const genericOwner = await objects.Invoice.traverse.customer<'name', 'full'>(
  invoiceId,
);

if (genericOwner.status === 'ok') {
  // @ts-expect-error an explicit type argument cannot request evidence
  genericOwner.meta.fields.name;
}

const genericPage = await objects.Customer.traverse.invoices<'status', 'full'>(
  customerId,
);

// @ts-expect-error an explicit type argument cannot request evidence
genericPage.data[0]!.meta.fields.status;
