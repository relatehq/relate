import type { z } from 'zod';
import type { ComputedResultType } from '@relate/protocol';

/** Dataset rows are trusted after physical checks; refinements cannot be promised. */
export function datasetType(schema: z.ZodType): ComputedResultType {
  let current = schema;
  let nullable = false;

  while (current?.def?.type === 'nullable') {
    if (current.def.checks?.length)
      throw new Error('Dataset columns do not support refinements');

    nullable = true;
    current = (current as z.ZodNullable).unwrap() as z.ZodType;
  }

  if (
    !current?.def ||
    ('coerce' in current.def && current.def.coerce) ||
    ('checks' in current.def && current.def.checks?.length)
  )
    throw new Error(
      'Dataset columns require uncoerced scalar schemas without refinements',
    );

  const def = current.def;

  if ('format' in def) {
    if (def.type === 'number' && def.format === 'int32')
      return { type: 'int32', nullable };

    if (def.type === 'bigint' && def.format === 'int64')
      return { type: 'int64', nullable };

    if (
      def.type === 'string' &&
      def.format === 'datetime' &&
      'offset' in def &&
      def.offset === true &&
      'local' in def &&
      def.local === false &&
      'precision' in def &&
      (def.precision === 3 || def.precision === 6)
    )
      return { type: 'timestamp', precision: def.precision, nullable };

    throw new Error('Unsupported dataset scalar format');
  }

  if (def.type === 'boolean' || def.type === 'string')
    return { type: def.type, nullable };

  if (def.type === 'number') return { type: 'float64', nullable };

  throw new Error('Unsupported dataset column type');
}
