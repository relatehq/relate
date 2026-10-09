import type { Manifest } from 'relate/model';
import { ReadError } from '@relate/protocol';
import type {
  ReadRequest,
  FullReadResult as ReadResult,
  TraversalRequest,
  FullObjectRecord as ObjectRecord,
  FullObjectResult as ObjectResult,
  FullPageResult as PageResult,
} from '@relate/protocol';
import type { ObservationStore, StorageScope } from '../storage.js';
import { scanBatch } from '../storage.js';
import { allowsField } from '../authorization/index.js';
import type { Principal } from '../authorization/index.js';
import {
  cursorCodec,
  invalidValue,
  objectName,
  operationName,
  project,
  requestIssues,
  throwIssues,
} from '../reads/index.js';
import { traversalScope } from './scope.js';

import { createThroughTraversal } from './through.js';
import {
  availableTraversals,
  traversalAllowed,
  traversalsFrom,
  traversalSupported,
} from './available.js';

type Available = Extract<ReadResult, { status: 'ok' }>;

/** Reference-backed traversal composes the same authorized read path in both directions. */
export interface TraversalOptions {
  manifest: Manifest;
  graphId: string;
  revision: string;
  store: ObservationStore;
  clock(): number;
  cursorKey?: Uint8Array;
  scopeFor(objectId: string, sourceId: string): StorageScope;
  read(
    principal: Principal,
    typeId: string,
    id: string,
    request?: ReadRequest,
    requiredReference?: string,
    captureAuthorization?: (check: () => Promise<boolean>) => void,
  ): Promise<ReadResult>;
}

export function createTraversal(options: TraversalOptions) {
  const through = createThroughTraversal(options);
  const { manifest, store, read, clock, scopeFor } = options;
  const codec = cursorCodec(options.cursorKey);
  const empty = (): PageResult => ({ data: [], meta: { exhausted: true } });

  return async (
    principal: Principal,
    typeId: string,
    id: string,
    name: string,
    input: TraversalRequest = {},
  ): Promise<PageResult | ObjectResult> => {
    const operation = operationName(manifest, typeId, `traverse.${name}`);
    const match = traversalsFrom(manifest, typeId).find(
      ({ relationship: r, forward }) =>
        (forward ? r.forward : r.reverse).name === name,
    );
    const cardinality = match
      ? (match.forward
          ? match.relationship.forward
          : match.relationship.reverse
        ).cardinality
      : 'many';
    const kind = cardinality === 'one' ? 'traverse-one' : 'traverse-many';
    const issues = requestIssues(input, kind);

    if (typeof id !== 'string' || !id.trim())
      issues.unshift(
        invalidValue(
          ['id'],
          `a nonblank ${objectName(manifest, typeId)} object ID string`,
          id,
        ),
      );

    // Unsupported and unauthorized traversals share one answer; the accepted
    // names are exactly the traversals this reader can discover.
    if (!match || !traversalSupported(manifest, match.relationship))
      issues.unshift({
        path: [],
        problem: 'unknown-traversal',
        message: `"${name}" is not an available traversal from this object.`,
        accepted: availableTraversals(manifest, principal, typeId).map(
          (t) => t.traversal.name,
        ),
      });

    if (!match || issues.length) throwIssues(operation, kind, issues);

    const request: TraversalRequest = structuredClone(
      Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined),
      ),
    );
    const { relationship, forward } = match;
    const limit = request.limit ?? 25;

    if ('through' in relationship)
      return through(
        principal,
        typeId,
        id,
        relationship,
        forward,
        request,
        operation,
      );

    const targetType = forward
      ? relationship.toObjectDefinitionId
      : relationship.fromObjectDefinitionId;
    const owner = manifest.objects.find(
      (o) => o.id === relationship.toObjectDefinitionId,
    )!;
    const via = owner.properties.find(
      (p) => p.id === relationship.referencePropertyDefinitionId,
    )!;

    const ownerPolicy = manifest.policies[owner.id];
    // Evidence mode is presentation only, so it stays out of the cursor scope.
    const {
      cursor,
      limit: _limit,
      evidence: _evidence,
      ...readRequest
    } = request;
    const scope = traversalScope(options, {
      principal,
      typeId,
      id,
      relationship: relationship.id,
      forward,
      query: { ...readRequest, limit },
    });
    let after = cursor
      ? codec.decode(cursor, scope, clock(), operation)
      : undefined;
    const unavailable = () =>
      forward ? empty() : { status: 'not-found' as const };

    if (!ownerPolicy || !traversalAllowed(manifest, principal, match))
      return unavailable();

    const root = await read(principal, typeId, id, {
      ...readRequest,
      select: [],
      requireComplete: false,
    });

    if (root.status !== 'ok') return unavailable();

    const linkRequest = (refresh = request.refresh): ReadRequest => ({
      ...readRequest,
      select: [via.name],
      requireComplete: false,
      ...(refresh !== undefined ? { refresh } : {}),
    });

    if (!forward) {
      const link = await read(principal, owner.id, id, linkRequest());
      const targetId = link.status === 'ok' ? link.data[via.name] : undefined;

      if (typeof targetId !== 'string') return { status: 'not-found' };

      const target = await read(principal, targetType, targetId, readRequest);

      if (target.status !== 'ok') return target;

      let linkAllowed = async () => false;
      const finalLink = await read(
        principal,
        owner.id,
        id,
        linkRequest(false),
        undefined,
        (check) => {
          linkAllowed = check;
        },
      );

      if (finalLink.status !== 'ok' || finalLink.data[via.name] !== targetId)
        return { status: 'not-found' };

      // Recheck the destination after link validation may have refreshed private evidence.
      let targetAllowed = async () => false;
      const finalTarget = await read(
        principal,
        targetType,
        targetId,
        {
          ...readRequest,
          select: [],
          requireComplete: false,
          refresh: false,
        },
        undefined,
        (check) => {
          targetAllowed = check;
        },
      );

      if (!(await linkAllowed()) || !(await targetAllowed()))
        return { status: 'not-found' };

      return finalTarget.status === 'ok'
        ? {
            status: 'ok',
            ...project(
              targetId,
              target,
              Object.keys(target.meta.fields),
              readRequest,
              clock(),
            ),
          }
        : finalTarget;
    }

    const selected = [
      ...new Set(
        request.select ??
          owner.properties
            .filter((p) => allowsField(principal, ownerPolicy, p.access))
            .map((p) => p.name),
      ),
    ];

    // The engine includes the membership field privately after validating the
    // public selection. Projection removes it unless the caller requested it.
    async function member(objectId: string): Promise<Available | undefined> {
      const target = await read(
        principal,
        targetType,
        objectId,
        { ...readRequest, select: selected, requireComplete: false },
        via.name,
      );

      if (target.status !== 'ok') return undefined;

      if (typeof target.data[via.name] !== 'string')
        throw new ReadError('incomplete');

      if (target.data[via.name] !== id) return undefined;

      return target;
    }

    const pending: { id: string; result: Available }[] = [];
    let scanned = 0;
    let more = true;

    while (more && scanned < 100 && pending.length < limit) {
      const batch = await scanBatch(
        (input) =>
          store.scan(scopeFor(owner.id, owner.sourceDefinitionId!), input),
        after,
        Math.min(100 - scanned, limit - pending.length),
      );

      more = batch.hasMore;

      for (const candidate of batch.ids) {
        after = candidate;
        scanned++;
        const result = await member(candidate);

        if (result) pending.push({ id: candidate, result });
      }

      if (!batch.ids.length) break;
    }

    const authorized: ((typeof pending)[number] & {
      allowed(): Promise<boolean>;
    })[] = [];

    for (const item of pending) {
      let allowed = async () => false;
      const finalLink = await read(
        principal,
        owner.id,
        item.id,
        linkRequest(false),
        undefined,
        (check) => {
          allowed = check;
        },
      );

      if (finalLink.status !== 'ok') continue;

      if (typeof finalLink.data[via.name] !== 'string')
        throw new ReadError('incomplete');

      if (finalLink.data[via.name] === id)
        authorized.push({ ...item, allowed });
    }

    let rootAllowed = async () => false;
    const finalRoot = await read(
      principal,
      typeId,
      id,
      {
        ...readRequest,
        select: [],
        requireComplete: false,
        refresh: false,
      },
      undefined,
      (check) => {
        rootAllowed = check;
      },
    );

    if (finalRoot.status !== 'ok') return empty();

    const data: ObjectRecord[] = [];

    for (const item of authorized) {
      if (await item.allowed())
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
            continuationCursor: codec.encode(scope, after!, clock() + 900_000),
          }
        : { exhausted: true },
    };
  };
}
