import type { AnalyticalLimits } from 'relate/analytics';

/** Snapshot host configuration once, before the runtime becomes available. */
export function operationLimits(input?: AnalyticalLimits) {
  if (
    input !== undefined &&
    (!input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) =>
          ![
            'operationTimeoutMs',
            'maxSourceCalls',
            'maxCandidatesScanned',
            'maxCandidatesAdmitted',
          ].includes(key),
      ))
  )
    throw new Error('Invalid analytical operation limits');

  const operationTimeoutMs =
    input?.operationTimeoutMs === undefined ? 60_000 : input.operationTimeoutMs;
  const maxSourceCalls =
    input?.maxSourceCalls === undefined ? 100_000 : input.maxSourceCalls;

  const maxCandidatesScanned =
    input?.maxCandidatesScanned === undefined
      ? 12_500
      : input.maxCandidatesScanned;
  const maxCandidatesAdmitted =
    input?.maxCandidatesAdmitted === undefined
      ? 10_000
      : input.maxCandidatesAdmitted;

  if (
    [maxCandidatesScanned, maxCandidatesAdmitted].some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    ) ||
    !Number.isSafeInteger(operationTimeoutMs) ||
    operationTimeoutMs < 1 ||
    operationTimeoutMs > 2_147_483_647 ||
    !Number.isSafeInteger(maxSourceCalls) ||
    maxSourceCalls < 0
  )
    throw new Error('Invalid analytical operation limits');

  return Object.freeze({
    operationTimeoutMs,
    maxSourceCalls,
    maxCandidatesScanned,
    maxCandidatesAdmitted,
  });
}
