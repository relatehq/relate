import type { Consumer } from 'relate/consumer';
import type { ObjectId } from 'relate';
import type { FieldEvidence } from '@relate/protocol';
import type { createAnalyticalGraph } from '../../../tests/support/analytical-graph.js';

async function typed(
  consumer: Consumer<ReturnType<typeof createAnalyticalGraph>['graph']>,
  id: ObjectId<'customer'>,
) {
  const full = await consumer.objects.Customer.get(id, {
    select: ['label'],
    evidence: 'full',
    compute: { n: { sql: 'SELECT COUNT(*) FROM self.events' } },
  });

  if (full.status === 'ok') {
    const label: string | undefined = full.data.label;
    const n: string | number | boolean | null | undefined = full.data.n;
    const mode: 'full' = full.meta.evidence;
    const evidence: FieldEvidence | undefined = full.meta.fields.n;
    const nullable: boolean = full.meta.computed.n.nullable;

    // @ts-expect-error Unselected ordinary properties remain absent from the type.
    full.data.externalId;
    // @ts-expect-error SQL does not imply a non-optional numeric result.
    const count: number = full.data.n;

    void [label, n, mode, evidence, nullable, count];
  }

  await consumer.objects.Customer.get(id, {
    select: [],
    // @ts-expect-error An alias cannot collide with an unselected property.
    compute: { label: { sql: 'SELECT COUNT(*) FROM self.events' } },
  });
  await consumer.objects.Customer.get(id, {
    // @ts-expect-error An alias cannot collide with a declared calculation.
    compute: { count: { sql: 'SELECT COUNT(*) FROM self.events' } },
  });
  await consumer.objects.Customer.get(id, {
    // @ts-expect-error Unsafe aliases are rejected statically too.
    compute: { constructor: { sql: 'SELECT COUNT(*) FROM self.events' } },
  });
  const compact = await consumer.objects.Customer.get(id, {
    compute: { n: { sql: 'SELECT COUNT(*) FROM self.events' } },
  });

  if (compact.status === 'ok') {
    const mode: 'compact' = compact.meta.evidence;
    const evidence: FieldEvidence | undefined = compact.meta.fields?.n;

    void [mode, evidence];
  }

  const page = await consumer.objects.Customer.query({
    select: ['label'],
    evidence: 'full',
    compute: { n: { sql: 'SELECT COUNT(*) FROM self.events' } },
  });

  for (const row of page.data) {
    const value: string | number | boolean | null | undefined = row.data.n;
    const mode: 'full' = row.meta.evidence;
    const evidence: FieldEvidence | undefined = row.meta.fields.n;
    const nullable: boolean = row.meta.computed.n.nullable;

    // @ts-expect-error Unselected ordinary properties remain absent.
    row.data.externalId;
    void [value, mode, evidence, nullable];
  }

  for await (const row of consumer.objects.Customer.query({
    compute: { n: { sql: 'SELECT COUNT(*) FROM self.events' } },
  })) {
    const value: string | number | boolean | null | undefined = row.data.n;
    const mode: 'compact' = row.meta.evidence;

    void [value, mode];
  }

  await consumer.objects.Customer.query({
    // @ts-expect-error Query aliases cannot collide with declared properties.
    compute: { count: { sql: 'SELECT COUNT(*) FROM self.events' } },
  });
}

void typed;
