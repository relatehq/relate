import { z } from 'zod';
import { createRuntime } from '@relate/node';
import {
  connect,
  implementAction,
  defineAccess,
  defineAction,
  defineGraph,
  defineObject,
  defineRelationship,
  defineSource,
  from,
  objectId,
  reference,
  referenceInput,
  source,
} from 'relate';

const targets = {
  Membership: { playlist: 'Playlist', song: 'Song' },
  Transaction: { sender: 'Person', receiver: 'Person' },
  ContactRelationship: { owner: 'Person', contact: 'Person' },
};

// A task-local application snapshot, populated exclusively through public APIs.
// The agent receives the real consumer SDK; acquisition remains host-owned.
export function model() {
  const descriptions = {
    Playlist: 'A playlist in the user’s Spotify playlist library.',
    Song: 'A song occurring in that playlist library.',
    Membership:
      'A playlist-to-song association. sourceId joins the original playlist and song IDs with a colon.',
    Person:
      'A phone contact, Venmo participant or supervisor, joined by exact email. ContactRelationship records describe the contact labels assigned by an owner to another person.',
    ContactRelationship:
      'One label assigned by an owner to a contact. To select a contact group, match both owner and kind. Matching owner alone includes all relationship kinds. A contact can have several labels; deduplicate contact IDs when combining labels.',
    Transaction:
      'An own Venmo payment, incoming or outgoing. sender is the payer and receiver is the payee, using canonical Person references. Direction does not imply a contact group; group membership comes from ContactRelationship owner and kind.',
  };
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
      email: z.string(),
    }),
    ContactRelationship: z.object({
      sourceId: z.string(),
      owner: z.string(),
      contact: z.string(),
      kind: z.string(),
    }),
    Transaction: z.object({
      sourceId: z.string(),
      sender: z.string(),
      receiver: z.string(),
      amount: z.number(),
      description: z.string(),
      createdAt: z.string(),
      likeCount: z.number(),
      commentCount: z.number(),
    }),
    Membership: z.object({
      sourceId: z.string(),
      playlist: z.string(),
      song: z.string(),
    }),
  };
  const propertyDescriptions = {
    Song: {
      duration: 'Duration of the song in seconds.',
      releaseDate:
        'Release date of the song, preserved as the source datetime string. AppWorld datetimes are deliberately timezone-free and do not identify UTC instants.',
      likeCount:
        'Total number of times the song has been liked across users; not whether the current user liked it.',
      playCount:
        'Total number of times the song has been played across users; not the current user’s play count.',
      artistsJson:
        'JSON-encoded array of the song’s artist records from the source API.',
    },
    Person: {
      email:
        'Exact email address used to join phone contacts, Venmo participants and the supervisor identity supplied with the task.',
      name: 'Display name. Names are not unique identifiers.',
    },
    ContactRelationship: {
      owner: 'Person whose phone contacts assign this label.',
      contact: 'Person to whom the owner assigned the label.',
      kind: 'Exact contact-group label. Match the requested group using owner and kind together; one person may appear under multiple kinds.',
    },
    Transaction: {
      sourceId:
        'Original Venmo transaction ID, not the canonical Relate object ID used by actions.',
      sender: 'Person who sent this payment.',
      receiver: 'Person who received this payment.',
      amount: 'Amount of the transaction in dollars, in major currency units.',
      createdAt:
        'Date and time when the transaction occurred in AppWorld, preserved without conversion. Uses AppWorld’s simulated, deliberately timezone-free clock, shared with the task date. The value has no UTC offset and does not identify a UTC instant.',
      likeCount:
        'Total likes on the transaction; not whether the current user liked it.',
      commentCount: 'Total comments on the transaction, not comment contents.',
    },
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
    'ContactRelationship',
    'Membership',
    'Transaction',
  ]) {
    const properties = { id: objectId({ id: `${kind}.id` }) };

    for (const field of Object.keys(schemas[kind].shape)) {
      // Provider identity stays host-side for these objects; expose semantic fields.
      if (
        field === 'sourceId' &&
        ['Person', 'ContactRelationship'].includes(kind)
      )
        continue;

      const description = propertyDescriptions[kind]?.[field];
      const options = {
        id: `${kind}.${field}`,
        ...(description ? { description } : {}),
      };

      properties[field] = targets[kind]?.[field]
        ? reference(objects[targets[kind][field]], {
            ...options,
            from: sources[kind].fields[field],
          })
        : from(sources[kind].fields[field], options);
    }

    objects[kind] = defineObject({
      id: kind,
      description: descriptions[kind],
      membership: source(sources[kind]),
      properties,
    });
  }

  const relationships = {
    OwnedContactRelationships: defineRelationship({
      id: 'person.contact-relationships',
      forward: 'contactRelationships',
      reverse: 'owner',
      via: objects.ContactRelationship.properties.owner,
    }),
    LabeledContactRelationships: defineRelationship({
      id: 'person.labels-from-others',
      forward: 'labelsFromOthers',
      reverse: 'contact',
      via: objects.ContactRelationship.properties.contact,
    }),
    PlaylistSongs: defineRelationship({
      id: 'playlist.songs',
      forward: 'songs',
      reverse: 'playlists',
      through: {
        from: objects.Membership.properties.playlist,
        to: objects.Membership.properties.song,
      },
    }),
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
  const actions = {
    likeTransaction: defineAction({
      id: 'venmo.like-transaction',
      description:
        'Like an own Venmo transaction as the authenticated user. Updates its likeCount; does not transfer money.',
      input: z.object({ transaction: referenceInput(objects.Transaction) }),
      output: z.object({ message: z.string() }),
      creates: [],
      policy: { execute: access.role('reader') },
    }),
    commentOnTransaction: defineAction({
      id: 'venmo.comment-on-transaction',
      description:
        'Add a comment to an own Venmo transaction as the authenticated user. Updates its commentCount; does not transfer money.',
      input: z.object({
        transaction: referenceInput(objects.Transaction),
        comment: z.string(),
      }),
      output: z.object({ message: z.string(), commentId: z.string() }),
      creates: [],
      policy: { execute: access.role('reader') },
    }),
  };
  const graph = defineGraph({
    id: 'appworld-sdk-snapshot',
    description:
      'Snapshot of all playlist-library pages and their member songs, phone contacts with email and explicit owner-scoped contact labels, the supplied supervisor identity, and own Venmo transactions. Excludes other music libraries, personal liked/downloaded state, social feed and payment requests. Source IDs are for original APIs; graph references are canonical IDs.',
    objects,
    actions,
    relationships,
    access,
    policies: Object.fromEntries(
      Object.keys(objects).map((kind) => [
        kind,
        { read: { gate: access.role('reader') } },
      ]),
    ),
  });

  return { graph, sources, objects, actions };
}

export async function createSdkSnapshot(rows, writeSource) {
  const { graph, sources, objects, actions } = model();
  const maps = Object.fromEntries(
    Object.keys(objects).map((kind) => [
      kind,
      new Map((rows[kind] ?? []).map((row) => [row.sourceId, row])),
    ]),
  );
  let fetches = 0;
  const runtime = createRuntime({
    graph,
    actionImplementations: Object.entries(actions).map(([operation, action]) =>
      implementAction(
        graph,
        action,
        async ({ input, objects: contextObjects }) => {
          const transaction = await contextObjects.Transaction.get(
            input.transaction,
          );

          if (transaction.status !== 'ok')
            throw new Error('Transaction unavailable');

          if (!writeSource)
            throw new Error('Source writes unavailable in this environment');

          const result = await writeSource({
            operation,
            sourceId: transaction.data.sourceId,
            ...(operation === 'commentOnTransaction'
              ? { comment: input.comment }
              : {}),
          });

          // The bridge reads the original record after mutation. Refresh the same
          // runtime observation, preserving canonical IDs and idempotency receipts.
          maps.Transaction.set(result.transaction.sourceId, result.transaction);
          const refreshed = await contextObjects.Transaction.get(
            input.transaction,
            { refresh: true },
          );

          if (refreshed.status !== 'ok')
            throw new Error(
              'Write succeeded but graph refresh failed; inspect source state before retrying',
            );

          return result.output;
        },
      ),
    ),
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

  try {
    for (const kind of [
      'Playlist',
      'Song',
      'Person',
      'ContactRelationship',
      'Membership',
      'Transaction',
    ])
      for (const row of rows[kind] ?? [])
        await runtime.host.adopt(objects[kind], row.sourceId);

    return {
      consumer: runtime.as({
        id: 'snapshot-reader',
        roles: ['reader'],
        claims: {},
      }),
      fetchCount: () => fetches,
      close: () => runtime.close(),
    };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
