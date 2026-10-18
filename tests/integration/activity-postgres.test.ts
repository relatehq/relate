import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect } from 'relate';
import { compile } from 'relate/compiler';
import { createRuntime } from '@relate/node';
import { createPostgresStore } from '@relate/postgres';
import type { OperationDraft } from '@relate/runtime/storage';
import { testDatabaseUrl } from '../support/database.js';
import {
  AccountReview,
  Customer,
  addAccountReview,
  customers,
  graph,
  invoices,
} from '../support/native-action-model.js';

describe('Postgres activity storage', () => {
  let db: pg.Client;
  let store: ReturnType<typeof createPostgresStore>;
  let graphId: string;

  beforeEach(async () => {
    store = createPostgresStore({ connectionString: testDatabaseUrl() });
    await store.migrate();
    db = new pg.Client({ connectionString: testDatabaseUrl() });
    await db.connect();
    graphId = randomUUID();
    await store.install(graphId, compile(graph).definitionRevision);
  });
  afterEach(async () => {
    await db.query(
      'DROP TRIGGER IF EXISTS reject_lineage ON relate.operation_objects',
    );
    await db.end();
    await store.close();
  });

  const entry = (overrides: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      graph_id: graphId,
      id: randomUUID(),
      schema_version: 1,
      position: Math.floor(Math.random() * 1e9),
      kind: 'updated',
      object_type: 'business.customer',
      object_key: 'cus_01',
      changed_property_ids: ['customer.name'],
      source_definition_id: 'crm.customers',
      action_id: null,
      failure_code: null,
      invocation_id: null,
      operation_id: randomUUID(),
      actor_kind: 'source',
      actor_id: 'crm.customers',
      triggered_by_kind: 'principal',
      triggered_by_id: 'fin',
      request_id: 'req',
      transport: 'embedded',
      definition_revision: 'revision',
      occurred_at: new Date(),
      recorded_at: new Date(),
      ...overrides,
    };
    const columns = Object.keys(row);

    return db.query(
      `INSERT INTO relate.feed_entries(${columns.join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`,
      Object.values(row),
    );
  };
  const event = {
    kind: 'invocation-succeeded',
    object_type: null,
    object_key: null,
    changed_property_ids: null,
    source_definition_id: null,
    action_id: 'business.add-account-review',
    invocation_id: 'inv_01',
    actor_kind: 'principal',
    actor_id: 'ana',
    triggered_by_kind: null,
    triggered_by_id: null,
  };

  it('accepts well-formed feed rows and rejects malformed ones', async () => {
    await expect(entry()).resolves.toBeDefined();
    await expect(entry(event)).resolves.toBeDefined();

    for (const invalid of [
      { kind: 'renamed' },
      { object_key: null },
      { ...event, invocation_id: null },
      { ...event, invocation_id: 'inv_02', failure_code: 'unexpected' },
      { ...event, invocation_id: 'inv_03', kind: 'invocation-failed' },
      { actor_kind: 'principal', actor_id: 'fin' },
      { actor_id: 'billing.invoices' },
      { triggered_by_kind: null, triggered_by_id: null },
      { kind: 'created' },
      { kind: 'adopted', actor_kind: 'source' },
      { kind: 'deleted' },
      { source_definition_id: null },
      { transport: 'smtp' },
    ])
      await expect(entry(invalid), JSON.stringify(invalid)).rejects.toThrow();

    const position = 7_777;

    await entry({ position });
    // Positions are unique across change and invocation-event kinds.
    await expect(
      entry({ ...event, invocation_id: 'inv_04', position }),
    ).rejects.toThrow(/feed_entries_graph_id_position_key/);
  });

  function draft(objects: number): OperationDraft {
    return {
      schemaVersion: 1,
      id: randomUUID(),
      graphId,
      definitionRevision: 'revision',
      actor: { kind: 'principal', id: 'ana' },
      context: { requestId: 'req', transport: 'http', executionId: 'exec' },
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(1).toISOString(),
      durationMs: 1.5,
      objects: Array.from({ length: objects }, (_, index) => ({
        objectDefinitionId: 'business.invoice',
        objectId: `inv_${10 - index}`,
        role: 'returned' as const,
        returned: ['invoice.status'],
        forbidden: index % 2 ? ['invoice.total'] : [],
        unavailable: [],
      })),
      kind: 'query',
      definitionId: 'business.invoice',
      outcome: { status: 'ok' },
      details: { hasMore: true },
    };
  }

  it('round-trips lineage order and context, and rolls back a failed lineage write', async () => {
    const recorded = draft(5);

    await store.activity!.appendOperations(graphId, [recorded]);

    const [operation] = (await store.activity!.operations.list(graphId))
      .entries;

    expect(operation).toEqual({ ...recorded, recordedAt: expect.any(String) });

    await db.query(
      `CREATE OR REPLACE FUNCTION relate.reject_lineage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected lineage failure'; END $$`,
    );
    await db.query(
      'CREATE TRIGGER reject_lineage BEFORE INSERT ON relate.operation_objects FOR EACH ROW EXECUTE FUNCTION relate.reject_lineage()',
    );

    const failed = draft(2);

    await expect(
      store.activity!.appendOperations(graphId, [failed]),
    ).rejects.toThrow();
    expect(
      (
        await db.query('SELECT 1 FROM relate.operations WHERE id=$1', [
          failed.id,
        ])
      ).rowCount,
    ).toBe(0);
  });

  it('reports legacy objects without provenance as unknown', async () => {
    const runtime = createRuntime({
      graph,
      graphId,
      store,
      actionImplementations: [addAccountReview],
      connections: [
        connect(customers, {
          providerAccountId: 'example-account',
          connectionId: 'crm',
          connector: {
            identify: async () => 'example-account',
            fetch: async (id) => ({
              providerAccountId: 'example-account',
              state: 'present',
              record: { id, name: 'Legacy', portfolio: 'north' },
            }),
          },
        }),
        connect(invoices, {
          providerAccountId: 'example-account',
          connectionId: 'billing',
          connector: {
            identify: async () => 'example-account',
            fetch: async (id) => ({
              providerAccountId: 'example-account',
              state: 'present',
              record: { id },
            }),
          },
        }),
      ],
    });
    const customer = await runtime.host.adopt(Customer, 'legacy');

    await db.query(
      `INSERT INTO relate.native_objects(graph_id,object_type,object_key,values,created_at) VALUES ($1,$2,'old-review','{}',1)`,
      [graphId, AccountReview.id],
    );
    await db.query(
      'UPDATE relate.objects SET adopted_by_kind=NULL, adopted_by_id=NULL, adopted_at=NULL WHERE graph_id=$1',
      [graphId],
    );

    for (const object of [
      { objectDefinitionId: AccountReview.id, objectId: 'old-review' },
      { objectDefinitionId: Customer.id, objectId: customer },
    ])
      expect(await runtime.host.provenance(object)).toEqual({
        kind: 'unknown',
      });

    await runtime.close();
  });
});
