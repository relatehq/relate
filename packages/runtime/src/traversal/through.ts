import { createHash } from 'node:crypto';
import { canonicalJson } from 'relate/model';
import type { Manifest } from 'relate/model';
import { ReadError } from '@relate/protocol';
import type {
  FullPageResult,
  FullReadResult,
  ReadRequest,
  TraversalRequest,
} from '@relate/protocol';
import { allowsField } from '../authorization/index.js';
import type { Principal } from '../authorization/index.js';
import { compareObjectIds } from '../storage.js';
import { cursorCodec, project } from '../reads/index.js';
import type { TraversalOptions } from './traversal.js';

type Through = Extract<
  NonNullable<Manifest['relationships']>[number],
  { through: unknown }
>;

type Available = Extract<FullReadResult, { status: 'ok' }>;

type Position = {
  afterTarget?: string;
  target?: string;
  targetHasMore?: boolean;
  afterLink?: string;
};

/** Destination-major enumeration gives distinct results across pages without an unbounded seen-ID cursor. */
export function createThroughTraversal(options: TraversalOptions) {
  const { manifest, store, read, clock, scopeFor } = options;
  const codec = cursorCodec(options.cursorKey);
  const empty = (): FullPageResult => ({ data: [], meta: { exhausted: true } });
  const nativeScope = {
    graphId: options.graphId,
    definitionRevision: options.revision,
  };

  async function scan(object: Manifest['objects'][number], after?: string) {
    let batch;

    try {
      const input = { ...(after !== undefined ? { after } : {}), limit: 1 };

      batch = object.sourceDefinitionId
        ? await store.scan(
            scopeFor(object.id, object.sourceDefinitionId),
            input,
          )
        : await store.native!.scan(nativeScope, object.id, input);
    } catch {
      throw new ReadError('unavailable');
    }

    if (batch.objects.length > 1 || (!batch.objects.length && batch.hasMore))
      throw new ReadError('unavailable');

    const candidate = batch.objects[0]?.objectId;

    if (
      candidate !== undefined &&
      (typeof candidate !== 'string' ||
        !candidate ||
        (after !== undefined && compareObjectIds(candidate, after) <= 0))
    )
      throw new ReadError('incomplete');

    return { id: candidate, hasMore: batch.hasMore };
  }

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
    const policy = manifest.policies[owner.id]!;
    const { cursor, limit = 25, evidence: _evidence, ...readRequest } = request;
    const scope = createHash('sha256')
      .update(
        canonicalJson({
          graphId: options.graphId,
          revision: options.revision,
          principal,
          typeId,
          id,
          relationship: relationship.id,
          forward,
          query: { ...readRequest, limit },
          bindings: manifest.objects
            .filter((o) => o.sourceDefinitionId)
            .map((o) => scopeFor(o.id, o.sourceDefinitionId!)),
        }),
      )
      .digest('hex');
    const position: Position = cursor
      ? JSON.parse(codec.decode(cursor, scope, clock()))
      : {};

    if (
      !allowsField(principal, policy, from.access) ||
      !allowsField(principal, policy, to.access)
    )
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
    const pending: { id: string; linkId: string; result: Available }[] = [];
    let scanned = 0;
    let more = true;
    const finishTarget = () => {
      position.afterTarget = position.target!;
      more = position.targetHasMore!;
      delete position.target;
      delete position.targetHasMore;
      delete position.afterLink;
    };

    // The budget includes both destination and membership scans. A cursor can
    // resume inside a destination's membership search, including empty pages.
    while (more && scanned < 100 && pending.length < limit) {
      if (!position.target) {
        const next = await scan(target, position.afterTarget);

        scanned++;

        if (!next.id) {
          more = false;
          break;
        }

        position.target = next.id;
        position.targetHasMore = next.hasMore;

        if (scanned === 100) break;
      }

      const link = await scan(owner, position.afterLink);

      scanned++;

      if (!link.id) {
        finishTarget();
        continue;
      }

      position.afterLink = link.id;
      const member = await read(principal, owner.id, link.id, linkRequest);

      if (
        member.status === 'ok' &&
        member.data[from.name] === id &&
        member.data[to.name] === position.target
      ) {
        const result = await read(principal, target.id, position.target, {
          ...readRequest,
          select: selected,
          requireComplete: false,
        });

        if (result.status === 'ok')
          pending.push({ id: position.target, linkId: link.id, result });

        finishTarget();
      } else if (!link.hasMore) finishTarget();
    }

    const authorized: {
      item: (typeof pending)[number];
      linkAllowed(): Promise<boolean>;
      targetAllowed(): Promise<boolean>;
    }[] = [];

    for (const item of pending) {
      let linkAllowed = async () => false;
      const link = await read(
        principal,
        owner.id,
        item.linkId,
        { ...linkRequest, refresh: false },
        undefined,
        (check) => {
          linkAllowed = check;
        },
      );

      if (
        link.status !== 'ok' ||
        link.data[from.name] !== id ||
        link.data[to.name] !== item.id
      )
        continue;

      let targetAllowed = async () => false;
      const destination = await read(
        principal,
        target.id,
        item.id,
        { ...rootRequest, refresh: false },
        undefined,
        (check) => {
          targetAllowed = check;
        },
      );

      if (destination.status === 'ok')
        authorized.push({ item, linkAllowed, targetAllowed });
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

    for (const { item, linkAllowed, targetAllowed } of authorized) {
      if ((await linkAllowed()) && (await targetAllowed()))
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
            continuationCursor: codec.encode(
              scope,
              JSON.stringify(position),
              clock() + 900_000,
            ),
          }
        : { exhausted: true },
    };
  };
}
