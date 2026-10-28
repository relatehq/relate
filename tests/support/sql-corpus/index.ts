import { readFileSync, readdirSync } from 'node:fs';
import { z } from 'zod';

const scalar = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const resultType = z.union([
  z.strictObject({
    type: z.enum(['string', 'boolean', 'int32', 'int64', 'float64', 'date']),
    nullable: z.boolean(),
  }),
  z.strictObject({
    type: z.literal('timestamp'),
    precision: z.union([z.literal(3), z.literal(6)]),
    nullable: z.boolean(),
  }),
]);
const representation = z.record(z.string(), z.unknown());
const caseSchema = z.strictObject({
  name: z.string().min(1),
  sql: z.string().min(1),
  parameters: z.record(z.string(), scalar).optional(),
  expect: z.discriminatedUnion('phase', [
    z.strictObject({
      phase: z.literal('parse'),
      problem: z.enum(['invalid-value', 'not-supported']),
    }),
    z.strictObject({
      phase: z.literal('resolve'),
      representation,
      problem: z.enum(['invalid-value', 'unknown-property', 'not-supported']),
    }),
    z.strictObject({
      phase: z.literal('execute'),
      representation,
      resultType,
      values: z.record(z.string(), scalar),
    }),
  ]),
});

export type SqlCorpusCase = z.infer<typeof caseSchema>;

const directory = new URL('./cases/', import.meta.url);

export const sqlCorpus = readdirSync(directory)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => {
    const value = caseSchema.parse(
      JSON.parse(readFileSync(new URL(name, directory), 'utf8')),
    );

    if (name !== `${value.name}.json`)
      throw new Error(`Corpus case name differs from filename: ${name}`);

    return value;
  });

/** Spans have separate UTF-16 assertions; semantic goldens remain readable across whitespace changes. */
export function semanticQuery(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticQuery);

  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'at')
        .map(([key, child]) => [key, semanticQuery(child)]),
    );

  return value;
}
