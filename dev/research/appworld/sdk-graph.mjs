import {
  musicTargets,
  musicSchemas,
  musicDescriptions,
  musicActions,
  musicActionTargets,
  musicRelationships,
} from './music-model.mjs';
import { z } from 'zod';
import { ActionError, createRuntime } from '@relate/node';
import {
  connect,
  localDateTime,
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
  ...musicTargets,
  ContactGroup: { owner: 'Person' },
  ContactGroupMember: { group: 'ContactGroup', person: 'Person' },
  ContactGroupReceivedPayment: {
    owner: 'Person',
    group: 'ContactGroup',
    transaction: 'Transaction',
  },
  ContactGroupSentPayment: {
    owner: 'Person',
    group: 'ContactGroup',
    transaction: 'Transaction',
  },
  MusicLibrary: { owner: 'Person' },
  SavedSong: { library: 'MusicLibrary', song: 'Song' },
  SavedAlbum: { library: 'MusicLibrary', album: 'Album' },
  AlbumMembership: { album: 'Album', song: 'Song' },
  Membership: { playlist: 'Playlist', song: 'Song' },
  Transaction: { sender: 'Person', receiver: 'Person' },
  ContactRelationship: { owner: 'Person', contact: 'Person' },
};

// A task-local application snapshot, populated exclusively through public APIs.
// The agent receives the real consumer SDK; acquisition remains host-owned.
export function model() {
  const descriptions = {
    ...musicDescriptions,
    ContactGroup:
      'An owner-scoped contact group, unique by owner and kind. Use paymentsReceivedFromMembers for money members paid the owner, and paymentsSentToMembers for money the owner paid members. Filter payment dates on the traversal. Different groups can contain the same person and payment; deduplicate transaction IDs when combining groups.',
    ContactGroupMember:
      'Derived membership from an explicit owner-assigned contact label.',
    ContactGroupReceivedPayment:
      'One link between a contact group and a payment received by its owner from a member. This collection includes every contact-group kind. Filter owner and kind to select friends, coworkers, or roommates. The same transaction can appear under multiple groups; deduplicate transaction references.',
    ContactGroupSentPayment:
      'One link between a contact group and a payment sent by its owner to a member. This collection includes every contact-group kind. Filter owner and kind to select friends, coworkers, or roommates. The same transaction can appear under multiple groups; deduplicate transaction references.',
    Playlist: 'A playlist in the user’s Spotify playlist library.',
    Song: 'A song in the acquired public catalog. Querying all songs does not select a personal library. MusicLibrary.allSongs selects the union of personal song, album and playlist libraries. Use MusicLibrary.savedSongs for the song library, or MusicLibrary.savedAlbums then Album.songs for the album library.',
    MusicLibrary:
      'The authenticated user’s Spotify library. savedSongs and savedAlbums are distinct, fully acquired personal collections. Record completeness describes fields, not library membership.',
    Album:
      'An acquired catalog album; songs contains every song in that album. Use MusicLibrary.savedAlbums to select saved albums.',
    SavedSong: 'Explicit membership in the user’s saved song library.',
    SavedAlbum: 'Explicit membership in the user’s saved album library.',
    AlbumMembership: 'A song belonging to an acquired album.',
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
    ...musicSchemas,
    ContactGroup: z.object({
      sourceId: z.string(),
      owner: z.string(),
      kind: z.string(),
    }),
    ContactGroupMember: z.object({
      sourceId: z.string(),
      group: z.string(),
      person: z.string(),
    }),
    ContactGroupReceivedPayment: z.object({
      sourceId: z.string(),
      owner: z.string(),
      kind: z.string(),
      group: z.string(),
      transaction: z.string(),
    }),
    ContactGroupSentPayment: z.object({
      sourceId: z.string(),
      owner: z.string(),
      kind: z.string(),
      group: z.string(),
      transaction: z.string(),
    }),
    MusicLibrary: z.object({ sourceId: z.string(), owner: z.string() }),
    Album: z.object({ sourceId: z.string(), title: z.string() }),
    SavedSong: z.object({
      sourceId: z.string(),
      library: z.string(),
      song: z.string(),
    }),
    SavedAlbum: z.object({
      sourceId: z.string(),
      library: z.string(),
      album: z.string(),
    }),
    AlbumMembership: z.object({
      sourceId: z.string(),
      album: z.string(),
      song: z.string(),
    }),
    Playlist: z.object({ sourceId: z.string(), title: z.string() }),
    Song: z.object({
      sourceId: z.string(),
      title: z.string(),
      albumId: z.string().nullable(),
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
      createdAt: localDateTime({ precision: 'second' }),
      likeCount: z.number(),
      commentCount: z.number(),
      syncState: z.string().describe('current or pending'),
    }),
    Membership: z.object({
      sourceId: z.string(),
      playlist: z.string(),
      song: z.string(),
    }),
  };
  const musicKinds = new Set([
    'MusicLibrary',
    'Album',
    'Song',
    'Playlist',
    'SavedSong',
    'SavedAlbum',
    'AlbumMembership',
    'Membership',
    ...Object.keys(musicSchemas),
  ]);

  for (const kind of musicKinds)
    schemas[kind] = schemas[kind].extend({
      syncState: z
        .string()
        .describe(
          'current or pending; pending means music snapshot may be stale, call refreshMusic with a fresh key',
        ),
    });

  const propertyDescriptions = {
    ContactGroupReceivedPayment: {
      owner:
        'Group owner who received this payment. Derived from group.owner; filter together with kind.',
      kind: 'Exact owner-assigned contact label, derived from group.kind. Use friend for friends, coworker for coworkers, or roommate for roommates.',
    },
    ContactGroupSentPayment: {
      owner:
        'Group owner who sent this payment. Derived from group.owner; filter together with kind.',
      kind: 'Exact owner-assigned contact label, derived from group.kind. Use friend for friends, coworker for coworkers, or roommate for roommates.',
    },
    Song: {
      albumId:
        'Original album ID, or null for no album. An album association does not establish saved-library membership.',
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
      commentCount:
        'Last observed total comments; may be stale when syncState is pending.',
      syncState:
        'Whether the last source write or explicit refresh has been read back into the graph. Pending means counts may be stale; use refreshTransaction with a new request key.',
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
    'MusicLibrary',
    'Album',
    'SavedSong',
    'SavedAlbum',
    'AlbumMembership',
    'ContactRelationship',
    'Membership',
    'Transaction',
    'ContactGroup',
    'ContactGroupMember',
    'ContactGroupReceivedPayment',
    'ContactGroupSentPayment',
    ...Object.keys(musicSchemas),
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
    ...musicRelationships(objects),
    ContactGroups: defineRelationship({
      id: 'person.contact-groups',
      forward: 'contactGroups',
      reverse: 'owner',
      via: objects.ContactGroup.properties.owner,
    }),
    GroupMembers: defineRelationship({
      id: 'contact-group.members',
      forward: 'members',
      reverse: 'contactGroupsContainingPerson',
      through: {
        from: objects.ContactGroupMember.properties.group,
        to: objects.ContactGroupMember.properties.person,
      },
    }),
    GroupReceivedPayments: defineRelationship({
      id: 'contact-group.received-payments',
      forward: 'paymentsReceivedFromMembers',
      reverse: 'recipientContactGroups',
      through: {
        from: objects.ContactGroupReceivedPayment.properties.group,
        to: objects.ContactGroupReceivedPayment.properties.transaction,
      },
    }),
    GroupSentPayments: defineRelationship({
      id: 'contact-group.sent-payments',
      forward: 'paymentsSentToMembers',
      reverse: 'senderContactGroups',
      through: {
        from: objects.ContactGroupSentPayment.properties.group,
        to: objects.ContactGroupSentPayment.properties.transaction,
      },
    }),
    LibraryOwner: defineRelationship({
      id: 'person.music-library',
      forward: 'musicLibraries',
      reverse: 'owner',
      via: objects.MusicLibrary.properties.owner,
    }),
    SavedSongs: defineRelationship({
      id: 'library.saved-songs',
      forward: 'savedSongs',
      reverse: 'savedInLibraries',
      through: {
        from: objects.SavedSong.properties.library,
        to: objects.SavedSong.properties.song,
      },
    }),
    SavedAlbums: defineRelationship({
      id: 'library.saved-albums',
      forward: 'savedAlbums',
      reverse: 'savedInLibraries',
      through: {
        from: objects.SavedAlbum.properties.library,
        to: objects.SavedAlbum.properties.album,
      },
    }),
    AlbumSongs: defineRelationship({
      id: 'album.songs',
      forward: 'songs',
      reverse: 'albums',
      through: {
        from: objects.AlbumMembership.properties.album,
        to: objects.AlbumMembership.properties.song,
      },
    }),
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
    ...musicActions(objects, access),
    likeTransaction: defineAction({
      id: 'venmo.like-transaction',
      description:
        'Like an own Venmo transaction as the authenticated user. A confirmed write can return refreshState pending; use refreshTransaction to update stale counts. An uncertain error must not be retried with a new key.',
      input: z.object({ transaction: referenceInput(objects.Transaction) }),
      output: z.object({
        message: z.string(),
        operationId: z.string(),
        refreshState: z.string().describe('current or pending'),
      }),
      creates: [],
      policy: { execute: access.role('reader') },
    }),
    commentOnTransaction: defineAction({
      id: 'venmo.comment-on-transaction',
      description:
        'Add a comment to an own Venmo transaction as the authenticated user. A confirmed write can return refreshState pending; use refreshTransaction to update stale counts. An uncertain error must not be retried with a new key.',
      input: z.object({
        transaction: referenceInput(objects.Transaction),
        comment: z.string(),
      }),
      output: z.object({
        message: z.string(),
        commentId: z.string(),
        operationId: z.string(),
        refreshState: z.string().describe('current or pending'),
      }),
      creates: [],
      policy: { execute: access.role('reader') },
    }),
  };

  actions.refreshTransaction = defineAction({
    id: 'venmo.refresh-transaction',
    description:
      'Read an own transaction again without a mutation. Use after a write returns refreshState pending. Use a new idempotency key for each refresh attempt; replaying a receipt does not perform another read. This cannot resolve an uncertain write outcome.',
    input: z.object({ transaction: referenceInput(objects.Transaction) }),
    output: z.object({
      message: z.string(),
      operationId: z.string(),
      refreshState: z.string().describe('current or pending'),
    }),
    creates: [],
    policy: { execute: access.role('reader') },
  });
  const graph = defineGraph({
    id: 'appworld-sdk-snapshot',
    description:
      'Snapshot of all playlist, saved-song and saved-album library pages, explicit library memberships and every song in those playlists and albums, phone contacts with email and explicit owner-scoped contact labels, the supplied supervisor identity, and own Venmo transactions. Expanded snapshots also include the public song/album/artist catalog, personal likes/downloads/follows, recommendations and player queue. Social feed and payment requests remain excluded. Music syncState pending means values may be stale; call refreshMusic with a fresh key. Source IDs are for original APIs; graph references are canonical IDs.',
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

  return { graph, sources, objects, actions, schemas, musicKinds };
}

export async function createSdkSnapshot(rows, writeSource, options = {}) {
  void options; // Reserved for host acquisition evidence in the coverage experiment.
  const { graph, sources, objects, actions, schemas, musicKinds } = model();
  const maps = Object.fromEntries(
    Object.keys(objects).map((kind) => [
      kind,
      new Map(
        (rows[kind] ?? []).map((row) => [
          row.sourceId,
          kind === 'Transaction' || musicKinds.has(kind)
            ? { syncState: 'current', ...row }
            : row,
        ]),
      ),
    ]),
  );
  const adopted = Object.fromEntries(
    Object.keys(objects).map((kind) => [kind, new Map()]),
  );
  let fetches = 0;
  const runtime = createRuntime({
    graph,
    actionImplementations: Object.entries(actions).map(([operation, action]) =>
      implementAction(
        graph,
        action,
        async ({ input, operationId, objects: contextObjects }) => {
          if (Object.hasOwn(musicActionTargets, operation)) {
            if (!writeSource) throw new Error('Source writes unavailable');

            const sourceInput = { ...input };

            for (const [field, kind] of Object.entries(
              musicActionTargets[operation],
            )) {
              const record = await contextObjects[kind].get(input[field]);

              if (record.status !== 'ok')
                throw new Error(`${kind} unavailable`);

              sourceInput[field] = record.data.sourceId;
            }

            const result = await writeSource({
              operation,
              operationId,
              input: sourceInput,
            });

            if (result.mutationState === 'conflict')
              throw new ActionError('conflict');

            const markPending = async () => {
              for (const kind of musicKinds)
                for (const [id, record] of maps[kind]) {
                  maps[kind].set(id, { ...record, syncState: 'pending' });
                  const canonical = adopted[kind].get(id);

                  if (canonical)
                    await contextObjects[kind].get(canonical, {
                      refresh: true,
                    });
                }
            };

            if (result.mutationState === 'uncertain') {
              await markPending();
              throw new ActionError('uncertain');
            }

            if (
              result.mutationState !==
              (operation === 'refreshMusic' ? 'none' : 'confirmed')
            )
              throw new Error('Invalid music mutation outcome');

            let refreshState = 'pending';

            if (result.refreshState === 'current') {
              try {
                // Validate the entire replacement before discarding any old rows.
                const replacements = Object.fromEntries(
                  [...musicKinds].map((kind) => {
                    if (!Array.isArray(result.rows?.[kind]))
                      throw new Error('Incomplete music readback');

                    return [
                      kind,
                      new Map(
                        result.rows[kind].map((row) => [
                          row.sourceId,
                          schemas[kind].parse({ ...row, syncState: 'current' }),
                        ]),
                      ),
                    ];
                  }),
                );

                for (const kind of musicKinds) {
                  const previous = maps[kind];

                  maps[kind] = replacements[kind];

                  for (const [id, row] of maps[kind]) {
                    if (
                      !Object.keys(row).every(
                        (field) => previous.get(id)?.[field] === row[field],
                      )
                    )
                      adopted[kind].set(
                        id,
                        await runtime.host.adopt(objects[kind], id),
                      );
                  }

                  for (const id of previous.keys())
                    if (!maps[kind].has(id)) {
                      await contextObjects[kind].get(adopted[kind].get(id), {
                        refresh: true,
                      });
                      adopted[kind].delete(id);
                    }
                }

                refreshState = 'current';
              } catch {
                await markPending();
              }
            } else await markPending();

            return { ...result.output, operationId, refreshState };
          }

          const transaction = await contextObjects.Transaction.get(
            input.transaction,
          );

          if (transaction.status !== 'ok')
            throw new Error('Transaction unavailable');

          if (!writeSource)
            throw new Error('Source writes unavailable in this environment');

          if (typeof operationId !== 'string' || !operationId)
            throw new Error('SDK with ActionContext.operationId is required');

          const result = await writeSource({
            operationId,
            operation,
            sourceId: transaction.data.sourceId,
            ...(operation === 'commentOnTransaction'
              ? { comment: input.comment }
              : {}),
          });

          if (result.mutationState === 'conflict')
            throw new ActionError('conflict');

          if (result.mutationState === 'uncertain') {
            const previous = maps.Transaction.get(transaction.data.sourceId);

            maps.Transaction.set(transaction.data.sourceId, {
              ...previous,
              syncState: 'pending',
            });
            await contextObjects.Transaction.get(input.transaction, {
              refresh: true,
            });
            throw new ActionError('uncertain');
          }

          if (
            result.mutationState !==
            (operation === 'refreshTransaction' ? 'none' : 'confirmed')
          )
            throw new Error('Invalid source mutation outcome');

          // The provider outcome is already journaled outside this SDK transaction.
          // Readback/graph refresh failures cannot authorize another provider write.
          const sourceId = transaction.data.sourceId;
          const readback = schemas.Transaction.safeParse({
            ...result.transaction,
            syncState: 'current',
          });
          let refreshState =
            result.refreshState === 'current' &&
            readback.success &&
            readback.data.sourceId === sourceId
              ? 'current'
              : 'pending';

          maps.Transaction.set(
            sourceId,
            refreshState === 'current'
              ? readback.data
              : { ...maps.Transaction.get(sourceId), syncState: 'pending' },
          );

          try {
            const refreshed = await contextObjects.Transaction.get(
              input.transaction,
              { refresh: true, evidence: 'full' },
            );

            if (
              refreshed.status !== 'ok' ||
              ['commentCount', 'likeCount', 'syncState'].some(
                (field) => refreshed.meta.fields[field]?.status !== 'available',
              )
            )
              refreshState = 'pending';
          } catch {
            refreshState = 'pending';
          }

          if (refreshState === 'pending')
            maps.Transaction.set(sourceId, {
              ...maps.Transaction.get(sourceId),
              syncState: 'pending',
            });

          return { ...result.output, operationId, refreshState };
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
    for (const kind of Object.keys(objects))
      for (const row of rows[kind] ?? [])
        adopted[kind].set(
          row.sourceId,
          await runtime.host.adopt(objects[kind], row.sourceId),
        );

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
