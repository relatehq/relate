import { decodeComputed } from 'relate/consumer';

const decoded = decodeComputed({
  status: 'ok',
  data: {
    name: 'Acme',
    count: '2',
    latest: '2026-10-09T10:30:00.000Z',
    exact: '2026-10-09T10:30:00.000001Z',
    flag: false,
  },
  meta: {
    computed: {
      count: { type: 'int64', nullable: false },
      latest: { type: 'timestamp', precision: 3, nullable: true },
      exact: { type: 'timestamp', precision: 6, nullable: false },
      flag: { type: 'boolean', nullable: false },
    },
  },
} as const);

const count: bigint | undefined = decoded.count;
const latest: Date | null | undefined = decoded.latest;
const exact: string | undefined = decoded.exact;
const flag: boolean | undefined = decoded.flag;
// @ts-expect-error Decoded data never guarantees presence.
const requiredCount: bigint = decoded.count;

// @ts-expect-error Non-computed fields are excluded when metadata names are known.
decoded.name;
// @ts-expect-error Microseconds do not become Date.
const rounded: Date | undefined = decoded.exact;

// @ts-expect-error Decoded fields are readonly.
decoded.count = 3n;
const missing = decodeComputed({ status: 'not-found' });

// @ts-expect-error A known not-found result has no fields.
missing.count;
const ordinary = decodeComputed({ data: { name: 'Acme' }, meta: {} });

// @ts-expect-error A record with no computed metadata has no decoded fields.
ordinary.name;
// @ts-expect-error A page must be decoded record by record.
decodeComputed({ data: [], meta: { exhausted: true } });
void [count, latest, exact, flag, requiredCount, rounded];

// Real consumer metadata must not inherit the protocol's open string index.
import type { ObjectOperations } from 'relate/consumer';
import { createAnalyticalGraph } from '../../../tests/support/analytical-graph.js';

const { Customer } = createAnalyticalGraph();

declare const customer: ObjectOperations<typeof Customer>;
const page = await customer.query({
  select: ['label', 'count'],
  compute: { extra: { sql: 'SELECT COUNT(*) FROM self.events' } },
});
const values = decodeComputed(page.data[0]!);

values.count;
values.extra;
// @ts-expect-error Ordinary fields are never computed values.
values.label;
