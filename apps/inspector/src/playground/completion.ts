/**
 * Suggestions at a cursor position, from the principal's discovery only, so
 * nothing the principal cannot use is ever offered. Two layers:
 *
 * - SDK: `graph.objects.` names, read methods, option keys the operation
 *   accepts, property names in `select`, `where` and `orderBy`, filter
 *   operators, and the keys of a `compute` entry.
 * - SQL, inside `compute.<alias>.sql` templates: associations after
 *   `FROM self.`, columns after the association alias, `self.` properties,
 *   aggregates, keywords and `$parameters` passed beside the SQL.
 *
 * Pure: the editor adapts `Suggestions` to CodeMirror.
 */
import type { PlaygroundDiscovery, PlaygroundObject } from '../protocol.js';
import {
  acceptedOptions,
  columnType,
  datasetsOf,
  isComputed,
  isFilterable,
  objectNames,
  objectOf,
  propertyType,
  sameName,
  type Column,
} from './model.js';
import {
  callContext,
  objectAt,
  sqlTemplates,
  type SqlTemplate,
} from './source.js';

export interface Suggestion {
  readonly label: string;
  readonly type:
    | 'class'
    | 'method'
    | 'property'
    | 'variable'
    | 'keyword'
    | 'function'
    | 'text';
  readonly detail?: string;
  readonly info?: string;
  /** Inserted text; defaults to the label. */
  readonly apply?: string;
  /** A CodeMirror snippet template (`${}` fields) instead of plain text. */
  readonly snippet?: string;
  readonly boost?: number;
}

export interface Suggestions {
  readonly from: number;
  readonly options: readonly Suggestion[];
  /** Keep the list while the typed word matches. */
  readonly validFor?: RegExp;
}

const word = /\w*$/;

function columnSuggestion(
  column: Column,
  principal: string,
  prefix = '',
): Suggestion {
  return {
    label: `${prefix}${column.name}`,
    type: 'property',
    detail: column.readable
      ? columnType(column)
      : `${column.type} · forbidden for ${principal}`,
    info: [
      column.description,
      column.readable
        ? undefined
        : `${principal} cannot read this column; a field that uses it comes back forbidden.`,
    ]
      .filter(Boolean)
      .join('\n'),
    boost: column.readable ? 1 : -5,
  };
}

function propertySuggestions(
  object: PlaygroundObject,
  quote = '',
): Suggestion[] {
  return object.properties.map((property) => ({
    label: `${quote}${property.name}${quote}`,
    type: 'property',
    detail: isComputed(property)
      ? `${propertyType(property)} · computed`
      : propertyType(property),
    ...(property.description ? { info: property.description } : {}),
  }));
}

const aggregates: readonly Suggestion[] = [
  {
    label: 'COUNT(*)',
    type: 'function',
    detail: '→ int64',
    info: 'Counts rows, duplicates included. 0 when there are none.',
  },
  {
    label: 'COUNT(DISTINCT …)',
    type: 'function',
    detail: '→ int64',
    snippet: 'COUNT(DISTINCT ${})',
    info: 'Distinct non-null values.',
  },
  {
    label: 'COUNT(…)',
    type: 'function',
    detail: '→ int64',
    snippet: 'COUNT(${})',
  },
  {
    label: 'SUM(…)',
    type: 'function',
    detail: 'null on no rows',
    snippet: 'SUM(${})',
  },
  {
    label: 'AVG(…)',
    type: 'function',
    detail: '→ float64',
    snippet: 'AVG(${})',
  },
  {
    label: 'MIN(…)',
    type: 'function',
    detail: 'column type',
    snippet: 'MIN(${})',
  },
  {
    label: 'MAX(…)',
    type: 'function',
    detail: 'column type',
    snippet: 'MAX(${})',
  },
  {
    label: 'COALESCE(…, fallback)',
    type: 'function',
    detail: 'never null',
    snippet: 'COALESCE(${}, ${0})',
    info: 'An aggregate with a literal fallback for empty input.',
  },
];

/** `$name`s passed in the `parameters` object right after this SQL template. */
function parametersBeside(text: string, template: SqlTemplate): string[] {
  const after = text.slice(template.contentTo, template.contentTo + 800);
  const block = /^`\s*,\s*parameters\s*:\s*\{([^}]*)\}/.exec(after)?.[1];

  return block
    ? [...block.matchAll(/(?:^|,)\s*['"]?(\w+)['"]?\s*:/g)].map((m) => m[1]!)
    : [];
}

function sqlSuggestions(
  text: string,
  pos: number,
  template: SqlTemplate,
  object: PlaygroundObject,
  principal: string,
  explicit: boolean,
): Suggestions | null {
  const before = text.slice(template.contentFrom, pos);
  const sql = text.slice(template.contentFrom, template.contentTo);
  const datasets = datasetsOf(object);
  const from = /\bfrom\s+self\.(\w+)(?:\s+(?:as\s+)?(?!where\b)(\w+))?/i.exec(
    sql,
  );
  const dataset = from && datasets.find((d) => sameName(d.name, from[1]!));
  const alias = from?.[2] ?? dataset?.name;
  let match: RegExpExecArray | null;

  if ((match = /\bfrom\s+self\.(\w*)$/i.exec(before))) {
    const start = pos - match[1]!.length;

    return {
      from: start,
      options: datasets.length
        ? datasets.map((d) => ({
            label: d.name,
            type: 'class',
            detail: 'dataset',
            info: [
              d.description,
              d.correlation && `Matched on ${d.correlation}`,
            ]
              .filter(Boolean)
              .join('\n'),
          }))
        : [
            {
              label: 'no datasets',
              type: 'text',
              detail: `none on ${object.apiName} for ${principal}`,
              apply: '',
            },
          ],
    };
  }

  if ((match = /\bself\.(\w*)$/i.exec(before)))
    return {
      from: pos - match[1]!.length,
      options: object.properties
        .filter((p) => !isComputed(p) && p.kind !== 'reference')
        .map((p) => ({
          label: p.name,
          type: 'variable',
          detail: propertyType(p),
          info: `The current ${object.apiName}'s ${p.name}. Not returned.`,
        })),
    };

  if ((match = /\b(\w+)\.(\w*)$/.exec(before))) {
    if (
      dataset &&
      alias &&
      (sameName(match[1]!, alias) || sameName(match[1]!, dataset.name))
    )
      return {
        from: pos - match[2]!.length,
        options: dataset.columns.map((c) => columnSuggestion(c, principal)),
      };

    return null;
  }

  if ((match = /\$(\w*)$/.exec(before)))
    return {
      from: pos - match[1]!.length - 1,
      options: parametersBeside(text, template).map((name) => ({
        label: `$${name}`,
        type: 'variable',
        detail: 'parameter',
      })),
    };

  const typed = word.exec(before)![0];

  if (!explicit && !typed && !/\s$/.test(before)) return null;

  const options: Suggestion[] = [];

  if (!before.trim())
    options.push({
      label: 'SELECT … FROM self.…',
      type: 'keyword',
      detail: 'expression',
      snippet: `SELECT \${COUNT(*)} FROM self.\${${datasets[0]?.name ?? 'dataset'}} AS \${d}`,
      info: 'One aggregate over one dataset of this object.',
      boost: 10,
    });

  if (!/\bselect\b/i.test(before))
    options.push({ label: 'SELECT', type: 'keyword' });
  else if (!/\bfrom\b/i.test(before)) {
    if (/\)\s*\w*$/.test(before))
      options.push({
        label: 'FROM self.',
        type: 'keyword',
        snippet: 'FROM self.${}',
        boost: 5,
      });
    else options.push(...aggregates);
  } else {
    options.push(
      ...(/\bwhere\b/i.test(before)
        ? ['AND', 'OR', 'NOT', 'IS NULL', 'IS NOT NULL']
        : ['WHERE']
      ).map((label): Suggestion => ({ label, type: 'keyword' })),
    );

    if (dataset && alias)
      options.push(
        ...dataset.columns.map((c) =>
          columnSuggestion(c, principal, `${alias}.`),
        ),
      );

    options.push(
      ...object.properties
        .filter((p) => !isComputed(p) && p.kind !== 'reference')
        .map((p): Suggestion => ({
          label: `self.${p.name}`,
          type: 'variable',
          detail: propertyType(p),
        })),
    );
  }

  return { from: pos - typed.length, options, validFor: /^\w*$/ };
}

const optionSnippets: Readonly<Record<string, string>> = {
  select: "select: ['${}'],",
  compute:
    'compute: {\n  ${alias}: {\n    sql: `SELECT ${COUNT(*)} FROM self.${}`,\n  },\n},',
  orderBy: "orderBy: [{ field: '${}', direction: 'desc' }],",
  where: 'where: { ${} },',
};

function sdkSuggestions(
  text: string,
  pos: number,
  discovery: PlaygroundDiscovery,
  explicit: boolean,
): Suggestions | null {
  const before = text.slice(0, pos);
  let match: RegExpExecArray | null;

  if ((match = /graph\s*\.\s*objects\s*\.\s*(\w*)$/.exec(before)))
    return {
      from: pos - match[1]!.length,
      options: objectNames(discovery).map((name) => {
        const description = discovery.objects[name]!.description;

        return {
          label: name,
          type: 'class',
          detail: 'object',
          ...(description ? { info: description } : {}),
        };
      }),
    };

  if ((match = /graph\s*\.\s*objects\s*\.\s*\w+\s*\.\s*(\w*)$/.exec(before)))
    return {
      from: pos - match[1]!.length,
      options: [
        {
          label: 'query',
          type: 'method',
          detail: '(options) → page',
          snippet: "query({\n  select: ['${}'],\n})",
          info: 'Read a page of objects. Await it, or iterate with for await.',
        },
        {
          label: 'get',
          type: 'method',
          detail: '(id, options) → object',
          snippet: "get(${id}, { select: ['${}'] })",
        },
      ],
    };

  if ((match = /graph\s*\.\s*(\w*)$/.exec(before)))
    return {
      from: pos - match[1]!.length,
      options: [
        { label: 'objects', type: 'property' },
        { label: 'actions', type: 'property' },
        { label: 'describe', type: 'method', apply: 'describe()' },
      ],
    };

  const context = callContext(text, pos);

  if (!context) {
    const typed = word.exec(before)![0];

    if (!typed && !explicit) return null;

    return {
      from: pos - typed.length,
      options: [
        {
          label: 'graph',
          type: 'variable',
          detail: `as ${discovery.principal}`,
        },
        { label: 'await', type: 'keyword' },
        { label: 'return', type: 'keyword' },
        { label: 'console', type: 'variable' },
      ],
      validFor: /^\w*$/,
    };
  }

  const object = objectOf(discovery, context.call.object);

  if (!object || context.depth === 0) return null;

  const { path } = context;
  const aliases = [
    ...text.slice(context.call.open).matchAll(/(\w+)\s*:\s*\{\s*sql\s*:/g),
  ].map((m) => m[1]!);
  const computed = object.properties.filter(isComputed).map((p) => p.name);

  if (context.stringFrom !== null) {
    const typed = text.slice(context.stringFrom + 1, pos);

    if (!/^\w*$/.test(typed)) return null;

    const from = context.stringFrom + 1;

    if (path[0] === 'select' && path.length === 1)
      return { from, options: propertySuggestions(object) };

    if (path[0] === 'orderBy' && /field\s*:\s*['"]\w*$/.test(before))
      return {
        from,
        options: [
          ...aliases.map((a): Suggestion => ({
            label: a,
            type: 'variable',
            detail: 'compute alias',
          })),
          ...computed.map((c): Suggestion => ({
            label: c,
            type: 'property',
            detail: 'computed',
          })),
        ],
      };

    if (path[0] === 'orderBy' && /direction\s*:\s*['"]\w*$/.test(before))
      return {
        from,
        options: [
          { label: 'desc', type: 'text' },
          { label: 'asc', type: 'text' },
        ],
      };

    return null;
  }

  const key = /(?:^|[{,])\s*(\w*)$/.exec(before);

  if (context.container === '[') {
    if (path[0] === 'select' && path.length === 1 && /[[,]\s*$/.test(before))
      return { from: pos, options: propertySuggestions(object, "'") };

    return null;
  }

  if (!key) return null;

  const from = pos - key[1]!.length;

  if (path.length === 0) {
    const accepted = acceptedOptions(discovery, context.call.operation);

    if (!accepted) return null;

    return {
      from,
      options: [...accepted].map(([name, description]) => ({
        label: name,
        type: 'property',
        info: description,
        ...(optionSnippets[name]
          ? { snippet: optionSnippets[name] }
          : { apply: `${name}: ` }),
      })),
    };
  }

  if (path[0] === 'compute' && path.length === 1)
    return {
      from,
      options: [
        {
          label: 'new field',
          type: 'text',
          detail: '{ sql }',
          snippet:
            '${alias}: {\n  sql: `SELECT ${COUNT(*)} FROM self.${}`,\n},',
          info: 'The key names the computed field in the result.',
        },
      ],
    };

  if (path[0] === 'compute' && path.length === 2)
    return {
      from,
      options: [
        {
          label: 'sql',
          type: 'property',
          detail: 'string',
          snippet: 'sql: `SELECT ${COUNT(*)} FROM self.${}`,',
          info: 'SELECT <aggregate> FROM self.<dataset> [WHERE …]',
        },
        {
          label: 'parameters',
          type: 'property',
          detail: 'values for $name',
          snippet: 'parameters: { ${} },',
        },
      ],
    };

  if (path[0] === 'compute' && path[2] === 'parameters') {
    const template = sqlTemplates(text)
      .filter((t) => t.contentFrom < pos)
      .at(-1);

    if (!template) return null;

    const sql = text.slice(template.contentFrom, template.contentTo);
    const used = [...new Set([...sql.matchAll(/\$(\w+)/g)].map((m) => m[1]!))];
    const passed = parametersBeside(text, template);

    return {
      from,
      options: used
        .filter((name) => !passed.includes(name))
        .map((name) => ({
          label: name,
          type: 'variable',
          detail: 'used in the SQL',
          apply: `${name}: `,
        })),
    };
  }

  if (path[0] === 'where' && path.length === 1)
    return {
      from,
      options: [
        ...object.properties.filter(isFilterable).map((p): Suggestion => ({
          label: p.name,
          type: 'property',
          detail: propertyType(p),
          apply: `${p.name}: `,
        })),
        ...aliases.map((a): Suggestion => ({
          label: a,
          type: 'variable',
          detail: 'compute alias',
          apply: `${a}: `,
        })),
      ],
    };

  if (path[0] === 'where' && path.length === 2) {
    const property = object.properties.find((p) => p.name === path[1]);
    // Only what discovery lists; never a guessed operator.
    const operators = property?.filterOperators ?? [];

    return {
      from,
      options: operators.map((o) => ({
        label: o,
        type: 'keyword',
        apply: `${o}: `,
      })),
    };
  }

  if (path[0] === 'orderBy' && path.length === 2)
    return {
      from,
      options: [
        { label: 'field', type: 'property', apply: "field: '" },
        { label: 'direction', type: 'property', apply: "direction: '" },
      ],
    };

  return null;
}

export function suggest(
  text: string,
  pos: number,
  discovery: PlaygroundDiscovery | null,
  explicit = false,
): Suggestions | null {
  if (!discovery) return null;

  const template = sqlTemplates(text).find(
    (t) => pos >= t.contentFrom && pos <= t.contentTo,
  );

  if (template) {
    const object = objectOf(discovery, objectAt(text, pos));

    return object
      ? sqlSuggestions(
          text,
          pos,
          template,
          object,
          discovery.principal,
          explicit,
        )
      : null;
  }

  return sdkSuggestions(text, pos, discovery, explicit);
}

/** Hover text for an identifier inside SQL: a dataset, a column or a `self` property. */
export function describeSql(
  text: string,
  pos: number,
  discovery: PlaygroundDiscovery | null,
): {
  from: number;
  to: number;
  title: string;
  detail: string;
  note?: string;
} | null {
  if (!discovery) return null;

  const template = sqlTemplates(text).find(
    (t) => pos >= t.contentFrom && pos <= t.contentTo,
  );
  const object = objectOf(discovery, objectAt(text, pos));

  if (!template || !object) return null;

  let from = pos;
  let to = pos;

  while (from > template.contentFrom && /[\w.]/.test(text[from - 1]!)) from--;

  while (to < template.contentTo && /\w/.test(text[to]!)) to++;

  const parts = text.slice(from, to).split('.');
  const name = parts.at(-1)!;
  const datasets = datasetsOf(object);
  const sql = text.slice(template.contentFrom, template.contentTo);
  const dataset = datasets.find((d) =>
    sameName(d.name, /\bfrom\s+self\.(\w+)/i.exec(sql)?.[1] ?? ''),
  );

  if (parts.length === 2 && sameName(parts[0]!, 'self')) {
    const association = datasets.find((d) => sameName(d.name, name));

    if (association)
      return {
        from,
        to,
        title: `self.${association.name}`,
        detail: 'dataset',
        note: [association.description, association.correlation]
          .filter(Boolean)
          .join('\n'),
      };

    const property = object.properties.find((p) => sameName(p.name, name));

    if (property)
      return {
        from,
        to,
        title: `self.${property.name}`,
        detail: propertyType(property),
        note: `The current ${object.apiName}'s ${property.name}.`,
      };
  }

  if (parts.length === 2 && dataset) {
    const column = dataset.columns.find((c) => sameName(c.name, name));

    if (column)
      return {
        from,
        to,
        title: column.name,
        detail: columnType(column),
        note: [
          column.description,
          column.readable
            ? undefined
            : `Not readable as ${discovery.principal}.`,
        ]
          .filter(Boolean)
          .join('\n'),
      };
  }

  return null;
}
