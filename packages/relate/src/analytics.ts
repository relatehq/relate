/** Portable analytical contracts. No compiler, parser implementation or driver. */
export type {
  LogicalType,
  ComputedResultType,
  AnalyticalExpression,
} from '@relate/protocol';

export type * from './analytics/sql.js';
export type { AnalyticalLimits } from './analytics/limits.js';

export {
  AnalyticalValueError,
  canonicalTimestamp,
  encodeAnalyticalValue,
  parseAnalyticalValue,
  decodeAnalyticalValue,
} from './analytics/values.js';

export type {
  TypedValue,
  AnalyticalScalar,
  DecodedAnalyticalScalar,
} from './analytics/values.js';

export {
  foldRowExpression,
  foldScalarExpression,
  isRowArithmetic,
  mapScalarExpression,
  rowOperands,
  scalarLeaves,
} from './analytics/scalar.js';

export {
  renderAnalyticalQuery,
  analyticalParameterBudget,
  checkedValue,
  quoteSqlIdentifier,
} from './analytics/render.js';

export type {
  AnalyticalSqlDialect,
  AnalyticalSqlPlan,
  CheckedAccumulation,
  CheckedArithmeticDialect,
  CheckedInput,
  CheckedType,
  SqlDataset,
} from './analytics/render.js';
