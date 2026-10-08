import { z } from 'zod';
import type { ScalarSchema } from './model.js';

// Zod installs this shared type guard on ordinary length checks. Custom predicates
// cannot cross the JSON boundary, but its built-in guard preserves scalar semantics.
const lengthWhen = z.string().min(0).def.checks![0]!._zod.def.when;

// Only checks represented in portable JSON may cross the compilation boundary.
export function portable(schema: z.ZodType): ScalarSchema {
  let current = schema;
  let optional = false;
  let nullable = false;

  while (current.def.type === 'optional' || current.def.type === 'nullable') {
    if ('checks' in current.def && current.def.checks?.length)
      throw new Error('Unsupported schema refinement');

    if (current.def.type === 'optional') optional = true;
    else nullable = true;

    current = (current as z.ZodOptional | z.ZodNullable).unwrap() as z.ZodType;
  }

  const type = current.def.type;

  if (
    !['string', 'number', 'boolean'].includes(type) ||
    // Coercion changes which inputs parse; the portable scalar would accept fewer.
    ('coerce' in current.def && current.def.coerce)
  ) {
    throw new Error(
      `Unsupported schema: ${type}. Only portable, uncoerced scalar fields are supported.`,
    );
  }

  const result: ScalarSchema = {
    type: type as ScalarSchema['type'],
    optional,
    nullable,
  };

  for (const check of ('checks' in current.def ? current.def.checks : []) ??
    []) {
    const def = check._zod.def;

    if (
      def.when !== undefined &&
      !(
        type === 'string' &&
        ['min_length', 'max_length', 'length_equals'].includes(def.check) &&
        def.when === lengthWhen
      )
    )
      throw new Error('Unsupported conditional schema check');

    // Preserve the strongest bound when callers chain checks in any order.
    if (type === 'string' && def.check === 'min_length') {
      result.minLength = Math.max(
        result.minLength ?? 0,
        (def as z.core.$ZodCheckMinLengthDef).minimum,
      );
    } else if (type === 'string' && def.check === 'max_length') {
      result.maxLength = Math.min(
        result.maxLength ?? Infinity,
        (def as z.core.$ZodCheckMaxLengthDef).maximum,
      );
    } else if (type === 'string' && def.check === 'length_equals') {
      const length = (def as z.core.$ZodCheckLengthEqualsDef).length;

      result.minLength = Math.max(result.minLength ?? 0, length);
      result.maxLength = Math.min(result.maxLength ?? Infinity, length);
    } else if (
      type === 'number' &&
      (def.check === 'greater_than' || def.check === 'less_than')
    ) {
      const bound = def as
        z.core.$ZodCheckGreaterThanDef | z.core.$ZodCheckLessThanDef;

      if (typeof bound.value !== 'number' || !Number.isFinite(bound.value))
        throw new Error('Non-finite schema bound');

      const key =
        def.check === 'greater_than'
          ? bound.inclusive
            ? 'minimum'
            : 'exclusiveMinimum'
          : bound.inclusive
            ? 'maximum'
            : 'exclusiveMaximum';

      result[key] =
        def.check === 'greater_than'
          ? Math.max(result[key] ?? -Infinity, bound.value)
          : Math.min(result[key] ?? Infinity, bound.value);
    } else {
      throw new Error(`Unsupported schema check: ${def.check}`);
    }
  }

  // Formats such as z.email() carry validation on the schema itself.
  if ('format' in current.def) throw new Error('Unsupported schema format');

  return result;
}
