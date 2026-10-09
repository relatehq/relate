import { expect, it } from 'vitest';
import { presentRead, presentPage } from '@relate/protocol';
import type { FieldEvidence, FullReadMeta } from '@relate/protocol';

const available = {
  status: 'available',
  freshness: 'fresh',
  observedAt: '2026-10-09T00:00:00Z',
  source: 'source',
  sourceDefinitionId: 'records',
  orderingBasis: 'fetch-start',
  retention: 'confirmed',
  retentionDurability: 'volatile',
  ordering: 'confirmed',
  refresh: 'not-needed',
} as const;

it('compacts only evidence envelopes without mutating data or the full result', () => {
  const data = {
    meta: { label: 'business data', fields: { title: 'unchanged' } },
    zero: 0,
    empty: '',
    nullable: null,
  };
  const meta: FullReadMeta = {
    evidence: 'full',
    completeness: 'complete',
    degraded: false,
    definitionRevision: 'sha256:test',
    fields: { meta: available },
    warnings: [],
  };
  const full = { status: 'ok' as const, data, meta };
  const before = structuredClone(full);

  expect(presentRead(full)).toEqual({
    status: 'ok',
    data,
    meta: {
      evidence: 'compact',
      completeness: 'complete',
      degraded: false,
      definitionRevision: 'sha256:test',
    },
  });
  expect(presentRead(full, 'full')).toEqual(full);
  expect(full).toEqual(before);
  expect(presentRead({ status: 'not-found' })).toEqual({ status: 'not-found' });
});

it('preserves every exceptional state including fresh retention and ordering failures', () => {
  const exceptions: Record<string, FieldEvidence> = {
    absent: { ...available, status: 'absent' },
    stale: { ...available, freshness: 'stale' },
    forbidden: { status: 'forbidden' },
    unavailable: { status: 'unavailable' },
    failed: { ...available, retention: 'failed' },
    uncertain: { ...available, retention: 'unconfirmed' },
    ordering: { ...available, ordering: 'unconfirmed' },
    refreshUnavailable: { ...available, refresh: 'unavailable' },
    invalid: { ...available, refresh: 'invalid' },
    superseded: { ...available, refresh: 'superseded' },
  };
  const result = presentRead({
    status: 'ok',
    data: {},
    meta: {
      evidence: 'full',
      completeness: 'partial',
      degraded: true,
      definitionRevision: 'r',
      fields: {
        ...exceptions,
        routine: available,
        refreshed: { ...available, refresh: 'succeeded' },
      },
      warnings: [
        'observation_not_retained',
        'retention_unconfirmed',
        'ordering_unconfirmed',
      ],
    },
  });

  expect(result).toMatchObject({
    meta: {
      evidence: 'compact',
      completeness: 'partial',
      degraded: true,
      fields: exceptions,
      warnings: [
        'observation_not_retained',
        'retention_unconfirmed',
        'ordering_unconfirmed',
      ],
    },
  });

  if (result.status !== 'ok') throw new Error('Expected result');

  expect(Object.keys(result.meta.fields ?? {})).toEqual(
    Object.keys(exceptions),
  );
});

it('preserves continuation even on an empty page and presents each record independently', () => {
  expect(
    presentPage({
      data: [],
      meta: { exhausted: false, continuationCursor: 'token' },
    }),
  ).toEqual({
    data: [],
    meta: { exhausted: false, continuationCursor: 'token' },
  });
  const record = {
    id: 'id',
    data: { name: 'Ada' },
    meta: {
      evidence: 'full' as const,
      completeness: 'complete' as const,
      degraded: false,
      definitionRevision: 'r',
      fields: { name: available },
      warnings: [],
    },
  };
  const page = { data: [record], meta: { exhausted: true as const } };

  expect(presentPage(page).data[0]).toEqual({
    ...record,
    meta: {
      evidence: 'compact',
      completeness: 'complete',
      degraded: false,
      definitionRevision: 'r',
    },
  });
  expect(presentPage(page, 'full')).toEqual(page);
});
