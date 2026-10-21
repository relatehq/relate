/**
 * Problems shown in the editor. Two sources, one shape:
 *
 * - `checkCode`: as you type, from the principal's discovery. Unknown objects,
 *   options the operation does not accept, unknown properties in `select` and
 *   `where`, and filter operators a property does not support. Only literal
 *   code is checked; anything built at run time is left to the run.
 * - `runDiagnostics`: after a run, each request issue a graph operation
 *   reported, placed on the code it names. `compute.<alias>.sql` issues land
 *   inside the SQL when the runtime reports where.
 *
 * SQL itself is not checked here: the runtime owns the analytical SQL rules,
 * so the editor shows what the runtime said rather than a second opinion.
 */
import type {
  PlaygroundDiscovery,
  PlaygroundOperationError,
} from '../protocol.js';
import {
  acceptedOptions,
  isFilterable,
  objectNames,
  objectOf,
  type ReadOperation,
} from './model.js';
import {
  entryOf,
  graphCalls,
  sqlTemplates,
  type GraphCall,
  type LiteralNode,
  type ObjectEntry,
  type ObjectNode,
  type Span,
} from './source.js';

export interface Fix {
  readonly label: string;
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

export interface Problem extends Span {
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly fix?: Fix;
}

function closest(name: string, options: readonly string[]): string | undefined {
  const lower = name.toLowerCase();
  let best: string | undefined;
  let bestDistance = Infinity;

  for (const option of options) {
    const other = option.toLowerCase();
    const row = Array.from({ length: other.length + 1 }, (_, j) => j);

    for (let i = 1; i <= lower.length; i++) {
      let previous = row[0]!;

      row[0] = i;

      for (let j = 1; j <= other.length; j++) {
        const current = row[j]!;

        row[j] = Math.min(
          row[j]! + 1,
          row[j - 1]! + 1,
          previous + (lower[i - 1] === other[j - 1] ? 0 : 1),
        );
        previous = current;
      }
    }

    if (row[other.length]! < bestDistance) {
      bestDistance = row[other.length]!;
      best = option;
    }
  }

  return bestDistance <= Math.max(2, Math.floor(name.length / 3))
    ? best
    : undefined;
}

const replace = (span: Span, text: string): Fix => ({
  label: `Use ${text}`,
  from: span.from,
  to: span.to,
  insert: text,
});

/** Aliases a call's literal `compute` declares; computed fields filter and order too. */
function computeAliases(options: ObjectNode | null): string[] {
  const compute = entryOf(options, 'compute')?.value;

  return compute?.kind === 'object'
    ? compute.entries.flatMap((entry) => (entry.key ? [entry.key] : []))
    : [];
}

function checkCall(call: GraphCall, discovery: PlaygroundDiscovery): Problem[] {
  const problems: Problem[] = [];
  const object = objectOf(discovery, call.object);

  if (!object) {
    const names = objectNames(discovery);
    const suggestion = closest(call.object, names);

    return [
      {
        ...call.objectSpan,
        severity: 'error',
        message: `Unknown object ${call.object}. ${discovery.principal} can use ${
          names.join(', ') || 'no objects'
        }.`,
        ...(suggestion ? { fix: replace(call.objectSpan, suggestion) } : {}),
      },
    ];
  }

  const options = call.options;

  if (!options) return problems;

  const accepted = acceptedOptions(discovery, call.operation as ReadOperation);
  const properties = object.properties.map((property) => property.name);
  const aliases = computeAliases(options);

  for (const entry of options.entries) {
    if (entry.key === null || !accepted || accepted.has(entry.key)) continue;

    const names = [...accepted.keys()];
    const suggestion = closest(entry.key, names);

    problems.push({
      ...entry.keySpan,
      severity: 'error',
      message:
        entry.key === 'compute' || entry.key === 'orderBy'
          ? `${entry.key} is not supported by this runtime yet. ${call.object}.${call.operation} accepts ${names.join(', ')}.`
          : `Unknown option ${entry.key}. ${call.object}.${call.operation} accepts ${names.join(', ')}.`,
      ...(suggestion ? { fix: replace(entry.keySpan, suggestion) } : {}),
    });
  }

  const select = entryOf(options, 'select')?.value;

  if (select?.kind === 'array')
    for (const item of select.items) {
      if (item.kind !== 'string' || item.interpolations.length) continue;

      if (!properties.includes(item.value)) {
        const suggestion = closest(item.value, properties);
        const span = { from: item.contentFrom, to: item.contentTo };

        problems.push({
          ...span,
          severity: 'warning',
          message: `${call.object} has no property ${item.value} that ${discovery.principal} can see; it comes back unavailable.${
            suggestion ? ` Did you mean ${suggestion}?` : ''
          }`,
          ...(suggestion ? { fix: replace(span, suggestion) } : {}),
        });
      }
    }

  const where = entryOf(options, 'where')?.value;

  if (where?.kind === 'object')
    for (const entry of where.entries) {
      if (entry.key === null || aliases.includes(entry.key)) continue;

      const property = object.properties.find((p) => p.name === entry.key);

      if (!property) {
        const suggestion = closest(entry.key, [...properties, ...aliases]);

        problems.push({
          ...entry.keySpan,
          severity: 'error',
          message: `Unknown filter field ${entry.key} on ${call.object}.${
            suggestion ? ` Did you mean ${suggestion}?` : ''
          }`,
          ...(suggestion ? { fix: replace(entry.keySpan, suggestion) } : {}),
        });
        continue;
      }

      if (!isFilterable(property)) {
        problems.push({
          ...entry.keySpan,
          severity: 'error',
          message: `${entry.key} is not a filterable property of ${call.object} for ${discovery.principal}.`,
        });
        continue;
      }

      const operators = property.filterOperators;

      if (entry.value.kind === 'object' && operators?.length)
        for (const operator of entry.value.entries)
          if (operator.key !== null && !operators.includes(operator.key))
            problems.push({
              ...operator.keySpan,
              severity: 'error',
              message: `${entry.key} does not support ${operator.key}. Use ${operators.join(', ')}.`,
            });
    }

  return problems;
}

/** Interpolated values in SQL are pasted into the text; parameters are typed. */
function interpolationProblems(text: string): Problem[] {
  return sqlTemplates(text).flatMap((template) =>
    template.interpolations.map((span) => ({
      ...span,
      severity: 'warning' as const,
      message:
        'This value is pasted into the SQL text. Pass it in parameters and write $name, so it is typed and checked.',
    })),
  );
}

export function checkCode(
  text: string,
  discovery: PlaygroundDiscovery | null,
): Problem[] {
  const problems = interpolationProblems(text);

  if (!discovery) return problems;

  for (const call of graphCalls(text))
    problems.push(...checkCall(call, discovery));

  return problems;
}

/** A SQL location as the runtime may report it: offsets, or a 1-based line and column. */
function sqlOffset(
  sql: string,
  location: unknown,
): { start: number; end: number } | null {
  if (!location || typeof location !== 'object') return null;

  const value = location as Record<string, unknown>;

  if (typeof value['start'] === 'number')
    return {
      start: value['start'],
      end: typeof value['end'] === 'number' ? value['end'] : value['start'] + 1,
    };

  if (
    typeof value['line'] === 'number' &&
    typeof value['column'] === 'number'
  ) {
    const lines = sql.split('\n');
    let offset = 0;

    for (let i = 0; i < value['line'] - 1 && i < lines.length; i++)
      offset += lines[i]!.length + 1;

    const start = offset + value['column'] - 1;

    return { start, end: start + 1 };
  }

  return null;
}

/** The node a request path names inside a call's options, if the code wrote it literally. */
function nodeAt(
  options: ObjectNode,
  path: readonly (string | number)[],
): { span: Span; node: LiteralNode | null } | null {
  let node: LiteralNode = options;
  let span: Span = options;

  for (const segment of path) {
    if (node.kind === 'object') {
      const entry: ObjectEntry | undefined = node.entries.find(
        (e) => e.key === String(segment),
      );

      if (!entry) return { span, node: null };

      span = entry.keySpan;
      node = entry.value;
    } else if (node.kind === 'array' && typeof segment === 'number') {
      const item: LiteralNode | undefined = node.items[segment];

      if (!item) return { span, node: null };

      span =
        item.kind === 'string'
          ? { from: item.contentFrom, to: item.contentTo }
          : item;
      node = item;
    } else return { span, node: null };
  }

  return { span, node };
}

/**
 * Place each issue of a run on the call that most likely made it: the first
 * literal call to the same object and operation. Issues that cannot be placed
 * stay in the results panel only.
 */
export function runDiagnostics(
  text: string,
  errors: readonly PlaygroundOperationError[],
): Problem[] {
  const calls = graphCalls(text);
  const problems: Problem[] = [];

  for (const error of errors) {
    const [object, operation] = error.operation.split('.');
    const call = calls.find(
      (c) => c.object === object && c.operation === operation && c.options,
    );

    for (const issue of error.issues) {
      const message = `${issue.message} (${error.code} from the last run)`;

      if (!call?.options) continue;

      const target = nodeAt(call.options, issue.path);

      if (!target) continue;

      const { node } = target;
      // Locations count characters of the SQL as written, escapes included.
      const location = sqlOffset(
        node?.kind === 'string'
          ? text.slice(node.contentFrom, node.contentTo)
          : '',
        (issue as Record<string, unknown>)['location'],
      );

      if (node?.kind === 'string' && node.template && location)
        problems.push({
          from: node.contentFrom + location.start,
          to: node.contentFrom + Math.max(location.end, location.start + 1),
          severity: 'error',
          message,
        });
      else
        problems.push({
          from: target.span.from,
          to: Math.max(target.span.to, target.span.from + 1),
          severity: 'error',
          message,
        });
    }
  }

  return problems;
}
