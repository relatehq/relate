/**
 * Static reading of playground code. It finds the literal
 * `graph.objects.<Name>.query(...)` and `.get(...)` calls, their option
 * objects with source offsets, and the SQL template literals under
 * `compute.<alias>.sql`. Pure and tolerant of half-typed code: a call whose
 * arguments do not parse is kept without arguments, and anything that is not
 * a literal is `dynamic`, so checks skip it rather than guess.
 */

export interface Span {
  readonly from: number;
  readonly to: number;
}

export interface StringNode extends Span {
  readonly kind: 'string';
  /** The text between the quotes; `${…}` stays as written in templates. */
  readonly value: string;
  readonly contentFrom: number;
  readonly contentTo: number;
  readonly template: boolean;
  readonly interpolations: readonly Span[];
}

export interface ObjectEntry {
  /** Null for a spread (`...rest`). */
  readonly key: string | null;
  readonly keySpan: Span;
  readonly value: LiteralNode;
}

export type LiteralNode =
  | StringNode
  | (Span & {
      readonly kind: 'object';
      readonly entries: readonly ObjectEntry[];
    })
  | (Span & { readonly kind: 'array'; readonly items: readonly LiteralNode[] })
  | (Span & {
      readonly kind: 'value';
      readonly value: number | boolean | null;
    })
  /** Any expression that is not a literal: a variable, a call, arithmetic. */
  | (Span & { readonly kind: 'dynamic' });

export type ObjectNode = Extract<LiteralNode, { kind: 'object' }>;

export interface GraphCall {
  readonly object: string;
  readonly objectSpan: Span;
  readonly operation: 'get' | 'query';
  /** Offset just after the call's `(`. */
  readonly open: number;
  /** Null when the arguments do not parse yet. */
  readonly args: readonly LiteralNode[] | null;
  /** The options argument: the first for `query`, the second for `get`. */
  readonly options: ObjectNode | null;
}

export interface SqlTemplate {
  readonly contentFrom: number;
  /** The closing backtick, or the end of the text while it is unterminated. */
  readonly contentTo: number;
  readonly closed: boolean;
  readonly interpolations: readonly Span[];
}

class Incomplete extends Error {}

/** Skip `${…}` starting at `i`; returns the offset after its closing brace. */
function skipInterpolation(text: string, i: number): number {
  let depth = 0;

  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i + 1;
  }

  return text.length;
}

/**
 * Template literals that are the value of an `sql:` key. Found lexically, so
 * an unterminated template while typing still counts.
 */
export function sqlTemplates(text: string): SqlTemplate[] {
  const found: SqlTemplate[] = [];
  const pattern = /\bsql\s*:\s*`/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    const contentFrom = pattern.lastIndex;
    const interpolations: Span[] = [];
    let i = contentFrom;

    while (i < text.length && text[i] !== '`') {
      if (text[i] === '\\') {
        i += 2;
        continue;
      }

      if (text[i] === '$' && text[i + 1] === '{') {
        const from = i;

        i = skipInterpolation(text, i);
        interpolations.push({ from, to: i });
        continue;
      }

      i++;
    }

    const contentTo = Math.min(i, text.length);

    found.push({
      contentFrom,
      contentTo,
      closed: i < text.length,
      interpolations,
    });
    pattern.lastIndex = Math.min(contentTo + 1, text.length);
  }

  return found;
}

/** Read literal arguments from just after `(` up to the matching `)`. */
export function readArguments(text: string, start: number): LiteralNode[] {
  let i = start;

  const space = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i++;

      if (text.startsWith('//', i)) {
        while (i < text.length && text[i] !== '\n') i++;

        continue;
      }

      if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2);

        i = end < 0 ? text.length : end + 2;
        continue;
      }

      return;
    }
  };
  const more = () => {
    if (i >= text.length) throw new Incomplete();
  };

  function string(): StringNode {
    const quote = text[i]!;
    const from = i;
    const contentFrom = ++i;
    const interpolations: Span[] = [];
    let value = '';

    while (i < text.length && text[i] !== quote) {
      if (text[i] === '\\') {
        value += text[i + 1] ?? '';
        i += 2;
        continue;
      }

      if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
        const start = i;

        i = skipInterpolation(text, i);
        interpolations.push({ from: start, to: i });
        value += text.slice(start, i);
        continue;
      }

      value += text[i++];
    }

    more();
    const contentTo = i++;

    return {
      kind: 'string',
      value,
      from,
      to: i,
      contentFrom,
      contentTo,
      template: quote === '`',
      interpolations,
    };
  }

  function expression(): LiteralNode {
    const from = i;
    let depth = 0;

    while (i < text.length) {
      const c = text[i]!;

      if (c === "'" || c === '"' || c === '`') {
        string();
        continue;
      }

      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) {
        if (depth === 0) break;

        depth--;
      } else if (c === ',' && depth === 0) break;

      i++;
    }

    more();

    return { kind: 'dynamic', from, to: i };
  }

  function value(): LiteralNode {
    space();
    more();
    const c = text[i]!;

    if (c === '{') {
      const from = i++;
      const entries: ObjectEntry[] = [];

      for (;;) {
        space();
        more();

        if (text[i] === '}') {
          i++;
          break;
        }

        if (text.startsWith('...', i)) {
          const keyFrom = i;

          i += 3;
          entries.push({
            key: null,
            keySpan: { from: keyFrom, to: i },
            value: value(),
          });
        } else {
          const keyFrom = i;
          let key: string;

          if (text[i] === "'" || text[i] === '"') key = string().value;
          else {
            const name = /^[A-Za-z_$][\w$]*/.exec(text.slice(i))?.[0];

            if (!name) throw new Incomplete();

            key = name;
            i += name.length;
          }

          const keySpan = { from: keyFrom, to: i };

          space();

          if (text[i] === ':') {
            i++;
            entries.push({ key, keySpan, value: value() });
          } else
            entries.push({
              key,
              keySpan,
              value: { kind: 'dynamic', ...keySpan },
            });
        }

        space();
        more();

        if (text[i] === ',') {
          i++;
          continue;
        }

        if (text[i] === '}') {
          i++;
          break;
        }

        throw new Incomplete();
      }

      return { kind: 'object', entries, from, to: i };
    }

    if (c === '[') {
      const from = i++;
      const items: LiteralNode[] = [];

      for (;;) {
        space();
        more();

        if (text[i] === ']') {
          i++;
          break;
        }

        items.push(value());
        space();
        more();

        if (text[i] === ',') {
          i++;
          continue;
        }

        if (text[i] === ']') {
          i++;
          break;
        }

        throw new Incomplete();
      }

      return { kind: 'array', items, from, to: i };
    }

    if (c === "'" || c === '"' || c === '`') {
      const node = string();

      space();

      // `'a' + b` is an expression, not a literal.
      if (i < text.length && !',}])'.includes(text[i]!)) {
        i = node.from;

        return expression();
      }

      return node;
    }

    const literal = /^(-?\d+(?:\.\d+)?|true|false|null)(?![\w$.(])/.exec(
      text.slice(i),
    );

    if (literal) {
      const from = i;

      i += literal[0].length;

      return {
        kind: 'value',
        value: JSON.parse(literal[0]) as number | boolean | null,
        from,
        to: i,
      };
    }

    return expression();
  }

  const args: LiteralNode[] = [];

  for (;;) {
    space();
    more();

    if (text[i] === ')') return args;

    args.push(value());
    space();
    more();

    if (text[i] === ',') {
      i++;
      continue;
    }

    if (text[i] === ')') return args;

    throw new Incomplete();
  }
}

const callPattern =
  /graph\s*\.\s*objects\s*\.\s*(\w+)\s*\.\s*(query|get)\s*\(/g;

/** Every `graph.objects.<Name>.query(...)` and `.get(...)` call, in order. */
export function graphCalls(text: string): GraphCall[] {
  const calls: GraphCall[] = [];

  for (const match of text.matchAll(callPattern)) {
    const open = match.index + match[0].length;
    const objectFrom =
      match.index + match[0].indexOf(match[1]!, 'graph'.length);
    const operation = match[2] as 'get' | 'query';
    let args: LiteralNode[] | null;

    try {
      args = readArguments(text, open);
    } catch (error) {
      if (!(error instanceof Incomplete)) throw error;

      args = null;
    }

    const options = args?.[operation === 'query' ? 0 : 1];

    calls.push({
      object: match[1]!,
      objectSpan: { from: objectFrom, to: objectFrom + match[1]!.length },
      operation,
      open,
      args,
      options: options?.kind === 'object' ? options : null,
    });
  }

  return calls;
}

/** The value of `key` in an object node. */
export function entryOf(
  node: LiteralNode | null | undefined,
  key: string,
): ObjectEntry | undefined {
  return node?.kind === 'object'
    ? node.entries.find((entry) => entry.key === key)
    : undefined;
}

/** The JSON value of a fully literal node; undefined when any part is dynamic. */
export function literalValue(node: LiteralNode | undefined): unknown {
  if (!node) return undefined;

  switch (node.kind) {
    case 'string':
      return node.interpolations.length ? undefined : node.value;
    case 'value':
      return node.value;
    case 'array': {
      const items = node.items.map(literalValue);

      return items.includes(undefined) ? undefined : items;
    }
    case 'object': {
      const result: Record<string, unknown> = {};

      for (const entry of node.entries) {
        const value =
          entry.key === null ? undefined : literalValue(entry.value);

        if (value === undefined) return undefined;

        result[entry.key!] = value;
      }

      return result;
    }
    case 'dynamic':
      return undefined;
  }
}

/**
 * The object of the graph call at or above `pos`, else the first call's. The
 * schema tree opens this object.
 */
export function objectAt(text: string, pos: number): string | null {
  let current: string | null = null;
  let first: string | null = null;

  for (const match of text.matchAll(callPattern)) {
    first ??= match[1]!;

    if (match.index <= pos) current = match[1]!;
  }

  return current ?? first;
}

/** Where `pos` sits inside a call's arguments: the option keys enclosing it. */
export interface CallContext {
  readonly call: {
    readonly object: string;
    readonly operation: 'get' | 'query';
    readonly open: number;
  };
  /** Containers open at `pos`; 0 between the call's parentheses only. */
  readonly depth: number;
  /** Option keys below the options object, `''` for an unkeyed level. */
  readonly path: readonly string[];
  /** The innermost container. */
  readonly container: '{' | '[' | null;
  /** The opening quote offset when `pos` is inside a string. */
  readonly stringFrom: number | null;
}

/** The enclosing call and key path at `pos`, or null outside every call. */
export function callContext(text: string, pos: number): CallContext | null {
  let call: CallContext['call'] | null = null;

  for (const match of text.matchAll(callPattern)) {
    const open = match.index + match[0].length;

    if (open <= pos)
      call = {
        object: match[1]!,
        operation: match[2] as 'get' | 'query',
        open,
      };
  }

  if (!call) return null;

  const stack: { key: string; type: '{' | '[' }[] = [];
  let quote: string | null = null;
  let stringFrom = 0;

  for (let i = call.open; i < pos; i++) {
    const c = text[i]!;

    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;

      continue;
    }

    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      stringFrom = i;
      continue;
    }

    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);

      i = end < 0 ? pos : end;
      continue;
    }

    if (c === '{' || c === '[') {
      const key = /(\w+)\s*:\s*$/.exec(
        text.slice(Math.max(call.open, i - 80), i),
      );

      stack.push({ key: key?.[1] ?? '', type: c });
    } else if (c === '}' || c === ']') {
      stack.pop();

      if (!stack.length) return null;
    } else if (c === ')' && !stack.length) return null;
  }

  // The options object of `get` is the second argument; its first level is ''.
  return {
    call,
    depth: stack.length,
    path: stack.slice(1).map((level) => level.key),
    container: stack.at(-1)?.type ?? null,
    stringFrom: quote ? stringFrom : null,
  };
}
