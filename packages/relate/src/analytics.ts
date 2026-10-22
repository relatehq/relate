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
  renderAnalyticalQuery,
  analyticalParameterBudget,
  quoteSqlIdentifier,
} from './analytics/render.js';

export type {
  AnalyticalSqlDialect,
  AnalyticalSqlPlan,
  SqlDataset,
} from './analytics/render.js';
