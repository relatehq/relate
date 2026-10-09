import type {
  FieldEvidence,
  FullReadResult as ReadResult,
} from '@relate/protocol';

type Supplied = Extract<FieldEvidence, { status: 'available' | 'absent' }>;

type Summary = Pick<
  Extract<ReadResult, { status: 'ok' }>['meta'],
  'completeness' | 'degraded'
>;

/** Evidence that describes a value or a known absence, with provenance. */
export function supplied(field: FieldEvidence): field is Supplied {
  return field.status === 'available' || field.status === 'absent';
}

/**
 * Completeness and degradation for one field selection.
 *
 * Any withheld field makes the selection partial. Only `unavailable` degrades
 * the read: data the caller may receive could not be supplied. A `forbidden`
 * field is a final, correct answer for this principal; retrying or refreshing
 * cannot change it, so it is not a quality problem with the read.
 */
export function summarize(
  fields: Readonly<Record<string, FieldEvidence>>,
  warnings: readonly string[] = [],
): Summary {
  const values = Object.values(fields);

  return {
    completeness: values.every(supplied) ? 'complete' : 'partial',
    degraded:
      warnings.length > 0 ||
      values.some(
        (field) =>
          field.status === 'unavailable' ||
          (supplied(field) &&
            (field.freshness === 'stale' ||
              field.refresh === 'invalid' ||
              field.refresh === 'unavailable')),
      ),
  };
}
