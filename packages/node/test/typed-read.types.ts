import { createRuntime } from '@relate/node';
import { connect } from 'relate';
import type { FieldEvidence } from '@relate/protocol';
import { assertFields } from 'relate';
import { defineObject, referenceInput } from 'relate';
import { graph, Customer, customers, ana } from './model.js';

const relate = createRuntime({
  graph,
  connections: [
    connect(customers, {
      providerAccountId: 'example-account',
      connectionId: 'crm',
      connector: {
        identify: async () => 'example-account',
        fetch: async () => ({
          providerAccountId: 'example-account',
          state: 'deleted',
        }),
      },
    }),
  ],
});
const id = referenceInput(Customer).parse('id');
const consumer = relate.as(ana);
const selected = await consumer.objects.Customer.get(id, {
  select: ['name'],
});

type ForbiddenEvidence = Extract<FieldEvidence, { status: 'forbidden' }>;

type UnavailableEvidence = Extract<FieldEvidence, { status: 'unavailable' }>;

const forbiddenEvidence: ForbiddenEvidence = { status: 'forbidden' };
const unavailableEvidence: UnavailableEvidence = { status: 'unavailable' };

// @ts-expect-error result must be narrowed before accessing data
selected.data.name;

if (selected.status === 'ok') {
  const name: string | undefined = selected.data.name;
  // @ts-expect-error selected does not mean available
  const guaranteed: string = selected.data.name;

  // @ts-expect-error unselected property is absent from the type
  selected.data.revenue;
  // @ts-expect-error evidence is scoped to selection too
  selected.meta.fields?.revenue;
  const evidence = selected.meta.fields?.name;

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

void [name, revenue, unasserted, forbiddenEvidence, unavailableEvidence];

if (selected.status === 'ok') {
  // @ts-expect-error compact metadata may omit the field map
  selected.meta.fields.name;
  const compact: 'compact' = selected.meta.evidence;

  void compact;
}

const full = await consumer.objects.Customer.get(id, {
  select: ['name'],
  evidence: 'full',
});

if (full.status === 'ok') {
  // Requesting full evidence makes the field map required without narrowing.
  const field: FieldEvidence | undefined = full.meta.fields.name;
  const warnings: readonly string[] = full.meta.warnings;

  // @ts-expect-error full evidence is still scoped to the selection
  full.meta.fields.revenue;
  void [field, warnings];
}

declare const mode: 'compact' | 'full';
const either = await consumer.objects.Customer.get(id, { evidence: mode });

if (either.status === 'ok') {
  // @ts-expect-error an unknown mode still needs narrowing
  either.meta.fields.name;

  if (either.meta.evidence === 'full') {
    const field: FieldEvidence | undefined = either.meta.fields.name;

    void field;
  }
}

// @ts-expect-error only compact and full are public modes
consumer.objects.Customer.get(id, { evidence: 'none' });
