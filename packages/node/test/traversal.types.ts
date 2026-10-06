import { createRuntime } from '@relate/node';
import { defineRelationship, referenceInput } from 'relate';
import {
  graph,
  ana,
  Customer,
  Invoice,
} from '../../../dev/fixtures/customer-graph/invoice-read/model.js';

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
defineRelationship({ id: 'invalid', from: Customer, to: Invoice, forward: { name: 'invoices', cardinality: 'many' }, reverse: { name: 'customer', cardinality: 'one' }, via: Invoice.properties.status });
// prettier-ignore
// @ts-expect-error the reference must target the from object
defineRelationship({ id: 'invalid', from: Invoice, to: Invoice, forward: { name: 'invoices', cardinality: 'many' }, reverse: { name: 'customer', cardinality: 'one' }, via: Invoice.properties.customer });
void [amount, cursor];

for await (const invoice of objects.Customer.traverse.invoices(customerId, {
  select: ['status'],
})) {
  const status: string | undefined = invoice.data.status;

  // @ts-expect-error iteration preserves selection
  invoice.data.totalMinor;
  void status;
}
