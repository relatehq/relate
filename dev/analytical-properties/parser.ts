import { parse } from 'libpg-query';
import { invalid } from './contracts.js';
import type { Operand, Predicate, SqlQuery } from './contracts.js';

// Parser-specific nodes stay inside this adapter. Every consumed object has an
// explicit key allowlist, so adding a parser feature cannot silently widen SQL.
type Node = Record<string, any>;

function shape(value: Node, keys: string[]): Node {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    invalid('not-supported');

  return value;
}

/** A lexical pass, never regex replacement inside SQL strings/comments. */
export function namedParameters(sql: string): { sql: string; names: string[] } {
  const names: string[] = [];
  let output = '';
  let i = 0;

  while (i < sql.length) {
    const rest = sql.slice(i);
    const comment = rest.match(/^--[^\n]*(?:\n|$)/);
    const dollar = rest.match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/);

    if (comment) {
      output += comment[0];
      i += comment[0].length;
      continue;
    }

    if (rest.startsWith('/*')) {
      let depth = 1,
        end = i + 2;

      while (end < sql.length && depth) {
        if (sql.slice(end, end + 2) === '/*') {
          depth++;
          end += 2;
        } else if (sql.slice(end, end + 2) === '*/') {
          depth--;
          end += 2;
        } else end++;
      }

      if (depth) invalid('unterminated-comment');

      output += sql.slice(i, end);
      i = end;
      continue;
    }

    if (dollar) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);

      if (end < 0) invalid('unterminated-string');

      const after = end + dollar[0].length;

      output += sql.slice(i, after);
      i = after;
      continue;
    }

    if (sql[i] === "'" || sql[i] === '"') {
      // Escape strings and Unicode quoted identifiers need a fuller lexer.
      if (/[eE]$|[uU]&$/.test(output)) invalid('not-supported');

      const quote = sql[i]!;
      let end = i + 1;

      for (; end < sql.length; end++) {
        if (sql[end] !== quote) continue;

        if (sql[end + 1] === quote) {
          end++;
          continue;
        }

        break;
      }

      if (end === sql.length) invalid('unterminated-string');

      output += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    const parameter = rest.match(/^\$([A-Za-z_][A-Za-z_0-9]*)/);

    if (parameter) {
      const name = parameter[1]!;

      if (!names.includes(name)) names.push(name);

      output += `$${names.indexOf(name) + 1}`;
      i += parameter[0].length;
      continue;
    }

    if (/^\$\d/.test(rest)) invalid('positional-parameter');

    output += sql[i++];
  }

  if (names.length > 16) invalid('parameter-limit');

  return { sql: output, names };
}

export async function parseExpression(sql: string): Promise<SqlQuery> {
  if (new TextEncoder().encode(sql).length > 4096) invalid('sql-limit');

  const rewritten = namedParameters(sql);
  let tree: Node;

  try {
    tree = await parse(rewritten.sql);
  } catch {
    return invalid('syntax');
  }

  let nodes = 0;

  function count(value: unknown): void {
    if (!value || typeof value !== 'object') return;

    if (++nodes > 256) invalid('node-limit');

    for (const child of Object.values(value)) count(child);
  }

  count(tree);

  if (tree.stmts?.length !== 1) invalid('not-supported');

  const statement = shape(tree.stmts[0].stmt, ['SelectStmt']);
  const select = shape(statement.SelectStmt, [
    'targetList',
    'fromClause',
    'whereClause',
    'limitOption',
    'op',
  ]);

  if (
    select.op !== 'SETOP_NONE' ||
    select.limitOption !== 'LIMIT_OPTION_DEFAULT' ||
    select.targetList?.length !== 1 ||
    select.fromClause?.length !== 1
  )
    invalid('not-supported');

  const range = shape(shape(select.fromClause[0], ['RangeVar']).RangeVar, [
    'schemaname',
    'relname',
    'inh',
    'relpersistence',
    'alias',
    'location',
  ]);

  if (range.schemaname !== 'self' || range.inh !== true)
    invalid('not-supported');

  if (range.alias) shape(range.alias, ['aliasname']);

  const alias = range.alias?.aliasname ?? range.relname;

  if (alias === 'self') invalid('reserved-self');

  const strings = (list: Node[]) =>
    list.map(
      (entry) =>
        shape(shape(entry, ['String']).String, ['sval']).sval as string,
    );

  function operand(node: Node): Operand {
    if (node.ColumnRef) {
      shape(node, ['ColumnRef']);
      const fields = strings(
        shape(node.ColumnRef, ['fields', 'location']).fields,
      );

      if (fields.length === 1) return { kind: 'column', name: fields[0]! };

      if (fields.length !== 2 || ![alias, 'self'].includes(fields[0]!))
        invalid('unknown-property');

      return {
        kind: fields[0] === 'self' ? 'self' : 'column',
        name: fields[1]!,
      };
    }

    if (node.ParamRef) {
      shape(node, ['ParamRef']);
      const name =
        rewritten.names[
          shape(node.ParamRef, ['number', 'location']).number - 1
        ];

      if (!name) invalid('invalid-value');

      return { kind: 'parameter', name };
    }

    if (node.A_Const) {
      shape(node, ['A_Const']);
      const value = shape(node.A_Const, [
        'sval',
        'ival',
        'fval',
        'boolval',
        'isnull',
        'location',
      ]);

      if (value.isnull) return { kind: 'literal', value: null };

      if (value.sval) return { kind: 'literal', value: value.sval.sval };

      if (value.ival) return { kind: 'literal', value: value.ival.ival ?? 0 };

      if (value.boolval)
        return { kind: 'literal', value: value.boolval.boolval ?? false };

      // PG encodes large integer and decimal tokens as text. Do not round them.
      if (value.fval) return { kind: 'literal', value: value.fval.fval };
    }

    return invalid('not-supported');
  }

  function predicate(node: Node): Predicate {
    if (node.A_Expr) {
      shape(node, ['A_Expr']);
      const expr = shape(node.A_Expr, [
        'kind',
        'name',
        'lexpr',
        'rexpr',
        'location',
      ]);
      const ops = strings(expr.name);

      if (
        expr.kind !== 'AEXPR_OP' ||
        ops.length !== 1 ||
        !['=', '<>', '>', '>=', '<', '<='].includes(ops[0]!)
      )
        invalid('not-supported');

      return {
        kind: 'compare',
        op: ops[0] as Extract<Predicate, { kind: 'compare' }>['op'],
        left: operand(expr.lexpr),
        right: operand(expr.rexpr),
      };
    }

    if (node.BoolExpr) {
      shape(node, ['BoolExpr']);
      const expr = shape(node.BoolExpr, ['boolop', 'args', 'location']);
      const op = ({ AND_EXPR: 'and', OR_EXPR: 'or', NOT_EXPR: 'not' } as const)[
        expr.boolop as 'AND_EXPR'
      ];

      if (!op) invalid('not-supported');

      return { kind: 'boolean', op, args: expr.args.map(predicate) };
    }

    if (node.NullTest) {
      shape(node, ['NullTest']);
      const expr = shape(node.NullTest, ['arg', 'nulltesttype', 'location']);

      if (!['IS_NULL', 'IS_NOT_NULL'].includes(expr.nulltesttype))
        invalid('not-supported');

      return {
        kind: 'null',
        value: operand(expr.arg),
        not: expr.nulltesttype === 'IS_NOT_NULL',
      };
    }

    return invalid('not-supported');
  }

  const target = shape(shape(select.targetList[0], ['ResTarget']).ResTarget, [
    'val',
    'location',
  ]);
  const call = shape(shape(target.val, ['FuncCall']).FuncCall, [
    'funcname',
    'args',
    'agg_star',
    'agg_distinct',
    'funcformat',
    'location',
  ]);
  const names = strings(call.funcname);

  if (
    names.length !== 1 ||
    !['count', 'sum', 'avg', 'min', 'max'].includes(names[0]!)
  )
    invalid('not-supported');

  if (
    call.agg_star
      ? names[0] !== 'count' || call.args || call.agg_distinct
      : call.args?.length !== 1
  )
    invalid('not-supported');

  if (call.agg_distinct && names[0] !== 'count') invalid('not-supported');

  const argument = call.agg_star ? '*' : operand(call.args[0]);

  if (argument !== '*' && argument.kind !== 'column') invalid('not-supported');

  return {
    association: range.relname,
    aggregate: names[0] as SqlQuery['aggregate'],
    argument,
    distinct: !!call.agg_distinct,
    ...(select.whereClause ? { predicate: predicate(select.whereClause) } : {}),
  };
}
