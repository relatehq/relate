import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntime } from '@relate/node';
import {
  connect,
  defineAccess,
  defineGraph,
  defineObject,
  defineRelationship,
  native,
  nativeMembership,
  objectId,
  reference,
  referenceInput,
} from 'relate';
import { compile } from 'relate/compiler';
import { SourceAccessDenied } from 'relate/connectors';
import type { SourceConnector } from 'relate/connectors';
import type { ObservationStore } from 'relate/storage';
import { z } from 'zod';
import { createPlaylistGraph } from './playlist-graph.js';

type Backing = { store: ObservationStore; close(): Promise<void> };

export function throughTraversalContract(
  name: string,
  open: () => Promise<Backing>,
) {
  describe(name, () => {
    const cleanup: (() => Promise<void>)[] = [];

    afterEach(async () => {
      for (const close of cleanup.reverse()) await close();

      cleanup.length = 0;
    });

    async function setup(restricted?: 'playlist' | 'song') {
      const model = createPlaylistGraph(restricted);
      const backing = await open();

      cleanup.push(backing.close);
      const rows = {
        playlists: new Map<
          string,
          { id: string; name: string; visible: boolean }
        >(),
        songs: new Map<
          string,
          { id: string; title: string; visible: boolean }
        >(),
        memberships: new Map<
          string,
          {
            id: string;
            playlist: string;
            song: string;
            position: number;
            visible: boolean;
          }
        >(),
      };
      const denied = new Set<string>();
      const offline = new Set<string>();
      let now = 1_000;
      const connector = (type: keyof typeof rows): SourceConnector => ({
        identify: async () => 'music',
        async fetch(id) {
          if (denied.has(`${type}/${id}`)) throw new SourceAccessDenied();

          if (offline.has(`${type}/${id}`))
            throw new Error('private provider outage');

          const record = rows[type].get(id);

          return record
            ? { providerAccountId: 'music', state: 'present', record }
            : { providerAccountId: 'music', state: 'deleted' };
        },
      });
      const runtime = createRuntime({
        graph: model.graph,
        graphId: randomUUID(),
        store: backing.store,
        clock: () => now,
        connections: [
          connect(model.playlists, {
            providerAccountId: 'music',
            connectionId: 'playlists',
            connector: connector('playlists'),
          }),
          connect(model.songs, {
            providerAccountId: 'music',
            connectionId: 'songs',
            connector: connector('songs'),
          }),
          connect(model.memberships, {
            providerAccountId: 'music',
            connectionId: 'memberships',
            connector: connector('memberships'),
          }),
        ],
      });

      cleanup.push(() => runtime.close());
      const playlist = async (id: string, visible = true) => {
        rows.playlists.set(id, { id, name: id, visible });

        return runtime.host.adopt(model.Playlist, id);
      };
      const song = async (id: string, visible = true) => {
        rows.songs.set(id, { id, title: id, visible });

        return runtime.host.adopt(model.Song, id);
      };
      const link = async (
        id: string,
        playlist: string,
        song: string,
        visible = true,
      ) => {
        rows.memberships.set(id, {
          id,
          playlist,
          song,
          position: rows.memberships.size,
          visible,
        });

        return runtime.host.adopt(model.Membership, id);
      };

      return {
        ...model,
        runtime,
        store: backing.store,
        rows,
        denied,
        offline,
        playlist,
        song,
        link,
        objects: runtime.as(model.reader).objects,
        advance: (ms: number) => {
          now += ms;
        },
      };
    }

    it('returns distinct destination pages and lazy iteration in both directions, retaining entry metadata separately', async () => {
      const t = await setup();
      const p = await t.playlist('morning');
      const q = await t.playlist('evening');
      const a = await t.song('alpha');
      const b = await t.song('beta');

      await t.link('a1', 'morning', 'alpha');
      await t.link('a2', 'morning', 'alpha');
      await t.link('b1', 'morning', 'beta');
      await t.link('a3', 'evening', 'alpha');

      for (const evidence of ['compact', 'full'] as const) {
        const seen: string[] = [];

        for await (const song of t.objects.Playlist.traverse.songs(p, {
          limit: 1,
          select: ['title'],
          evidence,
        })) {
          seen.push(song.id);
          expect(Object.keys(song.data)).toEqual(['title']);
          expect(song.meta.evidence).toBe(evidence);
        }

        expect(seen).toEqual([a, b].sort());
        const reverse: string[] = [];

        for await (const playlist of t.objects.Song.traverse.playlists(a, {
          limit: 1,
          select: ['name'],
          evidence,
        }))
          reverse.push(playlist.id);

        expect(reverse).toEqual([p, q].sort());
      }

      const entries = await t.objects.Playlist.traverse.entries(p, {
        select: ['position'],
      });

      expect(entries.data).toHaveLength(3);
      expect(entries.data.map((r) => r.data.position).sort()).toEqual([
        0, 1, 2,
      ]);
      expect(
        await t.objects.Playlist.traverse.songs(
          referenceInput(t.Playlist).parse('missing'),
        ),
      ).toEqual({ data: [], meta: { exhausted: true } });
    });

    it('enforces root, membership and destination policies in either direction', async () => {
      const t = await setup();
      const visible = await t.playlist('visible');
      const hidden = await t.playlist('hidden', false);
      const song = await t.song('song');

      await t.song('private-song', false);
      await t.song('private-link');
      await t.link('visible', 'visible', 'song');
      await t.link('hidden-root', 'hidden', 'song');
      await t.link('hidden-song', 'visible', 'private-song');
      await t.link('hidden-link', 'visible', 'private-link', false);
      expect(
        (await t.objects.Playlist.traverse.songs(visible)).data.map(
          (r) => r.id,
        ),
      ).toEqual([song]);
      expect((await t.objects.Playlist.traverse.songs(hidden)).data).toEqual(
        [],
      );
      expect(
        (await t.objects.Song.traverse.playlists(song)).data.map((r) => r.id),
      ).toEqual([visible]);
    });

    for (const restricted of ['playlist', 'song'] as const)
      it(`requires access to the ${restricted} reference even when not selected`, async () => {
        const t = await setup(restricted);
        const p = await t.playlist('p');
        const s = await t.song('s');

        await t.link('link', 'p', 's');
        expect(
          (await t.objects.Playlist.traverse.songs(p, { select: ['title'] }))
            .data,
        ).toEqual([]);
        expect(
          (await t.objects.Song.traverse.playlists(s, { select: ['name'] }))
            .data,
        ).toEqual([]);
        const editor = t.runtime.as({
          ...t.reader,
          roles: ['reader', 'editor'],
        }).objects;

        expect(
          (await editor.Playlist.traverse.songs(p)).data.map((r) => r.id),
        ).toEqual([s]);
        expect(
          (await editor.Song.traverse.playlists(s)).data.map((r) => r.id),
        ).toEqual([p]);
      });

    it('refreshes changed and deleted memberships, and never uses provider-denied links', async () => {
      const t = await setup();
      const p = await t.playlist('p');
      const q = await t.playlist('q');
      const s = await t.song('s');

      await t.link('link', 'p', 's');
      t.rows.memberships.get('link')!.playlist = 'q';
      expect(
        (await t.objects.Playlist.traverse.songs(p, { refresh: true })).data,
      ).toEqual([]);
      expect(
        (await t.objects.Song.traverse.playlists(s)).data.map((r) => r.id),
      ).toEqual([q]);
      t.denied.add('memberships/link');
      expect(
        (
          await t.objects.Playlist.traverse.songs(q, {
            refresh: true,
            stale: 'allow',
          })
        ).data,
      ).toEqual([]);
      t.denied.clear();
      t.rows.memberships.delete('link');
      expect(
        (await t.objects.Song.traverse.playlists(s, { refresh: true })).data,
      ).toEqual([]);
    });

    it('withholds destinations and roots denied by their providers, including retained values', async () => {
      const t = await setup();
      const p = await t.playlist('p');

      await t.song('s');
      await t.link('link', 'p', 's');
      t.denied.add('songs/s');
      expect(
        (await t.objects.Playlist.traverse.songs(p, { refresh: true })).data,
      ).toEqual([]);
      t.denied.clear();
      t.denied.add('playlists/p');
      expect(
        (await t.objects.Playlist.traverse.songs(p, { refresh: true })).data,
      ).toEqual([]);
    });

    it('bounds work and resumes inside a membership search without exposing hidden IDs', async () => {
      const t = await setup();
      const p = await t.playlist('p');
      const s = await t.song('s');
      const links = await Promise.all(
        Array.from({ length: 103 }, (_, i) =>
          t.link(`link-${i}`, 'p', 's', false),
        ),
      );
      const last = [...links].sort().at(-1)!;
      const lastSource = `link-${links.indexOf(last)}`;

      t.rows.memberships.get(lastSource)!.visible = true;
      await t.runtime.host.adopt(t.Membership, lastSource);
      const scan = vi.spyOn(t.store, 'scan');
      const query = t.objects.Playlist.traverse.songs(p, { limit: 1 });

      expect(scan).not.toHaveBeenCalled();
      const first = await query;

      expect(scan.mock.calls.length).toBeLessThanOrEqual(100);
      expect(first.data).toEqual([]);
      expect(first.meta.exhausted).toBe(false);

      for (const hidden of [...links, s])
        expect(JSON.stringify(first)).not.toContain(hidden);

      const second = await t.objects.Playlist.traverse.songs(p, {
        limit: 1,
        cursor: first.meta.continuationCursor!,
      });

      expect(second.data.map((record) => record.id)).toEqual([s]);
      expect(second.meta).toEqual({ exhausted: true });
    });

    it('binds cursors to principal, direction, selection, root and page size, but permits evidence changes', async () => {
      const t = await setup();
      const p = await t.playlist('p');
      const q = await t.playlist('q');
      const a = await t.song('a');

      await t.song('b');
      await t.link('a', 'p', 'a');
      await t.link('b', 'p', 'b');
      const first = await t.objects.Playlist.traverse.songs(p, {
        limit: 1,
        select: ['title'],
      });
      const cursor = first.meta.continuationCursor!;
      const input = { limit: 1, select: ['title'] as const, cursor };

      expect(
        (
          await t.objects.Playlist.traverse.songs(p, {
            ...input,
            evidence: 'full',
          })
        ).data,
      ).toHaveLength(1);

      for (const operation of [
        t.objects.Playlist.traverse.songs(q, input),
        t.objects.Playlist.traverse.songs(p, { ...input, limit: 2 }),
        t.objects.Playlist.traverse.songs(p, { ...input, select: ['id'] }),
        t.objects.Song.traverse.playlists(a, { limit: 1, cursor }),
        t.runtime
          .as({ ...t.reader, id: 'other' })
          .objects.Playlist.traverse.songs(p, input),
        t.objects.Playlist.traverse.songs(p, { ...input, cursor: 'tampered' }),
      ])
        await expect(Promise.resolve(operation)).rejects.toMatchObject({
          code: 'invalid-request',
        });

      t.advance(900_001);
      await expect(
        Promise.resolve(t.objects.Playlist.traverse.songs(p, input)),
      ).rejects.toMatchObject({ code: 'invalid-request' });
    });

    it('sanitizes scan failures and rejects nonadvancing membership scans', async () => {
      const t = await setup();
      const p = await t.playlist('p');

      await t.song('s');
      await t.link('one', 'p', 's', false);
      await t.link('two', 'p', 's', false);
      vi.spyOn(t.store, 'scan').mockRejectedValueOnce(
        new Error('private storage details'),
      );
      await expect(
        Promise.resolve(t.objects.Playlist.traverse.songs(p)),
      ).rejects.toMatchObject({ code: 'unavailable', message: 'unavailable' });
      vi.restoreAllMocks();
      const scan = t.store.scan.bind(t.store);

      vi.spyOn(t.store, 'scan').mockImplementation((scope, input) =>
        scan(scope, { limit: input.limit }),
      );
      await expect(
        Promise.resolve(t.objects.Playlist.traverse.songs(p)),
      ).rejects.toMatchObject({ code: 'incomplete' });
    });

    it('rechecks authorization after later reads expire earlier evidence', async () => {
      const t = await setup();
      const p = await t.playlist('p');
      const ids = [await t.song('a'), await t.song('b')].sort();

      await t.link('a', 'p', 'a');
      await t.link('b', 'p', 'b');
      const load = t.store.load.bind(t.store);
      let loads = 0;

      vi.spyOn(t.store, 'load').mockImplementation(async (scope, id) => {
        if (id === ids[1] && ++loads === 2) t.advance(10_001);

        return load(scope, id);
      });
      const page = await t.objects.Playlist.traverse.songs(p, {
        select: ['title'],
      });

      expect(page.data.map((r) => r.id)).not.toContain(ids[0]);
    });

    it('enumerates native endpoints through native memberships in both directions', async () => {
      const backing = await open();

      cleanup.push(backing.close);
      const access = defineAccess({
        roles: ['reader'],
        fieldGroups: ['ordinary'],
        claims: {},
      });
      const Playlist = defineObject({
        id: 'native-playlist',
        membership: nativeMembership(),
        properties: {
          id: objectId({ id: 'np.id' }),
          name: native(z.string(), { id: 'np.name' }),
        },
      });
      const Song = defineObject({
        id: 'native-song',
        membership: nativeMembership(),
        properties: {
          id: objectId({ id: 'ns.id' }),
          title: native(z.string(), { id: 'ns.title' }),
        },
      });
      const Membership = defineObject({
        id: 'native-membership',
        membership: nativeMembership(),
        properties: {
          id: objectId({ id: 'nm.id' }),
          playlist: reference(Playlist, { id: 'nm.playlist' }),
          song: reference(Song, { id: 'nm.song' }),
        },
      });
      const relation = defineRelationship({
        id: 'native-songs',
        forward: 'songs',
        reverse: 'playlists',
        through: {
          from: Membership.properties.playlist,
          to: Membership.properties.song,
        },
      });
      const policy = { read: { gate: access.role('reader') } };
      const graph = defineGraph({
        id: 'native-music',
        access,
        objects: { Playlist, Song, Membership },
        relationships: { relation },
        policies: { Playlist: policy, Song: policy, Membership: policy },
      });
      const graphId = randomUUID();
      const { definitionRevision } = compile(graph);
      const scope = { graphId, definitionRevision };

      await backing.store.install(graphId, definitionRevision);
      await backing.store.native!.transaction(scope, async (tx) => {
        await tx.insert({
          objectDefinitionId: Playlist.id,
          objectId: 'p',
          values: { 'np.name': 'Morning' },
          createdAt: 1000,
        });
        await tx.insert({
          objectDefinitionId: Song.id,
          objectId: 's',
          values: { 'ns.title': 'Song' },
          createdAt: 1000,
        });

        for (const id of ['one', 'two'])
          await tx.insert({
            objectDefinitionId: Membership.id,
            objectId: id,
            values: { 'nm.playlist': 'p', 'nm.song': 's' },
            createdAt: 1000,
          });
      });
      const runtime = createRuntime({
        graph,
        graphId,
        store: backing.store,
        connections: [],
      });

      cleanup.push(() => runtime.close());
      const objects = runtime.as({
        id: 'r',
        roles: ['reader'],
        claims: {},
      }).objects;

      expect(
        (
          await objects.Playlist.traverse.songs(
            referenceInput(Playlist).parse('p'),
            { select: ['title'] },
          )
        ).data,
      ).toMatchObject([{ id: 's', data: { title: 'Song' } }]);
      expect(
        (
          await objects.Song.traverse.playlists(
            referenceInput(Song).parse('s'),
            { select: ['name'] },
          )
        ).data,
      ).toMatchObject([{ id: 'p', data: { name: 'Morning' } }]);
    });
  });
}
