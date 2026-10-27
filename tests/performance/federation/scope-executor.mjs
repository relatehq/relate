import { AsyncLocalStorage } from 'node:async_hooks';
import {
  initializeRows,
  planBatches,
} from '../../../packages/runtime/dist/analytics/batch.js';
import { preparedFields } from '../../../packages/runtime/dist/analytics/prepare-compute.js';
import {
  mergeBatch,
  finishScope,
} from '../../../packages/runtime/dist/analytics/merge.js';
import { quoteSqlIdentifier, encodeAnalyticalValue } from 'relate/analytics';
import { utcTimestamp } from './queries.mjs';

const execution = new AsyncLocalStorage();

export const withScopeExecutor = (options, run) =>
  execution.run(options, async () => await run());

const quote = quoteSqlIdentifier;

function literal(value) {
  const encoded = encodeAnalyticalValue(value.value, {
    ...value,
    nullable: true,
  });

  if (encoded === null) return 'NULL';

  const text =
    typeof encoded === 'boolean'
      ? String(encoded)
      : `'${String(encoded).replaceAll("'", "''")}'`;
  const type = {
    string: 'VARCHAR',
    int64: 'BIGINT',
    int32: 'INT',
    boolean: 'BOOLEAN',
    timestamp: 'TIMESTAMP',
  }[value.type];

  if (!type) throw new Error(`Unsupported scope literal ${value.type}`);

  return `CAST(${text} AS ${type})`;
}

// Compile semantics, not execution placement: source-only aggregates become
// relational subqueries; the DataFusion federation optimizer places each one.
export function scopePlan(batches, candidates, sources) {
  const scopes = [],
    projections = ['a.row_index'],
    joins = [];

  for (const [index, batch] of batches.entries()) {
    const source = sources.get(batch.query.resource);

    if (!source) throw new Error('Unregistered federation resource');

    if (batch.query.keys.some((key) => key.type.type !== 'string'))
      throw new Error('Scope spike supports string correlation keys only');

    const operand = (value) => {
      if (value.kind === 'value') return literal(value.value);

      if (value.kind === 'key')
        throw new Error(
          'Per-object predicates require a different plan; unsupported in this spike',
        );

      const column = source.columns[value.column];

      if (!column) throw new Error('Unknown scope column');

      return `d.${quote(column)}`;
    };
    const predicate = (p) => {
      if (!p) return 'true';

      if (p.kind === 'compare')
        return `(${operand(p.left)} ${p.op} ${operand(p.right)})`;

      if (p.kind === 'null')
        return `(${operand(p.value)} IS ${p.not ? 'NOT ' : ''}NULL)`;

      if (p.op === 'not') return `(NOT ${predicate(p.args[0])})`;

      return `(${p.args.map(predicate).join(p.op === 'and' ? ' AND ' : ' OR ')})`;
    };

    scopes.push({
      keyCount: batch.query.keys.length,
      maskCount: batch.fields.length,
      rows: batch.query.slots.map((slot, i) => ({
        rowIndex: batch.rowIndexes[i],
        values: slot.values.map((v) => v.value),
        valid: slot.valid,
      })),
    });
    // COUNT and MAX with identical predicates share one scan/aggregate.
    const groups = new Map();

    for (const [column, aggregate] of batch.query.aggregates.entries()) {
      if (!['count', 'max', 'sum'].includes(aggregate.aggregate))
        throw new Error(`Unsupported scope aggregate ${aggregate.aggregate}`);

      const filter = predicate(aggregate.predicate);
      const group = groups.get(filter) ?? [];

      group.push({ column, aggregate });
      groups.set(filter, group);
    }

    const correlation = batch.query.correlation.map((pair, i) => ({
      source: `d.${quote(source.columns[pair.column])}`,
      alias: `c${i}`,
      key: pair.key,
    }));

    joins.push(
      `LEFT JOIN scope_${index} s${index} ON s${index}.row_index = a.row_index`,
    );

    for (const [groupIndex, [filter, aggregates]] of [
      ...groups.entries(),
    ].entries()) {
      const alias = `g${index}_${groupIndex}`;
      const expressions = aggregates.map(
        ({ column, aggregate }) =>
          `${aggregate.aggregate.toUpperCase()}(${aggregate.distinct ? 'DISTINCT ' : ''}${aggregate.argument === '*' ? '*' : operand(aggregate.argument)}) AS v${column}`,
      );

      joins.push(
        `LEFT JOIN (SELECT ${correlation.map((p) => `${p.source} AS ${p.alias}`).join(', ')}, ${expressions.join(', ')} FROM ${quote(source.table)} d WHERE ${filter} GROUP BY ${correlation.map((p) => p.source).join(', ')}) ${alias} ON ${correlation.map((p) => `${alias}.${p.alias} = s${index}.k${p.key}`).join(' AND ')}`,
      );

      for (const { column, aggregate } of aggregates) {
        let value = `${alias}.v${column}`;

        if (aggregate.aggregate === 'count') value = `COALESCE(${value}, 0)`;
        else if (aggregate.fallback)
          value = `COALESCE(${value}, ${literal(aggregate.fallback)})`;

        if (aggregate.result.type === 'int64')
          value = `CAST(${value} AS VARCHAR)`;

        projections.push(
          `CASE WHEN s${index}.m${column} THEN ${value} ELSE NULL END AS b${index}_v${column}`,
        );
      }
    }
  }

  return {
    candidateIds: candidates.map((c) => c.id),
    scopes,
    sql: `SELECT ${projections.join(', ')} FROM authorized a ${joins.join('\n')} ORDER BY a.row_index`,
  };
}

export async function computeScope(original, input) {
  const options = execution.getStore();

  if (!options) return original(input);

  const start = performance.now();

  input.signal.throwIfAborted();
  const fields = preparedFields(input.prepared);
  const rows = initializeRows(fields, input.candidates);
  // Reuse runtime masking/correlation logic, with an Arrow input capacity rather
  // than a SQL placeholder limit. No chunking or connector execution occurs.
  const batches = planBatches({
    fields,
    rows,
    maxSlots: Math.max(1, rows.length),
    binding(id) {
      const binding = input.binding(id);

      return {
        ...binding,
        connector: {
          ...binding.connector,
          limits: { maxParameters: Number.MAX_SAFE_INTEGER },
          parameterBudget: () => ({ fixed: 0, perSlot: 1 }),
        },
      };
    },
  });

  if (!batches.length)
    return finishScope(fields, rows, input.requireComplete ?? false);

  const request = scopePlan(batches, input.candidates, options.sources);
  const prepareMs = performance.now() - start;
  const readAt = new Date().toISOString();
  const call = performance.now();
  const result = await options.transport.query({
    ...request,
    mode: options.mode ?? 'federated',
    timeoutMs: input.statementTimeoutMs,
    explain: options.explain ?? false,
  });
  const engineMs = performance.now() - call;

  input.signal.throwIfAborted();

  if (
    result.rows.length !== rows.length ||
    result.rows.some((row, index) => row.row_index !== index)
  )
    throw new Error('Invalid whole-scope result frame');

  const mergeStart = performance.now(),
    failed = new Set();

  for (const [index, batch] of batches.entries()) {
    mergeBatch({
      batch,
      rows,
      failed,
      computedAt: new Date((input.clock ?? Date.now)()).toISOString(),
      result: {
        readAt,
        rows: batch.rowIndexes.map((rowIndex, slot) => ({
          slot,
          values: batch.query.aggregates.map((aggregate, column) => {
            const value = result.rows[rowIndex][`b${index}_v${column}`];

            if (value == null) return null;

            if (aggregate.result.type === 'int64') return BigInt(value);

            if (aggregate.result.type === 'timestamp')
              return utcTimestamp(value);

            return value;
          }),
        })),
      },
    });
  }

  const computed = finishScope(fields, rows, input.requireComplete ?? false);

  options.onExecution?.({
    candidateCount: rows.length,
    associationCount: batches.length,
    statementCount: 1,
    prepareMs,
    engineMs,
    mergeMs: performance.now() - mergeStart,
    planMs: result.planMs,
    collectMs: result.collectMs,
    encodeMs: result.encodeMs,
    sql: request.sql,
    plan: result.plan,
  });

  return computed;
}
