import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createRuntime } from '@relate/node';
import {
  connect,
  defineAccess,
  defineGraph,
  defineObject,
  defineRelationship,
  defineSource,
  from,
  objectId,
  reference,
  source,
} from 'relate';

const targets = {
  Membership: { playlist: 'Playlist', song: 'Song' },
  Transaction: { sender: 'Person', receiver: 'Person' },
};

// A task-local application snapshot, populated exclusively through public APIs.
// This is an experiment adapter, not a provider connector or public Relate API.
export function model() {
  const access = defineAccess({
    roles: ['reader'],
    fieldGroups: ['ordinary'],
    claims: {},
  });
  const schemas = {
    Playlist: z.object({ sourceId: z.string(), title: z.string() }),
    Song: z.object({
      sourceId: z.string(),
      title: z.string(),
      albumId: z.string(),
      duration: z.number(),
      genre: z.string(),
      releaseDate: z.string(),
      likeCount: z.number(),
      playCount: z.number(),
      artistsJson: z.string(),
    }),
    Person: z.object({
      sourceId: z.string(),
      name: z.string(),
      relationshipsJson: z.string(),
    }),
    Transaction: z.object({
      sourceId: z.string(),
      sender: z.string(),
      receiver: z.string(),
      amount: z.number(),
      description: z.string(),
      createdAt: z.string(),
      likeCount: z.number(),
    }),
    Membership: z.object({
      sourceId: z.string(),
      playlist: z.string(),
      song: z.string(),
    }),
  };
  const sources = Object.fromEntries(
    Object.entries(schemas).map(([kind, schema]) => [
      kind,
      defineSource({ id: `snapshot.${kind}`, idField: 'sourceId', schema }),
    ]),
  );
  const objects = {};

  for (const kind of [
    'Playlist',
    'Song',
    'Person',
    'Membership',
    'Transaction',
  ]) {
    const properties = { id: objectId({ id: `${kind}.id` }) };

    for (const field of Object.keys(schemas[kind].shape)) {
      properties[field] = targets[kind]?.[field]
        ? reference(objects[targets[kind][field]], {
            id: `${kind}.${field}`,
            from: sources[kind].fields[field],
          })
        : from(sources[kind].fields[field], { id: `${kind}.${field}` });
    }

    objects[kind] = defineObject({
      id: kind,
      membership: source(sources[kind]),
      properties,
    });
  }

  const relationships = {
    SentTransactions: defineRelationship({
      id: 'person.sent',
      forward: 'sentTransactions',
      reverse: 'sender',
      via: objects.Transaction.properties.sender,
    }),
    ReceivedTransactions: defineRelationship({
      id: 'person.received',
      forward: 'receivedTransactions',
      reverse: 'receiver',
      via: objects.Transaction.properties.receiver,
    }),
    PlaylistMemberships: defineRelationship({
      id: 'playlist.memberships',
      forward: 'memberships',
      reverse: 'playlist',
      via: objects.Membership.properties.playlist,
    }),
    SongMemberships: defineRelationship({
      id: 'song.memberships',
      forward: 'memberships',
      reverse: 'song',
      via: objects.Membership.properties.song,
    }),
  };
  const graph = defineGraph({
    id: 'appworld-research-snapshot',
    objects,
    relationships,
    access,
    policies: Object.fromEntries(
      Object.keys(objects).map((kind) => [
        kind,
        { read: { gate: access.role('reader') } },
      ]),
    ),
  });

  return { graph, sources, objects };
}

export function compact(value) {
  if (Array.isArray(value)) return value.map(compact);

  if (!value || typeof value !== 'object') return value;

  const result = {};

  for (const [key, field] of Object.entries(value)) {
    if (key !== 'meta') result[key] = compact(field);
    else {
      // Preserve unavailable/forbidden/stale signals. The full condition retains detailed provenance. No source freshness claim beyond this snapshot.
      const exceptions = Object.fromEntries(
        Object.entries(field.fields ?? {}).filter(
          ([, evidence]) =>
            evidence.status !== 'available' || evidence.freshness !== 'fresh',
        ),
      );

      result.meta = {
        ...('exhausted' in field ? { exhausted: field.exhausted } : {}),
        ...('continuationCursor' in field
          ? { continuationCursor: field.continuationCursor }
          : {}),
        ...('completeness' in field
          ? { completeness: field.completeness, degraded: field.degraded }
          : {}),
        ...(Object.keys(exceptions).length ? { fields: exceptions } : {}),
      };
    }
  }

  return result;
}

export async function createSnapshot(rows) {
  const { graph, sources, objects } = model();
  const loadedKinds = new Set(Object.keys(rows));

  rows = Object.fromEntries(
    Object.keys(objects).map((kind) => [kind, rows[kind] ?? []]),
  );
  const maps = Object.fromEntries(
    Object.entries(rows).map(([kind, records]) => [
      kind,
      new Map(records.map((r) => [r.sourceId, r])),
    ]),
  );
  let fetches = 0;
  const runtime = createRuntime({
    graph,
    connections: Object.entries(sources).map(([kind, resource]) =>
      connect(resource, {
        connectionId: `snapshot.${kind}`,
        connector: {
          identity: 'application',
          async fetch(id) {
            fetches++;
            const record = maps[kind].get(id);

            return record ? { state: 'present', record } : { state: 'deleted' };
          },
        },
      }),
    ),
  });
  const ids = {};

  for (const kind of [
    'Playlist',
    'Song',
    'Person',
    'Membership',
    'Transaction',
  ]) {
    ids[kind] = new Map();

    for (const row of rows[kind])
      ids[kind].set(
        row.sourceId,
        await runtime.host.adopt(objects[kind], row.sourceId),
      );
  }

  const consumer = runtime.as({
    id: 'snapshot-reader',
    roles: ['reader'],
    claims: {},
  });
  const normalized = (kind, sourceId, select) => {
    const row = maps[kind].get(sourceId);

    if (!row) return { status: 'not-found' };

    const data = Object.fromEntries(
      Object.entries({ id: ids[kind].get(sourceId), ...row })
        .filter(([k]) => !select || select.includes(k))
        .map(([k, v]) => [
          k,
          targets[kind]?.[k] ? ids[targets[kind][k]].get(v) : v,
        ]),
    );

    return { status: 'ok', id: ids[kind].get(sourceId), data };
  };
  const toSource = (kind, id) =>
    ids[kind].has(String(id))
      ? String(id)
      : [...ids[kind]].find(([, canonical]) => canonical === id)?.[0];

  return {
    async execute({ op, kind, id, relation, select, condition }) {
      if (!objects[kind]) throw new Error('Unknown object kind');

      if (!loadedKinds.has(kind))
        throw new Error('Object kind is outside loaded snapshot coverage');

      const before = fetches;
      let result;

      if (op === 'list') {
        const records = [];

        for (const sourceId of ids[kind].keys())
          records.push(
            condition === 'flat'
              ? normalized(kind, sourceId, select)
              : await consumer.objects[kind].get(ids[kind].get(sourceId), {
                  select,
                }),
          );

        result = { data: records, meta: { exhausted: true } };
      } else if (op === 'get') {
        const sourceId = toSource(kind, id);

        result =
          sourceId === undefined
            ? { status: 'not-found' }
            : condition === 'flat'
              ? normalized(kind, sourceId, select)
              : await consumer.objects[kind].get(ids[kind].get(sourceId), {
                  select,
                });
      } else if (op === 'traverse') {
        if (condition === 'flat')
          throw new Error(
            'Bulk control has no traversal; join the normalized source records in Python',
          );

        const sourceId = toSource(kind, id);

        if (sourceId === undefined) throw new Error('Unknown root ID');

        const traversal = consumer.objects[kind].traverse[relation];

        if (!traversal) throw new Error('Unknown relationship');

        if (targets[kind]?.[relation])
          result = await traversal(ids[kind].get(sourceId), { select });
        else {
          let cursor;
          const records = [];

          do {
            const page = await traversal(ids[kind].get(sourceId), {
              select,
              limit: 100,
              ...(cursor ? { cursor } : {}),
            });

            records.push(...page.data);
            cursor = page.meta.continuationCursor;

            if (!page.meta.exhausted && !cursor)
              throw new Error('Incomplete traversal without continuation');
          } while (cursor);

          result = { data: records, meta: { exhausted: true } };
        }
      } else throw new Error('Unknown operation');

      return {
        result: condition === 'compact' ? compact(result) : result,
        coverage: 'loaded snapshot only',
        snapshot_fetches: fetches - before,
      };
    },
    close: () => runtime.close(),
    ids,
  };
}

async function main() {
  let snapshot;
  const lines = createInterface({ input: process.stdin });

  for await (const line of lines) {
    try {
      const message = JSON.parse(line);

      if (message.op === 'load') {
        await snapshot?.close();
        snapshot = await createSnapshot(message.rows);
        console.log(JSON.stringify({ loaded: true }));
      } else {
        if (!snapshot) throw new Error('Load a snapshot first');

        console.log(JSON.stringify(await snapshot.execute(message)));
      }
    } catch (error) {
      console.log(JSON.stringify({ error: error.message }));
    }
  }

  await snapshot?.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
