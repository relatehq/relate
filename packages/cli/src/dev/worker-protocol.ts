/**
 * IPC contract between the supervisor and its application-loading child.
 * Plain validated data: no prototypes, `instanceof` or JSON.stringify(error).
 */
import { z } from 'zod';
import { manifestSchema } from 'relate/model';
import { diagnosticSchema, sourceSiteSchema } from '@relate/inspector/protocol';

export const workerMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('model'),
    manifest: manifestSchema,
    definitionRevision: z.string().min(1),
    /** Resolved declaration sites by definition ID, when provenance resolved. */
    sites: z.record(z.string(), sourceSiteSchema),
  }),
  z.strictObject({
    type: z.literal('failure'),
    diagnostics: z.array(diagnosticSchema).min(1),
  }),
]);

export type WorkerMessage = z.infer<typeof workerMessageSchema>;

export interface WorkerArguments {
  readonly bundlePath: string;
  readonly projectRoot: string;
  readonly configPath: string;
}

/** The child receives its instructions as JSON on argv to keep env untouched. */
export function encodeWorkerArguments(input: WorkerArguments): string {
  return JSON.stringify(input);
}

export function decodeWorkerArguments(
  value: string | undefined,
): WorkerArguments {
  const parsed = z
    .strictObject({
      bundlePath: z.string().min(1),
      projectRoot: z.string().min(1),
      configPath: z.string().min(1),
    })
    .safeParse(value === undefined ? undefined : JSON.parse(value));

  if (!parsed.success) throw new Error('Invalid worker arguments');

  return parsed.data;
}
