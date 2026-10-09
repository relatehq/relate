import type {
  EvidenceMode,
  FieldEvidence,
  FullReadMeta,
  FullReadResult,
  FullObjectRecord,
  FullPageResult,
  ReadMeta,
  ReadResult,
  ObjectRecord,
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

function presentMeta(meta: FullReadMeta, mode: EvidenceMode): ReadMeta {
  if (mode === 'full') return meta;

  const fields = Object.fromEntries(
    Object.entries(meta.fields).filter(([, field]) => !routine(field)),
  );

  return {
    evidence: 'compact',
    completeness: meta.completeness,
    degraded: meta.degraded,
    definitionRevision: meta.definitionRevision,
    ...(Object.keys(fields).length ? { fields } : {}),
    ...(meta.warnings.length ? { warnings: meta.warnings } : {}),
  };
}

/** Transform only the result envelope; business data is never traversed. */
export function presentRead(
  result: FullReadResult,
  mode: EvidenceMode = 'compact',
): ReadResult {
  return result.status === 'not-found'
    ? result
    : { ...result, meta: presentMeta(result.meta, mode) };
}

export function presentRecord(
  record: FullObjectRecord,
  mode: EvidenceMode = 'compact',
): ObjectRecord {
  return { ...record, meta: presentMeta(record.meta, mode) };
}

export function presentPage(
  page: FullPageResult,
  mode: EvidenceMode = 'compact',
): PageResult {
  return {
    data: page.data.map((record) => presentRecord(record, mode)),
    meta: page.meta,
  };
}
