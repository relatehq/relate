/** Portable analytical contracts. No compiler, parser implementation or driver. */
export type {
  LogicalType,
  ComputedResultType as ResultType,
  AnalyticalExpression,
} from '@relate/protocol';

export type * from './analytics/sql.js';

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
