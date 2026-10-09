import type { Manifest } from 'relate/model';
import type {
  FullPageResult,
  FullReadResult,
  ReadRequest,
  TraversalRequest,
} from '@relate/protocol';
import { allowsField } from '../authorization/index.js';
import type { Principal } from '../authorization/index.js';
import { compareObjectIds, scanBatch } from '../storage.js';
import { cursorCodec, project } from '../reads/index.js';
import { traversalScope } from './scope.js';
import { traversalAllowed } from './available.js';
import type { TraversalOptions } from './traversal.js';

type Through = Extract<
  NonNullable<Manifest['relationships']>[number],
  { through: unknown }
>;

type Available = Extract<FullReadResult, { status: 'ok' }>;

/** A destination and one readable junction record connecting it to the root. */
type Candidate = [target: string, link: string];

type Position = {
  /** Destinations up to and including this ID were returned by earlier pages. */
  afterTarget?: string;
  /** Junction scan position inside the current pass. */
  afterLink?: string;
  /** Smallest destinations after `afterTarget` found so far this pass, ascending. */
  candidates?: Candidate[];
  capacity?: number;
};

// Bounds the candidates carried in a mid-pass cursor; pages may be short.
const SERIALIZED_CANDIDATES = 26;

/**
 * Each page is one ordered pass over the junction records. The pass keeps the
 * smallest `limit + 1` distinct destinations connected to the root, so pages
 * stay in destination-ID order without an unbounded seen-ID cursor. A page
 * costs one junction scan, the same as reference traversal over its owner.
 */
export function createThroughTraversal(options: TraversalOptions) {
  const { manifest, store, read, clock, scopeFor } = options;
  const codec = cursorCodec(options.cursorKey);
  const empty = (): FullPageResult => ({ data: [], meta: { exhausted: true } });
  const nativeScope = {
    graphId: options.graphId,
    definitionRevision: options.revision,
  };

  const scanner =
    (object: Manifest['objects'][number]) =>
    (input: { after?: string; limit: number }) =>
      object.sourceDefinitionId
        ? store.scan(scopeFor(object.id, object.sourceDefinitionId), input)
        : store.native!.scan(nativeScope, object.id, input);

  return async (
    principal: Principal,
    typeId: string,
    id: string,
    relationship: Through,
    forward: boolean,
    request: TraversalRequest,
  ): Promise<FullPageResult> => {
    const owner = manifest.objects.find(
      (o) => o.id === relationship.through.objectDefinitionId,
    )!;
    const target = manifest.objects.find(
      (o) =>
        o.id ===
        (forward
          ? relationship.toObjectDefinitionId
          : relationship.fromObjectDefinitionId),
    )!;
    const fromId = forward
      ? relationship.through.fromReferencePropertyDefinitionId
      : relationship.through.toReferencePropertyDefinitionId;
    const toId = forward
      ? relationship.through.toReferencePropertyDefinitionId
      : relationship.through.fromReferencePropertyDefinitionId;
    const from = owner.properties.find((p) => p.id === fromId)!;
    const to = owner.properties.find((p) => p.id === toId)!;
    const { cursor, limit = 25, evidence: _evidence, ...readRequest } = request;
    const scope = traversalScope(options, {
      principal,
      typeId,
      id,
      relationship: relationship.id,
      forward,
      query: { ...readRequest, limit },
    });
    const position: Position = cursor
      ? JSON.parse(codec.decode(cursor, scope, clock()))
      : {};
    const encode = (next: Position) =>
      codec.encode(scope, JSON.stringify(next), clock() + 900_000);

    if (!traversalAllowed(manifest, principal, { relationship, forward }))
      return empty();

    const rootRequest: ReadRequest = {
      ...readRequest,
      select: [],
      requireComplete: false,
    };

    if ((await read(principal, typeId, id, rootRequest)).status !== 'ok')
      return empty();

    const linkRequest: ReadRequest = {
      ...readRequest,
      select: [from.name, to.name],
      requireComplete: false,
    };
    const { afterTarget } = position;
    const candidates = position.candidates ?? [];
    let capacity = position.capacity ?? limit + 1;
    let afterLink = position.afterLink;

    // A hidden or deleted destination makes the reference unavailable, the
    // same as a link to another root; neither is a membership of this root.
    function keep(link: string, member: FullReadResult) {
      const destination = member.status === 'ok' && member.data[to.name];

      if (
        member.status !== 'ok' ||
        member.data[from.name] !== id ||
        typeof destination !== 'string' ||
        (afterTarget !== undefined &&
          compareObjectIds(destination, afterTarget) <= 0)
      )
        return;

      const at = candidates.findIndex(
        ([t]) => compareObjectIds(t, destination) >= 0,
      );

      if (at < 0) {
        if (candidates.length < capacity) candidates.push([destination, link]);
      } else if (candidates[at]![0] !== destination) {
        candidates.splice(at, 0, [destination, link]);
        candidates.length = Math.min(candidates.length, capacity);
      }
    }

    let scanned = 0;
    let passing = true;

    while (passing && scanned < 100) {
      const batch = await scanBatch(scanner(owner), afterLink, 100 - scanned);

      scanned += batch.ids.length;
      passing = batch.hasMore;

      for (let i = 0; i < batch.ids.length; i += 8) {
        const links = batch.ids.slice(i, i + 8);
        const members = await Promise.all(
          links.map((link) => read(principal, owner.id, link, linkRequest)),
        );

        links.forEach((link, j) => keep(link, members[j]!));
      }

      afterLink = batch.ids.at(-1) ?? afterLink;
    }

    if (passing) {
      // The pass resumes on the next page. Dropping the largest candidates is
      // safe: a later pass finds them again.
      capacity = Math.min(capacity, SERIALIZED_CANDIDATES);
      candidates.length = Math.min(candidates.length, capacity);

      return {
        data: [],
        meta: {
          exhausted: false,
          continuationCursor: encode({
            ...(afterTarget !== undefined ? { afterTarget } : {}),
            afterLink: afterLink!,
            candidates,
            capacity,
          }),
        },
      };
    }

    // A full set holds one destination beyond this page, proving another exists.
    const more = candidates.length === capacity;
    const page = more ? candidates.slice(0, -1) : candidates;
    const selected = [
      ...new Set(
        request.select ??
          target.properties
            .filter((p) =>
              allowsField(principal, manifest.policies[target.id]!, p.access),
            )
            .map((p) => p.name),
      ),
    ];
    const authorized: {
      id: string;
      result: Available;
      linkAllowed(): Promise<boolean>;
      targetAllowed(): Promise<boolean>;
    }[] = [];

    for (const [destination, linkId] of page) {
      const result = await read(principal, target.id, destination, {
        ...readRequest,
        select: selected,
        requireComplete: false,
      });

      if (result.status !== 'ok') continue;

      let linkAllowed = async () => false;
      const link = await read(
        principal,
        owner.id,
        linkId,
        { ...linkRequest, refresh: false },
        undefined,
        (check) => {
          linkAllowed = check;
        },
      );

      if (
        link.status !== 'ok' ||
        link.data[from.name] !== id ||
        link.data[to.name] !== destination
      )
        continue;

      // Recheck the destination after link validation may have refreshed private evidence.
      let targetAllowed = async () => false;
      const final = await read(
        principal,
        target.id,
        destination,
        { ...rootRequest, refresh: false },
        undefined,
        (check) => {
          targetAllowed = check;
        },
      );

      if (final.status === 'ok')
        authorized.push({
          id: destination,
          result,
          linkAllowed,
          targetAllowed,
        });
    }

    let rootAllowed = async () => false;
    const finalRoot = await read(
      principal,
      typeId,
      id,
      { ...rootRequest, refresh: false },
      undefined,
      (check) => {
        rootAllowed = check;
      },
    );

    if (finalRoot.status !== 'ok') return empty();

    const data: Array<FullPageResult['data'][number]> = [];

    for (const item of authorized) {
      if ((await item.linkAllowed()) && (await item.targetAllowed()))
        data.push(
          project(item.id, item.result, selected, readRequest, clock()),
        );
    }

    if (!(await rootAllowed())) return empty();

    return {
      data,
      meta: more
        ? {
            exhausted: false,
            continuationCursor: encode({ afterTarget: page.at(-1)![0] }),
          }
        : { exhausted: true },
    };
  };
}
