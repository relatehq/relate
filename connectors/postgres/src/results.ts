import { DatasetExecutionError } from 'relate/connectors';
import type { DatasetExecution } from 'relate/connectors';
import type { PostgresPlan } from './plan.js';

/** Preserve invalid scalar values for scope-wide alias validation by the runtime. */
export function decode(
  plan: PostgresPlan,
  raw: readonly (readonly (string | null)[])[],
  readAt: string,
): DatasetExecution {
  const invalid = () =>
    new DatasetExecutionError('invalid-result', { retryable: false });

  if (raw.length !== plan.slots) throw invalid();

  const rows = raw.map((row, slot) => {
    if (row[0] !== String(slot) || row.length !== plan.results.length + 1)
      throw invalid();

    return {
      slot,
      values: plan.results.map((type, index) => {
        const value = row[index + 1];

        if (value !== null && typeof value !== 'string') throw invalid();

        if (value === null) return null;

        if (type.type === 'boolean')
          return value === 't' ? true : value === 'f' ? false : value;

        if (type.type === 'int64')
          return /^-?\d{1,19}$/.test(value) ? BigInt(value) : value;

        if (type.type === 'int32')
          return /^-?\d+$/.test(value) ? Number(value) : value;

        if (type.type === 'float64')
          return value.trim() === '' ? value : Number(value);

        if (
          type.type === 'timestamp' &&
          value.startsWith('0001-') &&
          value.endsWith('BC')
        )
          return `0000-${value.slice(5, -2)}`;

        if (type.type === 'timestamp' && value.endsWith('AD'))
          return value.slice(0, -2);

        return value;
      }),
    };
  });

  return { rows, readAt };
}
