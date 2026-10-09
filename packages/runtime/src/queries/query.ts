import { createHash, randomUUID } from 'node:crypto';
import { accepts, canonicalJson } from 'relate/model';
import type { Manifest } from 'relate/model';
import { ReadError } from '@relate/protocol';
import type {
  QueryRequest,
  ReadRequest,
  FullReadResult as ReadResult,
  FullPageResult as PageResult,
  FullObjectRecord as ObjectRecord,
} from '@relate/protocol';
import type {
  ObservationStore,
  StorageScope,
  NativeScope,
  NativeTransaction,
} from '../storage.js';
import { scanBatch } from '../storage.js';
import {
  allowsField,
  allowsObject,
  operationName,
  readableProperties,
} from '../authorization/index.js';
import type { Principal } from '../authorization/index.js';
import {
  cursorCodec,
  invalidValue,
  project,
  requestIssues,
  schemaText,
  throwIssues,
} from '../reads/index.js';

const isPlain = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) &&
  typeof value === 'object' &&
  Object.getPrototypeOf(value) === Object.prototype;

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
    const object = manifest.objects.find((o) => o.id === type);
    const policy = object && manifest.policies[object.id];
    const operation = operationName(manifest, principal, type, 'query');
    const issues = requestIssues(input, 'query');
    const where: Record<string, unknown> =
      input && typeof input === 'object' && isPlain(input.where)
        ? input.where
        : {};

    if (!object)
      issues.push({
        path: [],
        problem: 'invalid-value',
        message: 'unknown object type.',
      });
    // Validate filters before consulting membership, including empty populations.
    // An unreadable type returns an empty page below, with or without filters,
    // so its property names are neither checked nor offered.
    else if (Object.keys(where).length && allowsObject(principal, policy)) {
      // Filterable means discoverable: names outside that set share one answer,
      // so an error never confirms that a hidden field exists.
      const filterable = readableProperties(manifest, principal, object).map(
        ({ property, target }) => ({
          name: property.name,
          schema: property.schema,
          references:
            target?.apiName ??
            (property.origin.kind === 'object-id' ? object.apiName : undefined),
        }),
      );

      for (const [name, value] of Object.entries(where)) {
        const property = filterable.find((p) => p.name === name);

        if (!property)
          issues.push({
            path: ['where', name],
            problem: 'unknown-property',
            message: `not a filterable property of ${object.apiName} for this reader.`,
            accepted: filterable.map((p) => p.name),
          });
        else if (value === undefined)
          issues.push({
            path: ['where', name],
            problem: 'invalid-value',
            message: 'filter value is undefined; omit the filter instead.',
          });
        else if (!accepts(property.schema, value))
          issues.push(
            invalidValue(
              ['where', name],
              schemaText(property.schema, property.references),
              value,
            ),
          );
      }
    }

    if (!object || issues.length) throwIssues(operation, 'query', issues);

    const limit = input.limit ?? 25;

    const request: QueryRequest = structuredClone(
      Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined),
      ),
    );
    // Evidence mode is presentation only, so it stays out of the cursor scope.
    const {
      cursor,
      limit: _limit,
      evidence: _evidence,
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

    // An omitted selection already covers every readable filter field, so it keeps
    // get's unbounded default; only an explicit selection/filter union is capped.
    if (readRequest.select && needed.length > 100)
      throwIssues(operation, 'query', [
        {
          path: ['select'],
          problem: 'invalid-value',
          message: 'select and where together name more than 100 properties.',
        },
      ]);

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
    let after = cursor
      ? codec.decode(cursor, scope, clock(), operation)
      : undefined;

    if (!allowsObject(principal, policy))
      return { data: [], meta: { exhausted: true } };

    await options.install();

    if (!object.sourceDefinitionId && !store.native)
      throw new ReadError('unavailable');

    const usable = (record: ObjectRecord) =>
      filterNames.every((name) => {
        const status = record.meta.fields[name]?.status;

        return status === 'available' || status === 'absent';
      });
    const matches = (record: ObjectRecord) => {
      if (!usable(record)) throw new ReadError('incomplete');

      return filterNames.every(
        (name) =>
          Object.hasOwn(record.data, name) &&
          record.data[name] === filters[name],
      );
    };
    const evidence = (id: string, result: Available, at: number) =>
      project(
        id,
        result,
        needed,
        { ...readRequest, requireComplete: false },
        at,
      );
    const readCandidate = async (id: string) => {
      let allowed = async () => false;
      const result = await options.read(
        principal,
        type,
        id,
        {
          ...readRequest,
          ...(readRequest.select ? { select: needed } : {}),
          requireComplete: false,
        },
        undefined,
        (check) => {
          allowed = check;
        },
        transaction,
      );

      return { result, allowed: () => allowed() };
    };
    const pending: {
      id: string;
      result: Available;
      at: number;
      allowed(): Promise<boolean>;
    }[] = [];
    let scanned = 0;
    let more = true;

    while (more && scanned < 100 && pending.length < limit) {
      const batch = await scanBatch(
        (scan) =>
          object.sourceDefinitionId
            ? store.scan(
                options.scopeFor(type, object.sourceDefinitionId),
                scan,
              )
            : transaction
              ? transaction.scan(type, scan)
              : store.native!.scan(options.scope, type, scan),
        after,
        Math.min(100 - scanned, limit - pending.length),
      );

      more = batch.hasMore;

      if (!batch.ids.length) break;

      after = batch.ids.at(-1);
      scanned += batch.ids.length;

      // Transactions share one connection; independent reads can overlap. Each
      // candidate is evaluated as soon as its read settles, while evidence is fresh.
      const evaluate = async (id: string) => {
        const { result, allowed } = await readCandidate(id);

        if (result.status !== 'ok') return undefined;

        const at = clock();

        return {
          id,
          result,
          at,
          allowed,
          match: matches(evidence(id, result, at)),
        };
      };
      const evaluated: Awaited<ReturnType<typeof evaluate>>[] = [];
      const concurrency = transaction ? 1 : 8;

      for (let i = 0; i < batch.ids.length; i += concurrency)
        evaluated.push(
          ...(await Promise.all(
            batch.ids.slice(i, i + concurrency).map(evaluate),
          )),
        );

      for (const item of evaluated) {
        if (!item) continue;

        onRead?.(item.id, item.result);

        if (item.match) pending.push(item);
      }
    }

    const data: ObjectRecord[] = [];

    for (const item of pending) {
      if (!(await item.allowed())) continue;

      // Time may have advanced while processing other members. Re-evaluate filter
      // evidence under the caller's freshness rules before emitting a match.
      let at = clock();

      if (at !== item.at) {
        let current = evidence(item.id, item.result, at);

        if (!usable(current)) {
          // Evidence expired after matching; refresh this member, not the page.
          const reread = await readCandidate(item.id);

          if (reread.result.status !== 'ok' || !(await reread.allowed()))
            continue;

          onRead?.(item.id, reread.result);
          item.result = reread.result;
          at = clock();
          current = evidence(item.id, item.result, at);
        }

        if (!matches(current)) continue;
      }

      data.push(project(item.id, item.result, selected, readRequest, at));
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
