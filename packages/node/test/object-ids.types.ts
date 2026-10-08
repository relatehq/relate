import { createRuntime } from '@relate/node';
import { assertFields, defineObject, referenceInput } from 'relate';
import type { ObjectData, ObjectId } from 'relate';
import type { z } from 'zod';
import { createInvoiceGraph } from '../../../tests/support/invoice-graph.js';

const { graph, ana, Customer, Invoice } = createInvoiceGraph();

const relate = createRuntime({ graph, connections: [] });
const objects = relate.as(ana).objects;
const customerId = await relate.host.adopt(Customer, 'crm_1');
const invoiceId = await relate.host.adopt(Invoice, 'billing_1');
const customerSchema = referenceInput(Customer);
const parsed: ObjectId<'business.customer'> = customerSchema.parse('external');
const input: z.input<typeof customerSchema> = customerId;
const output: z.output<typeof customerSchema> = customerId;
const text: string = customerId;

// @ts-expect-error adoption preserves the specific object, not a registry union
const wrongAdoption: ObjectId<typeof Invoice.id> = customerId;
// @ts-expect-error brands cannot be assigned from ordinary source keys
const raw: ObjectId<typeof Customer.id> = 'crm_1';
// @ts-expect-error schema inputs retain the brand for typed action calls
const wrongInput: z.input<typeof customerSchema> = invoiceId;
// @ts-expect-error typed action calls cannot bypass the brand with plain strings
const rawInput: z.input<typeof customerSchema> = 'crm_1';

// @ts-expect-error the schema output is an ID, not a reference wrapper
parsed.id;
// @ts-expect-error wrong object ID
objects.Customer.get(invoiceId);
// @ts-expect-error plain string
objects.Customer.get('customer');
// @ts-expect-error traversal takes the starting object's ID
objects.Customer.traverse.invoices(invoiceId);
// @ts-expect-error reverse traversal starts at Invoice
objects.Invoice.traverse.customer(customerId);

const invoice = await objects.Invoice.get(invoiceId, {
  select: ['id', 'customer'],
});

if (invoice.status === 'ok') {
  const id: ObjectId<typeof Invoice.id> = invoice.id;
  const selected: ObjectId<typeof Invoice.id> | undefined = invoice.data.id;
  const reference: ObjectId<typeof Customer.id> | undefined =
    invoice.data.customer;

  // @ts-expect-error reference availability must still be checked
  objects.Customer.get(invoice.data.customer);
  void [id, selected, reference];
}

assertFields(invoice, ['id', 'customer']);
objects.Invoice.get(invoice.data.id);
objects.Customer.get(invoice.data.customer);
// @ts-expect-error assertFields preserves the target brand
objects.Invoice.get(invoice.data.customer);

const page = await objects.Customer.traverse.invoices(customerId, {
  select: ['id', 'customer'],
});

for (const record of page.data) {
  objects.Invoice.get(record.id);
  // @ts-expect-error a page record carries the destination object's brand
  objects.Customer.get(record.id);
}

for await (const record of objects.Customer.traverse.invoices(customerId)) {
  objects.Invoice.get(record.id);
  // @ts-expect-error iteration also preserves the destination brand
  objects.Customer.get(record.id);
}

const owner = await objects.Invoice.traverse.customer(invoiceId);

if (owner.status === 'ok') {
  objects.Customer.get(owner.id);
  // @ts-expect-error reverse traversal returns a Customer ID
  objects.Invoice.get(owner.id);
}

// Display names, registry keys and identity property names do not define the brand.
const Renamed = defineObject({
  ...Customer,
  label: 'Account',
  properties: { key: Customer.properties.id },
});
const renamed: ObjectData<typeof Renamed> = { key: customerId };

// @ts-expect-error own ID fields use the containing object definition
const wrongKey: ObjectData<typeof Renamed> = { key: invoiceId };

void [
  input,
  output,
  text,
  wrongAdoption,
  raw,
  wrongInput,
  rawInput,
  renamed,
  wrongKey,
];
