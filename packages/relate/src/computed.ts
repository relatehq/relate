import { z } from 'zod';
import type { Property, ObjectDefinition } from './index.js';
import type { FieldGroup } from './authorization.js';
import { CompileError } from './diagnostics.js';
import { recordProvenance } from './provenance.js';

/** JSON output envelope only; SQL result type is inferred during runtime preparation. */
const computedScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export interface ComputedProperty extends Property<typeof computedScalar> {
  readonly origin: { readonly kind: 'computed'; readonly sql: string };
}

/** Declare a read-only analytical property whose derived value is never persisted. */
export function computed<const Id extends string>(options: {
  readonly id: Id;
  readonly sql: string;
  readonly access?: FieldGroup;
  readonly description?: string;
}): ComputedProperty & { readonly id: Id } {
  if (
    !options ||
    typeof options !== 'object' ||
    Object.keys(options).some(
      (key) => !['id', 'sql', 'access', 'description'].includes(key),
    ) ||
    typeof options.sql !== 'string' ||
    !options.sql.trim()
  )
    throw new CompileError([
      {
        code: 'calculation.invalid-definition',
        message:
          'A computed property requires SQL and accepts only id, sql, access and description',
        path: { root: 'definition', segments: [] },
      },
    ]);

  return recordProvenance(
    Object.freeze({
      id: options.id,
      ...(options.description === undefined
        ? {}
        : { description: options.description }),
      ...(options.access === undefined ? {} : { access: options.access }),
      schema: computedScalar,
      origin: Object.freeze({ kind: 'computed', sql: options.sql }),
    }),
  );
}

export type ComputedPropertyNames<O extends ObjectDefinition> = {
  [
    K in keyof O['properties']
  ]: O['properties'][K]['origin']['kind'] extends 'computed' ? K : never;
}[keyof O['properties']] &
  string;
