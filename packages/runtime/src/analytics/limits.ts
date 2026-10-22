import type { AnalyticalLimits } from 'relate/analytics';

const defaults: Required<AnalyticalLimits> = Object.freeze({
  operationTimeoutMs: 60_000,
  maxSourceCalls: 100_000,
  maxCandidatesScanned: 12_500,
  maxCandidatesAdmitted: 10_000,
  maxSqlBytes: 4096,
  maxParsedNodes: 256,
  maxParameters: 16,
  maxParameterBytes: 1024,
  maxExpressions: 8,
  maxKeysPerStatement: 1000,
  statementTimeoutMs: 5000,
  maxConcurrentStatements: 4,
  maxQueuedStatements: 32,
  queueTimeoutMs: 2000,
});
const zeroAllowed = new Set<keyof AnalyticalLimits>([
  'maxSourceCalls',
  'maxCandidatesScanned',
  'maxCandidatesAdmitted',
  'maxQueuedStatements',
  'queueTimeoutMs',
]);
const timers = new Set<keyof AnalyticalLimits>([
  'operationTimeoutMs',
  'statementTimeoutMs',
  'queueTimeoutMs',
]);

/** Validate and detach host configuration before parsing, binding or serving. */
export function resolveAnalyticalLimits(
  input?: AnalyticalLimits,
): Readonly<Required<AnalyticalLimits>> {
  const fail = (): never => {
    throw new Error('Invalid analytical limits');
  };

  if (
    input !== undefined &&
    (!input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Reflect.ownKeys(input).some(
        (key) => typeof key !== 'string' || !Object.hasOwn(defaults, key),
      ))
  )
    fail();

  const result = { ...defaults };

  for (const key of Object.keys(defaults) as (keyof AnalyticalLimits)[]) {
    const supplied = input?.[key];
    const value = supplied === undefined ? defaults[key] : supplied;

    if (
      !Number.isSafeInteger(value) ||
      value < (zeroAllowed.has(key) ? 0 : 1) ||
      (timers.has(key) && value > 2_147_483_647)
    )
      fail();

    result[key] = value;
  }

  return Object.freeze(result);
}
