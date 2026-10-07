import type { z } from 'zod';

/** Compiler metadata for schemas constructed by referenceInput; not caller-supplied JSON. */
export const referenceSchemas = new WeakMap<z.ZodType, string>();
