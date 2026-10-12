import { expect, it } from 'vitest';
import { localDateTime, defineAccess, defineGraph } from 'relate';
import { compile } from 'relate/compiler';
import { localDateTimeValue, validateManifest } from 'relate/model';

it('validates precision, leap years, offsets and calendar components without Date parsing', () => {
  const seconds = localDateTime({ precision: 'second' });
  const millis = localDateTime({ precision: 'millisecond' });

  for (const value of [
    '2000-02-29T23:59:59',
    '2026-12-31T23:59:59',
    '0001-01-01T00:00:00',
  ])
    expect(seconds.safeParse(value).success).toBe(true);

  for (const value of [
    '1900-02-29T00:00:00',
    '2026-02-29T00:00:00',
    '2026-01-01T24:00:00',
    '2026-01-01T00:00:60',
    '0000-01-01T00:00:00',
    '2026-01-01',
    '2026-01-01T00:00:00Z',
  ])
    expect(seconds.safeParse(value).success).toBe(false);

  expect(millis.safeParse('2026-01-01T00:00:00.001').success).toBe(true);
  expect(millis.safeParse('2026-01-01T00:00:00.1').success).toBe(false);
  expect(millis.safeParse('2026-01-01T00:00:00').success).toBe(false);
  expect(localDateTimeValue('2026-12-31T23:59:59', 'second')).toBeLessThan(
    localDateTimeValue('2027-01-01T00:00:00', 'second')!,
  );
});

it.each([
  [
    { format: 'local-datetime' },
    'precision',
    'local-datetime requires precision',
  ],
  [
    { precision: 'second' },
    'format',
    'precision requires local-datetime format',
  ],
] as const)(
  'reports the missing local datetime constraint for %j',
  (constraints, field, message) => {
    const graph = defineGraph({
      id: 'diagnostics',
      access: defineAccess({
        roles: ['reader'],
        fieldGroups: ['ordinary'],
        claims: { clock: localDateTime({ precision: 'second' }) },
      }),
      objects: {},
      policies: {},
    });
    const manifest = structuredClone(compile(graph).manifest);

    manifest.claims.clock = {
      type: 'string',
      optional: false,
      nullable: false,
      ...constraints,
    };

    expect(() => validateManifest(manifest)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'schema.unsupported',
            message,
            path: { root: 'manifest', segments: ['claims', 'clock', field] },
          }),
        ]),
      }),
    );
  },
);
