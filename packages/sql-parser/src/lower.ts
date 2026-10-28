import { scalarLeaves } from 'relate/analytics';
import type {
  Aggregate,
  SqlAggregate,
  ScalarExpression,
  LiteralOperand,
  Operand,
  Predicate,
  RelateSqlQuery,
  RowExpression,
} from 'relate/analytics';
import { reject, unsupported } from './errors.js';
import type { SqlSource } from './source.js';

type Node = Record<string, unknown>;

function shape(value: unknown, keys: readonly string[]): Node {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    return unsupported();

  return value as Node;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) return unsupported();

  return value;
}

function text(value: unknown): string {
  if (typeof value !== 'string') return unsupported();

  return value;
}

function strings(value: unknown): string[] {
  return list(value).map((entry) =>
    text(shape(shape(entry, ['String']).String, ['sval']).sval),
  );
}

function location(node: Node): number {
  const value = node.location ?? 0;

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    return unsupported();

  return value;
}

/** Every consumed AST object has an explicit key and value allowlist. */
export function lower(
  tree: unknown,
  source: SqlSource,
  maxNodes: number,
): RelateSqlQuery {
  let nodes = 0;
  const count = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;

    if (++nodes > maxNodes)
      reject('invalid-value', 'The expression exceeds the parsed-node limit.');

    for (const child of Object.values(value)) count(child);
  };

  count(tree);
  const root = shape(tree, ['version', 'stmts']);

  if (root.version !== source.grammarVersion) return unsupported();

  const statements = list(root.stmts);

  if (statements.length !== 1) return unsupported();

  const statement = shape(statements[0], ['stmt', 'stmt_location', 'stmt_len']);
  const select = shape(shape(statement.stmt, ['SelectStmt']).SelectStmt, [
    'targetList',
    'fromClause',
    'whereClause',
    'limitOption',
    'op',
  ]);

  if (
    select.op !== 'SETOP_NONE' ||
    select.limitOption !== 'LIMIT_OPTION_DEFAULT'
  )
    return unsupported();

  const targets = list(select.targetList),
    ranges = list(select.fromClause);

  if (targets.length !== 1 || ranges.length !== 1) return unsupported();

  const range = shape(shape(ranges[0], ['RangeVar']).RangeVar, [
    'schemaname',
    'relname',
    'inh',
    'relpersistence',
    'alias',
    'location',
  ]);

  if (
    range.schemaname !== 'self' ||
    range.inh !== true ||
    range.relpersistence !== 'p'
  )
    return unsupported(source.span(location(range)));

  const association = source.identifiers(location(range), [
    'self',
    text(range.relname),
  ])[1]!;
  const alias =
    range.alias === undefined
      ? text(range.relname)
      : text(shape(range.alias, ['aliasname']).aliasname);

  if (alias === 'self') return unsupported(source.span(location(range)));

  function operand(value: unknown): Operand {
    const node = shape(value, ['ColumnRef', 'ParamRef', 'A_Const']);

    if (Object.keys(node).length !== 1) return unsupported();

    if (node.ColumnRef) {
      const reference = shape(node.ColumnRef, ['fields', 'location']);
      const fields = strings(reference.fields);

      if (fields.length < 1 || fields.length > 2)
        return unsupported(source.span(location(reference)));

      const names = source.identifiers(location(reference), fields);

      if (fields.length === 1) return { kind: 'column', ...names[0]! };

      if (fields[0] !== alias && fields[0] !== 'self')
        return unsupported(names[0]!.at);

      return { kind: fields[0] === 'self' ? 'self' : 'column', ...names[1]! };
    }

    if (node.ParamRef) {
      const reference = shape(node.ParamRef, ['number', 'location']);
      const index = reference.number;

      if (
        typeof index !== 'number' ||
        !Number.isSafeInteger(index) ||
        index < 1 ||
        index > source.names.length
      )
        return unsupported();

      return {
        kind: 'parameter',
        name: source.names[index - 1]!,
        at: source.span(location(reference)),
      };
    }

    const constant = shape(node.A_Const, [
      'sval',
      'ival',
      'fval',
      'boolval',
      'isnull',
      'location',
    ]);
    const at = source.span(location(constant));
    const kinds = ['sval', 'ival', 'fval', 'boolval', 'isnull'].filter((key) =>
      Object.hasOwn(constant, key),
    );

    if (kinds.length !== 1) return unsupported(at);

    if (constant.isnull === true)
      return { kind: 'literal', literal: 'null', value: null, at };

    if (constant.sval)
      return {
        kind: 'literal',
        literal: 'string',
        value: text(shape(constant.sval, ['sval']).sval ?? ''),
        at,
      };

    if (constant.fval)
      return {
        kind: 'literal',
        literal: 'number',
        value: text(shape(constant.fval, ['fval']).fval),
        at,
      };

    if (constant.ival) {
      const value = shape(constant.ival, ['ival']).ival ?? 0;

      if (typeof value !== 'number' || !Number.isSafeInteger(value))
        return unsupported(at);

      return { kind: 'literal', literal: 'number', value: String(value), at };
    }

    if (constant.boolval) {
      const value = shape(constant.boolval, ['boolval']).boolval ?? false;

      if (typeof value !== 'boolean') return unsupported(at);

      return { kind: 'literal', literal: 'boolean', value, at };
    }

    return unsupported(at);
  }

  // Parentheses are already structural in the parse tree; precedence is the parser's.
  function rowExpression(value: unknown): RowExpression {
    if (value && typeof value === 'object' && 'A_Expr' in value) {
      const expr = shape(shape(value, ['A_Expr']).A_Expr, [
        'kind',
        'name',
        'lexpr',
        'rexpr',
        'location',
      ]);
      const names = strings(expr.name);
      const at = source.span(location(expr));

      if (
        expr.kind !== 'AEXPR_OP' ||
        names.length !== 1 ||
        !['+', '-', '*', '/'].includes(names[0]!) ||
        expr.lexpr === undefined ||
        expr.rexpr === undefined
      )
        return unsupported(at);

      return {
        kind: 'arithmetic',
        op: names[0] as '+' | '-' | '*' | '/',
        left: rowExpression(expr.lexpr),
        right: rowExpression(expr.rexpr),
        at,
      };
    }

    return operand(value);
  }

  function predicate(value: unknown): Predicate {
    if (
      value &&
      typeof value === 'object' &&
      ('ColumnRef' in value || 'ParamRef' in value || 'A_Const' in value)
    ) {
      const left = operand(value);

      // Bare boolean columns, parameters and TRUE/FALSE mean `= TRUE`.
      if (left.kind === 'literal' && left.literal !== 'boolean')
        return unsupported(left.at);

      return {
        kind: 'compare',
        op: '=',
        left,
        right: {
          kind: 'literal',
          literal: 'boolean',
          value: true,
          at: left.at,
        },
      };
    }

    const node = shape(value, ['A_Expr', 'BoolExpr', 'NullTest']);

    if (Object.keys(node).length !== 1) return unsupported();

    if (node.A_Expr) {
      const expression = shape(node.A_Expr, [
        'kind',
        'name',
        'lexpr',
        'rexpr',
        'location',
      ]);
      const operators = strings(expression.name);
      const op = operators[0];

      if (
        expression.kind !== 'AEXPR_OP' ||
        operators.length !== 1 ||
        !['=', '<>', '>', '>=', '<', '<='].includes(op!)
      )
        return unsupported(source.span(location(expression)));

      return {
        kind: 'compare',
        op: op as Extract<Predicate, { kind: 'compare' }>['op'],
        left: operand(expression.lexpr),
        right: operand(expression.rexpr),
      };
    }

    if (node.BoolExpr) {
      const expression = shape(node.BoolExpr, ['boolop', 'args', 'location']);
      const operations = {
        AND_EXPR: 'and',
        OR_EXPR: 'or',
        NOT_EXPR: 'not',
      } as const;
      const name = text(expression.boolop);

      if (!Object.hasOwn(operations, name))
        return unsupported(source.span(location(expression)));

      const op = operations[name as keyof typeof operations];
      const args = list(expression.args);

      if (!op || (op === 'not' ? args.length !== 1 : args.length < 2))
        return unsupported(source.span(location(expression)));

      return {
        kind: 'boolean',
        op: op as 'and' | 'or' | 'not',
        args: args.map(predicate),
      };
    }

    const expression = shape(node.NullTest, [
      'arg',
      'nulltesttype',
      'location',
    ]);

    if (!['IS_NULL', 'IS_NOT_NULL'].includes(text(expression.nulltesttype)))
      return unsupported(source.span(location(expression)));

    return {
      kind: 'null',
      value: operand(expression.arg),
      not: expression.nulltesttype === 'IS_NOT_NULL',
    };
  }

  const target = shape(shape(targets[0], ['ResTarget']).ResTarget, [
    'val',
    'location',
  ]);

  // Lowered once, after the first aggregate call, and shared by every leaf.
  let where: Predicate | undefined;
  const lowerWhere = () =>
    select.whereClause === undefined
      ? undefined
      : (where ??= predicate(select.whereClause));

  function aggregate(output: unknown): SqlAggregate {
    let fallback: LiteralOperand | undefined;

    if (output && typeof output === 'object' && 'CoalesceExpr' in output) {
      const coalesce = shape(shape(output, ['CoalesceExpr']).CoalesceExpr, [
        'args',
        'location',
      ]);
      const args = list(coalesce.args);

      if (args.length !== 2)
        return unsupported(source.span(location(coalesce)));

      const value = operand(args[1]);

      if (value.kind !== 'literal' || value.literal === 'null')
        return unsupported(source.span(location(coalesce)));

      fallback = value;
      output = args[0];
    }

    const call = shape(shape(output, ['FuncCall']).FuncCall, [
      'funcname',
      'args',
      'agg_star',
      'agg_distinct',
      'agg_filter',
      'funcformat',
      'location',
    ]);
    const functions = strings(call.funcname);
    const name = functions[0];

    if (
      functions.length !== 1 ||
      !['count', 'sum', 'avg', 'min', 'max'].includes(name!) ||
      call.funcformat !== 'COERCE_EXPLICIT_CALL'
    )
      return unsupported(source.span(location(call)));

    if (
      (call.agg_star !== undefined && call.agg_star !== true) ||
      (call.agg_distinct !== undefined && call.agg_distinct !== true)
    )
      return unsupported(source.span(location(call)));

    if (
      call.agg_star
        ? name !== 'count' || call.args !== undefined || call.agg_distinct
        : list(call.args).length !== 1
    )
      return unsupported(source.span(location(call)));

    if (call.agg_distinct && name !== 'count')
      return unsupported(source.span(location(call)));

    const filters = [
      lowerWhere(),
      call.agg_filter === undefined ? undefined : predicate(call.agg_filter),
    ].filter((value) => value !== undefined);

    const argument = call.agg_star ? '*' : rowExpression(list(call.args)[0]);

    // DISTINCT compares stored values; it never deduplicates computed rows.
    if (call.agg_distinct && argument !== '*' && argument.kind === 'arithmetic')
      return unsupported(argument.at);

    return {
      aggregate: name as Aggregate,
      argument,
      distinct: call.agg_distinct === true,
      ...(filters.length
        ? {
            predicate:
              filters.length === 1
                ? filters[0]!
                : {
                    kind: 'boolean' as const,
                    op: 'and' as const,
                    args: filters,
                  },
          }
        : {}),
      ...(fallback ? { fallback } : {}),
    };
  }

  function expression(
    value: unknown,
    standalone = false,
  ): ScalarExpression<SqlAggregate> {
    const node = shape(value, [
      'A_Expr',
      'CoalesceExpr',
      'FuncCall',
      'A_Const',
      'ColumnRef',
      'ParamRef',
    ]);

    if (Object.keys(node).length !== 1) return unsupported();

    if (node.A_Expr) {
      const expr = shape(node.A_Expr, [
        'kind',
        'name',
        'lexpr',
        'rexpr',
        'location',
      ]);
      const names = strings(expr.name);
      const at = source.span(location(expr));

      if (names.length !== 1) return unsupported(at);

      if (expr.kind === 'AEXPR_NULLIF' && names[0] === '=')
        return {
          kind: 'nullif',
          left: expression(expr.lexpr),
          right: expression(expr.rexpr),
        };

      if (expr.kind !== 'AEXPR_OP' || !['+', '-', '*', '/'].includes(names[0]!))
        return unsupported(at);

      return {
        kind: 'binary',
        op: names[0] as '+' | '-' | '*' | '/',
        left: expression(expr.lexpr),
        right: expression(expr.rexpr),
      };
    }

    if (node.CoalesceExpr) {
      const coalesce = shape(node.CoalesceExpr, ['args', 'location']);
      const args = list(coalesce.args);

      if (args.length !== 2)
        return unsupported(source.span(location(coalesce)));

      // Only standalone COALESCE keeps the aggregate's exact scalar type.
      // Nested calls use float64 operands like the surrounding formula.
      if (
        standalone &&
        args[0] &&
        typeof args[0] === 'object' &&
        'FuncCall' in args[0] &&
        args[1] &&
        typeof args[1] === 'object' &&
        'A_Const' in args[1]
      )
        return { kind: 'aggregate', value: aggregate(value) };

      return {
        kind: 'coalesce',
        left: expression(args[0]),
        right: expression(args[1]),
      };
    }

    if (node.FuncCall) return { kind: 'aggregate', value: aggregate(value) };

    const resolved = operand(value);

    if (resolved.kind === 'column') return unsupported(resolved.at);

    return { kind: 'operand', value: resolved };
  }

  const result = expression(target.val, true);

  if (result.kind === 'aggregate') return { association, ...result.value };

  if (!scalarLeaves(result).some((leaf) => leaf.kind === 'aggregate'))
    return unsupported(source.span(location(target)));

  return { association, aggregate: 'expression', expression: result };
}
