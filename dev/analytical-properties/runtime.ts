import { invalid, SpikeError } from './contracts.js';
import type {
  Association,
  Backend,
  Candidate,
  Expression,
  ResolvedExpression,
  Scalar,
  SqlQuery,
} from './contracts.js';
import { resolveExpression } from './resolve.js';
import { resultValue, inputValue } from './values.js';
import { StatementQueue } from './queue.js';

export interface ComputedRecord {
  id: string;
  data: Record<string, Scalar>;
  fields: Record<
    string,
    | { status: 'available'; freshness: 'unverified'; readAt: string }
    | { status: 'forbidden' | 'unavailable'; reason?: string }
  >;
}

export interface ComputeRequest {
  compute: Record<string, Expression>;
  where?: Record<string, { eq?: Scalar; gt?: Scalar }>;
  orderBy?: { field: string; direction: 'asc' | 'desc' }[];
  limit?: number;
  /** Internal continuation value only; production must wrap in the existing encrypted cursor codec. */
  after?: { id: string; values: Scalar[] };
  requireComplete?: boolean;
}

/** Runtime seam: candidates have ALREADY passed object policy/property filters.
 * Production must obtain and revalidate these through the existing read path. */
export function createAnalyticalSpike(
  backend: Backend,
  association: Association | undefined,
  parse: (sql: string) => Promise<SqlQuery>,
  options: {
    scopeLimit?: number;
    batchSize?: number;
    statementMs?: number;
    queue?: StatementQueue;
  } = {},
) {
  const queue = options.queue ?? new StatementQueue();

  return async (
    candidates: Candidate[],
    request: ComputeRequest,
    signal = new AbortController().signal,
  ) => {
    const entries = Object.entries(request.compute);

    if (!entries.length || entries.length > 8) invalid('expression-limit');

    const expressions: Record<string, ResolvedExpression> = Object.create(null);

    for (const [alias, expression] of entries) {
      if (
        ['__proto__', 'prototype', 'constructor'].includes(alias) ||
        !/^[A-Za-z_][A-Za-z_0-9]*$/.test(alias) ||
        (association && Object.hasOwn(association.properties, alias))
      )
        invalid('alias');

      const query = await parse(expression.sql);

      if (!association) invalid('unknown-property');

      expressions[alias] = resolveExpression(query, expression, association);
    }

    const order = request.orderBy ?? [];
    const required = new Set([
      ...Object.keys(request.where ?? {}),
      ...order.map((o) => o.field),
    ]);

    for (const alias of required)
      if (!Object.hasOwn(expressions, alias)) invalid('unknown-property');

    for (const item of order)
      if (!['asc', 'desc'].includes(item.direction)) invalid('order');

    for (const [alias, filter] of Object.entries(request.where ?? {})) {
      if (Object.keys(filter).some((key) => !['eq', 'gt'].includes(key)))
        invalid('filter');

      for (const value of Object.values(filter))
        inputValue(value, expressions[alias]!.type);
    }

    const limit = request.limit ?? 25;

    if (!Number.isInteger(limit) || limit < 1) invalid('limit');

    const scope = required.size > 0;

    if (scope && candidates.length > (options.scopeLimit ?? 10_000))
      invalid('not-supported: narrow the property filter');

    // In a real query, the normal path pages membership before this seam.
    const selected = scope ? candidates : candidates.slice(0, limit);
    const records = selected.map((c): ComputedRecord => ({
      id: c.id,
      data: {},
      fields: {},
    }));
    const batchSize = options.batchSize ?? 1000;

    if (!Number.isInteger(batchSize) || batchSize < 1) invalid('batch-size');

    for (let offset = 0; offset < selected.length; offset += batchSize) {
      // Exceptional missing dependencies partition the otherwise single batch.
      // Do not let an unavailable self property suppress unrelated aliases.
      const groups = new Map<string, { aliases: string[]; slots: number[] }>();

      for (
        let slot = offset;
        slot < Math.min(offset + batchSize, selected.length);
        slot++
      ) {
        const aliases: string[] = [];

        for (const [alias, expression] of Object.entries(expressions)) {
          if (expression.forbidden)
            records[slot]!.fields[alias] = { status: 'forbidden' };
          else if (
            expression.dependencies.some(
              (name) =>
                !association!.properties[name]!.readable ||
                selected[slot]!.properties[name] == null,
            )
          )
            records[slot]!.fields[alias] = {
              status: 'unavailable',
              reason: 'correlation-unavailable',
            };
          else aliases.push(alias);
        }

        if (aliases.length) {
          const key = JSON.stringify(aliases);
          const group = groups.get(key) ?? { aliases, slots: [] };

          group.slots.push(slot);
          groups.set(key, group);
        }
      }

      for (const { aliases, slots } of groups.values()) {
        const resolved = aliases.map((alias) => expressions[alias]!);
        const statement = backend.plan(
          association!,
          slots.map((slot) => selected[slot]!),
          resolved,
        );
        const readAt = new Date().toISOString();

        try {
          const rows = await queue.run(signal, () =>
            backend.execute(statement, {
              signal,
              timeoutMs: options.statementMs ?? 5000,
            }),
          );

          if (
            rows.length !== slots.length ||
            rows.some((row, index) => Number(row.slot) !== index)
          )
            throw new SpikeError('invalid-result', 'slots');

          for (let a = 0; a < aliases.length; a++) {
            const alias = aliases[a]!;

            try {
              // Validate the whole alias before publishing any of its values.
              const values = rows.map((row) =>
                resultValue(row[`v${a}`], resolved[a]!),
              );

              slots.forEach((slot, index) => {
                records[slot]!.data[alias] = values[index]!;
                records[slot]!.fields[alias] = {
                  status: 'available',
                  freshness: 'unverified',
                  readAt,
                };
              });
            } catch {
              slots.forEach((slot) => {
                records[slot]!.fields[alias] = {
                  status: 'unavailable',
                  reason: 'invalid-result',
                };
              });
            }
          }
        } catch (error) {
          if (signal.aborted) throw signal.reason;

          const reason =
            error instanceof SpikeError &&
            ['busy', 'invalid-result'].includes(error.code)
              ? error.code
              : 'execution-failed';

          for (const slot of slots)
            for (const alias of aliases)
              records[slot]!.fields[alias] = { status: 'unavailable', reason };
        }
      }
    }

    signal.throwIfAborted();

    // A backend/encoding failure invalidates that alias across the returned scope,
    // including successful earlier batches. Dependency failures remain per object.
    for (const alias of Object.keys(expressions)) {
      const failure = records
        .map((record) => record.fields[alias])
        .find(
          (field) =>
            field?.status === 'unavailable' &&
            field.reason !== 'correlation-unavailable',
        );

      if (failure)
        for (const record of records) {
          if (record.fields[alias]?.status === 'available') {
            delete record.data[alias];
            record.fields[alias] = failure;
          }
        }
    }

    for (const record of records)
      for (const [alias, field] of Object.entries(record.fields))
        if (
          field.status !== 'available' &&
          (request.requireComplete || required.has(alias))
        )
          throw new SpikeError(
            'incomplete',
            `${alias}:${field.status === 'forbidden' ? 'forbidden' : field.reason}`,
          );

    function compare(a: Scalar, b: Scalar, alias: string): number {
      const type = expressions[alias]!.type;
      const left = type === 'int64' ? BigInt(a as string) : a!;
      const right = type === 'int64' ? BigInt(b as string) : b!;

      return left < right ? -1 : left > right ? 1 : 0;
    }

    function position(
      a: { id: string; values: Scalar[] },
      b: { id: string; values: Scalar[] },
    ): number {
      for (let i = 0; i < order.length; i++) {
        const x = a.values[i]!,
          y = b.values[i]!;

        if (x === null || y === null) {
          if (x !== y) return x === null ? 1 : -1;

          continue;
        }

        const result =
          compare(x, y, order[i]!.field) *
          (order[i]!.direction === 'asc' ? 1 : -1);

        if (result) return result;
      }

      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }

    const boundary = (record: ComputedRecord) => ({
      id: record.id,
      values: order.map((o) => record.data[o.field]!),
    });
    let matching = records.filter((record) =>
      Object.entries(request.where ?? {}).every(([alias, filter]) => {
        const actual = record.data[alias];

        return (
          actual != null &&
          Object.entries(filter).every(([op, value]) => {
            const comparison = compare(
              actual,
              inputValue(value, expressions[alias]!.type),
              alias,
            );

            return op === 'eq' ? comparison === 0 : comparison > 0;
          })
        );
      }),
    );

    if (scope) matching.sort((a, b) => position(boundary(a), boundary(b)));

    if (request.after)
      matching = matching.filter(
        (r) => position(boundary(r), request.after!) > 0,
      );

    const data = matching.slice(0, limit);

    return {
      data,
      computed: Object.fromEntries(
        Object.entries(expressions).map(([alias, e]) => [
          alias,
          { type: e.type, nullable: e.nullable },
        ]),
      ),
      after: matching.length > limit ? boundary(data.at(-1)!) : undefined,
    };
  };
}
