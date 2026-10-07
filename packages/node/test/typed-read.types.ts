import { createRuntime, connect } from '@relate/node';
import { assertFields } from 'relate';
import { defineObject, referenceInput } from 'relate';
import { graph, Customer, customers, ana } from './model.js';

const relate = createRuntime({
  graph,
  connections: [
    connect(customers, {
      connectionId: 'crm',
      connector: { fetch: async () => ({ state: 'deleted' }) },
    }),
  ],
});
const id = referenceInput(Customer).parse('id');
const consumer = relate.as(ana);
const selected = await consumer.objects.Customer.get(id, {
  select: ['name'],
});

// @ts-expect-error result must be narrowed before accessing data
selected.data.name;

if (selected.status === 'ok') {
  const name: string | undefined = selected.data.name;
  // @ts-expect-error selected does not mean available
  const guaranteed: string = selected.data.name;

  // @ts-expect-error unselected property is absent from the type
  selected.data.revenue;
  // @ts-expect-error evidence is scoped to selection too
  selected.meta.fields.revenue;
  const evidence = selected.meta.fields.name;

  if (evidence?.status === 'forbidden') {
    const status: 'forbidden' = evidence.status;

    // @ts-expect-error forbidden fields expose no source or policy evidence
    evidence.source;
    void status;
  }

  void [name, guaranteed];
}

assertFields(selected, ['name']);
const name: string = selected.data.name;
const both = await consumer.objects.Customer.get(id, {
  select: ['name', 'revenue'],
});

assertFields(both, ['revenue']);
const revenue: number = both.data.revenue;
// @ts-expect-error only the asserted field becomes required
const unasserted: string = both.data.name;

// @ts-expect-error unknown object
consumer.objects.Invoice;
// @ts-expect-error unknown selection
consumer.objects.Customer.get(id, { select: ['missing'] });
// @ts-expect-error host ingestion is unavailable to consumers
consumer.host.adopt(Customer, 'external');
const Other = defineObject({ ...Customer, id: 'other' });

// @ts-expect-error unregistered object
relate.host.adopt(Other, 'external');
const all = await consumer.objects.Customer.get(id);

if (all.status === 'ok') {
  const allRevenue: number | undefined = all.data.revenue;

  void allRevenue;
}

void [name, revenue, unasserted];
