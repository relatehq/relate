import { createHash, randomUUID } from 'node:crypto';
import { accepts, canonicalJson } from 'relate/model';
import type { Manifest } from 'relate/model';
import { ReadError } from '@relate/protocol';
import type {
  QueryRequest,
  ReadRequest,
  ReadResult,
  PageResult,
  ObjectRecord,
} from '@relate/protocol';
import type {
  ObservationStore,
  StorageScope,
  NativeScope,
  NativeTransaction,
} from '../storage.js';
import { allowsField } from '../authorization/index.js';
import type { Principal } from '../authorization/index.js';
import { validateReadRequest, project, cursorCodec } from '../reads/index.js';

type Available = Extract<ReadResult, { status: 'ok' }>;

/** Enumerate graph membership through the same authorized read path as get. */
export function createGraphQuery(options: {
  manifest: Manifest;
  scope: NativeScope;
  store: ObservationStore;
  clock(): number;
  install(): Promise<void>;
  cursorKey?: Uint8Array;
  scopeFor(type: string, source: string): StorageScope;
  read(
    principal: Principal,
    type: string,
    id: string,
    request: ReadRequest,
    requiredReference?: string,
    capture?: (check: () => Promise<boolean>) => void,
    transaction?: NativeTransaction,
  ): Promise<ReadResult>;
}) {
  const { manifest, store, clock } = options;
  const codec = cursorCodec(options.cursorKey);
  const transactions = new WeakMap<NativeTransaction, string>();

  return async (
    principal: Principal,
    type: string,
    input: QueryRequest = {},
    transaction?: NativeTransaction,
    onRead?: (id: string, result: Available) => void,
  ): Promise<PageResult> => {
    validateReadRequest(input);
    const object = manifest.objects.find((o) => o.id === type);
    const policy = object && manifest.policies[object.id];
    const limit = input.limit ?? 25;
    const where = input.where ?? {};

    if (
      !object ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (input.cursor !== undefined &&
        (typeof input.cursor !== 'string' || !input.cursor)) ||
      (input.where !== undefined &&
        (!input.where ||
          typeof input.where !== 'object' ||
          Array.isArray(input.where) ||
          Object.getPrototypeOf(input.where) !== Object.prototype)) ||
      Object.keys(input).some(
        (key) =>
          ![
            'select',
            'maxAgeMs',
            'refresh',
            'stale',
            'requireComplete',
            'timeoutMs',
            'limit',
            'cursor',
            'where',
          ].includes(key),
      )
    )
      throw new ReadError('invalid-request');

    // Validate filters before consulting membership, including empty populations.
    for (const [name, value] of Object.entries(where)) {
      const property = object.properties.find((p) => p.name === name);

      if (
        !property ||
        !policy ||
        !allowsField(principal, policy, property.access) ||
        value === undefined ||
        !accepts(property.schema, value)
      )
        throw new ReadError('invalid-request');
    }

    const request: QueryRequest = structuredClone(
      Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined),
      ),
    );
    const {
      cursor,
      limit: _limit,
      where: filters = {},
      ...readRequest
    } = request;
    const filterNames = Object.keys(filters);
    const selected = [
      ...new Set(
        readRequest.select ??
          object.properties
            .filter((p) => policy && allowsField(principal, policy, p.access))
            .map((p) => p.name),
      ),
    ];
    const needed = [...new Set([...selected, ...filterNames])];

    if (needed.length > 100) throw new ReadError('invalid-request');

    if (transaction && !transactions.has(transaction))
      transactions.set(transaction, randomUUID());

    const scope = createHash('sha256')
      .update(
        canonicalJson({
          ...options.scope,
          type,
          principal,
          transaction: transaction ? transactions.get(transaction)! : null,
          query: { ...readRequest, where: filters, limit },
          bindings: manifest.objects
            .filter((o) => o.sourceDefinitionId)
            .map((o) => options.scopeFor(o.id, o.sourceDefinitionId!)),
        }),
      )
      .digest('hex');
    let after = cursor ? codec.decode(cursor, scope, clock()) : undefined;

    if (!policy || !principal.roles.includes(policy.read.role))
      return { data: [], meta: { exhausted: true } };

    await options.install();

    if (!object.sourceDefinitionId && !store.native)
      throw new ReadError('unavailable');

    const matches = (record: ObjectRecord) => {
      for (const name of filterNames) {
        const status = record.meta.fields[name]?.status;

        if (status !== 'available' && status !== 'absent')
          throw new ReadError('incomplete');
      }

      return filterNames.every(
        (name) =>
          Object.hasOwn(record.data, name) &&
          record.data[name] === filters[name],
      );
    };
    const pending: {
      id: string;
      result: Available;
      allowed(): Promise<boolean>;
    }[] = [];
    let scanned = 0;
    let more = true;

    while (more && scanned < 100 && pending.length < limit) {
      const batchLimit = Math.min(100 - scanned, limit - pending.length);
      let batch;

      try {
        const scan = {
          ...(after !== undefined ? { after } : {}),
          limit: batchLimit,
        };

        batch = object.sourceDefinitionId
          ? await store.scan(
              options.scopeFor(type, object.sourceDefinitionId),
              scan,
            )
          : transaction
            ? await transaction.scan(type, scan)
            : await store.native?.scan(options.scope, type, scan);
      } catch {
        throw new ReadError('unavailable');
      }

      if (
        !batch ||
        typeof batch.hasMore !== 'boolean' ||
        batch.objects.length > batchLimit
      )
        throw new ReadError('incomplete');

      more = batch.hasMore;

      if (!batch.objects.length) {
        if (more) throw new ReadError('incomplete');

        break;
      }

      for (const candidate of batch.objects) {
        if (
          typeof candidate.objectId !== 'string' ||
          !candidate.objectId ||
          (after !== undefined && candidate.objectId <= after)
        )
          throw new ReadError('incomplete');

        after = candidate.objectId;
        scanned++;
        let allowed = async () => false;
        const result = await options.read(
          principal,
          type,
          candidate.objectId,
          { ...readRequest, select: needed, requireComplete: false },
          undefined,
          (check) => {
            allowed = check;
          },
          transaction,
        );

        if (result.status !== 'ok') continue;

        onRead?.(candidate.objectId, result);

        if (
          matches(
            project(
              candidate.objectId,
              result,
              needed,
              { ...readRequest, requireComplete: false },
              clock(),
            ),
          )
        )
          pending.push({ id: candidate.objectId, result, allowed });
      }
    }

    const data: ObjectRecord[] = [];

    for (const item of pending) {
      if (!(await item.allowed())) continue;

      // Time may have advanced while processing other members. Re-evaluate filter
      // evidence under the caller's freshness rules before emitting a match.
      if (
        !matches(
          project(
            item.id,
            item.result,
            needed,
            { ...readRequest, requireComplete: false },
            clock(),
          ),
        )
      )
        continue;

      data.push(project(item.id, item.result, selected, readRequest, clock()));
    }

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
