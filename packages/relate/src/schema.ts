import type { z } from 'zod';

/** Compiler metadata for schemas constructed by referenceInput; not caller-supplied JSON. */
export const referenceSchemas = new WeakMap<z.ZodType['def'], string>();

/** Ordinary fields, action payloads and claims use their JSON representation. */
export type PortableValue<T> = T extends bigint
  ? string
  : T extends string | number | boolean | null | undefined
    ? T
    : T extends object
      ? { [K in keyof T]: PortableValue<T[K]> }
      : T;
