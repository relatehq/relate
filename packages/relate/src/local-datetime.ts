import { z } from 'zod';
import { localDateTimeValue } from './model/local-datetime.js';
import type { LocalDateTimePrecision } from './model/local-datetime.js';

export type { LocalDateTimePrecision } from './model/local-datetime.js';

declare const localDateTimeBrand: unique symbol;

export type LocalDateTimeSchema = z.ZodString & {
  readonly [localDateTimeBrand]: true;
};

const checks = new WeakMap<object, LocalDateTimePrecision>();

/** Explicit wall-clock schema. The application owns its common clock domain. */
export function localDateTime(options: {
  precision: LocalDateTimePrecision;
}): LocalDateTimeSchema {
  const precision = options.precision;

  if (precision !== 'second' && precision !== 'millisecond')
    throw new Error('Unsupported local datetime precision');

  const schema = z
    .string()
    .refine(
      (value) => localDateTimeValue(value, precision) !== undefined,
      'Expected a local calendar datetime without an offset at the declared precision',
    );

  checks.set(schema.def.checks![0]!, precision);

  return schema as LocalDateTimeSchema;
}

/** Only this library-owned check is portable; arbitrary refinements remain rejected. */
export const localDateTimeCheckPrecision = (check: object) => checks.get(check);
