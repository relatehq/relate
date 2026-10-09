import type {
  EvidenceMode,
  FieldEvidence,
  FullReadMeta,
  FullReadResult,
  FullObjectResult,
  FullPageResult,
  ReadMeta,
  ReadResult,
  ObjectResult,
  PageResult,
} from './index.js';

/** Available/fresh alone is insufficient: failed refresh or persistence matters. */
function routine(field: FieldEvidence): boolean {
  return (
    field.status === 'available' &&
    field.freshness === 'fresh' &&
    field.retention === 'confirmed' &&
    field.ordering === 'confirmed' &&
    (field.refresh === 'not-needed' || field.refresh === 'succeeded')
  );
}

/** Responses never share evidence objects with the runtime's resolved result. */
function presentMeta(meta: FullReadMeta, mode: EvidenceMode): ReadMeta {
  const own = structuredClone(meta);

  if (mode === 'full') return own;

  const fields = Object.fromEntries(
    Object.entries(own.fields).filter(([, field]) => !routine(field)),
  );

  return {
    evidence: 'compact',
    completeness: own.completeness,
    degraded: own.degraded,
    definitionRevision: own.definitionRevision,
    ...(Object.keys(fields).length ? { fields } : {}),
    ...(own.warnings.length ? { warnings: own.warnings } : {}),
  };
}

export type Presentable = FullReadResult | FullObjectResult | FullPageResult;

/** The response shape for each resolved shape; distributes over result unions. */
export type Presented<T extends Presentable> = T extends FullPageResult
  ? PageResult
  : T extends { status: 'not-found' }
    ? T
    : T extends { id: string }
      ? Extract<ObjectResult, { status: 'ok' }>
      : Extract<ReadResult, { status: 'ok' }>;

/** Transform only the result envelope; business data is never traversed. */
export function present<T extends Presentable>(
  result: T,
  mode: EvidenceMode = 'compact',
): Presented<T> {
  const presented: Presentable | ReadResult | PageResult = !('status' in result)
    ? {
        data: result.data.map((record) => ({
          ...record,
          meta: presentMeta(record.meta, mode),
        })),
        meta: result.meta,
      }
    : result.status === 'not-found'
      ? result
      : { ...result, meta: presentMeta(result.meta, mode) };

  return presented as Presented<T>;
}
