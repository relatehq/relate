import { z } from 'zod';
import {
  computed,
  defineAccess,
  defineDataset,
  defineGraph,
  defineObject,
  native,
  nativeMembership,
  objectId,
} from 'relate';
import type { SqlCorpusCase } from './index.js';

/** One test-owned schema shared by parser resolution and both backend generation suites. */
export function createSqlCorpusGraph(entry: SqlCorpusCase, declared = false) {
  const access = defineAccess({
    roles: ['reader'],
    fieldGroups: ['ordinary'],
    claims: {},
  });
  const column = <T extends z.ZodType>(id: string, schema: T) => ({
    id,
    schema,
    access: access.groups.ordinary,
  });
  const Events = defineDataset({
    id: 'events',
    columns: {
      customerId: column('events.customer', z.string()),
      value: column('events.value', z.int64().nullable()),
      label: column('events.label', z.string().nullable()),
      userId: column('events.user', z.string().nullable()),
      eventType: column('events.type', z.string().nullable()),
      occurredAt: column(
        'events.occurred',
        z.iso.datetime({ offset: true, precision: 3 }).nullable(),
      ),
      enabled: column('events.enabled', z.boolean().nullable()),
      visible: column('events.visible', z.boolean().nullable()),
      column$identifier: column('events.dollar', z.int32().nullable()),
      small: column('events.small', z.int32().nullable()),
      ratio: column('events.ratio', z.number().nullable()),
      preciseAt: column(
        'events.precise',
        z.iso.datetime({ offset: true, precision: 6 }).nullable(),
      ),
    },
  });
  const Customer = defineObject({
    id: 'customer',
    membership: nativeMembership(),
    properties: {
      id: objectId({ id: 'customer.id' }),
      externalId: native(z.string(), { id: 'customer.external' }),
      customerSince: native(z.iso.datetime({ offset: true, precision: 3 }), {
        id: 'customer.since',
      }),
      ...Object.fromEntries(
        declared
          ? [['value', computed({ id: 'customer.value', sql: entry.sql })]]
          : [],
      ),
    },
    datasets: {
      events: {
        id: 'customer.events',
        dataset: Events,
        on: [{ column: 'customerId', property: 'externalId' }],
      },
    },
  });
  const graph = defineGraph({
    id: 'sql-corpus',
    access,
    objects: { Customer },
    datasets: { Events },
    policies: {
      Customer: {
        read: { gate: access.role('reader') },
        datasets: { events: { gate: access.role('reader') } },
      },
      Events: {},
    },
  });

  return { graph, Events };
}

export type SqlCorpusRow = readonly (
  string | number | bigint | boolean | null
)[];

/** Fresh arrays, with identical rows and an unrelated key that caller predicates must never reach. */
export function sqlCorpusRows(): readonly SqlCorpusRow[] {
  const first = '2026-10-01T00:00:00.000Z';
  const second = '2026-10-09T00:00:00.000Z';
  const third = '2026-10-12T00:00:00.000Z';
  const precise = (value: string) => value.replace('.000Z', '.123456Z');

  return [
    [
      'acme',
      1n,
      'a',
      'u1',
      'login',
      first,
      false,
      true,
      1,
      2,
      1.25,
      precise(first),
    ],
    [
      'acme',
      2n,
      'z',
      'u1',
      "it's $notParameter",
      second,
      true,
      true,
      2,
      4,
      2.75,
      precise(second),
    ],
    [
      'acme',
      2n,
      'z',
      'u1',
      "it's $notParameter",
      second,
      true,
      true,
      2,
      4,
      2.75,
      precise(second),
    ],
    ['acme', null, null, null, null, null, null, null, null, null, null, null],
    [
      'acme',
      3n,
      'b',
      'u2',
      'a $notParameter',
      third,
      false,
      false,
      3,
      6,
      3.25,
      precise(third),
    ],
    ['nulls', null, null, null, null, null, null, null, null, null, null, null],
    [
      'wide',
      9007199254740993n,
      'wide',
      'u1',
      'login',
      first,
      true,
      false,
      8,
      8,
      1.5,
      precise(first),
    ],
    [
      'wide',
      2n,
      'wide',
      'u2',
      'login',
      second,
      true,
      false,
      8,
      8,
      1.5,
      precise(second),
    ],
    [
      'other',
      999n,
      'private',
      'secret',
      'login',
      third,
      true,
      true,
      9,
      9,
      9,
      precise(third),
    ],
  ];
}
